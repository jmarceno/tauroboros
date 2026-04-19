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

import { test, expect } from '@playwright/test'
import { randomUUID } from "crypto"

import { createTaskViaUI, getTaskCard, getColumn, gotoKanban } from './ui-helpers'

test.describe('Confirmation Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await gotoKanban(page)
  });

  async function openDeleteConfirm(page: import('@playwright/test').Page, taskName: string) {
    const taskCard = getTaskCard(page, taskName)
    await expect(taskCard).toBeVisible({ timeout: 10000 })

    const deleteButton = taskCard.locator('button[title*="Delete Task"]').first()
    await expect(deleteButton).toBeVisible({ timeout: 5000 })
    await deleteButton.click()

    const modal = page.locator('.modal-overlay').last()
    await expect(modal.getByRole('heading', { name: 'Confirm Delete' })).toBeVisible({ timeout: 5000 })
    return modal
  }

  async function openConvertConfirm(page: import('@playwright/test').Page, taskName: string) {
    const taskCard = getTaskCard(page, taskName)
    await expect(taskCard).toBeVisible({ timeout: 10000 })

    const convertButton = taskCard.locator('button[title*="Convert to Template"]').first()
    await expect(convertButton).toBeVisible({ timeout: 5000 })
    await convertButton.click()

    const modal = page.locator('.modal-overlay').last()
    await expect(modal.getByRole('heading', { name: 'Convert to Template' })).toBeVisible({ timeout: 5000 })
    return modal
  }

  test('deleting a backlog task shows confirmation dialog', async ({ page }) => {
    const taskName = `Archive Test ${randomUUID().slice(0, 8)}`;

    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for archive confirmation',
    });

    const confirmModal = await openDeleteConfirm(page, taskName)
    await expect(confirmModal.locator('.modal-body')).toContainText(taskName)

    await confirmModal.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirmModal).not.toBeVisible({ timeout: 5000 })
    await expect(getTaskCard(page, taskName)).toBeVisible({ timeout: 5000 })

    console.log('✓ Archive confirmation dialog shows correctly');
  });

  test('Ctrl+click bypasses archive confirmation dialog', async ({ page }) => {
    const taskName = `Ctrl Archive Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for Ctrl+archive',
    });

    const taskCard = getTaskCard(page, taskName)
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    const deleteButton = taskCard.locator('button[title*="Delete Task"]').first()
    await expect(deleteButton).toBeVisible({ timeout: 5000 })

    await deleteButton.click({ modifiers: ['Control'] });
    await page.waitForTimeout(2000);

    await expect(getColumn(page, 'backlog').locator('.task-card').filter({ hasText: taskName })).not.toBeVisible({ timeout: 5000 });

    console.log('✓ Ctrl+click bypasses archive confirmation');
  });

  test('converting task to template shows confirmation dialog', async ({ page }) => {
    const taskName = `Convert Test ${randomUUID().slice(0, 8)}`;

    // Create a task in backlog
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for convert confirmation',
    });

    const confirmModal = await openConvertConfirm(page, taskName)
    await expect(confirmModal.locator('.modal-body')).toContainText(taskName)

    await confirmModal.getByRole('button', { name: 'Cancel' }).click()

    await expect(confirmModal).not.toBeVisible({ timeout: 5000 });
    await expect(getTaskCard(page, taskName)).toBeVisible({ timeout: 5000 });

    console.log('✓ Convert to template confirmation dialog shows correctly');
  });

  test('Ctrl+click bypasses convert to template confirmation', async ({ page }) => {
    const taskName = `Ctrl Convert Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for Ctrl+convert',
    });

    const taskCard = getTaskCard(page, taskName)
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    const convertButton = taskCard.locator('button[title*="Convert to Template"]').first()
    await expect(convertButton).toBeVisible({ timeout: 5000 })
    await convertButton.click({ modifiers: ['Control'] });

    await page.waitForTimeout(2000);

    const templateColumn = page.locator('[data-status="template"]');
    const taskInTemplate = templateColumn.locator('.task-card').filter({ hasText: taskName });
    await expect(taskInTemplate).toBeVisible({ timeout: 10000 });

    const archiveButton = taskInTemplate.locator('button[title*="Archive Task"]').first()
    if (await archiveButton.isVisible().catch(() => false)) {
      await archiveButton.click({ modifiers: ['Control'] })
    }

    console.log('✓ Ctrl+click bypasses convert to template confirmation');
  });

  test('confirmation dialog can be closed by clicking overlay', async ({ page }) => {
    const taskName = `Overlay Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for overlay close',
    });

    const confirmModal = await openDeleteConfirm(page, taskName)
    await confirmModal.click({ position: { x: 5, y: 5 } });

    await page.waitForTimeout(500);
    await expect(confirmModal).not.toBeVisible({ timeout: 5000 });
    await expect(getTaskCard(page, taskName)).toBeVisible({ timeout: 5000 });

    console.log('✓ Confirmation dialog closes on overlay click');
  });

  test('confirming delete action archives the task', async ({ page }) => {
    const taskName = `Confirm Delete Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for confirm delete',
    });

    const confirmModal = await openDeleteConfirm(page, taskName)
    const deleteButton = confirmModal.locator('button.btn-danger, button:has-text("Delete")').first();
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    await page.waitForTimeout(2000);

    await expect(getColumn(page, 'backlog').locator('.task-card').filter({ hasText: taskName })).not.toBeVisible({ timeout: 5000 });

    console.log('✓ Confirming delete action archives the task');
  });

  test('task card displays task ID badge', async ({ page }) => {
    const taskName = `ID Badge Test ${randomUUID().slice(0, 8)}`;

    // Create a task
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Test prompt for ID badge',
    });

    const taskCard = getTaskCard(page, taskName)
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
