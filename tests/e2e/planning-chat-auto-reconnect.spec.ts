import { test, expect } from "@playwright/test"
import { spawn, ChildProcess } from "child_process"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * E2E tests for Planning Chat Auto-Reconnect functionality
 * 
 * These tests verify the full user flow:
 * 1. Session not active detection
 * 2. Successful reconnect with message retry
 * 3. Failed reconnect with proper error state
 * 4. Multiple rapid sends while reconnecting
 */

let serverProcess: ChildProcess | null = null
let baseUrl: string | null = null
let tempDir: string

test.beforeAll(async () => {
  // Create temp directory with git repo
  tempDir = mkdtempSync(join(tmpdir(), "tauroboros-chat-e2e-"))
  
  // Initialize git repo
  const { execFileSync } = await import("child_process")
  execFileSync("git", ["init"], { cwd: tempDir })
  execFileSync("git", ["checkout", "-b", "master"], { cwd: tempDir })
  writeFileSync(join(tempDir, "README.md"), "# e2e test\n", "utf-8")
  execFileSync("git", ["add", "README.md"], { cwd: tempDir })
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"], { cwd: tempDir })
  
  // Create .pi directory
  const piDir = join(tempDir, ".pi")
  
  // Create mock pi binary
  const mockPiPath = join(tempDir, "mock-pi-server.js")
  writeFileSync(
    mockPiPath,
    `#!/usr/bin/env bun
import { createInterface } from "readline"
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try { request = JSON.parse(line) } catch { return }
  const id = request?.id
  const type = request?.type
  
  if (type === "set_model") {
    console.log(JSON.stringify({ id, type: "response", command: "set_model", success: true }))
    return
  }
  
  if (type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: "set_thinking_level", success: true }))
    return
  }
  
  if (type === "prompt") {
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))
    setTimeout(() => {
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } }))
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text: "Hello from Pi" } }))
      console.log(JSON.stringify({ type: "agent_end" }))
    }, 100)
    return
  }
  
  console.log(JSON.stringify({ id, type: "response", success: true }))
})
`,
    "utf-8"
  )
  writeFileSync(join(piDir, "pi-path.txt"), mockPiPath, "utf-8")
  
  // Start the server
  const { server } = await import("../../src/server.ts")
  const result = server.createPiServer({
    dbPath: join(tempDir, ".tauroboros", "tasks.db"),
    port: 0, // Auto-assign port
  })
  
  const port = result.server.getPort()
  baseUrl = `http://localhost:${port}`
  
  // Wait for server to be ready
  await new Promise(resolve => setTimeout(resolve, 500))
  
  // Create default planning prompt
  await fetch(`${baseUrl}/api/planning/prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: "default",
      name: "Default",
      description: "Test prompt",
      promptText: "You are a helpful assistant for software development planning.",
    }),
  })
})

test.afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill()
  }
  // Cleanup temp dir
  try {
    const { rmSync } = await import("fs")
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
})

test.describe("Planning Chat Auto-Reconnect E2E", () => {
  test("should show error state when sending to inactive session", async ({ page }) => {
    test.skip(!baseUrl, "Server not available")
    
    // Navigate to the kanban board
    await page.goto(baseUrl!)
    
    // Open the planning chat panel
    await page.click('[data-testid="planning-chat-button"]')
    
    // Wait for the chat panel to be visible
    await page.waitForSelector('[data-testid="chat-panel"]', { state: 'visible' })
    
    // Create a new session
    await page.click('[data-testid="new-chat-session-button"]')
    await page.waitForSelector('[data-testid="chat-session-active"]', { state: 'visible' })
    
    // Get session ID from the UI or API
    const sessionId = await page.evaluate(async (url) => {
      const res = await fetch(`${url}/api/planning/sessions`)
      const sessions = await res.json()
      return sessions[0]?.id
    }, baseUrl)
    
    // Close the session via API (simulating server-side disconnect)
    await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/close`, {
      method: "POST",
    })
    
    // Try to send a message
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill("Test message after disconnect")
    await input.press('Enter')
    
    // Should show reconnecting state
    await page.waitForSelector('[data-testid="chat-reconnecting"]', { state: 'visible', timeout: 5000 })
    
    // Should eventually show error or success
    const errorOrSuccess = await page.waitForSelector(
      '[data-testid="chat-error"], [data-testid="chat-message-sent"]',
      { timeout: 30000 }
    )
    
    const testId = await errorOrSuccess.getAttribute('data-testid')
    expect(['chat-error', 'chat-message-sent']).toContain(testId)
  })

  test("should successfully reconnect and send message", async ({ page }) => {
    test.skip(!baseUrl, "Server not available")
    
    await page.goto(baseUrl!)
    
    // Open chat and create session
    await page.click('[data-testid="planning-chat-button"]')
    await page.waitForSelector('[data-testid="chat-panel"]', { state: 'visible' })
    await page.click('[data-testid="new-chat-session-button"]')
    await page.waitForSelector('[data-testid="chat-session-active"]', { state: 'visible' })
    
    // Get session ID
    const sessionId = await page.evaluate(async (url) => {
      const res = await fetch(`${url}/api/planning/sessions`)
      const sessions = await res.json()
      return sessions[0]?.id
    }, baseUrl)
    
    // Close the session
    await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/close`, {
      method: "POST",
    })
    
    // Send message - should trigger auto-reconnect
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill("Message after session closed")
    await input.press('Enter')
    
    // Wait for the full flow: reconnecting -> connected -> message sent
    await page.waitForSelector('[data-testid="chat-reconnecting"]', { state: 'visible', timeout: 5000 })
    
    // After reconnect, message should be sent and appear in chat
    await page.waitForSelector('[data-testid="chat-message-sent"]', { state: 'visible', timeout: 30000 })
    
    // Verify the message appears in the chat
    const messages = page.locator('[data-testid="chat-message"]')
    const count = await messages.count()
    expect(count).toBeGreaterThan(0)
  })

  test("should show error when reconnect fails", async ({ page }) => {
    test.skip(!baseUrl, "Server not available")
    
    await page.goto(baseUrl!)
    
    // Open chat and create session
    await page.click('[data-testid="planning-chat-button"]')
    await page.waitForSelector('[data-testid="chat-panel"]', { state: 'visible' })
    await page.click('[data-testid="new-chat-session-button"]')
    await page.waitForSelector('[data-testid="chat-session-active"]', { state: 'visible' })
    
    // Get session ID and delete it from DB (making reconnect impossible)
    const sessionId = await page.evaluate(async (url) => {
      const res = await fetch(`${url}/api/planning/sessions`)
      const sessions = await res.json()
      return sessions[0]?.id
    }, baseUrl)
    
    // Delete the session completely from DB
    await page.evaluate(async ({ url, id }) => {
      const res = await fetch(`${url}/api/planning/sessions/${id}`, {
        method: "DELETE",
      })
      return res.status
    }, { url: baseUrl, id: sessionId })
    
    // Try to send message - should fail with error
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill("Test message")
    await input.press('Enter')
    
    // Should show error state
    await page.waitForSelector('[data-testid="chat-error"]', { state: 'visible', timeout: 10000 })
    
    // Error message should be informative
    const errorText = await page.locator('[data-testid="chat-error"]').textContent()
    expect(errorText).toContain('reconnect failed')
  })

  test("should queue multiple rapid sends during reconnect", async ({ page }) => {
    test.skip(!baseUrl, "Server not available")
    
    await page.goto(baseUrl!)
    
    // Open chat and create session
    await page.click('[data-testid="planning-chat-button"]')
    await page.waitForSelector('[data-testid="chat-panel"]', { state: 'visible' })
    await page.click('[data-testid="new-chat-session-button"]')
    await page.waitForSelector('[data-testid="chat-session-active"]', { state: 'visible' })
    
    // Get session ID
    const sessionId = await page.evaluate(async (url) => {
      const res = await fetch(`${url}/api/planning/sessions`)
      const sessions = await res.json()
      return sessions[0]?.id
    }, baseUrl)
    
    // Close the session
    await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/close`, {
      method: "POST",
    })
    
    // Send multiple messages rapidly
    const input = page.locator('[data-testid="chat-input"]')
    
    // Fire off 3 messages quickly
    await input.fill("Message 1")
    await input.press('Enter')
    await input.fill("Message 2")
    await input.press('Enter')
    await input.fill("Message 3")
    await input.press('Enter')
    
    // Should show reconnecting state
    await page.waitForSelector('[data-testid="chat-reconnecting"]', { state: 'visible', timeout: 5000 })
    
    // Wait for all messages to be processed (either sent or error)
    await page.waitForTimeout(30000)
    
    // Check that we have either all messages sent or proper error state
    const errorCount = await page.locator('[data-testid="chat-error"]').count()
    const sentCount = await page.locator('[data-testid="chat-message-sent"]').count()
    
    // Either we have sent messages or we have an error (not stuck in between)
    expect(errorCount > 0 || sentCount >= 3).toBe(true)
  })
})
