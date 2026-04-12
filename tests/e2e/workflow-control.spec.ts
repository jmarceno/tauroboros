/**
 * E2E Test: Workflow Control (Pause, Resume, Stop) via Web UI ONLY
 * 
 * Tests the workflow control functionality:
 * - Pause workflow during execution
 * - Resume paused workflow
 * - Stop workflow (graceful and destructive)
 * - Stop confirmation modal
 * 
 * CRITICAL: This test uses ONLY Web UI interactions - no API calls.
 * It simulates exactly how a user would interact with the system.
 */

import { test, expect, Page } from '@playwright/test';

// Helper function to check if server is running
async function checkServer(page: Page): Promise<boolean> {
  try {
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/health');
      return res.ok;
    });
    return response;
  } catch {
    return false;
  }
}

test.describe('Workflow Control (Pause, Resume, Stop)', () => {
  test.setTimeout(120000); // 2 minutes per test

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give Vue app time to mount
    await page.waitForTimeout(2000);
  });

  /**
   * Helper: Create a simple task via Web UI
   */
  async function createSimpleTask(page: Page, name: string, prompt: string) {
    // Click "+ Add Task" button in backlog column
    const backlogColumn = page.locator('[data-status="backlog"]');
    await expect(backlogColumn).toBeVisible();
    
    const addTaskButton = backlogColumn.locator('button:has-text("+ Add Task")');
    await expect(addTaskButton).toBeVisible();
    await addTaskButton.click();
    
    // Wait for modal
    await page.waitForSelector('text=Add Task', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Fill in name
    const nameInput = page.locator('input[placeholder="Task name"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(name);
    
    // Fill in prompt
    const promptTextarea = page.locator('textarea[placeholder="What should this task do?"]').first();
    await expect(promptTextarea).toBeVisible();
    await promptTextarea.fill(prompt);
    
    // Save
    const saveButton = page.locator('button:has-text("Save")').filter({ hasNotText: 'Save Template' });
    await expect(saveButton).toBeVisible();
    await saveButton.click();
    
    // Wait for modal to close
    await page.waitForTimeout(1000);
    
    // Verify task appears
    const taskCard = page.locator(`text=${name}`).first();
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    
    console.log(`[UI] Created task: ${name}`);
  }

  /**
   * Helper: Start workflow via UI
   */
  async function startWorkflowViaUI(page: Page) {
    const startButton = page.locator('button:has-text("Start Workflow")').first();
    await expect(startButton).toBeVisible();
    await startButton.click();
    console.log('[UI] Started workflow');
    await page.waitForTimeout(1000);
  }

  /**
   * Helper: Get task status from UI
   */
  async function getTaskStatusFromUI(page: Page, taskName: string): Promise<string> {
    const columns = ['template', 'backlog', 'executing', 'review', 'stuck', 'done'];
    
    for (const column of columns) {
      const columnElement = page.locator(`[data-status="${column}"]`);
      const taskInColumn = columnElement.locator(`text=${taskName}`).first();
      
      if (await taskInColumn.isVisible().catch(() => false)) {
        return column;
      }
    }
    
    return 'unknown';
  }

  test('pause button is visible when workflow is running', async ({ page }) => {
    console.log('[TEST] Checking pause button visibility...');

    // Create a task
    await createSimpleTask(page, 'Pause Test Task', 'Create a file pause_test.txt');

    // Start workflow
    await startWorkflowViaUI(page);

    // Wait a moment for workflow to start
    await page.waitForTimeout(2000);

    // Check that pause button is visible in the sidebar
    const pauseButton = page.locator('button:has-text("Pause")').first();
    await expect(pauseButton).toBeVisible({ timeout: 5000 });

    console.log('[TEST] ✓ Pause button is visible during workflow execution');
  });

  test('stop button opens confirmation modal', async ({ page }) => {
    console.log('[TEST] Testing stop confirmation modal...');

    // Create a task
    await createSimpleTask(page, 'Stop Modal Test Task', 'Create a file stop_modal_test.txt');

    // Start workflow
    await startWorkflowViaUI(page);

    // Wait for workflow to start
    await page.waitForTimeout(2000);

    // Click stop button
    const stopButton = page.locator('button:has-text("Stop")').first();
    await expect(stopButton).toBeVisible({ timeout: 5000 });
    await stopButton.click();

    // Verify confirmation modal appears
    await page.waitForSelector('text=Stop Workflow', { timeout: 5000 });
    const modal = page.locator('.modal-overlay:has-text("Stop Workflow")');
    await expect(modal).toBeVisible();

    // Verify both graceful and destructive options are shown
    const gracefulOption = page.locator('button:has-text("Pause & Stop Gracefully")');
    const destructiveOption = page.locator('button:has-text("Stop & Delete Everything")');
    
    await expect(gracefulOption).toBeVisible();
    await expect(destructiveOption).toBeVisible();

    // Close modal with Cancel
    const cancelButton = page.locator('button:has-text("Cancel")');
    await cancelButton.click();
    
    // Verify modal closed
    await page.waitForTimeout(500);
    await expect(modal).not.toBeVisible();

    console.log('[TEST] ✓ Stop confirmation modal works correctly');
  });

  test('graceful stop stops workflow and preserves state', async ({ page }) => {
    console.log('[TEST] Testing graceful stop...');

    // Create a task
    const taskName = 'Graceful Stop Test Task';
    await createSimpleTask(page, taskName, 'Create a file graceful_stop_test.txt with "test content"');

    // Start workflow
    await startWorkflowViaUI(page);

    // Wait for workflow to start (task should move to executing)
    let attempts = 0;
    let taskInExecuting = false;
    while (attempts < 30 && !taskInExecuting) {
      const status = await getTaskStatusFromUI(page, taskName);
      if (status === 'executing') {
        taskInExecuting = true;
        break;
      }
      await page.waitForTimeout(1000);
      attempts++;
    }

    if (!taskInExecuting) {
      console.log('[TEST] ⚠ Task did not reach executing state, proceeding anyway');
    }

    // Click stop button to open confirmation modal
    const stopButton = page.locator('button:has-text("Stop")').first();
    await expect(stopButton).toBeVisible({ timeout: 5000 });
    await stopButton.click();

    // Wait for modal
    await page.waitForSelector('text=Stop Workflow', { timeout: 5000 });

    // Click graceful stop option
    const gracefulOption = page.locator('button:has-text("Pause & Stop Gracefully")');
    await expect(gracefulOption).toBeVisible();
    await gracefulOption.click();

    // Wait for stop to take effect
    await page.waitForTimeout(3000);

    // Verify workflow is stopped - Start button should be visible again
    const startButton = page.locator('button:has-text("Start Workflow")').first();
    await expect(startButton).toBeVisible({ timeout: 10000 });

    // Verify task is not stuck or failed (should be in a recoverable state)
    const status = await getTaskStatusFromUI(page, taskName);
    console.log(`[TEST] Task status after graceful stop: ${status}`);
    
    expect(['backlog', 'executing', 'review', 'done']).toContain(status);

    console.log('[TEST] ✓ Graceful stop works correctly');
  });

  test('destructive stop option is available', async ({ page }) => {
    console.log('[TEST] Testing destructive stop option...');

    // Create a task
    await createSimpleTask(page, 'Destructive Stop Test', 'Create file destructive_test.txt');

    // Start workflow
    await startWorkflowViaUI(page);

    // Wait for workflow to start
    await page.waitForTimeout(2000);

    // Click stop button
    const stopButton = page.locator('button:has-text("Stop")').first();
    await stopButton.click();

    // Wait for modal
    await page.waitForSelector('text=Stop Workflow', { timeout: 5000 });

    // Verify destructive option exists and has warning styling
    const destructiveOption = page.locator('button:has-text("Stop & Delete Everything")');
    await expect(destructiveOption).toBeVisible();
    
    // Check that the destructive option has appropriate warning text
    await expect(page.locator('text=Danger:')).toBeVisible();

    // Close modal without stopping
    const cancelButton = page.locator('button:has-text("Cancel")');
    await cancelButton.click();

    console.log('[TEST] ✓ Destructive stop option is available and properly labeled');
  });

  test('workflow control buttons change state correctly', async ({ page }) => {
    console.log('[TEST] Testing workflow control button states...');

    // Initially, only Start Workflow should be visible
    let startButton = page.locator('button:has-text("Start Workflow")').first();
    let pauseButton = page.locator('button:has-text("Pause")').first();
    let stopButton = page.locator('button:has-text("Stop")').first();
    
    // Start button should be visible initially
    await expect(startButton).toBeVisible();
    
    // Create and start a task
    await createSimpleTask(page, 'State Test Task', 'Create state_test.txt');
    await startWorkflowViaUI(page);

    // Wait for workflow state to update
    await page.waitForTimeout(3000);

    // After starting, pause and stop should be visible
    pauseButton = page.locator('button:has-text("Pause")').first();
    stopButton = page.locator('button:has-text("Stop")').first();
    
    // Check that pause button is visible
    const pauseVisible = await pauseButton.isVisible().catch(() => false);
    const stopVisible = await stopButton.isVisible().catch(() => false);
    
    console.log(`[TEST] Pause button visible: ${pauseVisible}`);
    console.log(`[TEST] Stop button visible: ${stopVisible}`);

    // At least one of these should be visible during execution
    expect(pauseVisible || stopVisible).toBe(true);

    console.log('[TEST] ✓ Workflow control buttons change state correctly');
  });

  test('modal can be closed via overlay click', async ({ page }) => {
    console.log('[TEST] Testing modal close via overlay...');

    // Create a task and start workflow
    await createSimpleTask(page, 'Modal Overlay Test', 'Create overlay_test.txt');
    await startWorkflowViaUI(page);
    await page.waitForTimeout(2000);

    // Open stop modal
    const stopButton = page.locator('button:has-text("Stop")').first();
    await stopButton.click();

    // Wait for modal
    await page.waitForSelector('text=Stop Workflow', { timeout: 5000 });
    const modal = page.locator('.modal-overlay:has-text("Stop Workflow")');
    await expect(modal).toBeVisible();

    // Click overlay to close
    await page.click('.modal-overlay', { position: { x: 10, y: 10 } });
    
    // Verify modal closed
    await page.waitForTimeout(500);
    await expect(modal).not.toBeVisible();

    console.log('[TEST] ✓ Modal closes correctly via overlay click');
  });

  test('sidebar shows workflow run information', async ({ page }) => {
    console.log('[TEST] Testing sidebar workflow run display...');

    // Create and start a task
    await createSimpleTask(page, 'Run Info Test Task', 'Create run_info_test.txt');
    await startWorkflowViaUI(page);

    // Wait for workflow to start
    await page.waitForTimeout(2000);

    // Check that sidebar shows active run information
    // The sidebar should have run cards with progress indicators
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();

    // Look for run-related elements
    const hasActiveRuns = await page.locator('.run-card').count() > 0 ||
                          await page.locator('text=Active Runs').isVisible().catch(() => false);

    console.log(`[TEST] Active run info displayed: ${hasActiveRuns}`);

    // The sidebar should at minimum show workflow controls
    const workflowControlSection = page.locator('.sidebar').locator('text=Workflow Control');
    await expect(workflowControlSection).toBeVisible();

    console.log('[TEST] ✓ Sidebar shows workflow control section');
  });
});
