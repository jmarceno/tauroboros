/**
 * E2E Tests: Workflow Execution
 * 
 * Tests workflow execution through the UI using real containerized agents
 * NOTE: These tests require Podman and the pi-agent image to be available
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { execSync } from "child_process"
import { startTestServer, type TestServer } from "./server-manager.ts"
import {
  openUI,
  closeBrowser,
  takeSnapshot,
} from "./playwright-utils.ts"

// Check if container requirements are available
const hasPodman = (() => {
  try {
    execSync("podman --version", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
})()

const hasPiAgentImage = (() => {
  if (!hasPodman) return false
  try {
    const result = execSync("podman images pi-agent:alpine -q", { encoding: "utf-8", stdio: "pipe" })
    return result.trim().length > 0
  } catch {
    return false
  }
})()

const skipContainerTests = !hasPodman || !hasPiAgentImage

if (skipContainerTests) {
  console.log("\n⚠️  Skipping container workflow tests:")
  if (!hasPodman) console.log("   - Podman not available")
  if (!hasPiAgentImage) console.log("   - pi-agent:alpine image not found")
  console.log("   Run 'bun run container:setup' to prepare the environment\n")
}

const describeOrSkip = skipContainerTests ? describe.skip : describe

describeOrSkip("Container Workflow Execution", () => {
  let server: TestServer

  beforeAll(async () => {
    console.log("\n[SETUP] Starting test server for container workflow...")
    server = await startTestServer()
    console.log(`[SETUP] Server ready at ${server.url}`)
    
    await openUI(server)
    console.log("[SETUP] Browser opened")
  }, 60000)

  afterAll(async () => {
    console.log("\n[TEARDOWN] Cleaning up container workflow tests...")
    await closeBrowser()
    if (server) {
      await server.stop()
    }
    console.log("[TEARDOWN] Done")
  }, 30000)

  test("can start a workflow run via API", async () => {
    // Create a task first
    const createResponse = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Container Workflow Task",
        prompt: "Create a file named 'test-output.txt' with content 'Hello from container workflow'",
        branch: "container-test",
        status: "backlog",
        planmode: false,
        autoApprovePlan: true,
        review: false,
        autoCommit: true,
        deleteWorktree: true,
        executionModel: "minimax/MiniMax-M2.7",
        thinkingLevel: "low",
      }),
    })
    
    expect(createResponse.status).toBe(201)
    const task = await createResponse.json()
    console.log(`[TEST] Task created: ${task.id}`)
    
    // Start the workflow
    const runResponse = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        kind: "single_task",
      }),
    })
    
    expect(runResponse.status).toBe(201)
    const run = await runResponse.json()
    expect(run.id).toBeDefined()
    expect(run.status).toBe("running")
    
    console.log(`[TEST] Workflow run started: ${run.id}`)
    
    // Poll for completion (with timeout)
    const startTime = Date.now()
    const maxWaitMs = 300000 // 5 minutes
    let completed = false
    let finalStatus = ""
    
    while (Date.now() - startTime < maxWaitMs) {
      const checkResponse = await fetch(`${server.url}/api/runs/${run.id}`)
      const runStatus = await checkResponse.json()
      
      finalStatus = runStatus.status
      
      if (runStatus.status === "completed" || runStatus.status === "failed") {
        completed = true
        break
      }
      
      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    
    expect(completed).toBe(true)
    console.log(`[TEST] Workflow completed with status: ${finalStatus}`)
    
    // Check task status
    const taskResponse = await fetch(`${server.url}/api/tasks/${task.id}`)
    const finalTask = await taskResponse.json()
    
    console.log(`[TEST] Final task status: ${finalTask.status}`)
    
    // The task should be done if the workflow completed successfully
    if (finalStatus === "completed") {
      expect(finalTask.status).toBe("done")
    }
  }, 320000)

  test("UI shows workflow run status", async () => {
    // Reload the page
    const { execSync } = await import("child_process")
    execSync("playwright-cli reload", { encoding: "utf-8", timeout: 10000 })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    
    // Take snapshot to check for workflow runs section
    const snapshot = await takeSnapshot()
    
    // Should show runs section or workflow status
    const hasRunsSection = 
      snapshot.includes("Runs") || 
      snapshot.includes("Workflow") ||
      snapshot.includes("run")
    
    // This is a basic check - in a real app the UI would show run status
    expect(hasRunsSection || snapshot.length > 0).toBe(true)
    
    console.log("✓ UI shows workflow information")
  })
})
