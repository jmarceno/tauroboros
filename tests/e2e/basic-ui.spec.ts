import { test, expect } from '@playwright/test'

import { createTaskViaUI, ctrlArchiveTask, getColumn, gotoKanban } from './ui-helpers'

test.describe('Basic UI Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await gotoKanban(page)
  })

  test('loads the application shell and kanban board', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Start Workflow' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Planning Chat' })).toBeVisible()

    for (const status of ['template', 'backlog', 'executing', 'review', 'code-style', 'done']) {
      await expect(getColumn(page, status)).toBeVisible()
    }

    const shortcutTexts = await page.locator('kbd').allTextContents()
    expect(shortcutTexts).toEqual(expect.arrayContaining(['T', 'B', 'P', 'Esc']))
  })

  test('switches between the primary application tabs', async ({ page }) => {
    await page.getByRole('tab', { name: 'Options' }).click()
    await expect(page.getByRole('heading', { name: 'Options Configuration' })).toBeVisible()

    await page.getByRole('tab', { name: 'Archived' }).click()
    await expect(page.getByText('Archived Tasks').first()).toBeVisible()

    await page.getByRole('tab', { name: 'Stats' }).click()
    await expect(
      page.getByText('System Statistics').first().or(page.getByText('Failed to Load Statistics').first())
    ).toBeVisible()

    await page.getByRole('tab', { name: 'Self-Heal' }).click()
    await expect(page.getByRole('heading', { name: 'Self-Heal Reports' })).toBeVisible()

    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible()
  })

  test('creates a task from the modal and shows its task id badge', async ({ page }) => {
    const taskName = `basic-ui-${Date.now()}`
    const taskCard = await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Create a small note so the kanban shows a freshly added task.',
    })

    await expect(taskCard.locator('.task-id-badge')).toHaveText(/#\d+/)
    await ctrlArchiveTask(page, taskName)
  })

  test('opens and closes the planning chat panel', async ({ page }) => {
    await page.getByRole('button', { name: 'Planning Chat' }).click()
    await expect(page.getByText('No active chat sessions')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start New Chat' })).toBeVisible()

    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(page.getByText('No active chat sessions')).not.toBeVisible()
  })

  test('shows newly created tasks in the backlog column', async ({ page }) => {
    const taskName = `backlog-visibility-${Date.now()}`
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Verify that new tasks appear in the backlog column.',
    })

    await expect(getColumn(page, 'backlog').locator('.task-card').filter({ hasText: taskName })).toBeVisible()
    await ctrlArchiveTask(page, taskName)
  })
})