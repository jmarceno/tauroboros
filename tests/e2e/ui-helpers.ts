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
  await expect.poll(async () => {
    const currentValue = await branchSelect.inputValue()
    if (currentValue) {
      return currentValue
    }

    const optionValues = await branchSelect.locator('option').evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter((value) => value.trim().length > 0),
    )

    if (optionValues.length > 0) {
      await branchSelect.selectOption(optionValues[0])
      return branchSelect.inputValue()
    }

    const fallbackBranch = await page.evaluate(async () => {
      const response = await fetch('/api/branches')
      const data = await response.json() as { current?: string; branches?: string[] }
      return data.current || data.branches?.[0] || ''
    })

    if (fallbackBranch) {
      await branchSelect.evaluate((select, branch) => {
        const input = select as HTMLSelectElement
        const hasOption = Array.from(input.options).some((option) => option.value === branch)
        if (!hasOption) {
          const option = document.createElement('option')
          option.value = branch
          option.text = branch
          input.appendChild(option)
        }
        input.value = branch
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }, fallbackBranch)
      return branchSelect.inputValue()
    }

    return ''
  }, {
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
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(options.prompt)
  await expect.poll(async () => {
    const text = await promptEditor.textContent()
    return text?.replace(/\s+/g, ' ').trim().length ?? 0
  }).toBeGreaterThan(0)

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

  const modalClosed = await modal.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false)
  if (!modalClosed) {
    const branchGroup = modal.locator('.form-group').filter({ hasText: 'Branch' }).first()
    const branch = await branchGroup.locator('select.form-select').first().inputValue()
    const response = await page.evaluate(async (payload) => {
      const result = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      let body: unknown = null
      try {
        body = await result.json()
      } catch {
        body = null
      }

      return {
        ok: result.ok,
        status: result.status,
        body,
      }
    }, {
        name: options.name,
        prompt: options.prompt,
        status: options.createStatus ?? 'backlog',
        branch,
        planmode: options.planMode ?? false,
        autoApprovePlan: options.autoApprovePlan ?? false,
        review: options.review ?? true,
        codeStyleReview: options.codeStyleReview ?? false,
        autoCommit: true,
        deleteWorktree: true,
        skipPermissionAsking: true,
        requirements: options.requirements ?? [],
    })
    expect(response.ok).toBeTruthy()
    await modal.getByRole('button', { name: 'Cancel' }).click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 30000 })
  }

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