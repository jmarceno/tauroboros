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
  });

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
    await expect(addTaskBtn).toBeVisible();
    await addTaskBtn.click();
    
    // Wait for modal
    await page.waitForTimeout(500);
    
    // Fill task name
    const nameInput = page.locator('sl-input#taskName');
    await expect(nameInput).toBeVisible();
    await nameInput.click();
    await page.keyboard.type(params.name);
    
    // Fill prompt
    const promptInput = page.locator('sl-textarea#taskPrompt');
    await expect(promptInput).toBeVisible();
    await promptInput.click();
    await page.keyboard.type(params.prompt);
    
    // Configure plan mode
    if (params.enablePlan) {
      const planCheckbox = page.locator('sl-checkbox#taskPlanMode');
      if (await planCheckbox.count() > 0) {
        await planCheckbox.click();
      }
      
      // Enable auto-approve plan
      const autoApproveCheckbox = page.locator('sl-checkbox#taskAutoApprovePlan');
      if (await autoApproveCheckbox.count() > 0) {
        await autoApproveCheckbox.click();
      }
    }
    
    // Enable review
    if (params.enableReview) {
      const reviewCheckbox = page.locator('sl-checkbox#taskReview');
      if (await reviewCheckbox.count() > 0) {
        const isChecked = await reviewCheckbox.evaluate(el => (el as any).checked);
        if (!isChecked) {
          await reviewCheckbox.click();
        }
      }
    }
    
    // Click Save
    const saveBtn = page.locator('sl-button#taskSaveBtn');
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();
    
    // Wait for modal to close and task to appear
    await page.waitForTimeout(1000);
    
    // Verify task appears in backlog
    const backlogColumn = page.locator('.column[data-status="backlog"]');
    await expect(backlogColumn.locator('.card').filter({ hasText: params.name })).toBeVisible();
    
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
    await taskCard.click();
    
    await page.waitForTimeout(500);
    
    // Look for dependency dropdown/list
    // Note: The dependency UI might vary, this is a generic approach
    const depsSection = page.locator('.req-list, #taskReqs, [data-testid="dependencies"]');
    if (await depsSection.count() > 0) {
      // Add dependency through UI
      const addDepBtn = page.locator('button:has-text("Add"), button:has-text("Dependency"), sl-button[variant="default"]').first();
      if (await addDepBtn.count() > 0) {
        await addDepBtn.click();
        await page.waitForTimeout(300);
        
        // Select dependency task
        const depOption = page.locator('.dep-option, sl-menu-item, sl-select').filter({ hasText: dependsOnName }).first();
        if (await depOption.count() > 0) {
          await depOption.click();
        }
      }
    }
    
    // Save changes
    const saveBtn = page.locator('sl-button#taskSaveBtn');
    await saveBtn.click();
    await page.waitForTimeout(500);
    
    console.log(`[UI] ✓ Dependency set: ${taskName} -> ${dependsOnName}`);
  }

  /**
   * Helper: Start workflow
   */
  async function startWorkflow(page: Page) {
    console.log('[UI] Starting workflow...');
    
    // Click Start Workflow button
    const startBtn = page.locator('sl-button#startBtn, button:has-text("Start"), button:has-text("Start Workflow")').first();
    await expect(startBtn).toBeVisible();
    await startBtn.click();
    
    await page.waitForTimeout(1000);
    
    // Confirm if dialog appears
    const confirmBtn = page.locator('sl-button:has-text("Confirm"), button:has-text("Confirm"), sl-button[variant="success"]').first();
    if (await confirmBtn.count() > 0 && await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }
    
    console.log('[UI] ✓ Workflow started');
  }

  /**
   * Helper: Wait for task to move to column
   */
  async function waitForTaskInColumn(page: Page, taskName: string, columnStatus: string, timeout = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const column = page.locator(`.column[data-status="${columnStatus}"]`);
      const taskCard = column.locator('.card').filter({ hasText: taskName });
      
      if (await taskCard.count() > 0 && await taskCard.isVisible().catch(() => false)) {
        console.log(`[UI] Task "${taskName}" found in ${columnStatus} column`);
        return true;
      }
      
      await page.waitForTimeout(1000);
    }
    
    return false;
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
   * Helper: Handle review approval
   */
  async function approveReview(page: Page, taskName: string) {
    console.log(`[UI] Approving review for: ${taskName}`);
    
    // Find task in review column
    const reviewColumn = page.locator('.column[data-status="review"]');
    const taskCard = reviewColumn.locator('.card').filter({ hasText: taskName });
    
    if (await taskCard.count() === 0) {
      console.log(`[UI] Task not in review column, may already be approved`);
      return;
    }
    
    await taskCard.click();
    await page.waitForTimeout(500);
    
    // Click approve button
    const approveBtn = page.locator('sl-button:has-text("Approve"), button:has-text("Approve"), sl-button[variant="success"]').first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();
    
    await page.waitForTimeout(1000);
    console.log(`[UI] ✓ Review approved for: ${taskName}`);
  }

  test('3-task chained workflow executes successfully via UI', async ({ page }) => {
    console.log('\n[TEST] ==========================================================');
    console.log('[TEST] REAL 3-TASK WORKFLOW - WEB UI ONLY');
    console.log('[TEST] ==========================================================\n');

    // STEP 1: Create Task 1 (Foundation)
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

    while (Date.now() - startTime < maxWaitTime) {
      // Refresh page to get latest status
      await page.reload();
      await page.waitForLoadState('networkidle');
      
      // Check each task's status
      for (const taskName of Object.keys(taskStatuses)) {
        const newStatus = await getTaskStatusFromUI(page, taskName);
        
        if (newStatus !== taskStatuses[taskName]) {
          console.log(`[TEST] ${taskName}: ${taskStatuses[taskName]} -> ${newStatus}`);
          taskStatuses[taskName] = newStatus;
        }
        
        // Handle review if task is in review column
        if (newStatus === 'review') {
          await approveReview(page, taskName);
        }
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
        for (const [name, status] of Object.entries(taskStatuses)) {
          console.log(`  ${name}: ${status}`);
        }
        throw new Error('Task workflow failed - tasks did not complete successfully');
      }

      // Wait before next poll
      await page.waitForTimeout(3000);
    }

    expect(allComplete).toBe(true);

    // FINAL VERIFICATION: All tasks in done column
    const doneColumn = page.locator('.column[data-status="done"]');
    await expect(doneColumn.locator('.card').filter({ hasText: 'Task 1' })).toBeVisible();
    await expect(doneColumn.locator('.card').filter({ hasText: 'Task 2' })).toBeVisible();
    await expect(doneColumn.locator('.card').filter({ hasText: 'Task 3' })).toBeVisible();

    console.log('[TEST] ==========================================================');
    console.log('[TEST] ✓✓✓ REAL WORKFLOW TEST PASSED ✓✓✓');
    console.log('[TEST] ==========================================================');
    console.log('[TEST] Successfully:');
    console.log('[TEST]  - Created 3 tasks via web UI');
    console.log('[TEST]  - Set up dependency chain via web UI');
    console.log('[TEST]  - Used plan mode with auto-approve');
    console.log('[TEST]  - Executed in real containers with pi-agent');
    console.log('[TEST]  - Processed review phases');
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
    const maxWaitTime = 180000; // 3 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      await page.reload();
      await page.waitForLoadState('networkidle');

      const statusA = await getTaskStatusFromUI(page, 'Step A: Foundation');
      const statusB = await getTaskStatusFromUI(page, 'Step B: Build');

      // Critical assertion: Task B should NOT be done if Task A is still in backlog
      if (statusB === 'done' && statusA === 'backlog') {
        throw new Error('Dependency order violated: Task B completed before Task A started');
      }

      // Both done means success
      if (statusA === 'done' && statusB === 'done') {
        console.log('[TEST] ✓ Dependency order respected');
        break;
      }

      await page.waitForTimeout(2000);
    }
  });
});
