import { test, expect } from '@playwright/test'

import { gotoKanban, openTaskModal } from './ui-helpers'

function saveOptionsButton(page: import('@playwright/test').Page) {
  return page.locator('button').filter({ hasText: 'Save Options' }).last()
}

test.describe('Options Tab', () => {
  test.beforeEach(async ({ page }) => {
    await gotoKanban(page)
    await page.getByRole('tab', { name: 'Options' }).click()
    await expect(page.getByRole('heading', { name: 'Options Configuration' })).toBeVisible({ timeout: 10000 })
  })

  test('persists numeric option changes after saving', async ({ page }) => {
    const parallelTasksInput = page.locator('.form-group').filter({ hasText: 'Parallel Tasks' }).locator('input[type="number"]').first()
    const maxReviewsInput = page.locator('.form-group').filter({ hasText: 'Maximum Review Runs' }).locator('input[type="number"]').first()

    const originalParallelTasks = await parallelTasksInput.inputValue()
    const originalMaxReviews = await maxReviewsInput.inputValue()

    const nextParallelTasks = originalParallelTasks === '1' ? '2' : '1'
    const nextMaxReviews = originalMaxReviews === '2' ? '3' : '2'

    await parallelTasksInput.fill(nextParallelTasks)
    await maxReviewsInput.fill(nextMaxReviews)
    await saveOptionsButton(page).click()
    await expect(page.getByText('Options saved successfully')).toBeVisible({ timeout: 10000 })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.getByRole('tab', { name: 'Options' }).click()

    const reloadedParallelTasksInput = page.locator('.form-group').filter({ hasText: 'Parallel Tasks' }).locator('input[type="number"]').first()
    const reloadedMaxReviewsInput = page.locator('.form-group').filter({ hasText: 'Maximum Review Runs' }).locator('input[type="number"]').first()

    await expect(reloadedParallelTasksInput).toHaveValue(nextParallelTasks)
    await expect(reloadedMaxReviewsInput).toHaveValue(nextMaxReviews)

    await reloadedParallelTasksInput.fill(originalParallelTasks)
    await reloadedMaxReviewsInput.fill(originalMaxReviews)
    await saveOptionsButton(page).click()
    await expect(page.getByText('Options saved successfully')).toBeVisible({ timeout: 10000 })
  })

  test('uses the saved default branch in the new task modal', async ({ page }) => {
    const branchSelect = page.locator('.form-group').filter({ hasText: 'Default Branch' }).locator('select').first()
    const optionValues = await branchSelect.locator('option:not([disabled])').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter(Boolean)
    )

    expect(optionValues.length).toBeGreaterThan(1)

    const originalBranch = await branchSelect.inputValue()
    const nextBranch = optionValues.find((branch) => branch !== originalBranch)

    expect(nextBranch).toBeTruthy()

    await branchSelect.selectOption(nextBranch!)
    await saveOptionsButton(page).click()
    await expect(page.getByText('Options saved successfully')).toBeVisible({ timeout: 10000 })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.getByRole('tab', { name: 'Kanban' }).click()

    const modal = await openTaskModal(page)
    const taskBranchSelect = modal.locator('.form-group').filter({ hasText: 'Branch' }).locator('select.form-select').first()
    await expect(taskBranchSelect).toHaveValue(nextBranch!)

    await modal.getByRole('button', { name: 'Cancel' }).click()
    await expect(modal).not.toBeVisible({ timeout: 10000 })

    await page.getByRole('tab', { name: 'Options' }).click()
    const restoredBranchSelect = page.locator('.form-group').filter({ hasText: 'Default Branch' }).locator('select').first()
    await restoredBranchSelect.selectOption(originalBranch)
    await saveOptionsButton(page).click()
    await expect(page.getByText('Options saved successfully')).toBeVisible({ timeout: 10000 })
  })
})