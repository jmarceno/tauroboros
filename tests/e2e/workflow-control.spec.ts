/**
 * E2E Test: Workflow Control (Pause, Resume, Stop) via Web UI ONLY
 *
 * This tes must pass in a single run without manually cleaning any state
 * if a test does not pass because the previous one left a bad state,
 * this means that the previous test in fact FAILED.
 *
 * Tests the workflow control functionality with real containers:
 * - Pause workflow during execution
 * - Resume paused workflow
 * - Stop workflow (graceful and destructive)
 * - Stop confirmation modal
 *
 * CRITICAL: This test uses ONLY Web UI interactions - no API calls.
 * page.evaluate is NOT used for any workflow operations.
 * Tasks are created with plan mode, auto-approve, and review enabled
 * to simulate a real end-to-end workflow scenario with containers.
 */

import { test, expect, type Page } from '@playwright/test'
import { execSync } from "child_process";
import { BASE_IMAGES } from "../../src/config/base-images.ts";

import { createTaskViaUI, gotoKanban } from './ui-helpers'

test.beforeAll(() => {
  console.log('[TEST SETUP] Verifying container infrastructure...');

  let hasPodman = false;
  let hasPiAgentImage = false;

  try {
    execSync('podman --version', { stdio: 'pipe' });
    hasPodman = true;
  } catch {}

  if (hasPodman) {
    try {
      const result = execSync(`podman images ${BASE_IMAGES.piAgent} -q`, { encoding: 'utf-8', stdio: 'pipe' });
      hasPiAgentImage = result.trim().length > 0;
    } catch {}
  }

  if (!hasPodman || !hasPiAgentImage) {
    console.error('Container infrastructure not available. Run: bun run container:setup');
    throw new Error('Container infrastructure not available. Test cannot proceed.');
  }

  console.log('[TEST SETUP] Container infrastructure verified');
});

test.describe('Workflow Control (Pause, Resume, Stop)', () => {
  test.setTimeout(300000); // 5 minutes per test
  const MODEL_VALUE = 'fake/fake-model'

  test.beforeEach(async ({ page }) => {
    await gotoKanban(page)
    await configureWorkflowDefaults(page)
  });

  test.afterEach(async ({ page }) => {
    await ensureIdleState(page)
  });

  async function configureWorkflowDefaults(page: Page): Promise<void> {
    await page.getByRole('tab', { name: 'Options' }).click()
    await expect(page.getByRole('heading', { name: 'Options Configuration' })).toBeVisible({ timeout: 10000 })

    await setModelPickerValue(page, 'Plan Model (global)', MODEL_VALUE)
    await setModelPickerValue(page, 'Execution Model (global)', MODEL_VALUE)
    await setModelPickerValue(page, 'Review Model', MODEL_VALUE)
    await setModelPickerValue(page, 'Repair Model', MODEL_VALUE)
    await setNumericOption(page, 'Parallel Tasks', '1')
    await setCheckboxState(page, 'Show execution graph before starting workflow', true)

    await page.locator('button').filter({ hasText: 'Save Options' }).last().click()
    await expect(page.getByText('Options saved successfully')).toBeVisible({ timeout: 10000 })
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 10000 })
  }

  async function setModelPickerValue(page: Page, labelText: string, value: string): Promise<void> {
    const group = page.locator('.form-group').filter({ hasText: labelText }).first()
    const input = group.locator('input.form-input').first()
    await expect(input).toBeVisible({ timeout: 10000 })
    await input.click()
    await input.fill(value)

    const suggestion = group.locator('.absolute > div').first()
    await expect(suggestion).toBeVisible({ timeout: 10000 })
    await suggestion.click()
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

  async function createWorkflowChain(page: Page, prefix: string): Promise<void> {
    const workflowStem = `workflow-control-${Date.now()}`
    const firstTaskName = `${workflowStem}-1`
    const secondTaskName = `${workflowStem}-2`
    const thirdTaskName = `${workflowStem}-3`
    const workflowFileStem = `${workflowStem}-file`

    await createTaskViaUI(page, {
      name: firstTaskName,
      prompt: `Create a file named ${workflowFileStem}.txt with content "workflow step 1".`,
      review: false,
    })

    await createTaskViaUI(page, {
      name: secondTaskName,
      prompt: `Append "workflow step 2" to ${workflowFileStem}.txt.`,
      review: false,
      requirements: [firstTaskName],
    })

    await createTaskViaUI(page, {
      name: thirdTaskName,
      prompt: `Append "workflow step 3" to ${workflowFileStem}.txt.`,
      review: false,
      requirements: [secondTaskName],
    })
  }

  async function startWorkflowViaUI(page: Page): Promise<void> {
    const startButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' }).first()
    await expect(startButton).toBeVisible({ timeout: 15000 })
    await expect(startButton).toBeEnabled({ timeout: 15000 })
    await startButton.click()
    await confirmExecutionGraph(page)
  }

  async function confirmExecutionGraph(page: Page): Promise<void> {
    const heading = page.getByRole('heading', { name: 'Execution Graph Preview' })
    await expect(heading).toBeVisible({ timeout: 20000 })
    const confirmButton = page.getByRole('button', { name: 'Confirm & Start' })
    await expect(confirmButton).toBeEnabled({ timeout: 10000 })
    await confirmButton.click()
    await expect(heading).not.toBeVisible({ timeout: 10000 })
  }

  async function waitForRunControls(page: Page): Promise<void> {
    const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' }).first()
    const stopButton = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' }).first()

    await expect.poll(async () => {
      const pauseEnabled = await pauseButton.isEnabled().catch(() => false)
      const stopEnabled = await stopButton.isEnabled().catch(() => false)
      return pauseEnabled || stopEnabled
    }, { timeout: 20000 }).toBe(true)
  }

  async function openStopModal(page: Page) {
    const stopButton = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' }).first()
    await expect(stopButton).toBeEnabled({ timeout: 20000 })
    await stopButton.click()

    const modal = page.locator('.modal-overlay').last()
    await expect(modal.getByRole('heading', { name: 'Stop Workflow' })).toBeVisible({ timeout: 10000 })
    return modal
  }

  async function ensureIdleState(page: Page): Promise<void> {
    const graphHeading = page.getByRole('heading', { name: 'Execution Graph Preview' })
    const stopButton = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' }).first()
    const startButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' }).first()
    const stopModal = page.locator('.modal-overlay').filter({ has: page.getByRole('heading', { name: 'Stop Workflow' }) }).last()

    if (await graphHeading.isVisible({ timeout: 1000 }).catch(() => false)) {
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(graphHeading).not.toBeVisible({ timeout: 10000 })
      return
    }

    await expect.poll(async () => {
      if (await stopModal.isVisible().catch(() => false)) return 'stop-modal'
      if (await stopButton.isEnabled().catch(() => false)) return 'stoppable'
      if (await startButton.isEnabled().catch(() => false)) return 'idle'
      return 'pending'
    }, { timeout: 30000 }).not.toBe('pending')

    if (await stopModal.isVisible().catch(() => false)) {
      await stopModal.locator('button.btn-danger').first().click()
      await expect(stopModal).not.toBeVisible({ timeout: 10000 })
      await expect.poll(async () => startButton.isEnabled().catch(() => false), { timeout: 30000 }).toBe(true)
      return
    }

    if (await stopButton.isEnabled().catch(() => false)) {
      const modal = await openStopModal(page)
      await modal.locator('button').filter({ hasText: 'STOP' }).first().click()
      await expect.poll(async () => startButton.isEnabled().catch(() => false), { timeout: 30000 }).toBe(true)
      return
    }

    await expect.poll(async () => startButton.isEnabled().catch(() => false), { timeout: 30000 }).toBe(true)
  }

  test('pause button is visible when workflow is running', async ({ page }) => {
    await createWorkflowChain(page, `pause-${Date.now()}`)
    await startWorkflowViaUI(page)
    await waitForRunControls(page)
    await expect(page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' }).first()).toBeVisible({ timeout: 10000 })
  });

  test('stop button opens confirmation modal with graceful and destructive options', async ({ page }) => {
    await createWorkflowChain(page, `stop-modal-${Date.now()}`)
    await startWorkflowViaUI(page)
    await waitForRunControls(page)

    const modal = await openStopModal(page)
    await expect(modal.locator('button').filter({ hasText: 'PAUSE' }).first()).toBeVisible({ timeout: 5000 })
    await expect(modal.locator('button').filter({ hasText: 'STOP' }).first()).toBeVisible({ timeout: 5000 })

    await modal.locator('button.icon-btn').click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })
  });

  test('graceful stop stops workflow and preserves state', async ({ page }) => {
    await createWorkflowChain(page, `graceful-${Date.now()}`)
    await startWorkflowViaUI(page)
    await waitForRunControls(page)

    const modal = await openStopModal(page)
    await modal.locator('button').filter({ hasText: 'PAUSE' }).first().click()

    await expect(page.locator('.animate-slide-in').filter({ hasText: 'Workflow paused gracefully - work preserved' }).first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Resume' }).first()).toBeVisible({ timeout: 20000 })
  });

  test('destructive stop option is available and properly labeled', async ({ page }) => {
    await createWorkflowChain(page, `destructive-${Date.now()}`)
    await startWorkflowViaUI(page)
    await waitForRunControls(page)

    const modal = await openStopModal(page)
    const destructiveOption = modal.locator('button.btn-danger').first()
    await expect(destructiveOption).toBeVisible({ timeout: 5000 })
    await expect(destructiveOption).toContainText('Kills containers')
    await expect(destructiveOption).toContainText('Data loss risk')

    await modal.locator('button.icon-btn').click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })
  });

  test('workflow control buttons change state correctly', async ({ page }) => {
    const workflowName = `state-${Date.now()}`
    await createWorkflowChain(page, workflowName)
    await startWorkflowViaUI(page)
    await waitForRunControls(page)

    const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' }).first()
    await expect(pauseButton).toBeVisible({ timeout: 10000 })
    await pauseButton.click()

    const resumeButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Resume' }).first()
    await expect(resumeButton).toBeVisible({ timeout: 15000 })
    await resumeButton.click()

    await expect(page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' }).first()).toBeVisible({ timeout: 15000 })
  });

  test('stop modal can be closed via overlay click', async ({ page }) => {
    await createWorkflowChain(page, `overlay-${Date.now()}`)
    await startWorkflowViaUI(page)
    await waitForRunControls(page)

    const modal = await openStopModal(page)
    await modal.click({ position: { x: 5, y: 5 } })
    await expect(modal).not.toBeVisible({ timeout: 5000 })
  });

  test('sidebar shows workflow control section during execution', async ({ page }) => {
    await createWorkflowChain(page, `run-info-${Date.now()}`)
    await startWorkflowViaUI(page)
    await waitForRunControls(page)

    const sidebar = page.locator('.sidebar')
    await expect(sidebar).toBeVisible({ timeout: 10000 })
    await expect(sidebar.getByText('Workflow Control')).toBeVisible({ timeout: 10000 })
    await expect(sidebar.locator('button.sidebar-btn.warning').filter({ hasText: 'Pause' }).first()).toBeVisible({ timeout: 10000 })
  });
});
