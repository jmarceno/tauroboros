import { execSync } from 'child_process'

import { test, expect, type Locator, type Page } from '@playwright/test'

import { BASE_IMAGES } from '../../src/backend-ts/config/base-images.ts'
import { createTaskViaUI, getTaskCard, gotoKanban } from './ui-helpers'

const WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000
const MODEL_VALUE = 'fake/fake-model'

type WorkflowTaskState = {
  name: string
  status: string
}

test.describe('REAL Multi-Task Workflow', () => {
  test.setTimeout(WORKFLOW_TIMEOUT_MS)

  test.beforeAll(() => {
    execSync('podman --version', { stdio: 'pipe' })
    const imageId = execSync(`podman images ${BASE_IMAGES.piAgent} -q`, { encoding: 'utf-8', stdio: 'pipe' }).trim()
    if (!imageId) {
      throw new Error(`Required container image not found: ${BASE_IMAGES.piAgent}. Run: bun run container:setup`)
    }
  })

  test('runs a chained 3-task workflow end to end through the web UI', async ({ page }) => {
    const workflowId = Date.now()
    const task1Name = `real-workflow-${workflowId}-task-1`
    const task2Name = `real-workflow-${workflowId}-task-2`
    const task3Name = `real-workflow-${workflowId}-task-3`

    await gotoKanban(page)
    await configureWorkflowDefaults(page)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 10000 })

    await createTaskViaUI(page, {
      name: task1Name,
      prompt: 'Create a file named workflow_result.txt with content "Task 1 complete".',
      review: false,
    })

    await createTaskViaUI(page, {
      name: task2Name,
      prompt: 'Append "Task 2 complete" to workflow_result.txt.',
      review: false,
      requirements: [task1Name],
    })

    await createTaskViaUI(page, {
      name: task3Name,
      prompt: 'Append "Task 3 complete" to workflow_result.txt.',
      review: false,
      requirements: [task2Name],
    })

    await startSingleTaskViaUI(page, task3Name)
    await waitForWorkflowCompletion(page, [task1Name, task2Name, task3Name])
  })
})

async function configureWorkflowDefaults(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Options' }).click()
  await expect(page.getByRole('heading', { name: 'Options Configuration' })).toBeVisible({ timeout: 15000 })

  await setModelPickerValue(page, 'Plan Model (global)', MODEL_VALUE)
  await setModelPickerValue(page, 'Execution Model (global)', MODEL_VALUE)
  await setModelPickerValue(page, 'Review Model', MODEL_VALUE)
  await setModelPickerValue(page, 'Repair Model', MODEL_VALUE)

  await setNumericOption(page, 'Parallel Tasks', '1')
  await setCheckboxState(page, 'Show execution graph before starting workflow', true)
  
  const saveButton = page.locator('button').filter({ hasText: 'Save Options' }).last()
  await expect(saveButton).toBeVisible({ timeout: 15000 })
  await saveButton.click()
  
  // Wait for save to complete - success toast OR just wait for button to be re-enabled
  await page.waitForTimeout(1000)
  await expect.poll(async () => saveButton.isEnabled(), { timeout: 15000 }).toBe(true)
}

async function setModelPickerValue(page: Page, labelText: string, value: string): Promise<void> {
  const group = page.locator('.form-group').filter({ hasText: labelText }).first()
  const input = group.locator('input.form-input').first()
  await expect(input).toBeVisible({ timeout: 15000 })
  await input.click()
  await input.fill(value)
  
  // Wait for Fuse.js search to complete and suggestions to appear
  await page.waitForTimeout(500)

  // Try to find and click the suggestion with retry logic
  const suggestion = group.locator('.absolute > div').first()
  await expect.poll(async () => suggestion.isVisible(), { 
    timeout: 10000,
    intervals: [200, 400, 600, 800]
  }).toBe(true)
  
  await suggestion.click()

  // Verify the value was set correctly
  await expect.poll(async () => input.inputValue(), { timeout: 10000 }).toBe(value)
}

async function setNumericOption(page: Page, labelText: string, value: string): Promise<void> {
  const input = page.locator('.form-group').filter({ hasText: labelText }).locator('input[type="number"]').first()
  await expect(input).toBeVisible({ timeout: 10000 })
  await input.fill(value)
}

async function setCheckboxState(page: Page, labelText: string, checked: boolean): Promise<void> {
  const label = page.locator('label.checkbox-item').filter({ hasText: labelText }).first()
  const checkbox = label.locator('input[type="checkbox"]').first()
  await expect(checkbox).toBeVisible({ timeout: 10000 })
  if ((await checkbox.isChecked()) !== checked) {
    await label.click()
  }
}

async function startWorkflowViaUI(page: Page): Promise<void> {
  const startButton = page.getByRole('button', { name: 'Start Workflow' })
  await expect(startButton).toBeVisible({ timeout: 10000 })
  await expect(startButton).toBeEnabled({ timeout: 10000 })
  await startButton.click()
}

async function startSingleTaskViaUI(page: Page, taskName: string): Promise<void> {
  const taskCard = getTaskCard(page, taskName)
  await expect(taskCard).toBeVisible({ timeout: 20000 })

  const startButton = taskCard.locator('button[title="Start this task"]').first()
  await expect(startButton).toBeVisible({ timeout: 15000 })
  await startButton.click()

  const modal = page.locator('.modal-overlay').last()
  await expect(modal.getByRole('heading', { name: new RegExp(`Start Task: ${escapeRegExp(taskName)}`) })).toBeVisible({ timeout: 15000 })

  await modal.getByRole('button', { name: 'Start Task' }).click()
  await expect(modal).not.toBeVisible({ timeout: 15000 })

  // Wait for task to start - check for toast OR wait for status change
  try {
    await expect(page.locator('.animate-slide-in, [class*="animate-slide-in"]').filter({ hasText: /Task started|Workflow started/ }).first()).toBeVisible({ timeout: 15000 })
  } catch {
    // Toast might not appear or disappear quickly - verify by checking workflow runs panel
    await page.waitForTimeout(2000)
  }
}

async function confirmExecutionGraphIfVisible(page: Page): Promise<boolean> {
  // Increase timeout to allow for slower graph generation
  const modal = page.locator('.modal-overlay').filter({ hasText: 'Execution Graph Preview' }).last()
  if (await modal.isVisible({ timeout: 10000 }).catch(() => false)) {
    await modal.getByRole('button', { name: 'Confirm & Start' }).click()
    return true
  }

  const confirmButton = page.getByRole('button', { name: 'Confirm & Start' })
  if (await confirmButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await confirmButton.click()
    return true
  }

  return false
}

async function waitForWorkflowStart(page: Page, taskNames: string[]): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 60_000) {
    await confirmExecutionGraphIfVisible(page)

    const errorToast = page.locator('div[role="alert"], .toast, [class*="animate-slide-in"]').filter({
      hasText: /Execution control failed|Cannot start workflow|Failed to load execution graph|No tasks available to execute/i,
    }).first()

    if (await errorToast.isVisible().catch(() => false)) {
      throw new Error(`Workflow failed to start: ${(await errorToast.textContent())?.trim() || 'unknown error'}`)
    }

    const pauseButton = page.getByRole('button', { name: 'Pause' })
    if (await pauseButton.isEnabled().catch(() => false)) {
      return
    }

    const states = await Promise.all(taskNames.map((name) => readTaskState(page, name)))
    if (states.some((state) => state.status !== 'backlog')) {
      return
    }

    const emptyRunsState = page.getByText('No active workflow runs')
    if (!(await emptyRunsState.isVisible().catch(() => false))) {
      return
    }

    await page.waitForTimeout(1000)
  }

  throw new Error('Workflow did not start within 60 seconds')
}

async function waitForWorkflowCompletion(page: Page, taskNames: string[]): Promise<void> {
  const startedAt = Date.now()
  let task1Done = false
  let task2Done = false
  let lastStatusLog = Date.now()

  while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS - 30_000) {
    const states = await Promise.all(taskNames.map((name) => readTaskState(page, name)))
    const [task1, task2, task3] = states
    
    // Log status every 30 seconds for debugging
    if (Date.now() - lastStatusLog > 30000) {
      console.log(`[Test] Status: ${states.map(s => `${s.name}=${s.status}`).join(', ')}`)
      lastStatusLog = Date.now()
    }

    if ((task2.status === 'executing' || task2.status === 'review' || task2.status === 'done') && task1.status !== 'done') {
      throw new Error(`Dependency order violated: ${task2.name} left backlog while ${task1.name} was ${task1.status}`)
    }

    if ((task3.status === 'executing' || task3.status === 'review' || task3.status === 'done') && task2.status !== 'done') {
      throw new Error(`Dependency order violated: ${task3.name} left backlog while ${task2.name} was ${task2.status}`)
    }

    task1Done ||= task1.status === 'done'
    task2Done ||= task2.status === 'done'

    const terminalFailure = states.find((state) => state.status === 'failed' || state.status === 'stuck')
    if (terminalFailure) {
      throw new Error(`Workflow task failed: ${terminalFailure.name} ended in ${terminalFailure.status}`)
    }

    if (states.every((state) => state.status === 'done')) {
      expect(task1Done).toBe(true)
      expect(task2Done).toBe(true)
      return
    }
    
    // Poll more frequently (3s instead of 5s) for faster completion detection
    await page.waitForTimeout(3000)
  }

  const finalStates = await Promise.all(taskNames.map((name) => readTaskState(page, name)))
  throw new Error(`Workflow timed out before completion: ${finalStates.map((state) => `${state.name}=${state.status}`).join(', ')}`)
}

async function readTaskState(page: Page, taskName: string): Promise<WorkflowTaskState> {
  const taskCard = getTaskCard(page, taskName)
  if (await taskCard.isVisible().catch(() => false)) {
    const status = await taskCard.getAttribute('data-task-status')
    if (status) {
      return { name: taskName, status }
    }
  }

  for (const status of ['template', 'backlog', 'queued', 'executing', 'review', 'code-style', 'done']) {
    const columnMatch = page.locator(`[data-status="${status}"] .task-card`).filter({ hasText: taskName }).first()
    if (await columnMatch.isVisible().catch(() => false)) {
      return { name: taskName, status }
    }
  }

  return { name: taskName, status: 'unknown' }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}