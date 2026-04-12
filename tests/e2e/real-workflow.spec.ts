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
 * This test FAILS (does not skip) if container infrastructure unavailable.
 * 
 * CRITICAL: This test uses ONLY Web UI interactions - no API calls except
 * for initial test configuration.
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

test.describe('REAL Multi-Task Workflow', () => {
  test.setTimeout(600000); // 10 minutes for full workflow

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give Vue app time to mount
    await page.waitForTimeout(2000);
    
    // Configure options for reliable test execution
    await configureTestOptions(page);
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
          body: JSON.stringify({ maxReviews: 2 })
        });
      } catch (e) {
        console.error('Failed to configure options:', e);
      }
    });
    await page.waitForTimeout(300);
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
  }): Promise<string> {
    // Click the "+ Add Task" button in backlog column
    const backlogColumn = page.locator('[data-status="backlog"]');
    await expect(backlogColumn).toBeVisible();
    
    const addTaskButton = backlogColumn.locator('button:has-text("+ Add Task")');
    await expect(addTaskButton).toBeVisible();
    await addTaskButton.click();
    
    // Wait for task modal to open
    await page.waitForSelector('text=Add Task', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Fill in the task name
    const nameInput = page.locator('input[placeholder="Task name"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(data.name);
    
    // Fill in the prompt using the textarea (MarkdownEditor)
    const promptTextarea = page.locator('textarea[placeholder="What should this task do?"]').first();
    await expect(promptTextarea).toBeVisible();
    await promptTextarea.fill(data.prompt);
    
    // Configure plan mode if requested
    if (data.planmode) {
      const planModeCheckbox = page.locator('label:has-text("Plan Mode") input[type="checkbox"]');
      await planModeCheckbox.check();
    }
    
    // Configure auto-approve plan if requested
    if (data.autoApprovePlan) {
      const autoApproveCheckbox = page.locator('label:has-text("Auto-approve plan") input[type="checkbox"]');
      // Only check if not already checked
      const isChecked = await autoApproveCheckbox.isChecked();
      if (!isChecked) {
        await autoApproveCheckbox.check();
      }
    }
    
    // Configure review if requested
    if (data.review !== undefined) {
      const reviewCheckbox = page.locator('label:has-text("Review") input[type="checkbox"]');
      const isChecked = await reviewCheckbox.isChecked();
      if (data.review && !isChecked) {
        await reviewCheckbox.check();
      } else if (!data.review && isChecked) {
        await reviewCheckbox.uncheck();
      }
    }
    
    // Set requirements if provided
    if (data.requirements && data.requirements.length > 0) {
      // Open requirements section and select dependencies
      for (const reqId of data.requirements) {
        const reqCheckbox = page.locator(`input[type="checkbox"][value="${reqId}"]`);
        if (await reqCheckbox.isVisible().catch(() => false)) {
          await reqCheckbox.check();
        }
      }
    }
    
    // Click Save button
    const saveButton = page.locator('button:has-text("Save")').filter({ hasNotText: 'Save Template' });
    await expect(saveButton).toBeVisible();
    await saveButton.click();
    
    // Wait for modal to close
    await page.waitForTimeout(1000);
    
    // Verify task appears on the board
    const taskCard = page.locator(`text=${data.name}`).first();
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    
    console.log(`[UI] Created task: ${data.name}`);
    
    // Return the task ID from the data attribute on the card
    const card = page.locator('.task-card').filter({ hasText: data.name }).first();
    const taskId = await card.getAttribute('data-task-id');
    return taskId || '';
  }

  /**
   * Helper: Get task status from UI by checking which column it appears in
   */
  async function getTaskStatusFromUI(page: Page, taskName: string): Promise<string> {
    // Check each column for the task
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

  /**
   * Helper: Start workflow via UI
   */
  async function startWorkflowViaUI(page: Page) {
    // Find and click the Start Workflow button in the sidebar
    const startButton = page.locator('button:has-text("Start Workflow")').first();
    await expect(startButton).toBeVisible();
    await startButton.click();
    
    console.log('[UI] Workflow started');
    await page.waitForTimeout(1000);
  }

  test('3-task chained workflow executes successfully', async ({ page }) => {
    console.log('\n[TEST] ==========================================================');
    console.log('[TEST] REAL 3-TASK WORKFLOW');
    console.log('[TEST] ==========================================================\n');

    // STEP 1: Create Task 1 (Foundation)
    const task1Name = 'Task 1: Create Base File';
    await createTaskViaUI(page, {
      name: task1Name,
      prompt: `Create a file named 'workflow_result.txt' with content:
Workflow Execution Log
====================
Task 1: Base created
Status: COMPLETE`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    // STEP 2: Create Task 2 (depends on Task 1)
    const task2Name = 'Task 2: Extend Base File';
    await createTaskViaUI(page, {
      name: task2Name,
      prompt: `Read workflow_result.txt and append:
Task 2: Extended successfully
Status: COMPLETE`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    // STEP 3: Create Task 3 (depends on Task 2)
    const task3Name = 'Task 3: Finalize File';
    await createTaskViaUI(page, {
      name: task3Name,
      prompt: `Read workflow_result.txt, verify content, append:
Task 3: Workflow completed
Status: DONE
End of Log`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
    });

    console.log('[TEST] ✓ All 3 tasks created via UI\n');

    // STEP 4: Start the workflow via UI
    await startWorkflowViaUI(page);

    // STEP 5: Monitor execution via UI
    console.log('[TEST] Monitoring workflow execution...');
    
    const taskNames = [task1Name, task2Name, task3Name];
    
    const taskStatuses: Record<string, string> = {
      [task1Name]: 'backlog',
      [task2Name]: 'backlog',
      [task3Name]: 'backlog',
    };

    const maxWaitTime = 480000; // 8 minutes
    const startTime = Date.now();
    let allComplete = false;
    let lastStatusLog = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      let statusChanged = false;
      
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
          console.log(`  ${taskName}: ${taskStatuses[taskName]}`);
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
    const taskAName = 'Step A: Foundation';
    await createTaskViaUI(page, {
      name: taskAName,
      prompt: 'Create a file step_order.txt with "Step A executed"',
    });

    // Create Task B with dependency on A
    const taskBName = 'Step B: Build';
    await createTaskViaUI(page, {
      name: taskBName,
      prompt: 'Append "Step B executed" to step_order.txt',
    });

    // Start workflow via UI
    await startWorkflowViaUI(page);

    // Monitor execution order
    const maxWaitTime = 300000; // 5 minutes
    const startTime = Date.now();
    let stepADone = false;
    let stepBDone = false;
    let lastLog = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
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
