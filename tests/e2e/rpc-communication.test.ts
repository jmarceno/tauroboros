/**
 * E2E Tests: RPC Communication
 *
 * Tests JSONL RPC communication between host and containerized pi agents.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { PiContainerManager } from "../../src/runtime/container-manager.ts"
import {
  createTempGitRepo,
  createWorktree,
  sendRpcCommand,
  waitForEvent,
  setupContainerImage,
  isPodmanAvailable,
} from "./utils.ts"

// Skip all tests if Podman is not available
const skipTests = !isPodmanAvailable()
if (skipTests) {
  console.log("Skipping container tests: Podman is not available")
}

const describeOrSkip = skipTests ? describe.skip : describe

describeOrSkip("RPC Communication", () => {
  let containerManager: PiContainerManager
  let repoDir: string
  let worktreeDir: string

  beforeAll(async () => {
    // Ensure container image is ready (builds if needed)
    await setupContainerImage()

    containerManager = new PiContainerManager()
    repoDir = createTempGitRepo()
    worktreeDir = createWorktree(repoDir, "rpc-test")
  })

  afterAll(async () => {
    await containerManager.cleanup()
  })

  test("can send set_model command", async () => {
    const sessionId = `test-rpc-model-${Date.now()}`

    const container = await containerManager.createContainer({
      sessionId,
      worktreeDir,
      repoRoot: repoDir,
    })

    try {
      // Send set_model command
      await sendRpcCommand(container, {
        type: "set_model",
        provider: "openai",
        modelId: "gpt-4",
      })

      // Wait for response
      const response = await waitForEvent(container, "response", 10000)

      expect(response).not.toBeNull()
      expect(response?.type).toBe("response")
      expect(response?.command).toBe("set_model")
    } finally {
      await container.kill()
    }
  }, 20000)

  test("can send set_thinking_level command", async () => {
    const sessionId = `test-rpc-thinking-${Date.now()}`

    const container = await containerManager.createContainer({
      sessionId,
      worktreeDir,
      repoRoot: repoDir,
    })

    try {
      await sendRpcCommand(container, {
        type: "set_thinking_level",
        level: "medium",
      })

      const response = await waitForEvent(container, "response", 10000)

      expect(response).not.toBeNull()
      expect(response?.type).toBe("response")
      expect(response?.command).toBe("set_thinking_level")
    } finally {
      await container.kill()
    }
  }, 20000)

  test("can send get_state command and receive state", async () => {
    const sessionId = `test-rpc-state-${Date.now()}`

    const container = await containerManager.createContainer({
      sessionId,
      worktreeDir,
      repoRoot: repoDir,
    })

    try {
      await sendRpcCommand(container, {
        type: "get_state",
      })

      const response = await waitForEvent(container, "response", 10000)

      expect(response).not.toBeNull()
      expect(response?.type).toBe("response")
      expect(response?.command).toBe("get_state")
      expect(response?.success).toBe(true)

      // Check that data contains state information
      const data = response?.data as Record<string, unknown> | undefined
      expect(data).toBeDefined()
    } finally {
      await container.kill()
    }
  }, 20000)

  test("stdin/stdout streams work correctly", async () => {
    const sessionId = `test-streams-${Date.now()}`

    const container = await containerManager.createContainer({
      sessionId,
      worktreeDir,
      repoRoot: repoDir,
    })

    try {
      // Send multiple commands
      await sendRpcCommand(container, { type: "get_state" })
      await sendRpcCommand(container, { type: "get_messages" })

      // Collect responses for a short time
      const { collectEvents } = await import("./utils.ts")
      const events = await collectEvents(container, 5000)

      // Should have received at least 2 responses
      const responses = events.filter(
        (e) => (e as Record<string, unknown>).type === "response",
      )
      expect(responses.length).toBeGreaterThanOrEqual(2)
    } finally {
      await container.kill()
    }
  }, 20000)
})
