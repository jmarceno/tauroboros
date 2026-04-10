/**
 * E2E Test Utilities for Playwright
 * 
 * Helper functions for interacting with the pi-easy-workflow UI
 */

import type { TestServer } from "./server-manager.ts"

/**
 * Execute a playwright-cli command and return the output
 */
export async function playwright(cmd: string, args: string[] = []): Promise<string> {
  const { execSync } = await import("child_process")
  const fullCmd = `playwright-cli ${cmd} ${args.join(" ")}`
  
  try {
    return execSync(fullCmd, { encoding: "utf-8", timeout: 30000 })
  } catch (error: any) {
    throw new Error(`playwright-cli command failed: ${error.message}`)
  }
}

/**
 * Open the pi-easy-workflow UI in Playwright
 */
export async function openUI(server: TestServer): Promise<void> {
  await playwright("open", [server.url, "--browser=chromium-headless-shell"])
  // Wait for page to load
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

/**
 * Close the Playwright browser
 */
export async function closeBrowser(): Promise<void> {
  try {
    await playwright("close")
  } catch {
    // Ignore errors if browser is already closed
  }
}

/**
 * Take a snapshot of the current page state
 */
export async function takeSnapshot(): Promise<string> {
  return await playwright("snapshot", ["--raw"])
}

/**
 * Wait for an element to appear in the snapshot
 */
export async function waitForElement(
  selector: string,
  timeoutMs = 10000
): Promise<boolean> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    const snapshot = await takeSnapshot()
    if (snapshot.includes(selector)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  
  return false
}

/**
 * Click an element by its ref (from snapshot)
 */
export async function click(ref: string): Promise<void> {
  await playwright("click", [ref])
  await new Promise((resolve) => setTimeout(resolve, 500))
}

/**
 * Fill an input field
 */
export async function fill(ref: string, value: string): Promise<void> {
  await playwright("fill", [ref, value])
  await new Promise((resolve) => setTimeout(resolve, 500))
}

/**
 * Type text (for textareas or contenteditable)
 */
export async function type(text: string): Promise<void> {
  await playwright("type", [text])
  await new Promise((resolve) => setTimeout(resolve, 500))
}

/**
 * Press a key
 */
export async function press(key: string): Promise<void> {
  await playwright("press", [key])
  await new Promise((resolve) => setTimeout(resolve, 500))
}

/**
 * Check if text exists on the page
 */
export async function hasText(text: string): Promise<boolean> {
  const snapshot = await takeSnapshot()
  return snapshot.includes(text)
}

/**
 * Create a task through the UI
 */
export async function createTask(params: {
  name: string
  prompt: string
  branch?: string
}): Promise<void> {
  // Click "New Task" button
  await click("e1") // Assuming e1 is the New Task button
  
  // Fill task name
  await fill("e2", params.name)
  
  // Fill prompt
  await fill("e3", params.prompt)
  
  // Fill branch if provided
  if (params.branch) {
    await fill("e4", params.branch)
  }
  
  // Click Create button
  await click("e5")
  
  // Wait for task to appear
  await waitForElement(params.name, 5000)
}

/**
 * Run a task through the UI
 */
export async function runTask(taskName: string): Promise<void> {
  // Find and click the run button for the task
  // This is a simplified version - in reality we'd need to find the specific task card
  const snapshot = await takeSnapshot()
  
  // Look for the task and its run button
  if (!snapshot.includes(taskName)) {
    throw new Error(`Task "${taskName}" not found in UI`)
  }
  
  // Click run button (ref would be determined from snapshot)
  await click("e6")
  
  // Wait for execution to start
  await waitForElement("running", 5000)
}

/**
 * Get task status from the UI
 */
export async function getTaskStatus(taskName: string): Promise<string | null> {
  const snapshot = await takeSnapshot()
  
  // Parse the snapshot to find task status
  // This is a simplified version
  if (snapshot.includes(`${taskName}`)) {
    if (snapshot.includes("done")) return "done"
    if (snapshot.includes("running")) return "running"
    if (snapshot.includes("backlog")) return "backlog"
    if (snapshot.includes("failed")) return "failed"
  }
  
  return null
}

/**
 * Wait for a task to complete
 */
export async function waitForTaskCompletion(
  taskName: string,
  timeoutMs = 120000
): Promise<boolean> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await getTaskStatus(taskName)
    if (status === "done" || status === "failed") {
      return status === "done"
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  
  return false
}
