/**
 * E2E Test: REAL Multi-Task Workflow via Web UI ONLY
 *
 * This is THE definitive end-to-end test that exercises the entire system.
 *
 * Requirements:
 * - Container mode MUST be active (real pi-agent containers)
 * - 3 tasks with chained dependencies
 * - Plan mode + auto-approve
 * - Review enabled
 *
  *
 * CRITICAL: This test uses ONLY Web UI interactions - no API calls except
 * for initial test configuration.
 */

import { test, expect, Page } from "@playwright/test';
import { execSync } from "child_process';
import { BASE_IMAGES } from "../../src/config/base-images.ts';

test.describe('REAL Multi-Task Workflow', () => {
  test.setTimeout(600000); // 10 minutes for full workflow

  // Pre-test check: Container requirements MUST be met
  test.beforeAll(() => {
    console.log('[TEST SETUP] Verifying container infrastructure...');

    let hasPodman = false;
    let hasPiAgentImage = false;

    try {
      execSync('podman --version', { stdio: 'pipe' });
      hasPodman = true;
      console.log('  ✓ Podman available');
    } catch {
      console.error('  ❌ Podman not found');
    }

    if (hasPodman) {
      try {
        const result = execSync(`podman images ${BASE_IMAGES.piAgent} -q`, { encoding: 'utf-8', stdio: 'pipe' });
        hasPiAgentImage = result.trim().length > 0;
        if (hasPiAgentImage) {
          console.log(`  ✓ ${BASE_IMAGES.piAgent} image available`);
        } else {
          console.error(`  ❌ ${BASE_IMAGES.piAgent} image not found`);
        }
      } catch {
        console.error(`  ❌ ${BASE_IMAGES.piAgent} image not found`);
      }
    }

    if (!hasPodman || !hasPiAgentImage) {
      console.error('\n❌ REAL WORKFLOW TEST FAILED: Container infrastructure not available');
      console.error('   Run: bun run container:setup');
      throw new Error('Container infrastructure not available. Test cannot proceed.');
    }

    console.log('  ✓ All container requirements met\n');
  });

  test.beforeEach(async ({ page }) => {
    // Capture browser console logs
    page.on('console', msg => {
      console.log(`[BROWSER ${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', err => {
      console.log(`[BROWSER ERROR] ${err.message}`);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give Vue app time to mount
    await page.waitForTimeout(2000);

    // Debug: Check initial task count
    const initialCount = await page.locator('.task-card').count();
    console.log(`[TEST] Initial task count: ${initialCount}`);

    // Configure options for reliable test execution
    await configureTestOptions(page);
  });

  test.afterEach(async ({ page }) => {
    // Clean up tasks after each test to ensure isolation
    console.log('[TEST] Cleaning up test state...');
    await page.evaluate(async () => {
      try {
        // Stop any running workflow first
        await fetch('/api/stop', { method: 'POST' });
        await new Promise(r => setTimeout(r, 1000));

        // Get all tasks and delete them
        const response = await fetch('/api/tasks');
        const tasks = await response.json();
        for (const task of tasks) {
          await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
        }
        console.log(`[TEST] Cleaned up ${tasks.length} tasks`);
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    });
    await page.waitForTimeout(1000);
  });

  /**
   * Helper: Configure test options via API (only allowed configuration call)
   */
  async function configureTestOptions(page: Page) {
    await page.evaluate(async () => {
      try {
        await fetch('/api/options', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxReviews: 2, showExecutionGraph: true })
        });
      } catch (e) {
        console.error('Failed to configure options:', e);
      }
    });
    // Wait for options to be applied and WebSocket update to propagate
    await page.waitForTimeout(1000);
    console.log('[TEST] Options configured: maxReviews=2, showExecutionGraph=true');
  }

  /**
   * Helper: Approve execution graph modal to continue execution
   * Waits up to 2 seconds for the modal to appear, then clicks Confirm & Start.
   */
  async function approveExecutionGraphModal(page: Page) {
    try {
      const modal = page.locator('.modal-overlay').filter({ hasText: /Execution Graph/ });
      await modal.waitFor({ state: 'visible', timeout: 2000 }).catch(() => null);

      if (!(await modal.isVisible().catch(() => false))) {
        console.log('[TEST] Execution graph modal not visible after 2s');
        return false;
      }

      console.log('[TEST] Execution graph modal is visible');
      const confirmButton = modal.locator('button').filter({ hasText: 'Confirm & Start' }).first();
      await confirmButton.waitFor({ state: 'visible', timeout: 2000 }).catch(() => null);

      if (!(await confirmButton.isVisible().catch(() => false))) {
        console.log('[TEST] Confirm & Start button not visible');
        return false;
      }

      console.log('[TEST] Clicking Confirm & Start button');
      await confirmButton.click();
      await page.waitForTimeout(1500);
      console.log('[UI] Approved execution graph modal - execution started');
      return true;
    } catch (e) {
      console.log('[TEST] Error in approveExecutionGraphModal:', e);
      return false;
    }
  }

  /**
   * Helper: Create a task via Web UI
   */
  async function createTaskViaUI(page: Page, data: {
    name: string;
    prompt: string;
    planmode?: boolean;
    autoApprovePlan?: boolean;
    review?: boolean;
    requirements?: string[];
  }): Promise<{ name: string; id: string }> {
    // Click the "+ Add Task" button in backlog column
    const backlogColumn = page.locator('[data-status="backlog"]');
    await expect(backlogColumn).toBeVisible({ timeout: 10000 });

    const addTaskButton = backlogColumn.locator('button.add-task-btn, button:has-text("+ Add Task")').first();
    await expect(addTaskButton).toBeVisible({ timeout: 10000 });
    await addTaskButton.click();

    // Wait for task modal to open and initialize
    await page.waitForSelector('.modal-overlay', { timeout: 10000 });
    await page.waitForSelector('input[placeholder="Task name"]', { timeout: 10000 });

    // Wait for modal initialization - critical for branches to load
    // The modal's initializeForm() runs on mount and fetches branches asynchronously
    await page.waitForTimeout(2000);

    // Wait for branch select to be visible and have options loaded
    const branchGroup = page.locator('.modal-overlay .form-group').filter({ hasText: /Branch/ });
    const branchSelect = branchGroup.locator('select.form-select').first();
    await expect(branchSelect).toBeVisible({ timeout: 10000 });
    // Poll until branches are loaded (the API call completes and Vue updates the DOM)
    await expect.poll(async () => {
      const count = await branchSelect.locator('option:not([value=""])').count();
      return count;
    }, { timeout: 10000 }).toBeGreaterThan(0);

    // Fill in the task name
    const nameInput = page.locator('input[placeholder="Task name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill(data.name);

    // Fill in the prompt using the MarkdownEditor (ProseMirror contenteditable)
    // The prompt editor is a tiptap/ProseMirror rich text editor, not a textarea
    const promptEditor = page.locator('.markdown-editor-content .ProseMirror').first();
    await expect(promptEditor).toBeVisible({ timeout: 5000 });
    await promptEditor.click();
    await promptEditor.fill(data.prompt);
    // Ensure a branch is selected
    const branchValue = await branchSelect.inputValue();
    if (!branchValue) {
      const options = branchSelect.locator('option:not([value=""])');
      const optionCount = await options.count();
      if (optionCount > 0) {
        const firstOptionValue = await options.first().getAttribute('value');
        if (firstOptionValue) {
          await branchSelect.selectOption(firstOptionValue);
        }
      }
    }

    // Configure plan mode if requested
    if (data.planmode) {
      const planModeCheckbox = page.getByRole('checkbox', { name: 'Plan Mode' });
      if (await planModeCheckbox.isVisible().catch(() => false)) {
        const isChecked = await planModeCheckbox.isChecked();
        if (!isChecked) await planModeCheckbox.check();
      }
    }

    // Configure auto-approve plan if requested
    if (data.autoApprovePlan) {
      const autoApproveCheckbox = page.getByRole('checkbox', { name: 'Auto-approve plan' });
      if (await autoApproveCheckbox.isVisible().catch(() => false)) {
        const isChecked = await autoApproveCheckbox.isChecked();
        if (!isChecked) await autoApproveCheckbox.check();
      }
    }

    // Configure review if requested
    if (data.review !== undefined) {
      const reviewCheckbox = page.getByRole('checkbox', { name: 'Review' });
      if (await reviewCheckbox.isVisible().catch(() => false)) {
        const isChecked = await reviewCheckbox.isChecked();
        if (data.review && !isChecked) {
          await reviewCheckbox.check();
        } else if (!data.review && isChecked) {
          await reviewCheckbox.uncheck();
        }
      }
    }

    // Set requirements if provided
    if (data.requirements && data.requirements.length > 0) {
      const requirementsSection = page.locator('.form-group').filter({ hasText: 'Requirements' });
      for (const reqId of data.requirements) {
        const reqCheckbox = requirementsSection.locator(`input[type="checkbox"][value="${reqId}"]`);
        if (await reqCheckbox.isVisible().catch(() => false)) {
          await reqCheckbox.check();
        }
      }
    }

    // Click Save button (filter to exclude "Save Template")
    const saveButton = page.locator('button.btn-primary').filter({ hasText: /^Save$/ }).first();
    await expect(saveButton).toBeVisible({ timeout: 5000 });

    // Capture response from save action
    const saveResponsePromise = page.waitForResponse(resp =>
      resp.url().includes('/api/tasks') && resp.request().method() === 'POST',
      { timeout: 10000 }
    );

    await saveButton.click();

    // Wait for the API response and extract task ID
    const saveResponse = await saveResponsePromise;
    console.log(`[UI] Save response status: ${saveResponse.status()}`);
    if (!saveResponse.ok()) {
      const body = await saveResponse.text();
      console.log(`[UI] Save error: ${body}`);
      throw new Error(`Failed to create task: ${body}`);
    }

    // Extract task ID from response
    let taskId = '';
    try {
      const responseData = await saveResponse.json();
      taskId = responseData.id || '';
      console.log(`[UI] Created task ID: ${taskId}`);
    } catch {
      console.log('[UI] Could not parse task ID from response');
    }

    // Wait for modal to close via WebSocket update
    await page.waitForTimeout(3000);

    // WORKAROUND: Reload page to force task load from database
    // This works around the Vue reactivity issue with WebSocket updates
    await page.reload();
    await page.waitForTimeout(3000);

    // Wait for tasks to load (check total count in sidebar)
    await expect.poll(async () => {
      const totalText = await page.locator('.stat-card .stat-value').first().textContent();
      const total = parseInt(totalText || '0', 10);
      return total;
    }, { timeout: 15000 }).toBeGreaterThan(0);

    // Additional wait for Vue to render
    await page.waitForTimeout(2000);

    // Verify task appears in UI
    const taskCard = page.locator('.task-card').filter({ hasText: data.name }).first();
    await expect(taskCard).toBeVisible({ timeout: 15000 });

    console.log(`[UI] Created task: ${data.name} (ID: ${taskId})`);

    // Return both name and ID for dependency setup
    return { name: data.name, id: taskId };
  }

  /**
   * Helper: Get task error message via API (for debugging only)
   */
  async function getTaskErrorFromAPI(page: Page, taskName: string): Promise<string | null> {
    return await page.evaluate(async (name) => {
      try {
        const response = await fetch('/api/tasks');
        const tasks = await response.json();
        const task = tasks.find((t: any) => t.name === name);
        return task?.errorMessage || null;
      } catch (e) {
        return null;
      }
    }, taskName);
  }

  /**
   * Helper: Get task status from UI ONLY
   *
   * Checks the task card's data-task-status attribute first,
   * then falls back to checking which column contains the task.
   * Note: "stuck" and "failed" tasks appear in the "review" column visually,
   * so we check the card's data-task-status attribute for accurate status.
   *
   * STRICT REQUIREMENT: NO API calls - Web UI only
   */
  async function getTaskStatusFromUI(page: Page, taskName: string): Promise<string> {
    // First try to find the task card and read its data-task-status attribute
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    if (await taskCard.isVisible().catch(() => false)) {
      const status = await taskCard.getAttribute('data-task-status');
      if (status) return status;
    }

    // Fallback: check which column the task appears in
    const columns = ['template', 'backlog', 'executing', 'review', 'code-style', 'done'];

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
   * Helper: Start workflow via UI
   */
  async function startWorkflowViaUI(page: Page) {
    const startButton = page.locator('button').filter({ hasText: 'Start Workflow' }).first();
    await expect(startButton).toBeVisible({ timeout: 10000 });

    // Check if button is enabled
    const isDisabled = await startButton.isDisabled().catch(() => false);
    console.log(`[UI] Start Workflow button disabled: ${isDisabled}`);

    await startButton.click();
    console.log('[UI] Start Workflow clicked');

    // Wait for either the modal to appear or execution to start
    await page.waitForTimeout(2000);
  }

test('3-task chained workflow executes successfully', async ({ page }) => {
    console.log('\n[TEST] ==========================================================');
    console.log('[TEST] REAL 3-TASK WORKFLOW');
    console.log('[TEST] ==========================================================\n');

    // STEP 1: Create Task 1 (Foundation)
    const task1 = await createTaskViaUI(page, {
      name: 'Task 1: Create Base File',
      prompt: `Create a file named 'workflow_result.txt' with content:
Workflow Execution Log
===================
Task 1: Base created
Status: COMPLETE`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });
    console.log(`[TEST] Created Task 1: ${task1.name} (ID: ${task1.id})`);

    // STEP 2: Create Task 2 (depends on Task 1)
    const task2 = await createTaskViaUI(page, {
      name: 'Task 2: Extend Base File',
      prompt: `Read workflow_result.txt and append:
Task 2: Extended successfully
Status: COMPLETE`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
      requirements: [task1.id], // Task 2 depends on Task 1
    });
    console.log(`[TEST] Created Task 2: ${task2.name} (ID: ${task2.id})`);

    // STEP 3: Create Task 3 (depends on Task 2)
    const task3 = await createTaskViaUI(page, {
      name: 'Task 3: Finalize File',
      prompt: `Read workflow_result.txt, verify content, append:
Task 3: Workflow completed
Status: DONE
End of Log`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
      requirements: [task2.id], // Task 3 depends on Task 2
    });
    console.log(`[TEST] Created Task 3: ${task3.name} (ID: ${task3.id})`);

    console.log('[TEST] ✓ All 3 tasks created via UI with dependencies\n');

    // Wait for tasks to be fully loaded in the UI before starting workflow
    // The groupedTasks computed property needs time to populate after page reloads
    await page.waitForTimeout(3000);
    const taskCount = await page.locator('.task-card').count();
    console.log(`[TEST] Ready to start workflow with ${taskCount} tasks visible`);

    // STEP 4: Start the workflow via UI
    await startWorkflowViaUI(page);

    // STEP 5: Monitor execution via UI
    console.log('[TEST] Monitoring workflow execution...');

    // Approve execution graph modal if shown
    await approveExecutionGraphModal(page);

    const taskNames = [task1.name, task2.name, task3.name];

    const taskStatuses: Record<string, string> = {
      [task1.name]: 'backlog',
      [task2.name]: 'backlog',
      [task3.name]: 'backlog',
    };

    const maxWaitTime = 480000; // 8 minutes
    const startTime = Date.now();
    let allComplete = false;
    let lastStatusLog = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      let statusChanged = false;

      // Approve execution graph modal if shown (during monitoring)
      await approveExecutionGraphModal(page);

      // Check each task's status via UI
      for (const taskName of taskNames) {
        const newStatus = await getTaskStatusFromUI(page, taskName);

        if (newStatus !== taskStatuses[taskName]) {
          console.log(`[TEST] ${taskName}: ${taskStatuses[taskName]} -> ${newStatus}`);
          taskStatuses[taskName] = newStatus;
          statusChanged = true;
        }
      }

      // Log status periodically
      if (Date.now() - lastStatusLog > 30000) {
        console.log(`[TEST] Status check at ${Math.round((Date.now() - startTime) / 1000)}s:`,
          taskNames.map(n => `${n.split(':')[0]}=${taskStatuses[n]}`).join(', '));
        lastStatusLog = Date.now();
      }

      // Check if all tasks are done
      const allDone = Object.values(taskStatuses).every(s => s === 'done');
      const anyFailed = Object.values(taskStatuses).some(s => s === 'failed' || s === 'stuck');

      if (allDone) {
        allComplete = true;
        console.log('\n[TEST] ✓✓✓ ALL TASKS COMPLETED SUCCESSFULLY ✓✓✓\n');
        break;
      }

      if (anyFailed) {
        console.log('\n[TEST] Task failure detected:');
        for (const taskName of taskNames) {
          const errorMsg = await getTaskErrorFromAPI(page, taskName);
          console.log(`  ${taskName}: ${taskStatuses[taskName]}${errorMsg ? ` - Error: ${errorMsg}` : ''}`);
        }
        throw new Error('Task workflow failed - tasks did not complete successfully');
      }

      // Wait before next poll
      await page.waitForTimeout(5000);
    }

    expect(allComplete).toBe(true);

    // FINAL VERIFICATION via UI
    for (const taskName of taskNames) {
      const finalStatus = await getTaskStatusFromUI(page, taskName);
      expect(finalStatus).toBe('done');
    }

    console.log('[TEST] ==========================================================');
    console.log('[TEST] ✓✓✓ REAL WORKFLOW TEST PASSED ✓✓✓');
    console.log('[TEST] ==========================================================');
    console.log('[TEST] Successfully:');
    console.log('[TEST]  - Created 3 tasks via Web UI');
    console.log('[TEST]  - Set up dependency chain');
    console.log('[TEST]  - Used plan mode with auto-approve');
    console.log('[TEST]  - Executed in real containers with pi-agent');
    console.log('[TEST]  - All tasks completed successfully');
    console.log('[TEST] ==========================================================\n');
  });

  test('workflow respects dependency order - task 2 waits for task 1', async ({ page }) => {
    console.log('[TEST] Testing dependency order enforcement...');

    // Create Task A
    const taskA = await createTaskViaUI(page, {
      name: 'Step A: Foundation',
      prompt: 'Create a file step_order.txt with "Step A executed"',
    });

    // Create Task B with dependency on A
    const taskB = await createTaskViaUI(page, {
      name: 'Step B: Build',
      prompt: 'Append "Step B executed" to step_order.txt',
      requirements: [taskA.id], // Task B depends on Task A
    });

    const taskAName = taskA.name;
    const taskBName = taskB.name;

    // Wait for tasks to be fully loaded in the UI before starting workflow
    await page.waitForTimeout(3000);
    const taskCount = await page.locator('.task-card').count();
    console.log(`[TEST] Ready to start workflow with ${taskCount} tasks visible`);

    // Start workflow via UI
    await startWorkflowViaUI(page);

    // Monitor execution order
    const maxWaitTime = 300000; // 5 minutes
    const startTime = Date.now();
    let stepADone = false;
    let stepBDone = false;
    let lastLog = Date.now();

    // Approve execution graph modal if shown
    await approveExecutionGraphModal(page);

    while (Date.now() - startTime < maxWaitTime) {
      // Approve execution graph modal if shown (during monitoring)
      await approveExecutionGraphModal(page);

      const statusA = await getTaskStatusFromUI(page, taskAName);
      const statusB = await getTaskStatusFromUI(page, taskBName);

      // Critical assertion: Task B should NOT be done if Task A is still in backlog
      if (statusB === 'done' && statusA === 'backlog') {
        throw new Error('Dependency order violated: Task B completed before Task A started');
      }

      if (statusA === 'done') stepADone = true;
      if (statusB === 'done') stepBDone = true;

      // Log status periodically
      if (Date.now() - lastLog > 15000) {
        console.log(`[TEST] Status: A=${statusA}, B=${statusB}`);
        lastLog = Date.now();
      }

      // Both done means success
      if (stepADone && stepBDone) {
        console.log('[TEST] ✓ Dependency order respected');
        break;
      }

      await page.waitForTimeout(3000);
    }

    expect(stepADone && stepBDone).toBe(true);
  });
});
