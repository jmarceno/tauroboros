import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'

// E2E tests for Options Modal - data loading and persistence
// These tests ONLY use the Web UI and verify in the database

const DB_PATH = './data/tasks.db'
const BASE_URL = 'http://localhost:5173'

test.describe('Options Modal Data Loading and Persistence', () => {
  test.beforeEach(async ({ page }) => {
    // Ensure server is running and load the page
    await page.goto(BASE_URL)
    await page.waitForSelector('.kanban-board', { timeout: 10000 })
  })

  test('Options modal should load and display current values from database', async ({ page }) => {
    // Get current values from database
    const dbBranch = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='branch'"`).toString().trim()
    const dbPlanModel = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='plan_model'"`).toString().trim()
    const dbParallelTasks = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='parallel_tasks'"`).toString().trim()
    const dbMaxReviews = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='max_reviews'"`).toString().trim()

    console.log('Database values:', { dbBranch, dbPlanModel, dbParallelTasks, dbMaxReviews })

    // Open Options modal
    await page.click('text=Options')
    
    // Wait for modal to load data (should show "Loading options..." then actual values)
    await page.waitForTimeout(500)
    
    // Verify the form shows actual values from database (not "default" or empty)
    const branchValue = await page.locator('.form-select').first().inputValue()
    expect(branchValue).toBe(dbBranch)
    
    // Verify model pickers show actual values
    const planModelInput = await page.locator('text=Plan Model (global)').locator('..').locator('input').inputValue()
    expect(planModelInput).not.toBe('default')
    expect(planModelInput).toBe(dbPlanModel)
    
    // Verify number inputs
    const parallelTasksValue = await page.locator('label:has-text("Parallel Tasks") + input').inputValue()
    expect(parallelTasksValue).toBe(dbParallelTasks)
    
    const maxReviewsValue = await page.locator('label:has-text("Maximum Review Runs") + input').inputValue()
    expect(maxReviewsValue).toBe(dbMaxReviews)
  })

  test('Changing options should persist to database after save', async ({ page }) => {
    // Generate test values
    const testParallelTasks = Math.floor(Math.random() * 5) + 1
    const testMaxReviews = Math.floor(Math.random() * 3) + 1
    const testCommand = `echo "test-${randomUUID().slice(0, 8)}"`

    // Open Options modal
    await page.click('text=Options')
    await page.waitForTimeout(500)

    // Change Parallel Tasks
    const parallelTasksInput = page.locator('label:has-text("Parallel Tasks") + input')
    await parallelTasksInput.fill(String(testParallelTasks))
    
    // Change Max Reviews
    const maxReviewsInput = page.locator('label:has-text("Maximum Review Runs") + input')
    await maxReviewsInput.fill(String(testMaxReviews))
    
    // Change Command
    const commandInput = page.locator('label:has-text("Pre-execution Command") + input')
    await commandInput.fill(testCommand)
    
    // Save
    await page.click('button:has-text("Save")')
    
    // Wait for save and modal close
    await page.waitForTimeout(1000)
    
    // Verify values in database
    const dbParallelTasks = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='parallel_tasks'"`).toString().trim()
    const dbMaxReviews = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='max_reviews'"`).toString().trim()
    const dbCommand = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='command'"`).toString().trim()
    
    expect(dbParallelTasks).toBe(String(testParallelTasks))
    expect(dbMaxReviews).toBe(String(testMaxReviews))
    expect(dbCommand).toBe(testCommand)
  })

  test('Commit prompt should load and save correctly', async ({ page }) => {
    const testCommitPrompt = `Test commit prompt ${randomUUID().slice(0, 8)}`

    // Open Options modal
    await page.click('text=Options')
    await page.waitForTimeout(500)

    // Get current commit prompt value
    const commitPromptTextarea = page.locator('label:has-text("Commit Prompt") + textarea')
    const currentPrompt = await commitPromptTextarea.inputValue()
    
    // Should not be empty - should have the default worktree prompt
    expect(currentPrompt.length).toBeGreaterThan(100)
    expect(currentPrompt).toContain('worktree')
    
    // Change it
    await commitPromptTextarea.fill(testCommitPrompt)
    
    // Save
    await page.click('button:has-text("Save")')
    await page.waitForTimeout(1000)
    
    // Verify in database
    const dbCommitPrompt = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='commit_prompt'"`).toString().trim()
    expect(dbCommitPrompt).toBe(testCommitPrompt)
    
    // Reopen modal and verify it loads the new value
    await page.click('text=Options')
    await page.waitForTimeout(500)
    
    const newPrompt = await commitPromptTextarea.inputValue()
    expect(newPrompt).toBe(testCommitPrompt)
  })

  test('Model fields should not show "default" when database has real values', async ({ page }) => {
    // First set real model values in database
    const testPlanModel = 'openai/gpt-4'
    const testExecModel = 'anthropic/claude-3-opus'
    
    execSync(`sqlite3 ${DB_PATH} "INSERT OR REPLACE INTO options (key, value) VALUES ('plan_model', '${testPlanModel}')"`)
    execSync(`sqlite3 ${DB_PATH} "INSERT OR REPLACE INTO options (key, value) VALUES ('execution_model', '${testExecModel}')"`)
    
    // Reload the page to get fresh data
    await page.reload()
    await page.waitForSelector('.kanban-board', { timeout: 10000 })
    
    // Open Options modal
    await page.click('text=Options')
    await page.waitForTimeout(500)
    
    // Verify model pickers show the actual values, not "default"
    const planModelInput = await page.locator('text=Plan Model (global)').locator('..').locator('input').inputValue()
    expect(planModelInput).toBe(testPlanModel)
    
    const execModelInput = await page.locator('text=Execution Model (global)').locator('..').locator('input').inputValue()
    expect(execModelInput).toBe(testExecModel)
  })

  test('Checkbox fields should persist correctly', async ({ page }) => {
    // Get current state
    const dbBefore = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='show_execution_graph'"`).toString().trim()
    
    // Open Options modal
    await page.click('text=Options')
    await page.waitForTimeout(500)
    
    // Toggle the checkbox
    const checkbox = page.locator('label:has-text("Show execution graph") input[type="checkbox"]')
    const wasChecked = await checkbox.isChecked()
    await checkbox.click()
    
    // Save
    await page.click('button:has-text("Save")')
    await page.waitForTimeout(1000)
    
    // Verify database changed
    const dbAfter = execSync(`sqlite3 ${DB_PATH} "SELECT value FROM options WHERE key='show_execution_graph'"`).toString().trim()
    expect(dbAfter).not.toBe(dbBefore)
    expect(dbAfter).toBe(wasChecked ? 'false' : 'true')
  })
})
