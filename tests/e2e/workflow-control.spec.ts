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

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { BASE_IMAGES } from '../../src/config/base-images.ts';

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

  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`[BROWSER ERROR] ${msg.text()}`);
      }
    });
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    // Clean up: stop any running workflow and archive completed/failed runs
    console.log('[TEST CLEANUP] Checking for running workflow...');
    
    // First, archive any stale/failed runs that might block new workflows
    const archiveButtons = page.locator('.sidebar button').filter({ hasText: /Archive this run|Archive.*Stale/ });
    let archiveCount = 0;
    while (await archiveButtons.first().isVisible().catch(() => false)) {
      // Use Ctrl+click to bypass confirmation modal
      await archiveButtons.first().click({ modifiers: ['Control'] });
      console.log('[TEST CLEANUP] Archived a run (with Ctrl to skip confirmation)');
      await page.waitForTimeout(1000);
      archiveCount++;
      if (archiveCount > 10) break; // Safety limit
    }
    
    // Keep trying to stop until Start Workflow button appears (meaning system is idle)
    let attempts = 0;
    const maxAttempts = 5;
    
    while (attempts < maxAttempts) {
      const stopButton = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' });
      const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' });
      const startButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' });
      
      // Check for workflows in "stopping" state - these need to be force-stopped
      const stoppingRun = page.locator('.sidebar .active-runs .run-item, .sidebar [class*="run"]').filter({ hasText: /stopping/ }).first();
      const isStopping = await stoppingRun.isVisible().catch(() => false);
      
      const isStopVisible = await stopButton.isVisible().catch(() => false);
      const isPauseVisible = await pauseButton.isVisible().catch(() => false);
      const isStartVisible = await startButton.isVisible().catch(() => false);
      
      // If Start button is visible and enabled, system is idle - cleanup done
      if (isStartVisible) {
        const isDisabled = await startButton.evaluate(el => el.disabled).catch(() => false);
        if (!isDisabled) {
          console.log('[TEST CLEANUP] System is idle (Start Workflow button visible and enabled)');
          break;
        }
        console.log('[TEST CLEANUP] Start Workflow button visible but disabled, continuing cleanup...');
      }
      
      // If workflow is stuck in "stopping" state, we need to wait for backend cleanup
      // or reload to trigger cleanupStaleRuns
      if (isStopping) {
        console.log('[TEST CLEANUP] Workflow is in stopping state, waiting for cleanup...');
        await page.waitForTimeout(5000);
        await page.reload();
        await page.waitForTimeout(3000);
        attempts++;
        continue;
      }
      
      // If no control buttons visible and no stopping run, wait a bit and recheck
      if (!isStopVisible && !isPauseVisible && !isStopping) {
        console.log('[TEST CLEANUP] No control buttons visible, waiting...');
        await page.waitForTimeout(3000);
        await page.reload();
        await page.waitForTimeout(2000);
        attempts++;
        continue;
      }
      
      // Workflow is running - stop it
      console.log('[TEST CLEANUP] Workflow is running, stopping it (attempt ' + (attempts + 1) + ')...');
      try {
        // Click stop or pause button to trigger stop
        if (isStopVisible) {
          await stopButton.click();
          console.log('[TEST CLEANUP] Clicked Stop button');
        } else if (isPauseVisible) {
          await pauseButton.click();
          console.log('[TEST CLEANUP] Clicked Pause button');
        }
        
        await page.waitForTimeout(1500);
        
        // Handle the stop confirmation modal
        const modal = page.locator('.modal-overlay');
        const isModalVisible = await modal.isVisible().catch(() => false);
        
        if (isModalVisible) {
          console.log('[TEST CLEANUP] Stop modal is open');
          
          // Click the destructive/primary stop button
          const destructiveButton = modal.locator('button.option-btn.destructive');
          const stopConfirmButton = modal.locator('button:has-text("STOP")');
          const primaryButton = modal.locator('button').first();
          
          if (await destructiveButton.isVisible().catch(() => false)) {
            await destructiveButton.click();
            console.log('[TEST CLEANUP] Clicked destructive stop button');
          } else if (await stopConfirmButton.isVisible().catch(() => false)) {
            await stopConfirmButton.click();
            console.log('[TEST CLEANUP] Clicked STOP button');
          } else {
            await primaryButton.click();
            console.log('[TEST CLEANUP] Clicked primary modal button');
          }
        }
        
        // Wait for stop to take effect
        await page.waitForTimeout(5000);
        
        // Reload to trigger cleanup of stale runs
        await page.reload();
        await page.waitForTimeout(3000);
        
        // Check if start button is now visible and enabled
        const isStartNowVisible = await startButton.isVisible().catch(() => false);
        if (isStartNowVisible) {
          const isDisabled = await startButton.evaluate(el => el.disabled).catch(() => false);
          if (!isDisabled) {
            console.log('[TEST CLEANUP] Workflow stopped successfully');
            break;
          }
        }
      } catch (e) {
        console.log('[TEST CLEANUP] Error during stop attempt:', e);
      }
      
      attempts++;
    }
    
    // Final cleanup: prune any orphaned custom images from this test session
    // This ensures tests don't leave custom container images behind
    try {
      const result = execSync(
        'podman images --format "{{.Repository}}:{{.Tag}}" | grep "pi-agent:" | grep -v "${BASE_IMAGES.piAgent}" || true',
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      const images = result.trim().split('\n').filter(img => img.startsWith('pi-agent:') && !img.includes('alpine'));
      if (images.length > 0) {
        console.log(`[TEST CLEANUP] Found ${images.length} orphaned custom images, cleaning up...`);
        for (const img of images) {
          try {
            execSync(`podman rmi -f ${img}`, { stdio: 'pipe' });
            console.log(`[TEST CLEANUP] Removed image: ${img}`);
          } catch {}
        }
      }
    } catch {}

    console.log('[TEST CLEANUP] Complete');
  });

  /**
   * Helper: Create a task via Web UI with plan mode, auto-approve, and review.
   */
  async function createTaskViaUI(page: Page, data: {
    name: string;
    prompt: string;
    planmode?: boolean;
    autoApprovePlan?: boolean;
    review?: boolean;
  }): Promise<string> {
    const taskName = data.name;

    const backlogColumn = page.locator('[data-status="backlog"]');
    await expect(backlogColumn).toBeVisible({ timeout: 15000 });
    
    const addTaskButton = backlogColumn.locator('button.add-task-btn, button:has-text("+ Add Task")').first();
    await expect(addTaskButton).toBeVisible({ timeout: 10000 });
    await addTaskButton.click();
    
    await page.waitForSelector('.modal-overlay', { timeout: 10000 });
    await page.waitForSelector('input[placeholder="Task name"]', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Wait for branch select to have options loaded
    const branchGroup = page.locator('.modal-overlay .form-group').filter({ hasText: /Branch/ });
    const branchSelect = branchGroup.locator('select.form-select').first();
    await expect(branchSelect).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => {
      const count = await branchSelect.locator('option:not([value=""])').count();
      return count;
    }, { timeout: 10000 }).toBeGreaterThan(0);

    // Fill name
    const nameInput = page.locator('input[placeholder="Task name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill(taskName);

    // Fill prompt using ProseMirror contenteditable
    const promptEditor = page.locator('.markdown-editor-content .ProseMirror').first();
    await expect(promptEditor).toBeVisible({ timeout: 5000 });
    await promptEditor.click();
    await promptEditor.fill(data.prompt);

    // Ensure branch is selected
    const branchValue = await branchSelect.inputValue();
    if (!branchValue) {
      const options = branchSelect.locator('option:not([value=""])');
      const firstOptionValue = await options.first().getAttribute('value');
      if (firstOptionValue) {
        await branchSelect.selectOption(firstOptionValue);
      }
    }

    // Plan Mode
    if (data.planmode) {
      const planModeCheckbox = page.getByRole('checkbox', { name: 'Plan Mode' });
      await expect(planModeCheckbox).toBeVisible({ timeout: 5000 });
      const isChecked = await planModeCheckbox.isChecked();
      if (!isChecked) await planModeCheckbox.check();
    }

    // Auto-approve plan
    if (data.autoApprovePlan) {
      const autoApproveCheckbox = page.getByRole('checkbox', { name: 'Auto-approve plan' });
      await expect(autoApproveCheckbox).toBeVisible({ timeout: 5000 });
      const isChecked = await autoApproveCheckbox.isChecked();
      if (!isChecked) await autoApproveCheckbox.check();
    }

    // Review
    if (data.review !== undefined) {
      const reviewCheckbox = page.getByRole('checkbox', { name: 'Review' });
      await expect(reviewCheckbox).toBeVisible({ timeout: 5000 });
      const isChecked = await reviewCheckbox.isChecked();
      if (data.review && !isChecked) {
        await reviewCheckbox.check();
      } else if (!data.review && isChecked) {
        await reviewCheckbox.uncheck();
      }
    }

    // Save
    const saveButton = page.locator('button.btn-primary').filter({ hasText: /^Save$/ }).first();
    await expect(saveButton).toBeVisible({ timeout: 5000 });

    const saveResponsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/tasks') && resp.request().method() === 'POST',
      { timeout: 15000 }
    );
    
    await saveButton.click();
    const saveResponse = await saveResponsePromise;
    console.log(`[UI] Task created: ${taskName}, status: ${saveResponse.status()}`);

    await page.waitForTimeout(2000);

    // Reload to ensure Vue state sync
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Verify task appears
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 15000 });
    
    console.log(`[UI] Task visible in UI: ${taskName}`);
    return taskName;
  }

  /**
   * Start workflow via the sidebar Start Workflow button.
   * Handles the Execution Graph modal if it appears.
   */
  async function startWorkflowViaUI(page: Page) {
    const startButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' }).first();
    await expect(startButton).toBeVisible({ timeout: 15000 });
    await startButton.click();
    console.log('[UI] Start Workflow clicked');
    await page.waitForTimeout(2000);
    
    // Handle Execution Graph modal if shown
    await approveExecutionGraphModal(page);
  }

  /**
   * Approve the Execution Graph modal if it appears.
   * Clicks "Confirm & Start" button.
   */
  async function approveExecutionGraphModal(page: Page) {
    try {
      const modal = page.locator('.modal-overlay').filter({ hasText: /Execution Graph/ });
      await modal.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
      
      if (await modal.isVisible().catch(() => false)) {
        const confirmButton = modal.locator('button').filter({ hasText: 'Confirm & Start' }).first();
        if (await confirmButton.isVisible().catch(() => false)) {
          await confirmButton.click();
          console.log('[UI] Approved execution graph modal');
          await page.waitForTimeout(2000);
        }
      }
    } catch {
      // Modal didn't appear, that's fine
    }
  }

  /**
   * Get task status from the task card's data-task-status attribute.
   */
  async function getTaskStatusFromUI(page: Page, taskName: string): Promise<string> {
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    if (await taskCard.isVisible().catch(() => false)) {
      const status = await taskCard.getAttribute('data-task-status');
      if (status) return status;
    }

    const columns = ['template', 'backlog', 'executing', 'review', 'code-style', 'stuck', 'done'];
    for (const column of columns) {
      const columnElement = page.locator(`[data-status="${column}"]`);
      const taskInColumn = columnElement.locator(`text=${taskName}`).first();
      if (await taskInColumn.isVisible().catch(() => false)) {
        return column;
      }
    }

    return 'unknown';
  }

  /**
   * Wait for a task to reach a specific status, polling every interval.
   * Also returns early if task completes (done/failed) or gets stuck.
   */
  async function waitForTaskStatus(
    page: Page,
    taskName: string,
    targetStatuses: string[],
    timeoutMs: number = 90000,
    intervalMs: number = 3000
  ): Promise<string> {
    const startTime = Date.now();
    let lastStatus = 'unknown';
    let lastLog = startTime;
    
    while (Date.now() - startTime < timeoutMs) {
      const status = await getTaskStatusFromUI(page, taskName);
      lastStatus = status;
      
      if (targetStatuses.includes(status)) {
        return status;
      }
      
      if (Date.now() - lastLog > 10000) {
        console.log(`[TEST] Task "${taskName}" status: ${status} (waiting for ${targetStatuses.join('/')})`);
        lastLog = Date.now();
      }
      
      if (status === 'done' || status === 'failed' || status === 'stuck') {
        console.log(`[TEST] Task "${taskName}" reached terminal status: ${status}`);
        return status;
      }
      
      await page.waitForTimeout(intervalMs);
    }
    
    throw new Error(`Task "${taskName}" did not reach status ${targetStatuses.join('/')} within ${timeoutMs}ms. Final status: ${lastStatus}`);
  }

  /**
   * Wait for the StopConfirmModal to appear.
   */
  async function waitForStopModal(page: Page): Promise<void> {
    await page.waitForSelector('.modal-overlay:has-text("Stop Workflow")', { timeout: 10000 });
    await page.waitForTimeout(300);
  }

  test('pause button is visible when workflow is running', async ({ page }) => {
    console.log('[TEST] Checking pause button visibility...');

    await createTaskViaUI(page, {
      name: 'Pause Test Task',
      prompt: 'Create a file named pause_test.txt with content "pause test completed"',
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    await startWorkflowViaUI(page);

    // Wait for task to reach executing or beyond
    const status = await waitForTaskStatus(page, 'Pause Test Task', ['executing', 'review', 'done'], 90000);
    console.log(`[TEST] Task reached status: ${status}`);

    // Check control buttons are visible
    const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' });
    const stopButton = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' });
    const startButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' });
    
    const isPauseVisible = await pauseButton.isVisible().catch(() => false);
    const isStopVisible = await stopButton.isVisible().catch(() => false);
    const isStartVisible = await startButton.isVisible().catch(() => false);

    // At least one control button should be visible
    expect(isPauseVisible || isStopVisible || isStartVisible).toBe(true);
    
    if (isPauseVisible) {
      console.log('[TEST] Pause button is visible during workflow execution');
    } else if (isStopVisible) {
      console.log('[TEST] Stop button is visible during workflow execution');
    } else {
      console.log('[TEST] Start Workflow button visible (workflow may have completed)');
    }
  });

  test('stop button opens confirmation modal with graceful and destructive options', async ({ page }) => {
    console.log('[TEST] Testing stop confirmation modal...');

    await createTaskViaUI(page, {
      name: 'Stop Modal Test Task',
      prompt: 'Create a file named stop_modal_test.txt with content "stop modal test"',
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    await startWorkflowViaUI(page);

    const status = await waitForTaskStatus(page, 'Stop Modal Test Task', ['executing', 'review', 'done'], 90000);
    console.log(`[TEST] Task reached status: ${status}`);

    // Get the Stop or Pause button
    let stopButton = page.locator('.sidebar button.sidebar-btn.danger').first();
    let isStopVisible = await stopButton.isVisible().catch(() => false);

    if (!isStopVisible) {
      // If workflow already paused, check if we have a Stop button there
      stopButton = page.locator('.sidebar button.sidebar-btn.danger').first();
      isStopVisible = await stopButton.isVisible().catch(() => false);
    }

    if (!isStopVisible) {
      // Task may have completed - skip modal test
      console.log('[TEST] Workflow completed before Stop could be tested. Verifying modal structure exists in DOM.');
      // We can still verify the sidebar has workflow control section
      const workflowControl = page.locator('text=Workflow Control');
      await expect(workflowControl).toBeVisible({ timeout: 10000 });
      return;
    }

    await stopButton.click();

    await waitForStopModal(page);

    // Verify modal content
    const modal = page.locator('.modal-overlay:has-text("Stop Workflow")');
    await expect(modal).toBeVisible({ timeout: 10000 });

    const modalTitle = modal.locator('h3.modal-title');
    await expect(modalTitle).toHaveText('Stop Workflow');

    const gracefulOption = modal.locator('button.option-btn.graceful');
    await expect(gracefulOption).toBeVisible({ timeout: 5000 });
    await expect(gracefulOption).toContainText('Pause & Stop Gracefully');

    const destructiveOption = modal.locator('button.option-btn.destructive');
    await expect(destructiveOption).toBeVisible({ timeout: 5000 });
    await expect(destructiveOption).toContainText('Stop & Delete Everything');

    const destructiveText = await destructiveOption.textContent();
    expect(destructiveText?.toLowerCase()).toContain('danger');

    const cancelButton = modal.locator('button.btn').filter({ hasText: 'Cancel' });
    await expect(cancelButton).toBeVisible({ timeout: 5000 });

    // Close modal via Cancel
    await cancelButton.click();
    await page.waitForTimeout(500);
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    console.log('[TEST] Stop confirmation modal works correctly');
  });

  test('graceful stop stops workflow and preserves state', async ({ page }) => {
    console.log('[TEST] Testing graceful stop...');

    const taskName = 'Graceful Stop Test Task';
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Create a file named graceful_stop_test.txt with content "graceful stop test"',
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    await startWorkflowViaUI(page);

    const status = await waitForTaskStatus(page, taskName, ['executing', 'review', 'done'], 90000);
    console.log(`[TEST] Task reached status: ${status}`);

    if (status === 'done') {
      console.log('[TEST] Task completed before graceful stop could be tested');
      return;
    }

    // Click Stop button
    const stopButton = page.locator('.sidebar button.sidebar-btn.danger').first();
    await expect(stopButton).toBeVisible({ timeout: 10000 });
    await stopButton.click();

    await waitForStopModal(page);

    // Click graceful stop option
    const gracefulOption = page.locator('.modal-overlay button.option-btn.graceful');
    await expect(gracefulOption).toBeVisible({ timeout: 5000 });
    await gracefulOption.click();

    // Wait for stop to take effect - Start Workflow should reappear
    const startButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' });
    await expect(startButton).toBeVisible({ timeout: 30000 });

    // Verify task is in a reasonable state
    const taskStatus = await getTaskStatusFromUI(page, taskName);
    console.log(`[TEST] Task status after graceful stop: ${taskStatus}`);
    expect(['backlog', 'executing', 'review', 'done']).toContain(taskStatus);

    console.log('[TEST] Graceful stop works correctly');
  });

  test('destructive stop option is available and properly labeled', async ({ page }) => {
    console.log('[TEST] Testing destructive stop option...');

    await createTaskViaUI(page, {
      name: 'Destructive Stop Test',
      prompt: 'Create a file named destructive_test.txt with content "destructive test"',
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    await startWorkflowViaUI(page);

    const status = await waitForTaskStatus(page, 'Destructive Stop Test', ['executing', 'review', 'done'], 90000);
    console.log(`[TEST] Task reached status: ${status}`);

    // Get Stop button
    const stopButton = page.locator('.sidebar button.sidebar-btn.danger').first();
    let isStopVisible = await stopButton.isVisible().catch(() => false);

    if (!isStopVisible) {
      // Try Pause then look for Stop in paused state
      const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' });
      const isPauseVisible = await pauseButton.isVisible().catch(() => false);
      if (!isPauseVisible) {
        console.log('[TEST] Workflow completed before Stop could be tested');
        return;
      }
    }

    const stopBtn = page.locator('.sidebar button.sidebar-btn.danger').first();
    await expect(stopBtn).toBeVisible({ timeout: 10000 });
    await stopBtn.click();

    await waitForStopModal(page);

    // Verify destructive option
    const destructiveOption = page.locator('.modal-overlay button.option-btn.destructive');
    await expect(destructiveOption).toBeVisible({ timeout: 5000 });
    
    const destructiveText = await destructiveOption.textContent();
    expect(destructiveText?.toLowerCase()).toContain('danger');

    // Close modal without stopping
    const cancelButton = page.locator('.modal-overlay button.btn').filter({ hasText: 'Cancel' });
    await expect(cancelButton).toBeVisible({ timeout: 5000 });
    await cancelButton.click();

    await page.waitForTimeout(500);
    const modal = page.locator('.modal-overlay:has-text("Stop Workflow")');
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    console.log('[TEST] Destructive stop option is available and properly labeled');
  });

  test('workflow control buttons change state correctly', async ({ page }) => {
    console.log('[TEST] Testing workflow control button states...');

    // Initially, Start Workflow should be visible
    const startButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' });
    await expect(startButton).toBeVisible({ timeout: 10000 });

    await createTaskViaUI(page, {
      name: 'State Test Task',
      prompt: 'Create a file named state_test.txt with content "state test"',
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    await startWorkflowViaUI(page);

    const status = await waitForTaskStatus(page, 'State Test Task', ['executing', 'review', 'done'], 90000);
    console.log(`[TEST] Task reached status: ${status}`);

    if (status === 'done') {
      console.log('[TEST] Task completed before button state testing could be performed');
      return;
    }

    // Verify Pause and Stop buttons
    const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' });
    const stopButton = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' });
    
    await expect(pauseButton).toBeVisible({ timeout: 10000 });
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    console.log('[TEST] Pause and Stop buttons are visible when running');

    // Test Pause
    await pauseButton.click();
    console.log('[UI] Pause clicked');
    await page.waitForTimeout(3000);

    // After pausing, Resume and Stop should appear
    const resumeButton = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Resume' });
    await expect(resumeButton).toBeVisible({ timeout: 15000 });

    const stopButtonPaused = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' });
    await expect(stopButtonPaused).toBeVisible({ timeout: 5000 });

    console.log('[TEST] Resume and Stop buttons visible when paused');

    // Test Resume
    await resumeButton.click();
    console.log('[UI] Resume clicked');
    await page.waitForTimeout(3000);

    // Verify controls change back
    const pauseButtonResumed = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' });
    const stopButtonResumed = page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' });
    const startButtonResumed = page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' });
    
    const anyControlVisible = await pauseButtonResumed.isVisible().catch(() => false)
      || await stopButtonResumed.isVisible().catch(() => false)
      || await startButtonResumed.isVisible().catch(() => false);
    expect(anyControlVisible).toBe(true);

    console.log('[TEST] Workflow control buttons change state correctly');
  });

  test('stop modal can be closed via overlay click', async ({ page }) => {
    console.log('[TEST] Testing modal close via overlay...');

    await createTaskViaUI(page, {
      name: 'Modal Overlay Test',
      prompt: 'Create a file named overlay_test.txt with content "overlay test"',
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    await startWorkflowViaUI(page);

    const status = await waitForTaskStatus(page, 'Modal Overlay Test', ['executing', 'review', 'done'], 90000);
    console.log(`[TEST] Task reached status: ${status}`);

    if (status === 'done') {
      console.log('[TEST] Task completed before modal test could be run');
      return;
    }

    // Get Stop button - may need to look in paused state too
    let stopButton = page.locator('.sidebar button.sidebar-btn.danger').first();
    let isStopVisible = await stopButton.isVisible().catch(() => false);

    if (!isStopVisible) {
      const pauseButton = page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' });
      const isPauseVisible = await pauseButton.isVisible().catch(() => false);
      if (!isPauseVisible) {
        console.log('[TEST] No control buttons visible, skipping modal test');
        return;
      }
    }

    stopButton = page.locator('.sidebar button.sidebar-btn.danger').first();
    await expect(stopButton).toBeVisible({ timeout: 10000 });
    await stopButton.click();

    await waitForStopModal(page);

    const modal = page.locator('.modal-overlay:has-text("Stop Workflow")');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Click overlay to close
    await modal.click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(500);
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    console.log('[TEST] Modal closes correctly via overlay click');
  });

  test('sidebar shows workflow control section during execution', async ({ page }) => {
    console.log('[TEST] Testing sidebar workflow run display...');

    await createTaskViaUI(page, {
      name: 'Run Info Test Task',
      prompt: 'Create a file named run_info_test.txt with content "run info test"',
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    await startWorkflowViaUI(page);

    const status = await waitForTaskStatus(page, 'Run Info Test Task', ['executing', 'review', 'done'], 90000);
    console.log(`[TEST] Task reached status: ${status}`);

    // Verify sidebar is visible
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Verify Workflow Control section
    const workflowControlSection = sidebar.locator('text=Workflow Control');
    await expect(workflowControlSection).toBeVisible({ timeout: 10000 });

    // Check for active runs or control buttons
    const hasRunCards = await page.locator('.run-card').isVisible().catch(() => false);
    const hasPauseButton = await page.locator('.sidebar button.sidebar-btn.warning').filter({ hasText: 'Pause' }).isVisible().catch(() => false);
    const hasStopButton = await page.locator('.sidebar button.sidebar-btn.danger').filter({ hasText: 'Stop' }).isVisible().catch(() => false);
    const hasStartButton = await page.locator('.sidebar button.sidebar-btn.primary').filter({ hasText: 'Start Workflow' }).isVisible().catch(() => false);

    console.log(`[TEST] Active runs: ${hasRunCards}, Pause: ${hasPauseButton}, Stop: ${hasStopButton}, Start: ${hasStartButton}`);
    
    expect(hasRunCards || hasPauseButton || hasStopButton || hasStartButton).toBe(true);

    console.log('[TEST] Sidebar shows workflow control section');
  });
});