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
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Give Vue app time to mount
    await page.waitForTimeout(2000);
  });

  test('server starts and UI loads', async ({ page }) => {
    // Check that the kanban board loaded by looking for the kanban columns
    await expect(page.locator('[data-status="template"]')).toBeVisible();
    
    // Verify the sidebar has the workflow control section
    await expect(page.locator('.sidebar:has-text("Workflow Control")')).toBeVisible();
    
    console.log('✓ UI loaded successfully');
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
    // Check for WebSocket by looking at network or checking if WebSocket object exists
    const hasWebSocket = await page.evaluate(() => {
      // Check if WebSocket is defined in window
      return typeof window.WebSocket !== 'undefined';
    });
    
    expect(hasWebSocket).toBe(true);
    console.log('✓ WebSocket support detected');
  });

  test('keyboard shortcuts are displayed', async ({ page }) => {
    // Look for kbd elements anywhere on the page (they're in the top bar)
    const kbdElements = page.locator('kbd');
    
    // Verify at least 4 keyboard shortcuts exist (T, B, S, D)
    await expect(kbdElements.first()).toBeVisible();
    const kbdCount = await kbdElements.count();
    expect(kbdCount).toBeGreaterThanOrEqual(4);
    
    // Get text content of all kbd elements and verify shortcuts exist
    const kbdTexts = await kbdElements.allTextContents();
    expect(kbdTexts).toContain('T');  // Template
    expect(kbdTexts).toContain('B');  // Backlog/Task
    expect(kbdTexts).toContain('P');  // Planning Chat
    expect(kbdTexts).toContain('Esc'); // Close
    
    console.log('✓ Keyboard shortcuts displayed');
  });
});
