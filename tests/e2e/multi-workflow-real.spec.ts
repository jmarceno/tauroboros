import { execSync } from 'child_process'

import { test, expect, type Page } from '@playwright/test'

import { BASE_IMAGES } from '../../src/config/base-images.ts'
import { createTaskViaUI, getTaskCard, gotoKanban } from './ui-helpers'

const WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000
const MODEL_VALUE = 'fake/fake-model'

type WorkflowTaskState = {
  name: string
  status: string
}

test.describe('REAL Multi-Workflow Scheduling', () => {
  test.setTimeout(WORKFLOW_TIMEOUT_MS)

  test.beforeAll(() => {
    execSync('podman --version', { stdio: 'pipe' })
    const imageId = execSync(`podman images ${BASE_IMAGES.piAgent} -q`, { encoding: 'utf-8', stdio: 'pipe' }).trim()
    if (!imageId) {
      throw new Error(`Required container image not found: ${BASE_IMAGES.piAgent}. Run: bun run container:setup`)
    }
  })

  test('allows two single-task runs to overlap and preserves dependency order across runs', async ({ page }) => {
    const workflowId = Date.now()
    const firstTaskName = `real-multi-${workflowId}-task-1`
    const secondTaskName = `real-multi-${workflowId}-task-2`

    await gotoKanban(page)
    await configureWorkflowDefaults(page)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 10000 })

    await createTaskViaUI(page, {
      name: firstTaskName,
      prompt: `Create a file named multi_workflow_${workflowId}.txt with content "First run complete".`,
      review: false,
    })

    await createTaskViaUI(page, {
      name: secondTaskName,
      prompt: `Append "Second run complete" to multi_workflow_${workflowId}.txt.`,
      review: false,
      requirements: [firstTaskName],
    })

    await startSingleTaskViaUI(page, firstTaskName)
    await waitForTaskLeavingBacklog(page, firstTaskName)

    await startSingleTaskViaUI(page, secondTaskName)
    await waitForTaskQueuedOrExecuting(page, secondTaskName)

    await waitForSingleRunCards(page, firstTaskName, secondTaskName)
    await waitForDependencySafeCompletion(page, firstTaskName, secondTaskName)
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
  await setCheckboxState(page, 'Show execution graph before starting workflow', false)

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
  await expect(checkbox).toBeVisible({ timeout: 5000 })
  if ((await checkbox.isChecked()) !== checked) {
    await label.click()
  }
}

async function startSingleTaskViaUI(page: Page, taskName: string): Promise<void> {
  const taskCard = getTaskCard(page, taskName)
  await expect(taskCard).toBeVisible({ timeout: 20000 })

  const startButton = taskCard.locator('button[title="Start this task"]').first()
  await expect(startButton).toBeVisible({ timeout: 15000 })
  await startButton.click()

  const modal = page.locator('.modal-overlay').last()
  await expect(modal.getByRole('heading', { name: new RegExp(`Start Task: ${escapeRegExp(taskName)}`) })).toBeVisible({ timeout: 15000 })

  const confirmStart = modal.getByRole('button', { name: 'Start Task' })
  await expect(confirmStart).toBeVisible({ timeout: 15000 })
  await confirmStart.click()

  await expect(modal).not.toBeVisible({ timeout: 15000 })
  
  // Wait for task to start - check for toast OR wait for status change
  try {
    await expect(page.locator('.animate-slide-in, [class*="animate-slide-in"]').filter({ hasText: /Task started|Workflow started/ }).first()).toBeVisible({ timeout: 15000 })
  } catch {
    // Toast might not appear or disappear quickly - verify by waiting briefly
    await page.waitForTimeout(2000)
  }
}

async function waitForTaskLeavingBacklog(page: Page, taskName: string): Promise<void> {
  await expect.poll(async () => {
    const task = await readTaskState(page, taskName)
    return task.status
  }, { timeout: 60000 }).not.toBe('backlog')
}

async function waitForTaskQueuedOrExecuting(page: Page, taskName: string): Promise<void> {
  await expect.poll(async () => {
    const task = await readTaskState(page, taskName)
    return task.status
  }, { timeout: 60000 }).toMatch(/queued|executing|done/)
}

async function waitForSingleRunCards(page: Page, firstTaskName: string, secondTaskName: string): Promise<void> {
  await expect.poll(async () => {
    const firstVisible = await page.getByText(`Single task: ${firstTaskName}`).first().isVisible().catch(() => false)
    const secondVisible = await page.getByText(`Single task: ${secondTaskName}`).first().isVisible().catch(() => false)
    const noRunsVisible = await page.getByText('No active workflow runs').isVisible().catch(() => false)
    return { firstVisible, secondVisible, noRunsVisible }
  }, { timeout: 45000 }).toEqual({ firstVisible: true, secondVisible: true, noRunsVisible: false })
}

async function waitForDependencySafeCompletion(page: Page, firstTaskName: string, secondTaskName: string): Promise<void> {
  const startedAt = Date.now()
  let firstDone = false

  while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS - 30_000) {
    const first = await readTaskState(page, firstTaskName)
    const second = await readTaskState(page, secondTaskName)

    firstDone ||= first.status === 'done'

    if ((second.status === 'executing' || second.status === 'done') && first.status !== 'done') {
      throw new Error(`Dependency order violated: ${second.name} entered ${second.status} while ${first.name} was ${first.status}`)
    }

    if (first.status === 'failed' || first.status === 'stuck') {
      throw new Error(`First task failed in ${first.status}`)
    }

    if (second.status === 'failed' || second.status === 'stuck') {
      throw new Error(`Second task failed in ${second.status}`)
    }

    if (first.status === 'done' && second.status === 'done') {
      expect(firstDone).toBe(true)
      return
    }

    await page.waitForTimeout(4000)
  }

  const first = await readTaskState(page, firstTaskName)
  const second = await readTaskState(page, secondTaskName)
  throw new Error(`Timed out waiting for completion: ${first.name}=${first.status}, ${second.name}=${second.status}`)
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
