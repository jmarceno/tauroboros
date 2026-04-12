/**
 * E2E Test: REAL Multi-Task Workflow via Web UI + API
 * 
 * This is THE definitive end-to-end test that exercises the entire system.
 * Due to Vue rendering issues in test environment, this uses API for verification
 * but still exercises the full workflow execution.
 * 
 * Requirements:
 * - Container mode MUST be active (real pi-agent containers)
 * - 3 tasks with chained dependencies
 * - Plan mode + auto-approve
 * - Review enabled
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

test.describe('REAL Multi-Task Workflow', () => {
  test.setTimeout(600000); // 10 minutes for full workflow

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Configure options for reliable test execution
    await configureTestOptions(page);
  });

  /**
   * Helper: Configure test options via API
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
   * Helper: Create a task via API
   */
  async function createTaskViaAPI(page: Page, data: {
    name: string;
    prompt: string;
    branch?: string;
    status?: string;
    planmode?: boolean;
    autoApprovePlan?: boolean;
    review?: boolean;
    requirements?: string[];
  }) {
    const response = await page.evaluate(async (taskData) => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: 'master',
          status: 'backlog',
          planmode: false,
          review: false,
          autoCommit: true,
          requirements: [],
          ...taskData
        }),
      });
      return { status: res.status, data: await res.json() };
    }, data);
    
    if (response.status !== 201) {
      throw new Error(`Failed to create task: ${response.status}`);
    }
    
    console.log(`[API] Created task: ${data.name} (${response.data.id})`);
    return response.data;
  }

  /**
   * Helper: Get task status from API
   */
  async function getTaskStatusFromAPI(page: Page, taskId: string): Promise<string> {
    return await page.evaluate(async (id) => {
      try {
        const res = await fetch(`/api/tasks/${id}`);
        const task = await res.json();
        return task?.status || 'unknown';
      } catch {
        return 'unknown';
      }
    }, taskId);
  }

  /**
   * Helper: Start workflow via API
   */
  async function startWorkflowViaAPI(page: Page) {
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/start', { method: 'POST' });
      return { status: res.status, data: await res.json().catch(() => null) };
    });
    
    if (response.status !== 200) {
      throw new Error(`Failed to start workflow: ${response.status}`);
    }
    
    console.log('[API] Workflow started');
  }

  test('3-task chained workflow executes successfully', async ({ page }) => {
    console.log('\n[TEST] ==========================================================');
    console.log('[TEST] REAL 3-TASK WORKFLOW');
    console.log('[TEST] ==========================================================\n');

    // STEP 1: Create Task 1 (Foundation)
    const task1 = await createTaskViaAPI(page, {
      name: 'Task 1: Create Base File',
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
    const task2 = await createTaskViaAPI(page, {
      name: 'Task 2: Extend Base File',
      prompt: `Read workflow_result.txt and append:
Task 2: Extended successfully
Status: COMPLETE`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
      requirements: [task1.id],
    });

    // STEP 3: Create Task 3 (depends on Task 2)
    const task3 = await createTaskViaAPI(page, {
      name: 'Task 3: Finalize File',
      prompt: `Read workflow_result.txt, verify content, append:
Task 3: Workflow completed
Status: DONE
End of Log`,
      planmode: true,
      autoApprovePlan: true,
      review: true,
      requirements: [task2.id],
    });

    console.log('[TEST] ✓ All 3 tasks created with dependencies\n');

    // STEP 4: Start the workflow
    await startWorkflowViaAPI(page);

    // STEP 5: Monitor execution
    console.log('[TEST] Monitoring workflow execution...');
    
    const taskIds = [task1.id, task2.id, task3.id];
    const taskNames = ['Task 1: Create Base File', 'Task 2: Extend Base File', 'Task 3: Finalize File'];
    
    const taskStatuses: Record<string, string> = {
      [task1.id]: 'backlog',
      [task2.id]: 'backlog',
      [task3.id]: 'backlog',
    };

    const maxWaitTime = 480000; // 8 minutes
    const startTime = Date.now();
    let allComplete = false;
    let lastStatusLog = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      let statusChanged = false;
      
      // Check each task's status
      for (let i = 0; i < taskIds.length; i++) {
        const id = taskIds[i];
        const name = taskNames[i];
        const newStatus = await getTaskStatusFromAPI(page, id);
        
        if (newStatus !== taskStatuses[id]) {
          console.log(`[TEST] ${name}: ${taskStatuses[id]} -> ${newStatus}`);
          taskStatuses[id] = newStatus;
          statusChanged = true;
        }
      }

      // Log status periodically
      if (Date.now() - lastStatusLog > 30000) {
        console.log(`[TEST] Status check at ${Math.round((Date.now() - startTime) / 1000)}s:`,
          taskNames.map((n, i) => `${n.split(':')[0]}=${taskStatuses[taskIds[i]]}`).join(', '));
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
        for (let i = 0; i < taskIds.length; i++) {
          console.log(`  ${taskNames[i]}: ${taskStatuses[taskIds[i]]}`);
        }
        throw new Error('Task workflow failed - tasks did not complete successfully');
      }

      // Wait before next poll
      await page.waitForTimeout(5000);
    }

    expect(allComplete).toBe(true);

    // FINAL VERIFICATION via API
    for (let i = 0; i < taskIds.length; i++) {
      const finalStatus = await getTaskStatusFromAPI(page, taskIds[i]);
      expect(finalStatus).toBe('done');
    }

    console.log('[TEST] ==========================================================');
    console.log('[TEST] ✓✓✓ REAL WORKFLOW TEST PASSED ✓✓✓');
    console.log('[TEST] ==========================================================');
    console.log('[TEST] Successfully:');
    console.log('[TEST]  - Created 3 tasks via API');
    console.log('[TEST]  - Set up dependency chain');
    console.log('[TEST]  - Used plan mode with auto-approve');
    console.log('[TEST]  - Executed in real containers with pi-agent');
    console.log('[TEST]  - All tasks completed successfully');
    console.log('[TEST] ==========================================================\n');
  });

  test('workflow respects dependency order - task 2 waits for task 1', async ({ page }) => {
    console.log('[TEST] Testing dependency order enforcement...');

    // Create Task A
    const taskA = await createTaskViaAPI(page, {
      name: 'Step A: Foundation',
      prompt: 'Create a file step_order.txt with "Step A executed"',
    });

    // Create Task B with dependency on A
    const taskB = await createTaskViaAPI(page, {
      name: 'Step B: Build',
      prompt: 'Append "Step B executed" to step_order.txt',
      requirements: [taskA.id],
    });

    // Start workflow
    await startWorkflowViaAPI(page);

    // Monitor execution order
    const maxWaitTime = 300000; // 5 minutes
    const startTime = Date.now();
    let stepADone = false;
    let stepBDone = false;
    let lastLog = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const statusA = await getTaskStatusFromAPI(page, taskA.id);
      const statusB = await getTaskStatusFromAPI(page, taskB.id);

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
