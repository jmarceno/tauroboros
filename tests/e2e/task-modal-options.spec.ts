import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'

// E2E tests for Task Modal - verify options are loaded correctly from backend
// These tests ONLY use the Web UI and verify in the database

const DB_PATH = './data/tasks.db'
const BASE_URL = 'http://localhost:5173'

test.describe('Task Modal - Options Loading', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForSelector('.kanban-board', { timeout: 10000 })
  })

  test('Creating new task should load global defaults from backend', async ({ page }) => {
    // Get current global defaults from database
    const dbPlanModel = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='plan_model'"`).toString().trim()
    const dbExecModel = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='execution_model'"`).toString().trim()
    
    console.log('Global defaults from DB:', { dbPlanModel, dbExecModel })

    // Click Add Task in backlog
    await page.click('[data-column="backlog"] button:has-text("+")')
    
    // Wait for modal
    await page.waitForSelector('text=Add Task', { timeout: 5000 })
    await page.waitForTimeout(500)
    
    // Verify model pickers show the global defaults (not empty or "default")
    const planModelInput = await page.locator('label:has-text("Plan Model") + div input').inputValue()
    const execModelInput = await page.locator('label:has-text("Execution Model") + div input').inputValue()
    
    console.log('Model values in form:', { planModelInput, execModelInput })
    
    // Should match database values
    expect(planModelInput).toBe(dbPlanModel)
    expect(execModelInput).toBe(dbExecModel)
    
    // Should NOT be empty or just "default"
    expect(planModelInput.length).toBeGreaterThan(0)
    expect(execModelInput.length).toBeGreaterThan(0)
  })

  test('Editing existing task should show task values, not global defaults', async ({ page }) => {
    // First, create a task with specific values via API
    const taskName = `Test-${randomUUID().slice(0, 8)}`
    
    // Create task via API with specific model values
    const createResponse = await page.request.post(`${BASE_URL}/api/tasks`, {
      data: {
        name: taskName,
        prompt: 'Test prompt',
        status: 'backlog',
        planModel: 'custom-plan-model-123',
        executionModel: 'custom-exec-model-456',
      }
    })
    expect(createResponse.ok()).toBeTruthy()
    const task = await createResponse.json()
    
    // Reload page to see the new task
    await page.reload()
    await page.waitForSelector('.kanban-board', { timeout: 10000 })
    
    // Find and click the task to edit
    const taskCard = page.locator(`text=${taskName}`).first()
    await taskCard.click()
    
    // Wait for modal
    await page.waitForSelector('text=Edit Task', { timeout: 5000 })
    await page.waitForTimeout(500)
    
    // Verify model pickers show the TASK's values, not global defaults
    const planModelInput = await page.locator('label:has-text("Plan Model") + div input').inputValue()
    const execModelInput = await page.locator('label:has-text("Execution Model") + div input').inputValue()
    
    expect(planModelInput).toBe('custom-plan-model-123')
    expect(execModelInput).toBe('custom-exec-model-456')
    
    // Cleanup - delete the task
    await page.request.delete(`${BASE_URL}/api/tasks/${task.id}`)
  })

  test('Task modal should wait for options before showing form', async ({ page }) => {
    // Open add task modal
    await page.click('[data-column="backlog"] button:has-text("+")')
    
    // Should show "Loading..." or wait for data
    // Then should show the form with actual values
    await page.waitForSelector('input[placeholder="Task name"]', { timeout: 5000 })
    
    // Verify model inputs are populated (not empty)
    const planModelInput = page.locator('label:has-text("Plan Model") + div input')
    await expect(planModelInput).not.toHaveValue('')
    await expect(planModelInput).not.toHaveValue('default')
  })
})
