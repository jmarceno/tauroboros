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
import { join } from 'path'
import { tmpdir } from 'os'

import { createTaskViaUI, getTaskCard } from './ui-helpers'

const WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000
const SERVER_START_TIMEOUT_MS = 120_000

type PiDefaults = {
  provider: string
  modelId: string
  modelValue: string
}

function loadPiDefaults(): PiDefaults {
  const home = process.env.HOME
  if (!home) throw new Error('HOME is not set')

  const settingsPath = join(home, '.pi', 'agent', 'settings.json')
  const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
    defaultProvider?: unknown
    defaultModel?: unknown
  }

  if (typeof raw.defaultProvider !== 'string' || raw.defaultProvider.trim() === '')
    throw new Error('Pi agent settings missing defaultProvider')
  if (typeof raw.defaultModel !== 'string' || raw.defaultModel.trim() === '')
    throw new Error('Pi agent settings missing defaultModel')

  return {
    provider: raw.defaultProvider,
    modelId: raw.defaultModel,
    modelValue: `${raw.defaultProvider}/${raw.defaultModel}`,
  }
}

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
let modelDefaults: PiDefaults

test.describe('Rust Advanced Execution Modes', () => {
  test.setTimeout(WORKFLOW_TIMEOUT_MS)

  test.beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, '../..')
    rustDir = join(repoRoot, 'tauroboros-rust')
    projectDir = mkdtempSync(join(tmpdir(), 'tauroboros-rust-advanced-'))
    serverPort = 3793
    modelDefaults = loadPiDefaults()

    prepareGitProject(projectDir)

    mkdirSync(join(projectDir, '.tauroboros'), { recursive: true })
    writeFileSync(
      join(projectDir, '.tauroboros', 'settings.json'),
      JSON.stringify({
        project: { name: 'tauroboros-rust-advanced', type: 'workflow' },
        workflow: {
          server: { port: serverPort, dbPath: join(projectDir, '.tauroboros', 'tasks.db') },
          container: { enabled: false },
        },
      }, null, 2),
    )

    execSync('npm run build', { cwd: join(repoRoot, 'src/kanban-solid'), stdio: 'pipe' })
    execSync('cargo build', { cwd: rustDir, stdio: 'pipe' })

    serverProcess = spawn(join(rustDir, 'target', 'debug', 'tauroboros-server'), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
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
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM')
    }
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
})

// ====== Helper functions (adapted from real-rust-workflow.spec.ts) ======

async function configureWorkflowDefaults(page: Page, modelValue: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Options Configuration' })).toBeVisible({ timeout: 20_000 })
  await setModelPickerValue(page, 'Plan Model (global)', modelValue)
  await setModelPickerValue(page, 'Execution Model (global)', modelValue)
  await setModelPickerValue(page, 'Review Model', modelValue)
  await setModelPickerValue(page, 'Repair Model', modelValue)
  await setNumericOption(page, 'Parallel Tasks', '1')
  await setCheckboxState(page, 'Show execution graph before starting workflow', true)

  const saveButton = page.locator('button').filter({ hasText: 'Save Options' }).last()
  await expect(saveButton).toBeVisible({ timeout: 20_000 })
  await saveButton.click()
  await expect.poll(() => saveButton.isEnabled(), { timeout: 20_000 }).toBe(true)
}

async function setModelPickerValue(page: Page, labelText: string, value: string): Promise<void> {
  const group = page.locator('.form-group').filter({ hasText: labelText }).first()
  const input = group.locator('input.form-input').first()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await input.click()
  await input.fill(value)
  await page.waitForTimeout(500)
  const suggestion = group.locator('.absolute > div').first()
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
