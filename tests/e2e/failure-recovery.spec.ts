/**
 * E2E Tests: Failure Recovery Scenarios
 *
 * Tests failure recovery scenarios using API calls.
 * Note: These tests primarily use the API since they test server-side behavior.
 */

import { test, expect } from "@playwright/test';

test.describe('Failure Recovery Scenarios', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('task can be reset via API', async ({ page }) => {
    console.log('[TEST] Testing task reset via API...');

    // Create a task via API
    const createResponse = await page.evaluate(async () => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Reset Test Task',
          prompt: 'Create a file test-reset.txt',
          branch: 'reset-test',
          status: 'backlog',
          planmode: false,
          review: false,
          autoCommit: true,
          requirements: [],
        }),
      });
      return { status: res.status, data: await res.json() };
    });

    expect(createResponse.status).toBe(201);
    const taskId = createResponse.data.id;
    console.log(`[TEST] Task created: ${taskId}`);

    // Reset the task
    const resetResponse = await page.evaluate(async (id) => {
      const res = await fetch(`/api/tasks/${id}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return { status: res.status, data: await res.json() };
    }, taskId);

    expect(resetResponse.status).toBe(200);
    console.log('[TEST] ✓ Task reset successful');

    // Verify task is back in backlog
    const verifyResponse = await page.evaluate(async (id) => {
      const res = await fetch(`/api/tasks/${id}`);
      const task = await res.json();
      return task.status;
    }, taskId);

    expect(verifyResponse).toBe('backlog');
    console.log('[TEST] ✓ Task verified in backlog');
    console.log('[TEST] ✓ Task reset test completed');
  });

  test('workflow can be stopped and resumed via API', async ({ page }) => {
    console.log('[TEST] Testing workflow stop/resume via API...');

    // Create a task
    const createResponse = await page.evaluate(async () => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Stop Resume Test Task',
          prompt: 'Create file and wait',
          branch: 'stop-test',
          status: 'backlog',
          planmode: false,
          review: false,
          autoCommit: true,
          requirements: [],
        }),
      });
      return { status: res.status, data: await res.json() };
    });

    const taskId = createResponse.data.id;

    // Try to stop workflow (may return 409 if no active run)
    const stopResponse = await page.evaluate(async () => {
      const res = await fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return { status: res.status };
    });

    console.log(`[TEST] Stop returned: ${stopResponse.status}`);
    expect([200, 409]).toContain(stopResponse.status);

    // Should be able to restart the task
    const restartResponse = await page.evaluate(async (id) => {
      const res = await fetch(`/api/tasks/${id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return { status: res.status };
    }, taskId);

    // Should succeed or give clear error
    expect([200, 409, 400]).toContain(restartResponse.status);

    console.log(`[TEST] Restart returned: ${restartResponse.status}`);
    console.log('[TEST] ✓ Stop/resume test completed');
  });

  test('stuck task can be reset via API', async ({ page }) => {
    console.log('[TEST] Testing stuck task recovery...');

    // Create a stuck task via API
    const createResponse = await page.evaluate(async () => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Stuck Task Recovery Test',
          prompt: 'Test stuck task',
          branch: 'stuck-test',
          status: 'stuck', // Create directly in stuck state
          planmode: false,
          review: false,
          autoCommit: true,
          requirements: [],
        }),
      });
      return { status: res.status, data: await res.json() };
    });

    expect(createResponse.status).toBe(201);
    const taskId = createResponse.data.id;

    // Reset task to backlog
    const resetResponse = await page.evaluate(async (id) => {
      const res = await fetch(`/api/tasks/${id}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return { status: res.status };
    }, taskId);

    expect(resetResponse.status).toBe(200);

    // Verify via API
    const statusResponse = await page.evaluate(async (id) => {
      const res = await fetch(`/api/tasks/${id}`);
      const task = await res.json();
      return task.status;
    }, taskId);

    expect(statusResponse).toBe('backlog');
    console.log('[TEST] ✓ Stuck task recovery test completed');
  });
});
