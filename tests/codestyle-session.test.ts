import { afterEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import { CodeStyleSessionRunner, RunCodeStyleInput } from "../src/runtime/codestyle-session.ts"
import { PiSessionManager, ExecuteSessionPromptResult } from "../src/runtime/session-manager.ts"
import { DEFAULT_CODE_STYLE_PROMPT, resolveCodeStylePrompt } from "../src/types.ts"
import { InfrastructureSettings, DEFAULT_INFRASTRUCTURE_SETTINGS } from "../src/config/settings.ts"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("CodeStyleSessionRunner", () => {
  describe("constructor initialization", () => {
    it("should create its own PiSessionManager when no external manager is provided", () => {
      const root = createTempDir("tauroboros-codestyle-ctor-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const runner = new CodeStyleSessionRunner(db, DEFAULT_INFRASTRUCTURE_SETTINGS)

      expect(runner).toBeDefined()
      db.close()
    })

    it("should use external PiSessionManager when provided", () => {
      const root = createTempDir("tauroboros-codestyle-ctor-external-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      // Create external session manager
      const externalManager = new PiSessionManager(db)

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        externalManager
      )

      expect(runner).toBeDefined()
      db.close()
    })

    it("should work without settings (undefined settings)", () => {
      const root = createTempDir("tauroboros-codestyle-ctor-no-settings-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const runner = new CodeStyleSessionRunner(db, undefined)

      expect(runner).toBeDefined()
      db.close()
    })
  })

  describe("run() method success path", () => {
    it("should execute code style check and return success result", async () => {
      const root = createTempDir("tauroboros-codestyle-success-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      // Create a mock session manager that returns successful response
      const mockExecutePrompt = mock(async (_input: unknown): Promise<ExecuteSessionPromptResult> => {
        const session = db.createWorkflowSession({
          id: "test-session-1",
          taskId: "task-1",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "completed",
        })
        return {
          session,
          responseText: "Code style check passed. All files comply with the style guidelines.",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-1",
        name: "Code style task",
        prompt: "Check code style",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      const result = await runner.run(input)

      expect(result.success).toBe(true)
      expect(result.responseText).toBe("Code style check passed. All files comply with the style guidelines.")
      expect(result.sessionId).toBe("test-session-1")
      expect(result.errorMessage).toBeUndefined()

      // Verify the session manager was called with correct parameters
      expect(mockExecutePrompt).toHaveBeenCalledTimes(1)
      const callArg = mockExecutePrompt.mock.calls[0][0] as {
        taskId: string
        sessionKind: string
        promptText: string
        model: string
        thinkingLevel: string
      }
      expect(callArg.taskId).toBe("task-1")
      expect(callArg.sessionKind).toBe("task_run_reviewer")
      expect(callArg.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(callArg.thinkingLevel).toBe("default")

      db.close()
    })

    it("should use custom code style prompt when provided", async () => {
      const root = createTempDir("tauroboros-codestyle-custom-prompt-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      let capturedPrompt: string | undefined
      const mockExecutePrompt = mock(async (input: unknown): Promise<ExecuteSessionPromptResult> => {
        const execInput = input as { promptText: string }
        capturedPrompt = execInput.promptText

        const session = db.createWorkflowSession({
          id: "test-session-2",
          taskId: "task-2",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "completed",
        })
        return {
          session,
          responseText: "Custom style check passed.",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-2",
        name: "Custom style task",
        prompt: "Check with custom style",
        status: "backlog",
      })

      const customPrompt = "Use 4 spaces for indentation. Use semicolons."
      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: customPrompt,
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "high",
      }

      await runner.run(input)

      expect(capturedPrompt).toBe(customPrompt)

      // Verify high thinking level is passed through
      const callArg = mockExecutePrompt.mock.calls[0][0] as { thinkingLevel: string }
      expect(callArg.thinkingLevel).toBe("high")

      db.close()
    })

    it("should fall back to DEFAULT_CODE_STYLE_PROMPT when codeStylePrompt is empty", async () => {
      const root = createTempDir("tauroboros-codestyle-default-prompt-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      let capturedPrompt: string | undefined
      const mockExecutePrompt = mock(async (input: unknown): Promise<ExecuteSessionPromptResult> => {
        const execInput = input as { promptText: string }
        capturedPrompt = execInput.promptText

        const session = db.createWorkflowSession({
          id: "test-session-3",
          taskId: "task-3",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "completed",
        })
        return {
          session,
          responseText: "Default style check passed.",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-3",
        name: "Default style task",
        prompt: "Check with default style",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      await runner.run(input)

      expect(capturedPrompt).toBe(DEFAULT_CODE_STYLE_PROMPT)
      expect(capturedPrompt).toContain("code style enforcement")
      expect(capturedPrompt).toContain("STANDARD RULES")

      db.close()
    })

    it("should call onOutput callback when provided", async () => {
      const root = createTempDir("tauroboros-codestyle-callbacks-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const onOutputMock = mock((chunk: string) => {
        console.log(`Output: ${chunk}`)
      })

      const onSessionCreatedMock = mock((_process: unknown, _session: unknown) => {
        // session created callback
      })

      const mockExecutePrompt = mock(async (input: unknown): Promise<ExecuteSessionPromptResult> => {
        const execInput = input as { onOutput?: (chunk: string) => void; onSessionCreated?: () => void }

        // Simulate calling the callbacks
        if (execInput.onOutput) {
          execInput.onOutput("Processing files...")
        }
        if (execInput.onSessionCreated) {
          execInput.onSessionCreated({} as unknown as import("../src/runtime/pi-process.ts").PiRpcProcess, {} as unknown as import("../src/db/types.ts").PiWorkflowSession)
        }

        const session = db.createWorkflowSession({
          id: "test-session-callbacks",
          taskId: "task-callbacks",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "completed",
        })
        return {
          session,
          responseText: "Callbacks test passed.",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-callbacks",
        name: "Callbacks task",
        prompt: "Test callbacks",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
        onOutput: onOutputMock,
        onSessionCreated: onSessionCreatedMock,
      }

      await runner.run(input)

      // The callbacks should be passed through to executePrompt
      const callArg = mockExecutePrompt.mock.calls[0][0] as {
        onOutput?: (chunk: string) => void
        onSessionCreated?: () => void
      }
      expect(callArg.onOutput).toBe(onOutputMock)
      expect(callArg.onSessionCreated).toBe(onSessionCreatedMock)

      db.close()
    })

    it("should use container image from settings when task has no specific image", async () => {
      const root = createTempDir("tauroboros-codestyle-image-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      let capturedImage: string | null | undefined
      const mockExecutePrompt = mock(async (input: unknown): Promise<ExecuteSessionPromptResult> => {
        const execInput = input as { containerImage?: string | null }
        capturedImage = execInput.containerImage

        const session = db.createWorkflowSession({
          id: "test-session-image",
          taskId: "task-image",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "completed",
        })
        return {
          session,
          responseText: "Image test passed.",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const settings: InfrastructureSettings = {
        ...DEFAULT_INFRASTRUCTURE_SETTINGS,
        workflow: {
          ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow,
          container: {
            ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow.container,
            image: "custom-image:v1",
          },
        },
      }

      const runner = new CodeStyleSessionRunner(
        db,
        settings,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-image",
        name: "Image task",
        prompt: "Test image resolution",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      await runner.run(input)

      expect(capturedImage).toBe("custom-image:v1")

      db.close()
    })
  })

  describe("run() method failure handling", () => {
    it("should return failure when session status is not completed", async () => {
      const root = createTempDir("tauroboros-codestyle-failure-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const mockExecutePrompt = mock(async (_input: unknown): Promise<ExecuteSessionPromptResult> => {
        const session = db.createWorkflowSession({
          id: "test-session-fail",
          taskId: "task-fail",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "failed",
        })
        // Update session to reflect failure
        db.updateWorkflowSession("test-session-fail", {
          status: "failed",
          errorMessage: "Code style violations found",
        })

        return {
          session,
          responseText: "Issues found: trailing whitespace in file.ts",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-fail",
        name: "Failure task",
        prompt: "Check code style that will fail",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      const result = await runner.run(input)

      expect(result.success).toBe(false)
      expect(result.responseText).toBe("Issues found: trailing whitespace in file.ts")
      expect(result.sessionId).toBe("test-session-fail")
      expect(result.errorMessage).toBe("Code style violations found")

      db.close()
    })

    it("should handle throw from session manager", async () => {
      const root = createTempDir("tauroboros-codestyle-throw-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const mockExecutePrompt = mock(async (_input: unknown): Promise<ExecuteSessionPromptResult> => {
        throw new Error("Session execution failed: connection timeout")
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-throw",
        name: "Throw task",
        prompt: "Check code style that throws",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      // Should throw the error from session manager
      await expect(runner.run(input)).rejects.toThrow("Session execution failed: connection timeout")

      db.close()
    })

    it("should handle unknown session status gracefully", async () => {
      const root = createTempDir("tauroboros-codestyle-unknown-status-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const mockExecutePrompt = mock(async (_input: unknown): Promise<ExecuteSessionPromptResult> => {
        const session = db.createWorkflowSession({
          id: "test-session-unknown",
          taskId: "task-unknown",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "active", // Non-completed, non-failed status
        })

        return {
          session,
          responseText: "Session still active",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-unknown",
        name: "Unknown status task",
        prompt: "Check code style with unknown status",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      const result = await runner.run(input)

      // Should be false since status is "active", not "completed"
      expect(result.success).toBe(false)
      expect(result.responseText).toBe("Session still active")
      expect(result.sessionId).toBe("test-session-unknown")
      expect(result.errorMessage).toBeUndefined()

      db.close()
    })
  })

  describe("proper session manager delegation", () => {
    it("should pass all required parameters to session manager", async () => {
      const root = createTempDir("tauroboros-codestyle-params-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const capturedParams: unknown[] = []
      const mockExecutePrompt = mock(async (input: unknown): Promise<ExecuteSessionPromptResult> => {
        capturedParams.push(input)

        const session = db.createWorkflowSession({
          id: "test-session-params",
          taskId: "task-params",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "completed",
        })
        return {
          session,
          responseText: "Parameters test passed.",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-params",
        name: "Parameters task",
        prompt: "Check parameters",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: "/worktree/path",
        branch: "feature-branch",
        codeStylePrompt: "Custom prompt",
        model: "openai/gpt-4",
        thinkingLevel: "low",
      }

      await runner.run(input)

      expect(mockExecutePrompt).toHaveBeenCalledTimes(1)

      const params = capturedParams[0] as {
        taskId: string
        sessionKind: string
        cwd: string
        worktreeDir: string
        branch: string
        model: string
        thinkingLevel: string
        promptText: string
        containerImage?: string | null
      }

      expect(params.taskId).toBe("task-params")
      expect(params.sessionKind).toBe("task_run_reviewer")
      expect(params.cwd).toBe(root)
      expect(params.worktreeDir).toBe("/worktree/path")
      expect(params.branch).toBe("feature-branch")
      expect(params.model).toBe("openai/gpt-4")
      expect(params.thinkingLevel).toBe("low")
      expect(params.promptText).toBe("Custom prompt")

      db.close()
    })
  })

  describe("correct result structure", () => {
    it("should return result with all required fields on success", async () => {
      const root = createTempDir("tauroboros-codestyle-result-success-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const mockExecutePrompt = mock(async (_input: unknown): Promise<ExecuteSessionPromptResult> => {
        const session = db.createWorkflowSession({
          id: "session-success",
          taskId: "task-result",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "completed",
        })
        return {
          session,
          responseText: "All code style checks passed successfully!",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-result",
        name: "Result task",
        prompt: "Check result structure",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      const result = await runner.run(input)

      // Verify all required fields are present
      expect(result).toHaveProperty("success")
      expect(result).toHaveProperty("responseText")
      expect(result).toHaveProperty("sessionId")
      expect(result).toHaveProperty("errorMessage")

      // Verify types
      expect(typeof result.success).toBe("boolean")
      expect(typeof result.responseText).toBe("string")
      expect(typeof result.sessionId).toBe("string")

      // On success, errorMessage should be undefined
      expect(result.success).toBe(true)
      expect(result.errorMessage).toBeUndefined()
      expect(result.responseText).toBe("All code style checks passed successfully!")
      expect(result.sessionId).toBe("session-success")

      db.close()
    })

    it("should return result with all required fields on failure", async () => {
      const root = createTempDir("tauroboros-codestyle-result-failure-")
      const db = new PiKanbanDB(join(root, "tasks.db"))

      const mockExecutePrompt = mock(async (_input: unknown): Promise<ExecuteSessionPromptResult> => {
        const session = db.createWorkflowSession({
          id: "session-failure",
          taskId: "task-fail-result",
          sessionKind: "task_run_reviewer",
          cwd: root,
          status: "failed",
        })
        db.updateWorkflowSession("session-failure", {
          status: "failed",
          errorMessage: "Trailing whitespace detected in 3 files",
        })

        return {
          session,
          responseText: "Code style issues found",
        }
      })

      const mockSessionManager = {
        executePrompt: mockExecutePrompt,
      } as unknown as PiSessionManager

      const runner = new CodeStyleSessionRunner(
        db,
        DEFAULT_INFRASTRUCTURE_SETTINGS,
        undefined,
        mockSessionManager
      )

      const task = db.createTask({
        id: "task-fail-result",
        name: "Fail result task",
        prompt: "Check failure result structure",
        status: "backlog",
      })

      const input: RunCodeStyleInput = {
        task,
        cwd: root,
        worktreeDir: root,
        branch: "master",
        codeStylePrompt: "",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "default",
      }

      const result = await runner.run(input)

      // Verify all required fields are present
      expect(result).toHaveProperty("success")
      expect(result).toHaveProperty("responseText")
      expect(result).toHaveProperty("sessionId")
      expect(result).toHaveProperty("errorMessage")

      // On failure
      expect(result.success).toBe(false)
      expect(result.errorMessage).toBe("Trailing whitespace detected in 3 files")
      expect(result.responseText).toBe("Code style issues found")
      expect(result.sessionId).toBe("session-failure")

      db.close()
    })
  })
})
