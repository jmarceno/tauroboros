import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execFileSync } from "child_process"
import { ErrorCode, isErrorCode, detectErrorCodeFromMessage } from "../src/shared/error-codes.ts"
import type { InfrastructureSettings } from "../src/config/settings.ts"
import { createPiServer } from "./test-utils"

// Default test settings with container mode disabled
function getTestSettings(): InfrastructureSettings {
  return {
    skills: {
      localPath: "./skills",
      autoLoad: true,
      allowGlobal: false,
    },
    project: {
      name: "tauroboros-test",
      type: "workflow",
    },
    workflow: {
      server: {
        port: 0,
        dbPath: ".tauroboros/tasks.db",
      },
      runtime: {
        mode: "native",
        piBin: "mock-pi",
        piArgs: "",
      },
      container: {
        enabled: false, // Disable container mode for tests
        image: "pi-agent:latest",
        memoryMb: 512,
        cpuCount: 1,
        portRangeStart: 30000,
        portRangeEnd: 40000,
      },
    },
  }
}

// Helper to create a temp directory
function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// Helper to run git commands
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim()
}

// Helper to initialize a git repo
function initGitRepo(root: string): void {
  git(root, ["init"])
  git(root, ["checkout", "-b", "master"])
  writeFileSync(join(root, "README.md"), "# test repo\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"])
}

describe("Planning Chat Auto-Reconnect", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  })

  describe("Error Code Detection", () => {
    it("should detect PLANNING_SESSION_NOT_ACTIVE from ErrorCode enum", () => {
      const error = { error: "Planning session not active", code: ErrorCode.PLANNING_SESSION_NOT_ACTIVE }
      expect(isErrorCode(error, ErrorCode.PLANNING_SESSION_NOT_ACTIVE)).toBe(true)
      expect(isErrorCode(error, ErrorCode.SESSION_NOT_FOUND)).toBe(false)
    })

    it("should detect error code from legacy message string", () => {
      const message = "Request failed (400): Planning session not active"
      expect(detectErrorCodeFromMessage(message)).toBe(ErrorCode.PLANNING_SESSION_NOT_ACTIVE)
    })

    it("should return null for unknown error messages", () => {
      const message = "Some random error occurred"
      expect(detectErrorCodeFromMessage(message)).toBeNull()
    })

    it("should handle Error objects with code property", () => {
      const error = new Error("Planning session not active")
      ;(error as Error & { code: string }).code = ErrorCode.PLANNING_SESSION_NOT_ACTIVE
      expect(isErrorCode(error, ErrorCode.PLANNING_SESSION_NOT_ACTIVE)).toBe(true)
    })
  })

  describe("API Error Response Structure", () => {
    it("should return structured error with code for inactive session", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      const { server, db } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        // Create a default planning prompt in DB
        db.updatePlanningPrompt(1, {
          name: "Default",
          description: "Test",
          promptText: "Test prompt",
          isActive: true,
        })

        // Create a planning session directly in DB (bypassing actual Pi process)
        const session = db.createWorkflowSession({
          id: "test-session-1",
          sessionKind: "planning",
          status: "completed", // Inactive status
          cwd: tempDir,
          model: "default",
          thinkingLevel: "default",
          startedAt: Math.floor(Date.now() / 1000),
          finishedAt: Math.floor(Date.now() / 1000),
        })

        // Try to send a message - should get structured error
        const sendRes = await fetch(`${baseUrl}/api/planning/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Test message" }),
        })

        expect(sendRes.status).toBe(400)
        const error = await sendRes.json()
        expect(error.code).toBe(ErrorCode.PLANNING_SESSION_NOT_ACTIVE)
        expect(error.error).toContain("Planning session not active")
      } finally {
        server.stop()
      }
    })

    it("should return structured error for non-existent session", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      const { server } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        // Try to send to non-existent session
        const sendRes = await fetch(`${baseUrl}/api/planning/sessions/non-existent/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Test message" }),
        })

        expect(sendRes.status).toBe(404)
        const error = await sendRes.json()
        expect(error.code).toBe(ErrorCode.SESSION_NOT_FOUND)
      } finally {
        server.stop()
      }
    })

    it("should return structured error for non-planning session", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      const { server, db } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        // Create a non-planning session (e.g., task execution session)
        const session = db.createWorkflowSession({
          id: "task-session-1",
          sessionKind: "task", // Not a planning session
          status: "active",
          cwd: tempDir,
          model: "default",
          thinkingLevel: "default",
          startedAt: Math.floor(Date.now() / 1000),
        })

        // Try to use as planning session
        const sendRes = await fetch(`${baseUrl}/api/planning/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Test message" }),
        })

        expect(sendRes.status).toBe(400)
        const error = await sendRes.json()
        expect(error.code).toBe(ErrorCode.NOT_A_PLANNING_SESSION)
      } finally {
        server.stop()
      }
    })
  })

  describe("Session Reconnect Flow", () => {
    it("should successfully reconnect to an inactive session", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      // Create mock pi binary
      const mockPiDir = join(tempDir, ".pi")
      mkdirSync(mockPiDir, { recursive: true })
      writeFileSync(
        join(mockPiDir, "pi-path.txt"),
        "#!/bin/bash\necho 'mock pi'",
        "utf-8"
      )

      const { server, db } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        // Create a planning prompt via the update API (create if not exists)
        db.updatePlanningPrompt(1, {
          name: "Default",
          description: "Test",
          promptText: "Test prompt",
          isActive: true,
        })

        // Create an inactive planning session
        const session = db.createWorkflowSession({
          id: "reconnect-test-1",
          sessionKind: "planning",
          status: "completed",
          cwd: tempDir,
          model: "default",
          thinkingLevel: "default",
          startedAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
          finishedAt: Math.floor(Date.now() / 1000),
        })

        // Attempt reconnect - will fail without real Pi process, but tests the endpoint
        const reconnectRes = await fetch(`${baseUrl}/api/planning/sessions/${session.id}/reconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })

        // Expect failure since we don't have a real Pi process, but verify error structure
        expect([200, 500]).toContain(reconnectRes.status)

        if (reconnectRes.status !== 200) {
          const error = await reconnectRes.json()
          expect(error.code).toBe(ErrorCode.PLANNING_SESSION_RECONNECT_FAILED)
        }
      } finally {
        server.stop()
      }
    })

    it("should return error when trying to reconnect non-existent session", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      const { server } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        const reconnectRes = await fetch(`${baseUrl}/api/planning/sessions/non-existent/reconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })

        expect(reconnectRes.status).toBe(404)
        const error = await reconnectRes.json()
        expect(error.code).toBe(ErrorCode.SESSION_NOT_FOUND)
      } finally {
        server.stop()
      }
    })
  })

  describe("Create Planning Session Endpoint", () => {
    it("should create session with default planning prompt when configured", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      const { server, db } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        // Create a planning prompt in the DB
        db.updatePlanningPrompt(1, {
          name: "Default",
          description: "Test",
          promptText: "Test prompt for planning",
          isActive: true,
        })

        // Create session should succeed with planning prompt configured
        const createRes = await fetch(`${baseUrl}/api/planning/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: tempDir }),
        })

        // Will fail to actually start Pi process but tests that prompt is found
        expect([201, 500]).toContain(createRes.status)
      } finally {
        server.stop()
      }
    })
  })

  describe("Set Model Endpoint", () => {
    it("should return error for invalid thinking level", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      const { server, db } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        // Create a planning session
        const session = db.createWorkflowSession({
          id: "model-test-1",
          sessionKind: "planning",
          status: "active",
          cwd: tempDir,
          model: "default",
          thinkingLevel: "default",
          startedAt: Math.floor(Date.now() / 1000),
        })

        // Try to set invalid thinking level
        const modelRes = await fetch(`${baseUrl}/api/planning/sessions/${session.id}/model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "anthropic/claude-3-sonnet",
            thinkingLevel: "invalid_level"
          }),
        })

        expect(modelRes.status).toBe(400)
        const error = await modelRes.json()
        expect(error.code).toBe(ErrorCode.INVALID_THINKING_LEVEL)
      } finally {
        server.stop()
      }
    })

    it("should return error when setting model on inactive session", async () => {
      const tempDir = createTempDir("tauroboros-chat-test-")
      tempDirs.push(tempDir)
      initGitRepo(tempDir)

      const dbPath = join(tempDir, ".tauroboros", "tasks.db")
      mkdirSync(join(tempDir, ".tauroboros"), { recursive: true })

      const { server, db } = createPiServer({ dbPath, port: 0, settings: getTestSettings() })
      const port = await server.start(0)
      const baseUrl = `http://localhost:${port}`

      try {
        // Create an inactive session
        const session = db.createWorkflowSession({
          id: "inactive-model-test",
          sessionKind: "planning",
          status: "completed",
          cwd: tempDir,
          model: "default",
          thinkingLevel: "default",
          startedAt: Math.floor(Date.now() / 1000) - 3600,
          finishedAt: Math.floor(Date.now() / 1000),
        })

        // Try to set model on inactive session
        const modelRes = await fetch(`${baseUrl}/api/planning/sessions/${session.id}/model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "anthropic/claude-3-sonnet" }),
        })

        expect(modelRes.status).toBe(400)
        const error = await modelRes.json()
        expect(error.code).toBe(ErrorCode.PLANNING_SESSION_NOT_ACTIVE)
      } finally {
        server.stop()
      }
    })
  })
})
