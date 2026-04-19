import { test, expect } from '@playwright/test'

import { createTaskViaUI, getTaskCard, gotoKanban } from './ui-helpers'

test.describe('Task Modal Editing', () => {
  test('loads saved task details when reopening a newly created task', async ({ page }) => {
    const taskName = `Edit Modal Regression ${Date.now()}`
    const taskPrompt = 'Persist this prompt and reload it when the task is edited.'

    await gotoKanban(page)
    await createTaskViaUI(page, {
      name: taskName,
      prompt: taskPrompt,
      review: true,
      codeStyleReview: true,
    })

    const taskCard = getTaskCard(page, taskName)
    await taskCard.click()

    const modal = page.locator('.modal-overlay').last()
    await expect(page.getByRole('heading', { name: 'Edit Task' })).toBeVisible({ timeout: 10000 })
    await expect(modal.getByPlaceholder('Task name')).toHaveValue(taskName)
    await expect(modal.locator('.editor-content .ProseMirror').first()).toContainText(taskPrompt)

    const reviewLabel = modal.locator('label.checkbox-item').filter({ hasText: 'Review' }).first()
    await expect(reviewLabel.locator('input[type="checkbox"]').first()).toBeChecked()

    const codeStyleReviewLabel = modal.locator('label.checkbox-item').filter({ hasText: 'Code Style Review (after review)' }).first()
    await expect(codeStyleReviewLabel.locator('input[type="checkbox"]').first()).toBeChecked()
  })
})