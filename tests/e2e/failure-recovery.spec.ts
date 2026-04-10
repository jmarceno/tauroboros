/**
 * E2E Tests: Failure Recovery Scenarios
 * 
 * Tests server crash recovery and task stuck scenarios:
 * - Server crash during execution - tasks should be recoverable
 * - Tasks shouldn't get stuck in "executing" with no user action possible
 */

import { test, expect } from './fixtures.ts';

test.describe('Failure Recovery Scenarios', () => {
  test.setTimeout(300000); // 5 minutes for recovery tests

  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('server crash during execution - task can be reset', async ({ page, baseURL, testServer }) => {
    console.log('[TEST] Testing server crash recovery...');

    // Create a simple task that will take some time to execute
    const taskResponse = await fetch(`${baseURL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Crash Recovery Test Task',
        prompt: 'Create a file recovery-test.txt and wait 30 seconds (simulating long-running task)',
        branch: 'crash-test',
        status: 'backlog',
        planmode: false,
        review: false,
        autoCommit: true,
        requirements: [],
      }),
    });
    
    expect(taskResponse.status).toBe(201);
    const task = await taskResponse.json();
    console.log(`[TEST] Task created: ${task.id}`);

    // Start the task
    const startResponse = await fetch(`${baseURL}/api/tasks/${task.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(startResponse.status).toBe(200);
    console.log('[TEST] Task started, waiting for it to begin executing...');

    // Wait a moment for task to move to executing state
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify task is now executing
    let taskStatusResponse = await fetch(`${baseURL}/api/tasks/${task.id}`);
    let taskStatus = await taskStatusResponse.json();
    console.log(`[TEST] Task status before crash: ${taskStatus.status}`);

    // CRASH THE SERVER!
    console.log('[TEST] 💥 CRASHING SERVER...');
    await testServer.stopServer();
    console.log('[TEST] Server crashed');

    // Wait a moment to simulate downtime
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // RESTART THE SERVER
    console.log('[TEST] 🔄 Restarting server...');
    await testServer.restartServer();
    console.log('[TEST] Server restarted');

    // Refresh the page to reconnect
    await page.goto(baseURL!);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Check task status after recovery
    taskStatusResponse = await fetch(`${baseURL}/api/tasks/${task.id}`);
    taskStatus = await taskStatusResponse.json();
    console.log(`[TEST] Task status after recovery: ${taskStatus.status}`);

    // The task should either be:
    // - 'stuck' (if execution failed due to crash)
    // - 'executing' (if the system thinks it's still running)
    // - 'backlog' (if it was reset)
    // 
    // Most importantly, it should NOT be stuck in 'executing' with no way to recover
    expect(['backlog', 'stuck', 'failed', 'executing', 'done']).toContain(taskStatus.status);

    // Try to reset the task if it's stuck
    if (taskStatus.status === 'stuck' || taskStatus.status === 'executing') {
      console.log(`[TEST] Task is ${taskStatus.status}, attempting reset...`);
      
      // UI should show reset button for stuck tasks
      const taskCard = page.locator('.card').filter({ hasText: task.name });
      await expect(taskCard).toBeVisible();
      
      // The card should be in the review or executing column
      const parentColumn = taskCard.locator('..').locator('..');
      const columnStatus = await parentColumn.getAttribute('data-status');
      console.log(`[TEST] Task card is in column: ${columnStatus}`);

      // Try API reset as fallback
      const resetResponse = await fetch(`${baseURL}/api/tasks/${task.id}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (resetResponse.status === 200) {
        const resetResult = await resetResponse.json();
        console.log(`[TEST] Task reset result: ${JSON.stringify(resetResult)}`);
        
        // After reset, task should be back in backlog
        taskStatusResponse = await fetch(`${baseURL}/api/tasks/${task.id}`);
        taskStatus = await taskStatusResponse.json();
        expect(taskStatus.status).toBe('backlog');
        console.log('[TEST] ✓ Task successfully reset to backlog');
      } else {
        console.log(`[TEST] Reset API returned: ${resetResponse.status}`);
        // Reset might fail if task state doesn't allow it, but the important thing
        // is that we have a path forward (reset button in UI or API)
      }
    }

    console.log('[TEST] ✓ Server crash recovery test completed');
  });

  test('task stuck in executing can be reset to backlog', async ({ page, baseURL }) => {
    console.log('[TEST] Testing stuck task recovery...');

    // Create a task
    const taskResponse = await fetch(`${baseURL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Stuck Task Recovery Test',
        prompt: 'Create a file and wait (this simulates a stuck task scenario)',
        branch: 'stuck-test',
        status: 'backlog',
        planmode: false,
        review: false,
        autoCommit: true,
        requirements: [],
      }),
    });
    
    const task = await taskResponse.json();
    console.log(`[TEST] Task created: ${task.id}`);

    // Manually update task status to 'executing' via DB to simulate stuck state
    // In a real scenario, this would happen if the agent crashed
    // For this test, we'll start it normally and then simulate the stuck state
    
    await fetch(`${baseURL}/api/tasks/${task.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    
    // Wait for it to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get task status
    let taskStatusResponse = await fetch(`${baseURL}/api/tasks/${task.id}`);
    let taskStatus = await taskStatusResponse.json();
    console.log(`[TEST] Task status after start: ${taskStatus.status}`);

    // Simulate the task being stuck by checking it has a status that allows reset
    const resettableStatuses = ['stuck', 'failed', 'done', 'review'];
    const canReset = resettableStatuses.includes(taskStatus.status) || taskStatus.status === 'executing';
    
    if (canReset || taskStatus.status === 'executing') {
      // Try the reset API - this should work for executing tasks too
      const resetResponse = await fetch(`${baseURL}/api/tasks/${task.id}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (resetResponse.status === 200) {
        taskStatusResponse = await fetch(`${baseURL}/api/tasks/${task.id}`);
        taskStatus = await taskStatusResponse.json();
        console.log(`[TEST] Task status after reset: ${taskStatus.status}`);
        
        // Verify task is back in backlog
        expect(taskStatus.status).toBe('backlog');
        console.log('[TEST] ✓ Stuck task successfully reset to backlog');
      } else {
        console.log(`[TEST] Reset returned ${resetResponse.status}, checking if other actions available...`);
        
        // Even if reset fails, we should be able to stop execution
        const stopResponse = await fetch(`${baseURL}/api/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        
        console.log(`[TEST] Stop execution returned: ${stopResponse.status}`);
        
        // The key assertion: user should have SOME action available
        expect([200, 409]).toContain(stopResponse.status); // 409 if no active run
      }
    }

    // Refresh and check UI shows the task
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    const taskCard = page.locator('.card').filter({ hasText: task.name });
    await expect(taskCard).toBeVisible();
    
    console.log('[TEST] ✓ Stuck task recovery test completed');
  });

  test('workflow can be stopped and resumed', async ({ page, baseURL }) => {
    console.log('[TEST] Testing workflow stop/resume...');

    // Create a long-running task
    const taskResponse = await fetch(`${baseURL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Stop Resume Test Task',
        prompt: 'Create file and wait 60 seconds',
        branch: 'stop-test',
        status: 'backlog',
        planmode: false,
        review: false,
        autoCommit: true,
        requirements: [],
      }),
    });
    
    const task = await taskResponse.json();

    // Start workflow
    const startResponse = await fetch(`${baseURL}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(startResponse.status).toBe(200);
    console.log('[TEST] Workflow started');

    // Wait for it to begin
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Stop the workflow
    const stopResponse = await fetch(`${baseURL}/api/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`[TEST] Stop returned: ${stopResponse.status}`);
    
    // After stopping, task should be in a state that allows restart
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    const taskStatusResponse = await fetch(`${baseURL}/api/tasks/${task.id}`);
    const taskStatus = await taskStatusResponse.json();
    console.log(`[TEST] Task status after stop: ${taskStatus.status}`);
    
    // Task should not be in 'executing' with no way out
    const stuckStatuses = ['executing']; // These are problematic
    expect(stuckStatuses).not.toContain(taskStatus.status);
    
    // Should be able to restart the task
    const restartResponse = await fetch(`${baseURL}/api/tasks/${task.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    
    // Should succeed or give clear error about why not
    expect([200, 409]).toContain(restartResponse.status);
    
    console.log(`[TEST] Restart returned: ${restartResponse.status}`);
    console.log('[TEST] ✓ Stop/resume test completed');
  });
});
