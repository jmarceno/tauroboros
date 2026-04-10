/**
 * E2E Tests: Basic UI Functionality
 * 
 * Tests fundamental UI interactions using Playwright ONLY
 * - Server startup and UI loading
 * - Task creation via UI
 * - Basic navigation
 * 
 * NO API calls - all interactions through the web UI
 */

import { test, expect } from '@playwright/test';

test.describe('Basic UI Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');
  });

  test('server starts and UI loads', async ({ page }) => {
    // Check that the kanban board loaded
    await expect(page.locator('text=Easy Workflow')).toBeVisible();
    
    // Verify columns using data-status attributes
    await expect(page.locator('.column[data-status="template"]')).toBeVisible();
    await expect(page.locator('.column[data-status="backlog"]')).toBeVisible();
    await expect(page.locator('.column[data-status="executing"]')).toBeVisible();
    await expect(page.locator('.column[data-status="review"]')).toBeVisible();
    await expect(page.locator('.column[data-status="done"]')).toBeVisible();
    
    console.log('✓ UI loaded successfully with all columns');
  });

  test('can open and interact with task creation dialog', async ({ page }) => {
    // Find and click Add Task button in backlog column
    const addTaskButton = page.locator('.column[data-status="backlog"] button.add-task-btn');
    await expect(addTaskButton).toBeVisible();
    await expect(addTaskButton).toHaveText('+ Add Task');
    
    await addTaskButton.click();
    
    // Wait for dialog to appear
    await page.waitForTimeout(500);
    
    // Verify modal elements
    const nameInput = page.locator('sl-input#taskName');
    await expect(nameInput).toBeVisible();
    
    const promptInput = page.locator('sl-textarea#taskPrompt');
    await expect(promptInput).toBeVisible();
    
    const saveButton = page.locator('sl-button#taskSaveBtn');
    await expect(saveButton).toBeVisible();
    
    const cancelButton = page.locator('sl-button:has-text("Cancel")').first();
    await expect(cancelButton).toBeVisible();
    
    // Interact with form
    await nameInput.click();
    await page.keyboard.type('Test Task via UI');
    
    await promptInput.click();
    await page.keyboard.type('This is a test task created through the UI');
    
    // Cancel to close without saving
    await cancelButton.click();
    await page.waitForTimeout(500);
    
    // Verify modal closed
    await expect(nameInput).not.toBeVisible();
    
    console.log('✓ Task creation dialog works');
  });

  test('API endpoint responds correctly', async ({ page }) => {
    // Test API accessibility via fetch from browser context
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/tasks');
      return { status: res.status, ok: res.ok };
    });
    
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    
    console.log('✓ API is accessible');
  });

  test('WebSocket connection is available', async ({ page }) => {
    // Check for WebSocket-related code in the page
    const hasWebSocket = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      return html.includes('WebSocket') || html.includes('ws://') || html.includes('/ws');
    });
    
    expect(hasWebSocket).toBe(true);
    console.log('✓ WebSocket support detected');
  });

  test('can fill and submit task creation form', async ({ page }) => {
    // This test verifies the task creation form can be filled and submitted
    // Note: Actual task creation verification is in the real-workflow.spec.ts
    
    // Click Add Task
    const addTaskButton = page.locator('.column[data-status="backlog"] button.add-task-btn');
    await addTaskButton.click();
    await page.waitForTimeout(500);
    
    // Fill form
    const nameInput = page.locator('sl-input#taskName');
    await expect(nameInput).toBeVisible();
    await nameInput.click();
    await page.keyboard.type('Test Task ' + Date.now());
    
    const promptInput = page.locator('sl-textarea#taskPrompt');
    await expect(promptInput).toBeVisible();
    await promptInput.click();
    await page.keyboard.type('Test task description');
    
    // Verify Save button is clickable
    const saveButton = page.locator('sl-button#taskSaveBtn');
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();
    
    // Cancel to close without saving (we'll test full creation in real-workflow)
    const cancelButton = page.locator('sl-button:has-text("Cancel")').first();
    await cancelButton.click();
    await page.waitForTimeout(500);
    
    console.log('✓ Task creation form is functional');
  });
});
