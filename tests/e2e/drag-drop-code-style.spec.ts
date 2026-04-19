import { test, expect } from '@playwright/test'

import { createTaskViaUI, ctrlArchiveTask, getColumn, getTaskCard, gotoKanban, waitForToast } from './ui-helpers'

test.describe('Code Style Column Restrictions', () => {
  test.beforeEach(async ({ page }) => {
    await gotoKanban(page)
  })

  async function attemptDropOnCodeStyle(page: import('@playwright/test').Page, taskName: string): Promise<void> {
    const taskCard = getTaskCard(page, taskName)
    const codeStyleColumn = getColumn(page, 'code-style')

    await taskCard.dispatchEvent('dragstart')
    await codeStyleColumn.dispatchEvent('dragover', { bubbles: true, cancelable: true })
    await codeStyleColumn.dispatchEvent('drop', { bubbles: true, cancelable: true })
    await taskCard.dispatchEvent('dragend')
  }

  test('renders the code-style column', async ({ page }) => {
    const codeStyleColumn = getColumn(page, 'code-style')
    await expect(codeStyleColumn).toBeVisible()
    await expect(codeStyleColumn.locator('.kanban-column-header')).toContainText('Code Style')
  })

  test('rejects dragging a backlog task into the code-style column', async ({ page }) => {
    const taskName = `code-style-dnd-${Date.now()}`
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Use this task to verify that the code-style column is workflow-managed.',
    })

    await attemptDropOnCodeStyle(page, taskName)
    await waitForToast(page, 'Code Style column is workflow-managed')
    await expect(getColumn(page, 'backlog').locator('.task-card').filter({ hasText: taskName })).toBeVisible()

    await ctrlArchiveTask(page, taskName)
  })
})