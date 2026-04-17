/**
 * E2E Tests: Confirmation Dialog Functionality
 *
 * Tests the confirmation dialog for destructive actions:
 * - Delete task confirmation
 * - Convert to template confirmation
 * - Ctrl+click bypass functionality
 * - Cancel functionality
 *
 * All interactions through the web UI only.
 */

import { test, expect, Page } from "@playwright/test';
import { randomUUID } from "crypto';

test.describe('Confirmation Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give Vue app time to mount
    await page.waitForTimeout(2000);
  });

  /**
   * Helper: Create a task via Web UI
   */
  async function createTaskViaUI(page: Page, data: {
    name: string;
    prompt: string;
    status?: 'backlog' | 'template';
  }): Promise<string> {
    const status = data.status || 'backlog';
    const columnSelector = `[data-status="${status}"]`;

    const column = page.locator(columnSelector);
    await expect(column).toBeVisible({ timeout: 10000 });

    const addTaskButton = column.locator('button.add-task-btn, button:has-text("+ Add Task")').first();
    await expect(addTaskButton).toBeVisible({ timeout: 10000 });
    await addTaskButton.click();

    await page.waitForSelector('.modal-overlay', { timeout: 10000 });
    await page.waitForSelector('input[placeholder="Task name"]', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Fill name
    const nameInput = page.locator('input[placeholder="Task name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill(data.name);

    // Fill prompt using ProseMirror editor
    const promptEditor = page.locator('.markdown-editor-content .ProseMirror').first();
    await expect(promptEditor).toBeVisible({ timeout: 5000 });
    await promptEditor.click();
    await promptEditor.fill(data.prompt);

    // Select a branch if needed
    const branchSelect = page.locator('select.form-select').first();
    if (await branchSelect.isVisible().catch(() => false)) {
      const branchValue = await branchSelect.inputValue();
      if (!branchValue) {
        const options = branchSelect.locator('option:not([value=""])');
        const firstOptionValue = await options.first().getAttribute('value');
        if (firstOptionValue) {
          await branchSelect.selectOption(firstOptionValue);
        }
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
    await saveResponsePromise;

    await page.waitForTimeout(1500);

    // Reload to ensure task appears
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Verify task appears
    const taskCard = page.locator('.task-card').filter({ hasText: data.name }).first();
    await expect(taskCard).toBeVisible({ timeout: 15000 });

    return data.name;
  }

  test('archiving a task shows confirmation dialog', async ({ page }) => {
    const taskName = `Archive Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for archive confirmation',
      status: 'backlog',
    });

    // Find the archive button (trash icon) on the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Find the archive button by its title
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    await expect(archiveButton).toBeVisible({ timeout: 5000 });

    // Click archive (without Ctrl - should show confirmation)
    await archiveButton.click();

    // Wait for confirmation modal
    const confirmModal = page.locator('.modal-overlay').filter({ hasText: /Delete Task|Convert to Template/ });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });

    // Verify modal content
    const modalTitle = confirmModal.locator('h3.modal-title');
    await expect(modalTitle).toBeVisible();
    const titleText = await modalTitle.textContent();
    expect(titleText).toMatch(/Delete Task|Convert to Template/);

    // Verify the task name is mentioned in the modal
    const modalBody = confirmModal.locator('.modal-body');
    await expect(modalBody).toContainText(taskName);

    // Click Cancel
    const cancelButton = confirmModal.locator('button').filter({ hasText: 'Cancel' }).first();
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    // Verify modal closes
    await expect(confirmModal).not.toBeVisible({ timeout: 5000 });

    // Verify task still exists
    await expect(taskCard).toBeVisible({ timeout: 5000 });

    console.log('✓ Archive confirmation dialog shows correctly');
  });

  test('Ctrl+click bypasses archive confirmation dialog', async ({ page }) => {
    const taskName = `Ctrl Archive Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for Ctrl+archive',
      status: 'backlog',
    });

    // Find the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Find the archive button
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    await expect(archiveButton).toBeVisible({ timeout: 5000 });

    // Click archive with Ctrl held (should bypass confirmation)
    await archiveButton.click({ modifiers: ['Control'] });

    // Wait a moment for the archive to process
    await page.waitForTimeout(2000);

    // Verify task is archived (no longer visible in backlog)
    // Note: We check for the specific task card to not be visible in the column
    const backlogColumn = page.locator('[data-status="backlog"]');
    const taskInBacklog = backlogColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInBacklog).not.toBeVisible({ timeout: 5000 });

    console.log('✓ Ctrl+click bypasses archive confirmation');
  });

  test('converting task to template shows confirmation dialog', async ({ page }) => {
    const taskName = `Convert Test ${randomUUID().slice(0, 8)}`;

    // Create a task in backlog
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for convert confirmation',
      status: 'backlog',
    });

    // Find the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Find the convert to template button
    const convertButton = taskCard.locator('button[title*="Convert"], button[title*="convert"], button[title*="Template"]').first();
    await expect(convertButton).toBeVisible({ timeout: 5000 });

    // Click convert (without Ctrl - should show confirmation)
    await convertButton.click();

    // Wait for confirmation modal
    const confirmModal = page.locator('.modal-overlay').filter({ hasText: 'Convert to Template' });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });

    // Verify modal content
    const modalTitle = confirmModal.locator('h3.modal-title');
    await expect(modalTitle).toHaveText('Convert to Template');

    // Verify the task name is mentioned
    const modalBody = confirmModal.locator('.modal-body');
    await expect(modalBody).toContainText(taskName);

    // Click Cancel
    const cancelButton = confirmModal.locator('button').filter({ hasText: 'Cancel' }).first();
    await cancelButton.click();

    // Verify modal closes and task still in backlog
    await expect(confirmModal).not.toBeVisible({ timeout: 5000 });
    await expect(taskCard).toBeVisible({ timeout: 5000 });

    console.log('✓ Convert to template confirmation dialog shows correctly');
  });

  test('Ctrl+click bypasses convert to template confirmation', async ({ page }) => {
    const taskName = `Ctrl Convert Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for Ctrl+convert',
      status: 'backlog',
    });

    // Find the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Find the convert to template button
    const convertButton = taskCard.locator('button[title*="Convert"], button[title*="convert"], button[title*="Template"]').first();
    await expect(convertButton).toBeVisible({ timeout: 5000 });

    // Click convert with Ctrl held
    await convertButton.click({ modifiers: ['Control'] });

    // Wait for the conversion to process
    await page.waitForTimeout(2000);

    // Reload to ensure state is updated
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Verify task is now in template column
    const templateColumn = page.locator('[data-status="template"]');
    const taskInTemplate = templateColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInTemplate).toBeVisible({ timeout: 10000 });

    console.log('✓ Ctrl+click bypasses convert to template confirmation');
  });

  test('confirmation dialog can be closed by clicking overlay', async ({ page }) => {
    const taskName = `Overlay Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for overlay close',
      status: 'backlog',
    });

    // Find the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Click archive to trigger confirmation
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    await archiveButton.click();

    // Wait for confirmation modal
    const confirmModal = page.locator('.modal-overlay').filter({ hasText: 'Delete Task' });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });

    // Click on the overlay (outside the modal container)
    await confirmModal.click({ position: { x: 5, y: 5 } });

    // Verify modal closes
    await page.waitForTimeout(500);
    await expect(confirmModal).not.toBeVisible({ timeout: 5000 });

    // Verify task still exists
    await expect(taskCard).toBeVisible({ timeout: 5000 });

    console.log('✓ Confirmation dialog closes on overlay click');
  });

  test('confirming delete action archives the task', async ({ page }) => {
    const taskName = `Confirm Delete Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for confirm delete',
      status: 'backlog',
    });

    // Find the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Click archive
    const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="archive"]').first();
    await archiveButton.click();

    // Wait for confirmation modal
    const confirmModal = page.locator('.modal-overlay').filter({ hasText: 'Delete Task' });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });

    // Click the Delete button (btn-danger)
    const deleteButton = confirmModal.locator('button.btn-danger, button:has-text("Delete")').first();
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // Wait for archive to complete
    await page.waitForTimeout(2000);

    // Verify task is no longer in backlog
    const backlogColumn = page.locator('[data-status="backlog"]');
    const taskInBacklog = backlogColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInBacklog).not.toBeVisible({ timeout: 5000 });

    console.log('✓ Confirming delete action archives the task');
  });

  test('task card displays task ID badge', async ({ page }) => {
    const taskName = `ID Badge Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for ID badge',
      status: 'backlog',
    });

    // Find the task card
    const taskCard = page.locator('.task-card').filter({ hasText: taskName }).first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // Look for the task ID badge (e.g., #1, #2, etc.)
    const idBadge = taskCard.locator('.task-id-badge');
    await expect(idBadge).toBeVisible({ timeout: 5000 });

    // Verify it contains a # followed by a number
    const badgeText = await idBadge.textContent();
    expect(badgeText).toMatch(/#\d+/);

    console.log(`✓ Task ID badge displays correctly: ${badgeText}`);
  });
});
