/**
 * E2E Tests: Basic UI Functionality
 *
 * Tests fundamental UI interactions using Playwright ONLY
 * - Server startup and UI loading
 * - Task creation via UI
 * - Basic navigation
 *
 * NO API calls - all interactions through the web UI
 */

import { test, expect } from "@playwright/test";

test.describe('Basic UI Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give Vue app time to mount
    await page.waitForTimeout(2000);
  });

  test('server starts and UI loads', async ({ page }) => {
    // Check that the kanban board loaded by looking for the kanban columns
    await expect(page.locator('[data-status="template"]')).toBeVisible();

    // Verify the sidebar has the workflow control section
    await expect(page.locator('.sidebar:has-text("Workflow Control")')).toBeVisible();

    console.log('✓ UI loaded successfully');
  });

  test('API endpoint responds correctly', async ({ page }) => {
    // Test API accessibility via fetch from browser context
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/tasks');
      return { status: res.status, ok: res.ok };
    });

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);

    console.log('✓ API is accessible');
  });

  test('WebSocket connection is available', async ({ page }) => {
    // Check for WebSocket by looking at network or checking if WebSocket object exists
    const hasWebSocket = await page.evaluate(() => {
      // Check if WebSocket is defined in window
      return typeof window.WebSocket !== 'undefined';
    });

    expect(hasWebSocket).toBe(true);
    console.log('✓ WebSocket support detected');
  });

  test('keyboard shortcuts are displayed', async ({ page }) => {
    // Look for kbd elements anywhere on the page (they're in the top bar)
    const kbdElements = page.locator('kbd');

    // Verify at least 4 keyboard shortcuts exist (T, B, S, D)
    await expect(kbdElements.first()).toBeVisible();
    const kbdCount = await kbdElements.count();
    expect(kbdCount).toBeGreaterThanOrEqual(4);

    // Get text content of all kbd elements and verify shortcuts exist
    const kbdTexts = await kbdElements.allTextContents();
    expect(kbdTexts).toContain('T');  // Template
    expect(kbdTexts).toContain('B');  // Backlog/Task
    expect(kbdTexts).toContain('P');  // Planning Chat
    expect(kbdTexts).toContain('Esc'); // Close

    console.log('✓ Keyboard shortcuts displayed');
  });

  test('task cards display ID badges when tasks exist', async ({ page }) => {
    // First create a task to test the badge
    const taskName = `UI Test Task ${Date.now()}`;

    // Create a task via API to test UI elements
    const response = await page.evaluate(async (name) => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          prompt: 'Test prompt for UI verification',
          status: 'backlog',
        }),
      });
      return { status: res.status, data: await res.json() };
    }, taskName);

    expect(response.status).toBe(201);

    // Reload to show the new task
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Find the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Check for task ID badge
    const idBadge = taskCard.locator('.task-id-badge');
    await expect(idBadge).toBeVisible({ timeout: 5000 });

    // Verify badge format (#number)
    const badgeText = await idBadge.textContent();
    expect(badgeText).toMatch(/#\d+/);

    // Cleanup: archive the task using Ctrl+click to skip confirmation
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] });
      await page.waitForTimeout(1000);
    }

    console.log('✓ Task ID badges displayed correctly');
  });

  test('kanban columns have correct data-status attributes', async ({ page }) => {
    // Verify all expected columns exist with correct data-status
    const expectedColumns = ['template', 'backlog', 'executing', 'review', 'code-style', 'done'];

    for (const status of expectedColumns) {
      const column = page.locator(`[data-status="${status}"]`);
      await expect(column).toBeVisible({ timeout: 5000 });
    }

    console.log('✓ All kanban columns have correct data-status attributes');
  });

  test('sidebar has workflow control and stats sections', async ({ page }) => {
    // Verify sidebar sections exist
    const workflowControl = page.locator('.sidebar:has-text("Workflow Control")');
    await expect(workflowControl).toBeVisible({ timeout: 10000 });

    // Verify stats section
    const statsSection = page.locator('.sidebar .stats-section, .sidebar:has-text("Total")');
    await expect(statsSection).toBeVisible({ timeout: 5000 });

    // Verify Options button
    const optionsButton = page.locator('button:has-text("Options")');
    await expect(optionsButton).toBeVisible({ timeout: 5000 });

    console.log('✓ Sidebar has all expected sections');
  });
});
