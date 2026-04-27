import { expect, type Locator, type Page } from '@playwright/test'

type TaskModalOptions = {
  name: string
  prompt: string
  createStatus?: 'backlog' | 'template'
  review?: boolean
  planMode?: boolean
  autoApprovePlan?: boolean
  codeStyleReview?: boolean
  requirements?: string[]
}

export async function gotoKanban(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 30000 })
}

export function getColumn(page: Page, status: string): Locator {
  return page.locator(`[data-status="${status}"]`)
}

export function getTaskCard(page: Page, taskName: string): Locator {
  return page.locator('.task-card').filter({ hasText: taskName }).first()
}

export async function openTaskModal(page: Page, createStatus: 'backlog' | 'template' = 'backlog'): Promise<Locator> {
  const buttonName = createStatus === 'template' ? 'New Template' : 'New Task'
  const headingName = createStatus === 'template' ? 'Add Template' : 'Add Task'

  await page.getByRole('button', { name: buttonName }).click()
  await expect(page.getByRole('heading', { name: headingName })).toBeVisible({ timeout: 15000 })

  const modal = page.locator('.modal-overlay').last()
  const branchGroup = modal.locator('.form-group').filter({ hasText: 'Branch' }).first()
  const branchSelect = branchGroup.locator('select.form-select').first()

  await expect(branchSelect).toBeVisible({ timeout: 15000 })
  await expect.poll(async () => branchSelect.inputValue(), { 
    timeout: 15000,
    intervals: [100, 200, 500, 1000]
  }).not.toBe('')

  return modal
}

export async function createTaskViaUI(page: Page, options: TaskModalOptions): Promise<Locator> {
  const modal = await openTaskModal(page, options.createStatus ?? 'backlog')

  await modal.getByPlaceholder('Task name').fill(options.name)

  const promptEditor = modal.locator('.editor-content .ProseMirror').first()
  await expect(promptEditor).toBeVisible({ timeout: 15000 })
  await promptEditor.click()
  await promptEditor.fill(options.prompt)

  if (options.planMode !== undefined) {
    await setCheckboxState(modal, 'Plan Mode', options.planMode)
  }

  if (options.autoApprovePlan !== undefined) {
    await setCheckboxState(modal, 'Auto-approve plan', options.autoApprovePlan)
  }

  if (options.review !== undefined) {
    await setCheckboxState(modal, 'Review', options.review)
  }

  if (options.codeStyleReview !== undefined) {
    if (options.codeStyleReview) {
      await setCheckboxState(modal, 'Review', true)
    }
    await setCheckboxState(modal, 'Code Style Review (after review)', options.codeStyleReview)
  }

  if (options.requirements && options.requirements.length > 0) {
    const requirementsGroup = modal.locator('.form-group').filter({ hasText: 'Requirements (dependencies)' }).first()

    for (const requirementName of options.requirements) {
      const requirementLabel = requirementsGroup.locator('label.checkbox-item').filter({ hasText: requirementName }).first()
      await expect(requirementLabel).toBeVisible({ timeout: 15000 })
      const checkbox = requirementLabel.locator('input[type="checkbox"]').first()
      if (!(await checkbox.isChecked())) {
        await requirementLabel.click()
      }
    }
  }

  const saveButtonText = options.createStatus === 'template' ? 'Save Template' : 'Save'
  await modal.getByRole('button', { name: saveButtonText }).click()
  await expect(modal).not.toBeVisible({ timeout: 15000 })

  // Wait a moment for the card to appear in the DOM
  await page.waitForTimeout(500)
  
  const taskCard = getTaskCard(page, options.name)
  await expect(taskCard).toBeVisible({ timeout: 20000 })
  return taskCard
}

export async function ctrlArchiveTask(page: Page, taskName: string): Promise<void> {
  const taskCard = getTaskCard(page, taskName)
  await expect(taskCard).toBeVisible({ timeout: 10000 })

  const archiveButton = taskCard.locator('button[title*="Archive"], button[title*="Delete Task"]').first()
  await expect(archiveButton).toBeVisible({ timeout: 5000 })
  await archiveButton.click({ modifiers: ['Control'] })

  await expect(taskCard).not.toBeVisible({ timeout: 10000 })
}

export async function waitForToast(page: Page, message: string | RegExp): Promise<Locator> {
  const toast = page.locator('.animate-slide-in, [class*="animate-slide-in"], div[role="alert"], .toast').filter({ hasText: message }).first()
  await expect(toast).toBeVisible({ timeout: 10000 })
  return toast
}

async function setCheckboxState(modal: Locator, labelText: string, checked: boolean): Promise<void> {
  const label = modal.locator('label.checkbox-item').filter({ hasText: labelText }).first()
  const checkbox = label.locator('input[type="checkbox"]').first()

  await expect(checkbox).toBeVisible({ timeout: 5000 })

  if ((await checkbox.isChecked()) !== checked) {
    await label.click()
  }
}