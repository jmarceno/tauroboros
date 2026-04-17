/**
 * E2E Tests: Drag-Drop Code Style Column Restrictions
 *
 * Tests the drag-drop restrictions for the code-style column:
 * - Cannot manually drag tasks INTO code-style column
 * - CAN drag tasks OUT of code-style column to other columns
 * - Error toast appears when attempting invalid drops
 *
 * All interactions are via Web UI only.
 */

import { test, expect, Page } from "@playwright/test';

test.describe('Drag-Drop Code Style Restrictions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give React app time to mount
    await page.waitForTimeout(2000);
  });

  /**
   * Helper: Create a task via API with a specific status
   */
  async function createTaskWithStatus(
    page: Page,
    name: string,
    status: string
  ): Promise<string> {
    const response = await page.evaluate(async (data: { name: string; status: string }) => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          prompt: 'Test prompt for drag-drop testing',
          status: data.status,
        }),
      });
      return { status: res.status, data: await res.json() };
    }, { name, status });

    expect(response.status).toBe(201);
    const taskId = response.data.task?.id || response.data.id;

    // Reload to ensure task appears in UI
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    return taskId;
  }

  /**
   * Helper: Get the column element for a given status
   */
  function getColumn(page: Page, status: string) {
    return page.locator(`[data-status="${status}"]`);
  }

  /**
   * Helper: Get a task card by task name
   */
  function getTaskCard(page: Page, taskName: string) {
    return page.locator('.task-card').filter({ hasText: taskName }).first();
  }

  /**
   * Helper: Wait for toast message
   */
  async function waitForToast(page: Page, expectedText: string, variant?: 'error' | 'success'): Promise<void> {
    const toastSelector = variant
      ? `div[class*="${variant === 'error' ? 'accent-danger' : 'accent-success'}"]`
      : 'div[class*="animate-slide-in"]';

    const toast = page.locator(toastSelector).filter({ hasText: expectedText });
    await expect(toast).toBeVisible({ timeout: 5000 });
  }

  /**
   * Helper: Simulate drag and drop using HTML5 Drag and Drop API
   */
  async function dragAndDrop(
    page: Page,
    sourceCard: ReturnType<typeof getTaskCard>,
    targetColumn: ReturnType<typeof getColumn>
  ): Promise<void> {
    // Get the bounding boxes for both elements
    const sourceBox = await sourceCard.boundingBox();
    const targetBox = await targetColumn.boundingBox();

    if (!sourceBox || !targetBox) {
      throw new Error('Could not get bounding boxes for drag and drop');
    }

    // Start drag from source
    await sourceCard.dispatchEvent('dragstart');

    // Move to target and trigger dragover
    await targetColumn.dispatchEvent('dragover', {
      dataTransfer: {},
      bubbles: true,
      cancelable: true,
    });

    // Trigger drop on target
    await targetColumn.dispatchEvent('drop', {
      dataTransfer: {},
      bubbles: true,
      cancelable: true,
    });

    // Trigger dragend on source
    await sourceCard.dispatchEvent('dragend');

    // Wait a moment for the UI to update
    await page.waitForTimeout(500);
  }

  test('attempting to drag task to code-style column shows error toast', async ({ page }) => {
    const taskName = `Drag to Code Style Test ${Date.now()}`;

    // Create a task in review status (valid source for trying to drop to code-style)
    await createTaskWithStatus(page, taskName, 'review');

    // Verify task is visible in review column
    const reviewColumn = getColumn(page, 'review');
    const taskCard = getTaskCard(page, taskName);
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Verify task has the correct status
    const taskStatus = await taskCard.getAttribute('data-task-status');
    expect(taskStatus).toBe('review');

    // Attempt to drag to code-style column
    const codeStyleColumn = getColumn(page, 'code-style');
    await dragAndDrop(page, taskCard, codeStyleColumn);

    // Verify error toast appears with correct message
    await waitForToast(page, 'Code Style column is workflow-managed', 'error');

    // Verify task is still in review column (not moved)
    const taskInReview = reviewColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInReview).toBeVisible({ timeout: 5000 });

    // Cleanup: Archive the task
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] });
      await page.waitForTimeout(500);
    }

    console.log('✓ Code-style drop rejection works correctly');
  });

  test('attempting to drag from backlog to code-style shows error toast', async ({ page }) => {
    const taskName = `Backlog to Code Style Test ${Date.now()}`;

    // Create a task in backlog status
    await createTaskWithStatus(page, taskName, 'backlog');

    // Verify task is visible in backlog column
    const backlogColumn = getColumn(page, 'backlog');
    const taskCard = getTaskCard(page, taskName);
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Attempt to drag to code-style column
    const codeStyleColumn = getColumn(page, 'code-style');
    await dragAndDrop(page, taskCard, codeStyleColumn);

    // Verify error toast appears
    await waitForToast(page, 'Code Style column is workflow-managed', 'error');

    // Verify task is still in backlog column
    const taskInBacklog = backlogColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInBacklog).toBeVisible({ timeout: 5000 });

    // Cleanup
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] });
    }

    console.log('✓ Backlog to code-style drop rejection works');
  });

  test('dragging from code-style to review column succeeds', async ({ page }) => {
    const taskName = `Code Style to Review Test ${Date.now()}`;

    // Create a task in code-style status
    await createTaskWithStatus(page, taskName, 'code-style');

    // Verify task is visible in code-style column
    const codeStyleColumn = getColumn(page, 'code-style');
    const taskCard = getTaskCard(page, taskName);
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Drag to review column
    const reviewColumn = getColumn(page, 'review');
    await dragAndDrop(page, taskCard, reviewColumn);

    // Wait for UI to update and reload
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Verify task is now in review column
    const taskInReview = reviewColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInReview).toBeVisible({ timeout: 10000 });

    // Verify task status attribute
    const movedCard = getTaskCard(page, taskName);
    const taskStatus = await movedCard.getAttribute('data-task-status');
    expect(taskStatus).toBe('review');

    // Cleanup
    const archiveButton = movedCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] });
    }

    console.log('✓ Drag from code-style to review works correctly');
  });

  test('dragging from code-style to done column succeeds', async ({ page }) => {
    const taskName = `Code Style to Done Test ${Date.now()}`;

    // Create a task in code-style status
    await createTaskWithStatus(page, taskName, 'code-style');

    // Verify task is visible in code-style column
    const codeStyleColumn = getColumn(page, 'code-style');
    const taskCard = getTaskCard(page, taskName);
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Drag to done column
    const doneColumn = getColumn(page, 'done');
    await dragAndDrop(page, taskCard, doneColumn);

    // Wait for UI to update
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Verify task is now in done column
    const taskInDone = doneColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInDone).toBeVisible({ timeout: 10000 });

    // Verify task status attribute
    const movedCard = getTaskCard(page, taskName);
    const taskStatus = await movedCard.getAttribute('data-task-status');
    expect(taskStatus).toBe('done');

    // Cleanup - archive from done column
    const archiveButton = movedCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] });
    }

    console.log('✓ Drag from code-style to done works correctly');
  });

  test('dragging from code-style to backlog column succeeds', async ({ page }) => {
    const taskName = `Code Style to Backlog Test ${Date.now()}`;

    // Create a task in code-style status
    await createTaskWithStatus(page, taskName, 'code-style');

    // Verify task is visible in code-style column
    const codeStyleColumn = getColumn(page, 'code-style');
    const taskCard = getTaskCard(page, taskName);
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Drag to backlog column
    const backlogColumn = getColumn(page, 'backlog');
    await dragAndDrop(page, taskCard, backlogColumn);

    // Wait for UI to update
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Verify task is now in backlog column
    const taskInBacklog = backlogColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInBacklog).toBeVisible({ timeout: 10000 });

    // Verify task status attribute
    const movedCard = getTaskCard(page, taskName);
    const taskStatus = await movedCard.getAttribute('data-task-status');
    expect(taskStatus).toBe('backlog');

    // Cleanup
    const archiveButton = movedCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] });
    }

    console.log('✓ Drag from code-style to backlog works correctly');
  });

  test('multiple attempts to drop on code-style all show error toast', async ({ page }) => {
    const taskName = `Multiple Code Style Attempts ${Date.now()}`;

    // Create task in review status
    await createTaskWithStatus(page, taskName, 'review');

    const taskCard = getTaskCard(page, taskName);
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    const codeStyleColumn = getColumn(page, 'code-style');

    // Attempt first drop
    await dragAndDrop(page, taskCard, codeStyleColumn);
    await waitForToast(page, 'Code Style column is workflow-managed', 'error');

    // Dismiss toast by clicking X
    const toastCloseButton = page.locator('div[class*="animate-slide-in"] button').first();
    if (await toastCloseButton.isVisible().catch(() => false)) {
      await toastCloseButton.click();
      await page.waitForTimeout(300);
    }

    // Attempt second drop
    await dragAndDrop(page, taskCard, codeStyleColumn);
    await waitForToast(page, 'Code Style column is workflow-managed', 'error');

    // Cleanup
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] });
    }

    console.log('✓ Multiple code-style drop attempts all rejected');
  });

  test('code-style column is visible and has correct data attribute', async ({ page }) => {
    const codeStyleColumn = getColumn(page, 'code-style');

    // Verify column exists and is visible
    await expect(codeStyleColumn).toBeVisible({ timeout: 5000 });

    // Verify data-status attribute
    const statusAttr = await codeStyleColumn.getAttribute('data-status');
    expect(statusAttr).toBe('code-style');

    // Verify column header text
    const columnHeader = codeStyleColumn.locator('.kanban-column-header');
    await expect(columnHeader).toBeVisible();

    console.log('✓ Code-style column is properly rendered');
  });
});
