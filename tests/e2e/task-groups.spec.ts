import { test, expect } from '@playwright/test'

import { createTaskViaUI, ctrlArchiveTask, getTaskCard, gotoKanban } from './ui-helpers'

test.describe('Task Groups', () => {
  test.beforeEach(async ({ page }) => {
    await gotoKanban(page)
  })

  test('creates a group from selected tasks and opens its panel', async ({ page }) => {
    const timestamp = Date.now()
    const firstTask = `group-a-${timestamp}`
    const secondTask = `group-b-${timestamp}`
    const groupName = `group-${timestamp}`

    await createTaskViaUI(page, {
      name: firstTask,
      prompt: 'First task used to create a virtual workflow.',
    })
    await createTaskViaUI(page, {
      name: secondTask,
      prompt: 'Second task used to create a virtual workflow.',
    })

    await getTaskCard(page, firstTask).click({ modifiers: ['Control'] })
    await getTaskCard(page, secondTask).click({ modifiers: ['Control'] })

    const actionBar = page.getByRole('toolbar', { name: /2 tasks selected/ })
    await expect(actionBar).toBeVisible()
    await actionBar.getByRole('button', { name: 'Create Group' }).click()

    const modal = page.locator('.modal-overlay').last()
    await expect(modal.getByRole('heading', { name: 'Create Task Group' })).toBeVisible()
    await modal.getByPlaceholder('Enter group name...').fill(groupName)
    await modal.getByRole('button', { name: 'Create Group' }).click()
    await expect(page.locator('.animate-slide-in').filter({ hasText: `Group "${groupName}" created successfully` }).first()).toBeVisible({ timeout: 10000 })

    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await expect(virtualCard).toBeVisible({ timeout: 10000 })
    await expect(virtualCard).toContainText('2 tasks')

    await virtualCard.click()

    const groupPanel = page.getByRole('complementary', { name: `Group panel: ${groupName}` })
    await expect(groupPanel).toBeVisible({ timeout: 10000 })
    await expect(groupPanel).toContainText(firstTask)
    await expect(groupPanel).toContainText(secondTask)

    await groupPanel.getByRole('button', { name: 'Close group panel (Escape)' }).click()
    await expect(groupPanel).not.toBeVisible({ timeout: 10000 })

    await virtualCard.locator('button[title="Delete group"]').click({ modifiers: ['Control'] })
    await expect(virtualCard).not.toBeVisible({ timeout: 10000 })

    await ctrlArchiveTask(page, firstTask)
    await ctrlArchiveTask(page, secondTask)
  })

  test('clears the multi-select action bar without creating a group', async ({ page }) => {
    const timestamp = Date.now()
    const firstTask = `clear-a-${timestamp}`
    const secondTask = `clear-b-${timestamp}`

    await createTaskViaUI(page, {
      name: firstTask,
      prompt: 'First task for selection clearing.',
    })
    await createTaskViaUI(page, {
      name: secondTask,
      prompt: 'Second task for selection clearing.',
    })

    await getTaskCard(page, firstTask).click({ modifiers: ['Control'] })
    await getTaskCard(page, secondTask).click({ modifiers: ['Control'] })

    const actionBar = page.getByRole('toolbar', { name: /2 tasks selected/ })
    await expect(actionBar).toBeVisible()
    await page.getByRole('button', { name: 'Clear selection' }).click()
    await expect(actionBar).not.toBeVisible({ timeout: 10000 })

    await ctrlArchiveTask(page, firstTask)
    await ctrlArchiveTask(page, secondTask)
  })
})