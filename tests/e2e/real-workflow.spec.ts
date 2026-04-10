/**
 * E2E Test: REAL Multi-Task Workflow via Web UI ONLY
 * 
 * This is THE definitive end-to-end test that exercises the entire system
 * EXACTLY like a real user would, through the web UI only.
 * 
 * Requirements:
 * - Container mode MUST be active (real pi-agent containers)
 * - 3 tasks with chained dependencies
 * - Plan mode + auto-approve
 * - Review enabled
 * - All interactions via Playwright through the web UI
 * 
 * This test FAILS (does not skip) if container infrastructure unavailable.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

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
      const result = execSync('podman images pi-agent:alpine -q', { encoding: 'utf-8', stdio: 'pipe' });
      hasPiAgentImage = result.trim().length > 0;
      if (hasPiAgentImage) {
        console.log('  ✓ pi-agent:alpine image available');
      } else {
        console.error('  ❌ pi-agent:alpine image not found');
      }
    } catch {
      console.error('  ❌ pi-agent:alpine image not found');
    }
  }
  
  if (!hasPodman || !hasPiAgentImage) {
    console.error('\n❌ REAL WORKFLOW TEST FAILED: Container infrastructure not available');
    console.error('   Run: bun run container:setup');
    throw new Error('Container infrastructure not available. Test cannot proceed.');
  }
  
  console.log('  ✓ All container requirements met\n');
});

test.describe('REAL Multi-Task Workflow - Web UI Only', () => {
  test.setTimeout(600000); // 10 minutes for full workflow

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');
    
    // Wait for the app to be ready (branches loaded)
    await waitForAppReady(page);
    
    // Configure options for reliable test execution (disable automatic review)
    await configureTestOptions(page);
  });

  /**
   * Helper: Configure test options via API
   */
  async function configureTestOptions(page: Page) {
    await page.evaluate(async () => {
      try {
        // Keep using default models (minimax), just ensure maxReviews is set
        await fetch('/api/options', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxReviews: 2 })
        });
      } catch (e) {
        console.error('Failed to configure options:', e);
      }
    });
    await page.waitForTimeout(300);
  }

  /**
   * Helper: Wait for the application to be ready
   */
  async function waitForAppReady(page: Page, timeout = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      // Check if we can get branches from the API
      const hasBranches = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/branches');
          const data = await res.json();
          return data.branches && data.branches.length > 0;
        } catch {
          return false;
        }
      });
      
      if (hasBranches) {
        // Close any open modals that might interfere with the test
        await closeAllModals(page);
        console.log('[TEST] App ready - branches loaded');
        return;
      }
      
      await page.waitForTimeout(500);
    }
    
    throw new Error('App not ready - branches not loaded within timeout');
  }

  /**
   * Helper: Close all open modals
   */
  async function closeAllModals(page: Page) {
    await page.evaluate(() => {
      // Close graph modal if open
      const graphModal = document.getElementById('graphModal');
      if (graphModal && !graphModal.classList.contains('hidden')) {
        (window as any).closeGraphModal?.();
        graphModal.classList.add('hidden');
      }
      
      // Close task modal if open
      const taskModal = document.getElementById('taskModal');
      if (taskModal && !taskModal.classList.contains('hidden')) {
        (window as any).closeTaskModal?.();
        taskModal.classList.add('hidden');
      }
      
      // Close approve modal if open
      const approveModal = document.getElementById('approveModal');
      if (approveModal && !approveModal.classList.contains('hidden')) {
        (window as any).closeApproveModal?.();
        approveModal.classList.add('hidden');
      }
      
      // Close options modal if open
      const optionsModal = document.getElementById('optionsModal');
      if (optionsModal && !optionsModal.classList.contains('hidden')) {
        (window as any).closeOptionsModal?.();
        optionsModal.classList.add('hidden');
      }
    });
    await page.waitForTimeout(300);
  }

  /**
   * Helper: Fill Shoelace input component
   */
  async function fillShoelaceInput(page: Page, selector: string, value: string) {
    // Click to focus the input
    await page.locator(selector).click();
    // Clear any existing text
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    // Type the new value
    await page.keyboard.type(value);
  }

  /**
   * Helper: Fill Shoelace textarea component
   */
  async function fillShoelaceTextarea(page: Page, selector: string, value: string) {
    // Click to focus
    await page.locator(selector).click();
    // Clear any existing text
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    // Type the new value
    await page.keyboard.type(value);
  }

  /**
   * Helper: Select option from Shoelace select
   */
  async function selectShoelaceOption(page: Page, selectId: string, optionValue: string) {
    // Click the select to open it
    await page.locator(`sl-select#${selectId}`).click();
    await page.waitForTimeout(200);
    
    // Click the option
    await page.locator(`sl-option[value="${optionValue}"]`).click();
    await page.waitForTimeout(200);
  }

  /**
   * Helper: Create a task through the UI
   */
  async function createTask(page: Page, params: {
    name: string;
    prompt: string;
    enablePlan: boolean;
    enableReview: boolean;
  }) {
    console.log(`[UI] Creating task: ${params.name}`);
    
    // Click "Add Task" button in backlog column
    const addTaskBtn = page.locator('.column[data-status="backlog"] button.add-task-btn');
    await expect(addTaskBtn).toBeVisible({ timeout: 10000 });
    await addTaskBtn.click();
    
    // Wait for modal to appear and be fully rendered
    await page.waitForTimeout(800);
    
    // Fill task name using Shoelace input
    await fillShoelaceInput(page, 'sl-input#taskName', params.name);
    
    // Fill prompt using Shoelace textarea
    await fillShoelaceTextarea(page, 'sl-textarea#taskPrompt', params.prompt);
    
    // Wait for branch selector to populate and select a branch
    await page.waitForTimeout(500);
    
    // Check if branch selector has options and select the first real branch
    const branchSelect = page.locator('sl-select#taskBranch');
    const hasOptions = await branchSelect.evaluate((el: any) => {
      const options = el.querySelectorAll('sl-option');
      return options.length > 0 && options[0].value !== '';
    });
    
    if (!hasOptions) {
      throw new Error('No git branches available. Cannot create task without a branch.');
    }
    
    // Select the first available branch
    await branchSelect.evaluate((el: any) => {
      const options = el.querySelectorAll('sl-option');
      const firstRealBranch = Array.from(options).find((opt: any) => opt.value !== '');
      if (firstRealBranch) {
        el.value = (firstRealBranch as any).value;
      }
    });
    
    await page.waitForTimeout(200);
    
    // Configure plan mode
    if (params.enablePlan) {
      const planCheckbox = page.locator('sl-checkbox#taskPlanmode');
      await planCheckbox.evaluate((el: any) => {
        if (!el.checked) {
          el.click();
        }
      });
      await page.waitForTimeout(200);
      
      // Enable auto-approve plan
      const autoApproveCheckbox = page.locator('sl-checkbox#taskAutoApprovePlan');
      await autoApproveCheckbox.evaluate((el: any) => {
        if (!el.checked) {
          el.click();
        }
      });
      await page.waitForTimeout(200);
    }
    
    // Enable review if requested
    if (params.enableReview) {
      const reviewCheckbox = page.locator('sl-checkbox#taskReview');
      await reviewCheckbox.evaluate((el: any) => {
        if (!el.checked) {
          el.click();
        }
      });
      await page.waitForTimeout(200);
    }
    
    // Click Save - use the onclick handler directly for reliability
    const saveResult = await page.evaluate(() => {
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        // Override showToast to capture any error messages
        const originalShowToast = (window as any).showToast;
        (window as any).showToast = (msg: string, type: string) => {
          if (type === 'error') {
            resolve({ success: false, error: msg });
          }
          if (originalShowToast) originalShowToast(msg, type);
        };
        
        // Set up a listener for task creation success
        const checkForSuccess = () => {
          const modal = document.getElementById('taskModal');
          if (modal && modal.classList.contains('hidden')) {
            resolve({ success: true });
          }
        };
        
        // Try to save
        try {
          (window as any).saveTask();
          // Check after a short delay
          setTimeout(checkForSuccess, 1000);
          // Also resolve after a longer timeout if modal didn't close
          setTimeout(() => {
            const modal = document.getElementById('taskModal');
            resolve({ 
              success: modal?.classList.contains('hidden') || false 
            });
          }, 3000);
        } catch (e: any) {
          resolve({ success: false, error: e.message });
        }
      });
    });
    
    if (!saveResult.success) {
      throw new Error(`Failed to save task: ${saveResult.error || 'Unknown error'}`);
    }
    
    // Wait for modal to close and UI to update
    await page.waitForTimeout(1500);
    
    // Verify task appears in backlog by checking the API
    const taskCreated = await page.evaluate(async (taskName) => {
      try {
        const res = await fetch('/api/tasks');
        const tasks = await res.json();
        return tasks.some((t: any) => t.name === taskName && t.status === 'backlog');
      } catch {
        return false;
      }
    }, params.name);
    
    if (!taskCreated) {
      throw new Error(`Task "${params.name}" was not created in backlog`);
    }
    
    // Reload page to see the task card
    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForAppReady(page);
    
    // Verify task card is visible
    const backlogColumn = page.locator('.column[data-status="backlog"]');
    const taskCard = backlogColumn.locator('.card').filter({ hasText: params.name });
    await expect(taskCard).toBeVisible({ timeout: 10000 });
    
    console.log(`[UI] ✓ Task created: ${params.name}`);
  }

  /**
   * Helper: Set task dependency through UI
   */
  async function setDependency(page: Page, taskName: string, dependsOnName: string) {
    console.log(`[UI] Setting dependency: ${taskName} depends on ${dependsOnName}`);
    
    // Find and click on task card to open edit modal
    const backlogColumn = page.locator('.column[data-status="backlog"]');
    const taskCard = backlogColumn.locator('.card').filter({ hasText: taskName });
    await expect(taskCard).toBeVisible({ timeout: 10000 });
    await taskCard.click();
    
    await page.waitForTimeout(800);
    
    // Find the dependency checkbox for the dependsOn task
    const depItem = page.locator('.req-item').filter({ hasText: dependsOnName });
    if (await depItem.count() > 0) {
      const checkbox = depItem.locator('input[type="checkbox"]');
      await checkbox.check();
      await page.waitForTimeout(300);
    }
    
    // Save changes using the save button
    await page.evaluate(() => {
      (window as any).saveTask();
    });
    
    await page.waitForTimeout(1500);
    
    // Verify dependency was set via API
    const depSet = await page.evaluate(async ({ taskName, dependsOnName }: { taskName: string; dependsOnName: string }) => {
      try {
        const res = await fetch('/api/tasks');
        const tasks = await res.json();
        const task = tasks.find((t: any) => t.name === taskName);
        const dependsOn = tasks.find((t: any) => t.name === dependsOnName);
        if (task && dependsOn) {
          return task.requirements?.includes(dependsOn.id) || false;
        }
        return false;
      } catch {
        return false;
      }
    }, { taskName, dependsOnName });
    
    if (!depSet) {
      throw new Error(`Failed to set dependency: ${taskName} -> ${dependsOnName}`);
    }
    
    console.log(`[UI] ✓ Dependency set: ${taskName} -> ${dependsOnName}`);
  }

  /**
   * Helper: Start workflow
   */
  async function startWorkflow(page: Page) {
    console.log('[UI] Starting workflow...');
    
    // Ensure no modals are blocking the UI
    await closeAllModals(page);
    
    // Click Start Workflow button
    const startBtn = page.locator('#startBtn');
    await expect(startBtn).toBeVisible({ timeout: 10000 });
    await startBtn.click();
    
    await page.waitForTimeout(1000);
    
    // Confirm if dialog appears - use more specific selector
    const confirmBtn = page.locator('sl-button:has-text("Confirm")');
    try {
      await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
      await confirmBtn.click();
      console.log('[UI] Confirmed workflow start');
    } catch {
      // No confirmation dialog, which is fine
    }
    
    console.log('[UI] ✓ Workflow started');
  }

  /**
   * Helper: Get task status from UI
   */
  async function getTaskStatusFromUI(page: Page, taskName: string): Promise<string> {
    const columns = ['template', 'backlog', 'executing', 'review', 'done'];
    
    for (const status of columns) {
      const column = page.locator(`.column[data-status="${status}"]`);
      const taskCard = column.locator('.card').filter({ hasText: taskName });
      
      if (await taskCard.count() > 0 && await taskCard.isVisible().catch(() => false)) {
        return status;
      }
    }
    
    return 'unknown';
  }

  /**
   * Helper: Get task status from API (more reliable)
   */
  async function getTaskStatusFromAPI(page: Page, taskName: string): Promise<string> {
    return await page.evaluate(async (name) => {
      try {
        const res = await fetch('/api/tasks');
        const tasks = await res.json();
        const task = tasks.find((t: any) => t.name === name);
        return task?.status || 'unknown';
      } catch {
        return 'unknown';
      }
    }, taskName);
  }

  /**
   * Helper: Handle review approval
   */
  async function approveReview(page: Page, taskName: string) {
    console.log(`[UI] Approving review for: ${taskName}`);
    
    // Find task in review column
    const reviewColumn = page.locator('.column[data-status="review"]');
    const taskCard = reviewColumn.locator('.card').filter({ hasText: taskName });
    
    if (await taskCard.count() === 0) {
      // Check if already in done column
      const doneColumn = page.locator('.column[data-status="done"]');
      const doneCard = doneColumn.locator('.card').filter({ hasText: taskName });
      if (await doneCard.count() > 0) {
        console.log(`[UI] Task already in done column`);
        return;
      }
      console.log(`[UI] Task not in review column, may already be approved`);
      return;
    }
    
    await taskCard.click();
    await page.waitForTimeout(800);
    
    // Click approve button
    const approveBtn = page.locator('sl-button:has-text("Approve")').first();
    if (await approveBtn.count() > 0 && await approveBtn.isVisible()) {
      await approveBtn.click();
      await page.waitForTimeout(1500);
      console.log(`[UI] ✓ Review approved for: ${taskName}`);
    } else {
      console.log(`[UI] No approve button found for: ${taskName}`);
    }
    
    // Close modal if still open
    const modal = page.locator('#approveModal');
    if (await modal.count() > 0 && await modal.isVisible().catch(() => false)) {
      await page.evaluate(() => {
        (window as any).closeApproveModal?.();
      });
    }
  }

  test('3-task chained workflow executes successfully via UI', async ({ page }) => {
    console.log('\n[TEST] ==========================================================');
    console.log('[TEST] REAL 3-TASK WORKFLOW - WEB UI ONLY');
    console.log('[TEST] ==========================================================\n');

    // STEP 1: Create Task 1 (Foundation)
    // Review enabled - using reliable model for consistent JSON output
    await createTask(page, {
      name: 'Task 1: Create Base File',
      prompt: `Create a file named 'workflow_result.txt' with content:
Workflow Execution Log
====================
Task 1: Base created
Status: COMPLETE`,
      enablePlan: true,
      enableReview: true,
    });

    // STEP 2: Create Task 2 (depends on Task 1)
    await createTask(page, {
      name: 'Task 2: Extend Base File',
      prompt: `Read workflow_result.txt and append:
Task 2: Extended successfully
Status: COMPLETE`,
      enablePlan: true,
      enableReview: true,
    });

    // STEP 3: Set dependency (Task 2 depends on Task 1)
    await setDependency(page, 'Task 2: Extend Base File', 'Task 1: Create Base File');

    // STEP 4: Create Task 3 (depends on Task 2)
    await createTask(page, {
      name: 'Task 3: Finalize File',
      prompt: `Read workflow_result.txt, verify content, append:
Task 3: Workflow completed
Status: DONE
End of Log`,
      enablePlan: true,
      enableReview: true,
    });

    // STEP 5: Set dependency (Task 3 depends on Task 2)
    await setDependency(page, 'Task 3: Finalize File', 'Task 2: Extend Base File');

    console.log('[TEST] ✓ All 3 tasks created with dependencies\n');

    // STEP 6: Start the workflow
    await startWorkflow(page);

    // STEP 7: Monitor execution
    console.log('[TEST] Monitoring workflow execution...');
    
    const taskStatuses = {
      'Task 1: Create Base File': 'backlog',
      'Task 2: Extend Base File': 'backlog',
      'Task 3: Finalize File': 'backlog',
    };

    const maxWaitTime = 480000; // 8 minutes
    const startTime = Date.now();
    let allComplete = false;
    let lastStatusLog = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Refresh page to get latest status
      await page.reload();
      await page.waitForLoadState('networkidle');
      await waitForAppReady(page, 10000);
      
      let statusChanged = false;
      
      // Check each task's status using API (more reliable than UI)
      for (const taskName of Object.keys(taskStatuses)) {
        const newStatus = await getTaskStatusFromAPI(page, taskName);
        
        if (newStatus !== taskStatuses[taskName]) {
          console.log(`[TEST] ${taskName}: ${taskStatuses[taskName]} -> ${newStatus}`);
          taskStatuses[taskName] = newStatus;
          statusChanged = true;
        }
        
        // Note: Review disabled for reliability in this test
        // Review functionality is tested separately in other test cases
      }

      // Log status periodically even if unchanged
      if (Date.now() - lastStatusLog > 30000) {
        console.log(`[TEST] Status check at ${Math.round((Date.now() - startTime) / 1000)}s:`,
          Object.entries(taskStatuses).map(([n, s]) => `${n.split(':')[0]}=${s}`).join(', '));
        lastStatusLog = Date.now();
      }

      // Check if all tasks are done
      const allDone = Object.values(taskStatuses).every(s => s === 'done');
      const anyFailed = Object.values(taskStatuses).some(s => s === 'failed' || s === 'stuck');
      const anyReviewError = Object.values(taskStatuses).some(s => s === 'review');

      if (allDone) {
        allComplete = true;
        console.log('\n[TEST] ✓✓✓ ALL TASKS COMPLETED SUCCESSFULLY ✓✓✓\n');
        break;
      }

      if (anyFailed) {
        console.log('\n[TEST] Task failure detected:');
        for (const [name, status] of Object.entries(taskStatuses)) {
          console.log(`  ${name}: ${status}`);
        }
        throw new Error('Task workflow failed - tasks did not complete successfully');
      }
      
      // If a task is stuck in review with errors, log it but continue
      // (Review failures are a system config issue, not core workflow failure)
      if (anyReviewError && Date.now() - startTime > 300000) {
        console.log('\n[TEST] Warning: Task stuck in review (may be model configuration issue)');
      }

      // Wait before next poll
      await page.waitForTimeout(5000);
    }

    expect(allComplete).toBe(true);

    // FINAL VERIFICATION: All tasks in done column
    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForAppReady(page, 10000);
    
    const doneColumn = page.locator('.column[data-status="done"]');
    // Use full task names to avoid matching partial strings (e.g., "Task 1" matching "#1" in Task 3)
    await expect(doneColumn.locator('.card').filter({ hasText: 'Task 1: Create Base File' })).toBeVisible({ timeout: 10000 });
    await expect(doneColumn.locator('.card').filter({ hasText: 'Task 2: Extend Base File' })).toBeVisible({ timeout: 10000 });
    await expect(doneColumn.locator('.card').filter({ hasText: 'Task 3: Finalize File' })).toBeVisible({ timeout: 10000 });

    console.log('[TEST] ==========================================================');
    console.log('[TEST] ✓✓✓ REAL WORKFLOW TEST PASSED ✓✓✓');
    console.log('[TEST] ==========================================================');
    console.log('[TEST] Successfully:');
    console.log('[TEST]  - Created 3 tasks via web UI');
    console.log('[TEST]  - Set up dependency chain via web UI');
    console.log('[TEST]  - Used plan mode with auto-approve');
    console.log('[TEST]  - Executed in real containers with pi-agent');
    console.log('[TEST]  - All tasks completed successfully');
    console.log('[TEST] ==========================================================\n');
  });

  test('workflow respects dependency order - task 2 waits for task 1', async ({ page }) => {
    console.log('[TEST] Testing dependency order enforcement...');

    // Create Task A
    await createTask(page, {
      name: 'Step A: Foundation',
      prompt: 'Create a file step_order.txt with "Step A executed"',
      enablePlan: false,
      enableReview: false,
    });

    // Create Task B with dependency on A
    await createTask(page, {
      name: 'Step B: Build',
      prompt: 'Append "Step B executed" to step_order.txt',
      enablePlan: false,
      enableReview: false,
    });

    await setDependency(page, 'Step B: Build', 'Step A: Foundation');

    // Start workflow
    await startWorkflow(page);

    // Monitor execution order
    const maxWaitTime = 300000; // 5 minutes for container execution
    const startTime = Date.now();
    let stepADone = false;
    let stepBDone = false;
    let lastLog = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      await page.reload();
      await page.waitForLoadState('networkidle');
      await waitForAppReady(page, 10000);

      const statusA = await getTaskStatusFromAPI(page, 'Step A: Foundation');
      const statusB = await getTaskStatusFromAPI(page, 'Step B: Build');

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
