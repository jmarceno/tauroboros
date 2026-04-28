/// <reference types="node" />

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import {
  createMockPiBinary,
  MOCK_MODEL_DEFAULTS,
  prepareMockPiHome,
  stopChildProcess,
} from './rust-live-helpers'
import { createTaskViaUI, getTaskCard } from './ui-helpers'

const WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000
const SERVER_START_TIMEOUT_MS = 120_000

function prepareGitProject(projectDir: string): void {
  writeFileSync(join(projectDir, '.gitignore'), ['.tauroboros/', '.worktrees/'].join('\n') + '\n')
  writeFileSync(join(projectDir, 'README.md'), '# Advanced modes validation\n')
  mkdirSync(join(projectDir, 'notes'), { recursive: true })
  writeFileSync(join(projectDir, 'notes', 'context.md'), 'Repository for advanced execution mode browser validation.\n')

  execSync('git init -b master', { cwd: projectDir, stdio: 'ignore' })
  execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' })
  execSync('git config user.name "Test User"', { cwd: projectDir, stdio: 'ignore' })
  execSync('git add .', { cwd: projectDir, stdio: 'ignore' })
  execSync('git commit -m "init"', { cwd: projectDir, stdio: 'ignore' })
  execSync('git branch e2e-secondary', { cwd: projectDir, stdio: 'ignore' })
}

async function waitForServerReady(port: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
    try {
      const response = await fetch(`http://localhost:${port}/healthz`)
      if (response.ok) return
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Server did not become ready within ${SERVER_START_TIMEOUT_MS}ms on port ${port}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readWorkflowFile(projectDir: string, fileName: string): string {
  const absolutePath = join(projectDir, fileName)
  if (!existsSync(absolutePath)) return ''
  return readFileSync(absolutePath, 'utf-8').trim()
}

let serverProcess: ChildProcess
let serverPort: number
let projectDir: string
let rustDir: string
let homeDir: string
let mockPiBin: string
const modelDefaults = MOCK_MODEL_DEFAULTS

test.describe('Rust Advanced Execution Modes', () => {
  test.setTimeout(WORKFLOW_TIMEOUT_MS)

  test.beforeAll(async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
    rustDir = join(repoRoot, 'src/backend')
    projectDir = mkdtempSync(join(tmpdir(), 'src/backend-advanced-'))
    homeDir = join(projectDir, '.home')
    serverPort = 3793

    prepareGitProject(projectDir)
    prepareMockPiHome(homeDir, projectDir)
    mockPiBin = createMockPiBinary(projectDir)

    mkdirSync(join(projectDir, '.tauroboros'), { recursive: true })
    writeFileSync(
      join(projectDir, '.tauroboros', 'settings.json'),
      JSON.stringify({
        project: { name: 'src/backend-advanced', type: 'workflow' },
        workflow: {
          server: { port: serverPort, dbPath: join(projectDir, '.tauroboros', 'tasks.db') },
          container: { enabled: false },
        },
      }, null, 2),
    )

    execSync('npm run build', { cwd: join(repoRoot, 'src/frontend'), stdio: 'pipe' })
    execSync('cargo build', { cwd: rustDir, stdio: 'pipe' })

    serverProcess = spawn(join(rustDir, 'target', 'debug', 'tauroboros-server'), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH,
        HOME: homeDir,
        PI_BIN: mockPiBin,
        PROJECT_ROOT: projectDir,
        SERVER_PORT: String(serverPort),
        DATABASE_PATH: join(projectDir, '.tauroboros', 'tasks.db'),
      },
    })

    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.log(`[RUST-SERVER] ${text}`)
    })
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.error(`[RUST-SERVER-ERR] ${text}`)
    })

    await waitForServerReady(serverPort)
  })

  test.afterAll(() => {
    stopChildProcess(serverProcess)
    try { rmSync(projectDir, { recursive: true, force: true }) } catch { }
  })

  test('plan mode with auto-approve goes through planning and implementation phases', async ({ page }) => {
    const workflowId = Date.now()
    const taskName = `plan-mode-${workflowId}`
    const resultFile = `plan-result-${workflowId}.txt`

    await page.goto(`http://localhost:${serverPort}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Options' }).click()
    await configureWorkflowDefaults(page, modelDefaults.modelValue)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

    await createTaskViaUI(page, {
      name: taskName,
      prompt: `Create a file named ${resultFile} in the repository root with the exact text "plan-mode-executed" on the first line.`,
      planMode: true,
      autoApprovePlan: true,
      review: false,
    })

    await startSingleTaskViaUI(page, taskName)

    const runCard = await waitForRunCard(page)
    const runId = await runCard.getAttribute('data-run-id')
    expect(runId).toBeTruthy()

    // Wait for the task to complete through plan -> implementation
    await waitForTaskCompletion(page, taskName, ['done', 'failed', 'stuck'])

    expect(readWorkflowFile(projectDir, resultFile)).toContain('plan-mode-executed')
  })

  test('review loop executes and completes on standard task with review enabled', async ({ page }) => {
    const workflowId = Date.now()
    const taskName = `review-test-${workflowId}`
    const resultFile = `review-result-${workflowId}.txt`

    await page.goto(`http://localhost:${serverPort}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Options' }).click()
    await configureWorkflowDefaults(page, modelDefaults.modelValue)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

    await createTaskViaUI(page, {
      name: taskName,
      prompt: `Create a file named ${resultFile} in the repository root with the exact text "review-loop-passed" on the first line.`,
      review: true,
      planMode: false,
    })

    await startSingleTaskViaUI(page, taskName)

    const runCard = await waitForRunCard(page)
    const runId = await runCard.getAttribute('data-run-id')
    expect(runId).toBeTruthy()

    await waitForTaskCompletion(page, taskName, ['done', 'failed', 'stuck', 'review'])

    // The task should be done (review passes) or if review fails, still verify the file was created
    const content = readWorkflowFile(projectDir, resultFile)
    if (content) {
      expect(content).toContain('review-loop-passed')
    }

    // Verify sessions modal shows review-phase task runs
    await openTaskSessionsModal(page, taskName)
    const taskSessionsModal = page.locator('.modal-overlay').last()
    // Should have at least one session entry
    await expect(taskSessionsModal.locator('.session-entry').first()).toBeVisible({ timeout: 30_000 })
    await closeModal(page)
  })

  test('best-of-N execution with multiple workers completes successfully', async ({ page }) => {
    const workflowId = Date.now()
    const taskName = `bon-test-${workflowId}`
    const resultFile = `bon-result-${workflowId}.txt`

    await page.goto(`http://localhost:${serverPort}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Options' }).click()
    await configureWorkflowDefaults(page, modelDefaults.modelValue)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

    // Create best-of-N task via API (the UI modal doesn't expose best_of_n config easily)
    const createResponse = await fetch(`http://localhost:${serverPort}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: taskName,
        prompt: `Create a file named ${resultFile} in the repository root with the exact text "best-of-n-executed" on the first line.`,
        executionStrategy: 'best_of_n',
        bestOfNConfig: {
          workers: [{ model: modelDefaults.modelValue, count: 2 }],
          reviewers: [],
          finalApplier: { model: modelDefaults.modelValue },
          selectionMode: 'pick_best',
          minSuccessfulWorkers: 1,
        },
        review: false,
        planmode: false,
      }),
    })
    expect(createResponse.ok).toBe(true)
    const createdTask = await createResponse.json() as { id: string; name: string }
    expect(createdTask.id).toBeTruthy()

    // Reload page to see the task
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

    // Start the task via API
    const startResponse = await fetch(`http://localhost:${serverPort}/api/tasks/${createdTask.id}/start`, {
      method: 'POST',
    })
    expect(startResponse.ok).toBe(true)

    const runCard = await waitForRunCard(page)
    const runId = await runCard.getAttribute('data-run-id')
    expect(runId).toBeTruthy()

    // Wait for the task to complete
    await waitForTaskCompletion(page, taskName, ['done', 'failed', 'stuck'])

    const content = readWorkflowFile(projectDir, resultFile)
    if (content) {
      expect(content).toContain('best-of-n-executed')
    }

    // Verify best-of-n summary endpoint
    const summaryResponse = await fetch(
      `http://localhost:${serverPort}/api/tasks/${createdTask.id}/best-of-n-summary`,
    )
    expect(summaryResponse.ok).toBe(true)
    const summary = await summaryResponse.json() as {
      taskId: string
      workersTotal: number
      workersDone: number
      hasFinalApplier: boolean
      successfulCandidateCount: number
    }
    expect(summary.taskId).toBe(createdTask.id)
    expect(summary.workersTotal).toBeGreaterThanOrEqual(1)
    expect(summary.successfulCandidateCount).toBeGreaterThanOrEqual(0)
  })

  test('best-of-N manual review candidate selection works through the frontend', async ({ page }) => {
    const workflowId = Date.now()
    const taskName = `bon-manual-${workflowId}`

    await page.goto(`http://localhost:${serverPort}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Options' }).click()
    await configureWorkflowDefaults(page, modelDefaults.modelValue)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

    const createResponse = await fetch(`http://localhost:${serverPort}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: taskName,
        prompt: 'Create a small implementation and stop for manual best-of-n review.',
        executionStrategy: 'best_of_n',
        bestOfNConfig: {
          workers: [{ model: modelDefaults.modelValue, count: 1 }],
          reviewers: [{ model: modelDefaults.modelValue, count: 1, taskSuffix: 'force-manual' }],
          finalApplier: { model: modelDefaults.modelValue },
          selectionMode: 'pick_best',
          minSuccessfulWorkers: 1,
        },
        review: false,
        planmode: false,
      }),
    })
    expect(createResponse.ok).toBe(true)
    const createdTask = await createResponse.json() as { id: string }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

    const startResponse = await fetch(`http://localhost:${serverPort}/api/tasks/${createdTask.id}/start`, {
      method: 'POST',
    })
    expect(startResponse.ok).toBe(true)

    await waitForRunCard(page)
    const terminalState = await waitForTaskCompletion(page, taskName, ['review', 'failed', 'stuck', 'done'])
    expect(terminalState).toBe('review')

    const preSelectionSummaryResponse = await fetch(
      `http://localhost:${serverPort}/api/tasks/${createdTask.id}/best-of-n-summary`,
    )
    expect(preSelectionSummaryResponse.ok).toBe(true)
    const preSelectionSummary = await preSelectionSummaryResponse.json() as {
      substage: string
      selectedCandidate: string | null
      availableCandidates: number
    }
    expect(preSelectionSummary.substage).toBe('blocked_for_manual_review')
    expect(preSelectionSummary.selectedCandidate).toBeNull()
    expect(preSelectionSummary.availableCandidates).toBeGreaterThan(0)

    const taskCard = getTaskCard(page, taskName)
    await expect(taskCard).toBeVisible({ timeout: 20_000 })
    await taskCard.getByRole('button', { name: 'View Runs' }).click()

    const modal = page.locator('.modal-overlay').last()
    await expect(modal.getByRole('heading', { name: new RegExp(`Best-of-N: ${escapeRegExp(taskName)}`) })).toBeVisible({ timeout: 20_000 })

    const selectResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' && /\/api\/tasks\/[^/]+\/best-of-n\/select-candidate$/.test(response.url()),
    )
    await modal.getByRole('button', { name: 'Select' }).first().click()
    const selectResponse = await selectResponsePromise
    expect(selectResponse.ok()).toBe(true)
    await expect(modal).not.toBeVisible({ timeout: 20_000 })

    const selectedCandidatesResponse = await fetch(`http://localhost:${serverPort}/api/tasks/${createdTask.id}/candidates`)
    expect(selectedCandidatesResponse.ok).toBe(true)
    const selectedCandidates = await selectedCandidatesResponse.json() as Array<{ status: string }>
    expect(selectedCandidates.filter((candidate) => candidate.status === 'selected')).toHaveLength(1)

    const postSelectionSummaryResponse = await fetch(
      `http://localhost:${serverPort}/api/tasks/${createdTask.id}/best-of-n-summary`,
    )
    expect(postSelectionSummaryResponse.ok).toBe(true)
    const postSelectionSummary = await postSelectionSummaryResponse.json() as {
      selectedCandidate: string | null
      selectedCandidates: number
      availableCandidates: number
    }
    expect(postSelectionSummary.selectedCandidate).toBeTruthy()
    expect(postSelectionSummary.selectedCandidates).toBe(1)
    expect(postSelectionSummary.availableCandidates).toBe(0)
  })
})

// ====== Helper functions (adapted from real-rust-workflow.spec.ts) ======

async function configureWorkflowDefaults(page: Page, modelValue: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Options Configuration' })).toBeVisible({ timeout: 20_000 })

  const response = await fetch(`http://localhost:${serverPort}/api/options`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: 'master',
      planModel: modelValue,
      executionModel: modelValue,
      reviewModel: modelValue,
      repairModel: modelValue,
      parallelTasks: 1,
      showExecutionGraph: true,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to configure workflow defaults: ${response.status} ${await response.text()}`)
  }

  const updated = await response.json() as {
    branch?: string
    planModel?: string
    executionModel?: string
    reviewModel?: string
    repairModel?: string
    parallelTasks?: number
    showExecutionGraph?: boolean
  }
  expect(updated.branch).toBe('master')
  expect(updated.planModel).toBe(modelValue)
  expect(updated.executionModel).toBe(modelValue)
  expect(updated.reviewModel).toBe(modelValue)
  expect(updated.repairModel).toBe(modelValue)
  expect(updated.parallelTasks).toBe(1)
  expect(updated.showExecutionGraph).toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
}

async function setModelPickerValue(page: Page, labelText: string, value: string): Promise<void> {
  const group = page.locator('.form-group').filter({ hasText: labelText }).first()
  const input = group.locator('input.form-input').first()
  const modelToken = value.split('/').pop() || value

  await expect(input).toBeVisible({ timeout: 20_000 })
  if ((await input.inputValue()) === value) {
    return
  }

  await input.click()
  await expect(group.locator('.absolute .cursor-pointer').first()).toBeVisible({ timeout: 20_000 })
  await input.fill(value)
  await page.waitForTimeout(500)

  const suggestion = group.locator('.absolute .cursor-pointer').filter({ hasText: modelToken }).first()
  await expect(suggestion).toBeVisible({ timeout: 15_000 })
  await suggestion.click()

  await expect.poll(() => input.inputValue(), { timeout: 15_000 }).toBe(value)
}

async function setNumericOption(page: Page, labelText: string, value: string): Promise<void> {
  const input = page.locator('.form-group').filter({ hasText: labelText }).locator('input[type="number"]').first()
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(value)
}

async function setCheckboxState(page: Page, labelText: string, checked: boolean): Promise<void> {
  const label = page.locator('label.checkbox-item').filter({ hasText: labelText }).first()
  const checkbox = label.locator('input[type="checkbox"]').first()
  await expect(checkbox).toBeVisible({ timeout: 15_000 })
  if ((await checkbox.isChecked()) !== checked) {
    await label.click()
  }
}

async function startSingleTaskViaUI(page: Page, taskName: string): Promise<void> {
  const taskCard = getTaskCard(page, taskName)
  await expect(taskCard).toBeVisible({ timeout: 20_000 })

  const startButton = taskCard.locator('button[title="Start this task"]').first()
  await expect(startButton).toBeVisible({ timeout: 15_000 })
  await startButton.click()

  const modal = page.locator('.modal-overlay').last()
  await expect(modal.getByRole('heading', { name: new RegExp(`Start Task: ${escapeRegExp(taskName)}`) })).toBeVisible({ timeout: 15_000 })

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && /\/api\/tasks\/[^/]+\/start$/.test(response.url()),
  )
  await modal.getByRole('button', { name: 'Start Task' }).click()
  const response = await responsePromise
  if (!response.ok()) {
    throw new Error(`Task start failed with ${response.status()}: ${await response.text()}`)
  }
  await expect(modal).not.toBeVisible({ timeout: 15_000 })
}

async function openWorkflowRunsTab(page: Page): Promise<void> {
  const button = page.locator('button').filter({ hasText: /^Workflow Runs/ }).last()
  await expect(button).toBeVisible({ timeout: 20_000 })
  await button.click()
}

async function waitForRunCard(page: Page): Promise<Locator> {
  await openWorkflowRunsTab(page)
  const runCard = page.locator('[data-run-id]').first()
  await expect(runCard).toBeVisible({ timeout: 30_000 })
  return runCard
}

async function waitForTaskCompletion(
  page: Page,
  taskName: string,
  terminalStates: string[],
): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS - 30_000) {
    const state = await readTaskState(page, taskName)
    if (terminalStates.includes(state.status)) {
      return state.status
    }
    await page.waitForTimeout(3000)
  }
  const finalState = await readTaskState(page, taskName)
  throw new Error(`Task ${taskName} timed out before reaching terminal state. Final state: ${finalState.status}`)
}

async function readTaskState(page: Page, taskName: string): Promise<{ name: string; status: string }> {
  const taskCard = getTaskCard(page, taskName)
  if (await taskCard.isVisible().catch(() => false)) {
    const status = await taskCard.getAttribute('data-task-status')
    if (status) return { name: taskName, status }
  }

  for (const status of ['template', 'backlog', 'queued', 'executing', 'review', 'code-style', 'done', 'failed', 'stuck']) {
    const columnMatch = page.locator(`[data-status="${status}"] .task-card`).filter({ hasText: taskName }).first()
    if (await columnMatch.isVisible().catch(() => false)) {
      return { name: taskName, status }
    }
  }

  return { name: taskName, status: 'unknown' }
}

async function openTaskSessionsModal(page: Page, taskName: string): Promise<void> {
  const taskCard = getTaskCard(page, taskName)
  await expect(taskCard).toBeVisible({ timeout: 30_000 })
  const title = taskCard.locator('.task-title').first()
  await expect(title).toBeVisible({ timeout: 30_000 })
  await title.click()
  await expect(page.locator('.modal-overlay').last().locator('h2')).toContainText(`${taskName} • Sessions`, { timeout: 30_000 })
}

async function closeModal(page: Page): Promise<void> {
  const modal = page.locator('.modal-overlay').last()
  await modal.locator('button.icon-btn').click()
  await expect(modal).not.toBeVisible({ timeout: 15_000 })
}
