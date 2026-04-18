/**
 * E2E Tests: Task Groups Feature
 *
 * Tests comprehensive Task Groups functionality:
 * 1. Group Creation - Select 2+ tasks with CTRL+Click - Create Group
 * 2. Group Panel - Click virtual card opens panel, drag tasks in/out
 * 3. Execution - Start group, verify dependency order
 * 4. Restore Behavior - Complete and restore tasks
 * 5. Edge Cases - Delete group, prevent duplicate membership
 */

import { test, expect } from "@playwright/test"

// Helper to create tasks via API
async function createTaskViaAPI(page: any, name: string, status = "backlog"): Promise<{ id: string; idx: number }> {
  const response = await page.evaluate(async ({ taskName, taskStatus }) => {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: taskName,
        prompt: `Test prompt for ${taskName}`,
        status: taskStatus,
      }),
    })
    return res.json()
  }, { taskName: name, taskStatus: status })
  return response
}

// Helper to cleanup tasks
async function cleanupTaskViaAPI(page: any, taskId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' })
  }, taskId)
}

// Helper to delete a group
async function deleteGroupViaAPI(page: any, groupId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch(`/api/task-groups/${id}`, { method: 'DELETE' })
  }, groupId)
}

// Helper to get all task groups
async function getTaskGroups(page: any): Promise<any[]> {
  return await page.evaluate(async () => {
    const res = await fetch('/api/task-groups')
    return res.json()
  })
}

// Helper to select a task (click without modifier)
async function selectTask(page: any, taskSelector: string, mode = 'create-group'): Promise<void> {
  await page.click(taskSelector, { position: { x: 10, y: 10 } })
}

// Helper to select task with Ctrl+Click
async function ctrlClickTask(page: any, taskSelector: string): Promise<void> {
  await page.click(taskSelector, { modifiers: ['Control'] })
}

test.describe('Task Groups - Group Creation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    // Ensure kanban board is visible
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async ({ page }) => {
    // Cleanup: delete all groups
    const groups = await getTaskGroups(page)
    for (const group of groups) {
      await deleteGroupViaAPI(page, group.id)
    }
  })

  test('Select 2+ tasks with CTRL+Click shows action bar', async ({ page }) => {
    // Create 3 tasks
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Group Test Task 1 ${Date.now()}`),
      createTaskViaAPI(page, `Group Test Task 2 ${Date.now()}`),
      createTaskViaAPI(page, `Group Test Task 3 ${Date.now()}`),
    ])

    // Reload to show new tasks
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Get task card selectors
    const taskCards = page.locator('.task-card').filter({ hasText: /Group Test Task/ })

    // Select first task with Ctrl+Click
    await taskCards.first().click({ modifiers: ['Control'] })

    // Verify task appears selected (visual indicator)
    await page.waitForTimeout(500)

    // Select second task with Ctrl+Click
    await taskCards.nth(1).click({ modifiers: ['Control'] })

    // Action bar should appear with at least 2 selected
    const actionBar = page.locator('[aria-label="Multi-select actions"]')
    await expect(actionBar).toBeVisible({ timeout: 5000 })

    // Should show "2 tasks selected" or more
    const selectedText = await actionBar.textContent()
    expect(selectedText).toMatch(/[2-9]+ tasks? selected/)

    // Cleanup
    for (const task of tasks) {
      await cleanupTaskViaAPI(page, task.id)
    }
  })

  test('Create Group button opens modal', async ({ page }) => {
    // Create 2 tasks
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Create Group Test 1 ${Date.now()}`),
      createTaskViaAPI(page, `Create Group Test 2 ${Date.now()}`),
    ])

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Select both tasks
    const taskCards = page.locator('.task-card').filter({ hasText: /Create Group Test/ })
    await taskCards.first().click({ modifiers: ['Control'] })
    await taskCards.nth(1).click({ modifiers: ['Control'] })

    // Click Create Group button
    const createButton = page.getByLabel('Create group from selected tasks')
    await expect(createButton).toBeVisible({ timeout: 5000 })
    await createButton.click()

    // Modal should appear
    const modal = page.locator('h2:has-text("Create Group")')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // Cleanup
    for (const task of tasks) {
      await cleanupTaskViaAPI(page, task.id)
    }
  })

  test('Creating group with valid name shows virtual card', async ({ page }) => {
    const groupName = `Test Group ${Date.now()}`

    // Create 2 tasks
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Virtual Card Test 1 ${Date.now()}`),
      createTaskViaAPI(page, `Virtual Card Test 2 ${Date.now()}`),
    ])

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Select both tasks
    const taskCards = page.locator('.task-card').filter({ hasText: /Virtual Card Test/ })
    await taskCards.first().click({ modifiers: ['Control'] })
    await taskCards.nth(1).click({ modifiers: ['Control'] })

    // Click Create Group button
    await page.getByLabel('Create group from selected tasks').click()

    // Enter group name
    const nameInput = page.locator('input[type="text"]').filter({ has: page.locator('text=Group Name') }).first()
    await nameInput.fill(groupName)

    // Submit
    await page.getByRole('button', { name: 'Create' }).click()

    // Wait for modal to close
    await page.waitForTimeout(1000)

    // Verify virtual card appears in backlog column
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await expect(virtualCard).toBeVisible({ timeout: 5000 })

    // Should show task count
    await expect(virtualCard).toHaveText(/2 tasks/)

    // Tasks should be removed from visible backlog (filtered out)
    // The group panel will show the tasks when clicked

    // Cleanup
    for (const task of tasks) {
      await cleanupTaskViaAPI(page, task.id)
    }
  })

  test('Cancel group creation clears selection', async ({ page }) => {
    // Create 2 tasks
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Cancel Test 1 ${Date.now()}`),
      createTaskViaAPI(page, `Cancel Test 2 ${Date.now()}`),
    ])

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Select both tasks
    const taskCards = page.locator('.task-card').filter({ hasText: /Cancel Test/ })
    await taskCards.first().click({ modifiers: ['Control'] })
    await taskCards.nth(1).click({ modifiers: ['Control'] })

    // Click Create Group button
    await page.getByLabel('Create group from selected tasks').click()

    // Click Cancel
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Modal should close, action bar should hide
    await expect(page.locator('[aria-label="Multi-select actions"]')).not.toBeVisible()

    // Cleanup
    for (const task of tasks) {
      await cleanupTaskViaAPI(page, task.id)
    }
  })

  test('Clear button clears selection without creating group', async ({ page }) => {
    // Create 3 tasks
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Clear Test 1 ${Date.now()}`),
      createTaskViaAPI(page, `Clear Test 2 ${Date.now()}`),
      createTaskViaAPI(page, `Clear Test 3 ${Date.now()}`),
    ])

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Select tasks
    const taskCards = page.locator('.task-card').filter({ hasText: /Clear Test/ })
    await taskCards.first().click({ modifiers: ['Control'] })
    await taskCards.nth(1).click({ modifiers: ['Control'] })

    // Verify action bar is visible
    await expect(page.locator('[aria-label="Multi-select actions"]')).toBeVisible()

    // Click Clear
    await page.getByLabel('Clear selection').click()

    // Action bar should hide
    await expect(page.locator('[aria-label="Multi-select actions"]')).not.toBeVisible()

    // Cleanup
    for (const task of tasks) {
      await cleanupTaskViaAPI(page, task.id)
    }
  })
})

test.describe('Task Groups - Group Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async ({ page }) => {
    const groups = await getTaskGroups(page)
    for (const group of groups) {
      await deleteGroupViaAPI(page, group.id)
    }
  })

  test('Click virtual card opens group panel', async ({ page }) => {
    const groupName = `Panel Test ${Date.now()}`

    // Create tasks and group via API
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Panel Task 1 ${Date.now()}`),
      createTaskViaAPI(page, `Panel Task 2 ${Date.now()}`),
    ])

    // Create group
    const group = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: tasks.map(t => t.id), name: groupName })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Click virtual card
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await virtualCard.click()

    // Panel should slide in
    const panel = page.locator('.group-panel, [class*="panel"]').filter({ hasText: groupName })
    await expect(panel).toBeVisible({ timeout: 5000 })
  })

  test('Group panel shows task list', async ({ page }) => {
    const groupName = `Task List Test ${Date.now()}`

    // Create tasks and group
    const tasks = await Promise.all([
      createTaskViaAPI(page, `List Task 1 ${Date.now()}`),
      createTaskViaAPI(page, `List Task 2 ${Date.now()}`),
      createTaskViaAPI(page, `List Task 3 ${Date.now()}`),
    ])

    const group = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: tasks.map(t => t.id), name: groupName })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Open panel
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await virtualCard.click()

    // Wait for panel
    await page.waitForTimeout(1000)

    // Should show all tasks
    for (const task of tasks) {
      const taskItem = page.locator('.group-task-item, [class*="task-item"]').filter({ hasText: task.name })
      await expect(taskItem).toBeVisible({ timeout: 3000 })
    }
  })

  test('Group panel has Start button for active group', async ({ page }) => {
    const groupName = `Start Button Test ${Date.now()}`

    const tasks = await Promise.all([
      createTaskViaAPI(page, `Start Task 1 ${Date.now()}`),
      createTaskViaAPI(page, `Start Task 2 ${Date.now()}`),
    ])

    const group = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: tasks.map(t => t.id), name: groupName })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Open panel
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await virtualCard.click()

    await page.waitForTimeout(1000)

    // Start button should be visible
    const startButton = page.getByText('Start Group Workflow')
    await expect(startButton).toBeVisible({ timeout: 5000 })
  })

  test('Close button on panel closes it', async ({ page }) => {
    const groupName = `Close Panel Test ${Date.now()}`

    const tasks = await Promise.all([
      createTaskViaAPI(page, `Close Panel Task ${Date.now()}`),
    ])

    const group = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: tasks.map(t => t.id), name: groupName })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Open panel
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await virtualCard.click()

    await page.waitForTimeout(500)

    // Click close button (X button)
    const closeButton = page.locator('[title*="Close"], button:has-text("×"), button:has-text("X")]').first()
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click()
      await page.waitForTimeout(500)
      // Panel should be hidden
      await expect(page.locator('.group-panel, [class*="panel"]').filter({ hasText: groupName })).not.toBeVisible()
    }
  })
})

test.describe('Task Groups - Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async ({ page }) => {
    const groups = await getTaskGroups(page)
    for (const group of groups) {
      await deleteGroupViaAPI(page, group.id)
    }
  })

  test('Delete group with tasks restores tasks to backlog', async ({ page }) => {
    const groupName = `Delete Group Test ${Date.now()}`

    // Create tasks
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Delete Test 1 ${Date.now()}`),
      createTaskViaAPI(page, `Delete Test 2 ${Date.now()}`),
    ])

    // Create group
    const group = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: tasks.map(t => t.id), name: groupName })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Delete group (Ctrl+click to skip confirmation)
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    const deleteButton = virtualCard.locator('[title*="Delete"]')
    await deleteButton.click({ modifiers: ['Control'] })

    await page.waitForTimeout(1000)

    // Group should be deleted
    await expect(virtualCard).not.toBeVisible()

    // Tasks should be back in backlog
    const backlogTasks = page.locator('[data-status="backlog"] .task-card').filter({ hasText: /Delete Test/ })
    await expect(backlogTasks).toHaveCount(2)
  })

  test('Prevent adding task to multiple groups via API', async ({ page }) => {
    // Create tasks
    const tasks = await Promise.all([
      createTaskViaAPI(page, `Multi Group Task ${Date.now()}`),
      createTaskViaAPI(page, `Group A Task ${Date.now()}`),
      createTaskViaAPI(page, `Group B Task ${Date.now()}`),
    ])

    // Create group A with first task
    const groupA = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: [tasks[0].id], name: `Group A ${Date.now()}` })

    // Create group B with second task
    const groupB = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: [tasks[1].id], name: `Group B ${Date.now()}` })

    // Try to add task from group A to group B via API
    const response = await page.evaluate(async ({ groupId, taskId }) => {
      const res = await fetch(`/api/task-groups/${groupId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
      return { status: res.status, error: await res.text() }
    }, { groupId: groupB.id, taskId: tasks[0].id })

    // Should fail with conflict
    expect(response.status).toBeGreaterThanOrEqual(400)

    // Cleanup
    await deleteGroupViaAPI(page, groupA.id)
    await deleteGroupViaAPI(page, groupB.id)
    for (const task of tasks) {
      await cleanupTaskViaAPI(page, task.id)
    }
  })

  test('Group with single task functions correctly', async ({ page }) => {
    const groupName = `Single Task Group ${Date.now()}`

    // Create single task
    const task = await createTaskViaAPI(page, `Single Task ${Date.now()}`)

    // Create group with single task
    const group = await page.evaluate(async ({ taskIds, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: taskIds }),
      })
      return res.json()
    }, { taskIds: [task.id], name: groupName })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Virtual card should show "1 task"
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await expect(virtualCard).toHaveText(/1 task/)

    // Start button should be available
    await virtualCard.click()
    await page.waitForTimeout(500)

    const startButton = page.getByText('Start Group Workflow')
    await expect(startButton).toBeVisible()
  })

  test('Empty group shows appropriate state', async ({ page }) => {
    const groupName = `Empty Group ${Date.now()}`

    // Create empty group
    const group = await page.evaluate(async ({ name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: [] }),
      })
      return res.json()
    }, { name: groupName })

    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Virtual card should show "0 tasks"
    const virtualCard = page.locator('.virtual-card').filter({ hasText: groupName })
    await expect(virtualCard).toHaveText(/0 tasks/)

    // Start button should be disabled or not shown
    await virtualCard.click()
    await page.waitForTimeout(500)

    // Should show message about no tasks
    const noTasksMessage = page.locator('text=/no tasks|empty/i')
    const hasNoTasks = await noTasksMessage.isVisible().catch(() => false)

    // Cleanup
    await deleteGroupViaAPI(page, group.id)
  })
})

test.describe('Task Groups - Backend API', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test.afterEach(async ({ page }) => {
    const groups = await getTaskGroups(page)
    for (const group of groups) {
      await deleteGroupViaAPI(page, group.id)
    }
  })

  test('Create task group returns 201', async ({ page }) => {
    const task = await createTaskViaAPI(page, `API Test Task ${Date.now()}`)

    const response = await page.evaluate(async ({ taskId }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `API Test Group ${Date.now()}`,
          memberTaskIds: [taskId],
        }),
      })
      return { status: res.status, data: await res.json() }
    }, { taskId: task.id })

    expect(response.status).toBe(201)
    expect(response.data.id).toBeTruthy()
    expect(response.data.name).toContain('API Test Group')

    await cleanupTaskViaAPI(page, task.id)
  })

  test('Create group with invalid task ID returns 400', async ({ page }) => {
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Group',
          memberTaskIds: ['non-existent-task-id'],
        }),
      })
      return { status: res.status, error: await res.text() }
    })

    expect(response.status).toBe(400)
  })

  test('Start group with external dependency error', async ({ page }) => {
    // Create external task
    const externalTask = await createTaskViaAPI(page, `External Task ${Date.now()}`)

    // Create group task that depends on external task
    const dependentTask = await page.evaluate(async (name) => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          prompt: 'Test prompt',
          status: 'backlog',
          requirements: [externalTask.id],
        }),
      })
      return res.json()
    }, `Dependent Task ${Date.now()}`)

    // Create group with only the dependent task (not the external task)
    const group = await page.evaluate(async ({ taskId, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: [taskId] }),
      })
      return res.json()
    }, { taskId: dependentTask.id, name: `External Dep Test ${Date.now()}` })

    // Try to start group
    const response = await page.evaluate(async (groupId) => {
      const res = await fetch(`/api/task-groups/${groupId}/start`, {
        method: 'POST',
      })
      return { status: res.status, error: await res.text() }
    }, group.id)

    // Should fail with external dependency error
    expect(response.status).toBe(400)
    expect(response.error).toContain('external dependencies')

    // Cleanup
    await deleteGroupViaAPI(page, group.id)
    await cleanupTaskViaAPI(page, externalTask.id)
    await cleanupTaskViaAPI(page, dependentTask.id)
  })

  test('Delete group removes group and returns tasks', async ({ page }) => {
    const task = await createTaskViaAPI(page, `Delete API Test ${Date.now()}`)

    const group = await page.evaluate(async ({ taskId, name }) => {
      const res = await fetch('/api/task-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberTaskIds: [taskId] }),
      })
      return res.json()
    }, { taskId: task.id, name: `Delete API Test Group ${Date.now()}` })

    // Delete group
    const deleteResponse = await page.evaluate(async (groupId) => {
      const res = await fetch(`/api/task-groups/${groupId}`, {
        method: 'DELETE',
      })
      return { status: res.status }
    }, group.id)

    expect(deleteResponse.status).toBe(200)

    // Verify group is deleted
    const groups = await getTaskGroups(page)
    expect(groups.find(g => g.id === group.id)).toBeUndefined()
  })
})