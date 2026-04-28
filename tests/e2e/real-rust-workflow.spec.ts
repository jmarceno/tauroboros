/// <reference types="node" />

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

const WORKFLOW_TIMEOUT_MS = 12 * 60 * 1000
const SERVER_START_TIMEOUT_MS = 120_000

let serverPort: number

type WorkflowTaskState = {
  name: string
  status: string
}

type PiDefaults = {
  provider: string
  modelId: string
  modelValue: string
}

test.describe('REAL Rust Workflow', () => {
  test.setTimeout(WORKFLOW_TIMEOUT_MS)

  let projectDir: string
  let rustDir: string
  let serverProcess: ChildProcess
  let homeDir: string
  let mockPiBin: string
  const modelDefaults: PiDefaults = MOCK_MODEL_DEFAULTS

  test.beforeAll(async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
    rustDir = join(repoRoot, 'src/backend')
    projectDir = mkdtempSync(join(tmpdir(), 'src/backend-e2e-'))
    homeDir = join(projectDir, '.home')
    serverPort = 3792

    prepareGitProject(projectDir)
    prepareMockPiHome(homeDir, projectDir)
    mockPiBin = createMockPiBinary(projectDir)

    mkdirSync(join(projectDir, '.tauroboros'), { recursive: true })
    writeFileSync(
      join(projectDir, '.tauroboros', 'settings.json'),
      JSON.stringify(
        {
          project: { name: 'src/backend-e2e', type: 'workflow' },
          workflow: {
            server: {
              port: serverPort,
              dbPath: join(projectDir, '.tauroboros', 'tasks.db'),
            },
            container: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
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

    rmSync(projectDir, { recursive: true, force: true })
  })

  test('runs a live dependency chain through the Rust backend and validates browser-visible workflow state', async ({ page }) => {
    const workflowId = Date.now()
    const task1Name = `rust-workflow-${workflowId}-task-1`
    const task2Name = `rust-workflow-${workflowId}-task-2`
    const task3Name = `rust-workflow-${workflowId}-task-3`
    const workflowFile = `workflow-result-${workflowId}.txt`

    await page.goto(`http://localhost:${serverPort}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Options' }).click()
    await configureWorkflowDefaults(page, modelDefaults.modelValue)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

    await createTaskViaUI(page, {
      name: task1Name,
      prompt: [
        `Create a file named ${workflowFile} in the repository root.`,
        'Write exactly these three lines in order:',
        '1. workflow step 1',
        '2. verified by rust backend',
        '3. keep this file plain text',
      ].join('\n'),
      review: false,
    })

    await createTaskViaUI(page, {
      name: task2Name,
      prompt: `Append a new line with the exact text "workflow step 2" to ${workflowFile}.`,
      review: false,
      requirements: [task1Name],
    })

    await createTaskViaUI(page, {
      name: task3Name,
      prompt: `Append a new line with the exact text "workflow step 3" to ${workflowFile}.`,
      review: false,
      requirements: [task2Name],
    })

    await startSingleTaskViaUI(page, task3Name)

    const runCard = await waitForRunCard(page)
    const runId = await runCard.getAttribute('data-run-id')
    if (!runId) {
      throw new Error('Run card is missing data-run-id')
    }

    await waitForTaskToLeaveBacklog(page, task1Name)
    await pauseWorkflow(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Resume' }).first()).toBeVisible({ timeout: 30_000 })

    const pausedRunCard = await waitForRunCard(page)
    await expect(pausedRunCard).toContainText('paused')

    await resumeWorkflow(page)
    await waitForWorkflowCompletion(page, [task1Name, task2Name, task3Name])

    await expect.poll(() => readWorkflowFile(projectDir, workflowFile), { timeout: 30_000 }).toBe([
      'workflow step 1',
      'verified by rust backend',
      'keep this file plain text',
      'workflow step 2',
      'workflow step 3',
    ].join('\n'))

    await openTaskSessionsModal(page, task1Name)
    const taskSessionsModal = page.locator('.modal-overlay').last()
    await expect(taskSessionsModal.locator('.badge').filter({ hasText: /^status: completed$/ }).first()).toBeVisible({ timeout: 30_000 })
    await expect(taskSessionsModal.locator('.badge').filter({ hasText: /^phase: worker$/ }).first()).toBeVisible({ timeout: 30_000 })
    await expect(taskSessionsModal.locator('.badge').filter({ hasText: /^slot: 1$/ }).first()).toBeVisible({ timeout: 30_000 })
    await expect(taskSessionsModal.locator('.badge').filter({ hasText: new RegExp(`^model: ${escapeRegExp(modelDefaults.modelValue)}$`) }).first()).toBeVisible({ timeout: 30_000 })
    await expect(taskSessionsModal.getByText('No session messages yet.')).not.toBeVisible({ timeout: 30_000 })
    await expect(taskSessionsModal.locator('.session-entry').first()).toBeVisible({ timeout: 30_000 })
    await closeModal(page)

    await expect.poll(() => countWorktreeEntries(projectDir), { timeout: 30_000 }).toBe(0)

    const staleRunCard = await waitForRunCard(page)
    await expect(staleRunCard).toContainText('stale')
    await staleRunCard.locator('button[title="Archive this run"]').click()
    await expect(page.locator(`[data-run-id="${runId}"]`)).not.toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('No active workflow runs')).toBeVisible({ timeout: 30_000 })
  })
})

function prepareGitProject(projectDir: string): void {
  writeFileSync(join(projectDir, '.gitignore'), ['.tauroboros/', '.worktrees/'].join('\n') + '\n')
  writeFileSync(join(projectDir, 'README.md'), '# Rust workflow validation\n')
  mkdirSync(join(projectDir, 'notes'), { recursive: true })
  writeFileSync(join(projectDir, 'notes', 'context.md'), 'This repository is used for Rust workflow browser validation.\n')

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
    } catch {
      // Server not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Rust server did not become ready within ${SERVER_START_TIMEOUT_MS}ms on port ${port}`)
}

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
  const responsePromise = page.waitForResponse((response) => {
    return response.request().method() === 'POST' && /\/api\/tasks\/[^/]+\/start$/.test(response.url())
  })

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

async function waitForTaskToLeaveBacklog(page: Page, taskName: string): Promise<void> {
  await expect.poll(async () => {
    const state = await readTaskState(page, taskName)
    return state.status
  }, { timeout: 60_000, intervals: [1000, 2000, 3000] }).not.toBe('backlog')
}

async function pauseWorkflow(page: Page): Promise<void> {
  const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' }).first()
  await expect(pauseButton).toBeVisible({ timeout: 30_000 })
  await expect(pauseButton).toBeEnabled({ timeout: 30_000 })
  await pauseButton.click()

  const resumeButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Resume' }).first()
  await expect(resumeButton).toBeVisible({ timeout: 30_000 })
}

async function resumeWorkflow(page: Page): Promise<void> {
  const resumeButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Resume' }).first()
  await expect(resumeButton).toBeVisible({ timeout: 30_000 })
  await expect(resumeButton).toBeEnabled({ timeout: 30_000 })
  await resumeButton.click()

  const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' }).first()
  await expect(pauseButton).toBeVisible({ timeout: 30_000 })
}

async function waitForWorkflowCompletion(page: Page, taskNames: string[]): Promise<void> {
  const startedAt = Date.now()
  let sawTask1Done = false
  let sawTask2Done = false

  while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS - 30_000) {
    const states = await Promise.all(taskNames.map((taskName) => readTaskState(page, taskName)))
    const [task1, task2, task3] = states

    if ((task2.status === 'executing' || task2.status === 'review' || task2.status === 'done') && task1.status !== 'done') {
      throw new Error(`Dependency order violated: ${task2.name} left backlog while ${task1.name} was ${task1.status}`)
    }

    if ((task3.status === 'executing' || task3.status === 'review' || task3.status === 'done') && task2.status !== 'done') {
      throw new Error(`Dependency order violated: ${task3.name} left backlog while ${task2.name} was ${task2.status}`)
    }

    sawTask1Done ||= task1.status === 'done'
    sawTask2Done ||= task2.status === 'done'

    const failed = states.find((state) => state.status === 'failed' || state.status === 'stuck')
    if (failed) {
      throw new Error(`Workflow task failed: ${failed.name} ended in ${failed.status}`)
    }

    if (states.every((state) => state.status === 'done')) {
      expect(sawTask1Done).toBe(true)
      expect(sawTask2Done).toBe(true)
      return
    }

    await page.waitForTimeout(3000)
  }

  const finalStates = await Promise.all(taskNames.map((taskName) => readTaskState(page, taskName)))
  throw new Error(`Workflow timed out before completion: ${finalStates.map((state) => `${state.name}=${state.status}`).join(', ')}`)
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

async function readTaskState(page: Page, taskName: string): Promise<WorkflowTaskState> {
  const taskCard = getTaskCard(page, taskName)
  if (await taskCard.isVisible().catch(() => false)) {
    const status = await taskCard.getAttribute('data-task-status')
    if (status) return { name: taskName, status }
  }

  for (const status of ['template', 'backlog', 'queued', 'executing', 'review', 'code-style', 'done']) {
    const columnMatch = page.locator(`[data-status="${status}"] .task-card`).filter({ hasText: taskName }).first()
    if (await columnMatch.isVisible().catch(() => false)) {
      return { name: taskName, status }
    }
  }

  return { name: taskName, status: 'unknown' }
}

function countWorktreeEntries(projectDir: string): number {
  const worktreeDir = join(projectDir, '.worktrees')
  if (!existsSync(worktreeDir)) return 0
  return readdirSync(worktreeDir).length
}

function readWorkflowFile(projectDir: string, workflowFile: string): string {
  const absolutePath = join(projectDir, workflowFile)
  if (!existsSync(absolutePath)) return ''
  return readFileSync(absolutePath, 'utf-8').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}