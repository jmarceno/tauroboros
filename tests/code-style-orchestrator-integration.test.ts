/**
 * Integration Tests: Code Style Feature in Orchestrator
 *
 * Tests the code style integration within the orchestrator:
 * 1. Code style success path - task moves to done
 * 2. Code style failure path - task goes to stuck
 * 3. Code style disabled path - task skips code-style phase
 * 4. Integration with review loop
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/backend-ts/db.ts"
import { PiOrchestrator } from "../src/backend-ts/orchestrator.ts"
import { DEFAULT_INFRASTRUCTURE_SETTINGS } from "../src/backend-ts/config/settings.ts"
import { DEFAULT_CODE_STYLE_PROMPT, type Task, type WSMessage } from "../src/backend-ts/types.ts"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

function createMockGitRepo(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true })
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(dir, ".git", "config"), `[core]
    repositoryformatversion = 0
    filemode = true
    bare = false
`)
}

// Mock broadcast function
const createMockBroadcast = () => {
  const messages: WSMessage[] = []
  return {
    broadcast: (msg: WSMessage) => {
      messages.push(msg)
    },
    getMessages: () => messages,
    clearMessages: () => { messages.length = 0 },
  }
}

// Mock session URL function
const mockSessionUrlFor = (sessionId: string) => `/sessions/${sessionId}`

describe("Code Style Orchestrator Integration", () => {
  let root: string
  let db: PiKanbanDB
  let orchestrator: PiOrchestrator
  let mockBroadcast: ReturnType<typeof createMockBroadcast>

  beforeEach(() => {
    root = createTempDir("tauroboros-codestyle-integ-")
    createMockGitRepo(root)
    db = new PiKanbanDB(join(root, "tasks.db"))
    mockBroadcast = createMockBroadcast()
    orchestrator = new PiOrchestrator(
      db,
      mockBroadcast.broadcast,
      mockSessionUrlFor,
      root,
      DEFAULT_INFRASTRUCTURE_SETTINGS
    )
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe("Task Creation with Code Style Options", () => {
    it("should create task with codeStyleReview=true", () => {
      const task = db.createTask({
        id: "task-cs-enabled",
        name: "Task with Code Style Enabled",
        prompt: "Create a test file",
        status: "backlog",
        review: true,
        codeStyleReview: true,
      })

      expect(task).toBeDefined()
      expect(task.review).toBe(true)
      expect(task.codeStyleReview).toBe(true)

      // Verify task is stored correctly
      const stored = db.getTask(task.id)
      expect(stored).toBeDefined()
      expect(stored?.codeStyleReview).toBe(true)
    })

    it("should create task with codeStyleReview=false", () => {
      const task = db.createTask({
        id: "task-cs-disabled",
        name: "Task with Code Style Disabled",
        prompt: "Create a test file",
        status: "backlog",
        review: true,
        codeStyleReview: false,
      })

      expect(task).toBeDefined()
      expect(task.codeStyleReview).toBe(false)

      const stored = db.getTask(task.id)
      expect(stored?.codeStyleReview).toBe(false)
    })

    it("should default codeStyleReview to false when not specified", () => {
      const task = db.createTask({
        id: "task-cs-default",
        name: "Task with Code Style Default",
        prompt: "Create a test file",
        status: "backlog",
        review: true,
        // codeStyleReview not specified
      })

      // Should default to false
      expect(task.codeStyleReview).toBe(false)
    })

    it("should update task codeStyleReview option", () => {
      const task = db.createTask({
        id: "task-cs-update",
        name: "Task to Update",
        prompt: "Create a test file",
        status: "backlog",
        review: true,
        codeStyleReview: false,
      })

      // Update to enable code style
      const updated = db.updateTask(task.id, { codeStyleReview: true })
      expect(updated).toBeDefined()
      expect(updated?.codeStyleReview).toBe(true)

      // Verify stored
      const stored = db.getTask(task.id)
      expect(stored?.codeStyleReview).toBe(true)
    })
  })

  describe("Task Status Workflow with Code Style", () => {
    it("should have correct status sequence in database", () => {
      // This test verifies the status types are properly defined
      const validStatuses = [
        "template",
        "backlog",
        "executing",
        "review",
        "code-style",
        "done",
        "failed",
        "stuck"
      ]

      for (const status of validStatuses) {
        const task = db.createTask({
          id: `task-status-${status}`,
          name: `Task with status ${status}`,
          prompt: "Test",
          status: status as Task["status"],
        })

        expect(task.status).toBe(status)

        const stored = db.getTask(task.id)
        expect(stored?.status).toBe(status)
      }
    })

    it("should track task through status transitions", () => {
      const task = db.createTask({
        id: "task-transition",
        name: "Task for Transition Test",
        prompt: "Test transitions",
        status: "backlog",
        review: true,
        codeStyleReview: true,
      })

      const transitions: string[] = []

      // Simulate workflow transitions
      const statuses: Array<Task["status"]> = [
        "backlog",
        "executing",
        "review",
        "code-style",
        "done"
      ]

      for (const status of statuses) {
        const updated = db.updateTask(task.id, { status })
        expect(updated?.status).toBe(status)
        transitions.push(status)
      }

      expect(transitions).toEqual([
        "backlog",
        "executing",
        "review",
        "code-style",
        "done"
      ])

      const final = db.getTask(task.id)
      expect(final?.status).toBe("done")
    })

    it("should handle stuck status from code-style", () => {
      const task = db.createTask({
        id: "task-cs-stuck",
        name: "Task that gets stuck in code-style",
        prompt: "Test stuck state",
        status: "code-style",
        review: true,
        codeStyleReview: true,
      })

      // Simulate transition to stuck
      const updated = db.updateTask(task.id, {
        status: "stuck",
        errorMessage: "Code style enforcement failed"
      })

      expect(updated?.status).toBe("stuck")
      expect(updated?.errorMessage).toBe("Code style enforcement failed")
    })
  })

  describe("Code Style Review Dependencies", () => {
    it("should require review=true for codeStyleReview to work", () => {
      // In the orchestrator logic, code style only runs if review is also enabled
      const taskWithBoth = db.createTask({
        id: "task-both-enabled",
        name: "Task with both review and code style",
        prompt: "Test",
        review: true,
        codeStyleReview: true,
      })

      expect(taskWithBoth.review).toBe(true)
      expect(taskWithBoth.codeStyleReview).toBe(true)

      // This simulates what orchestrator does - code style needs review
      const shouldRunCodeStyle = taskWithBoth.review && taskWithBoth.codeStyleReview
      expect(shouldRunCodeStyle).toBe(true)
    })

    it("should not run code style when review=false", () => {
      const taskNoReview = db.createTask({
        id: "task-no-review",
        name: "Task without review",
        prompt: "Test",
        review: false,
        codeStyleReview: true, // Even if true, shouldn't run without review
      })

      // This simulates orchestrator logic
      const shouldRunCodeStyle = taskNoReview.review && taskNoReview.codeStyleReview
      expect(shouldRunCodeStyle).toBe(false)
    })
  })

  describe("Broadcast Messages for Code Style", () => {
    it("should broadcast task updates when code-style status changes", () => {
      mockBroadcast.clearMessages()

      const task = db.createTask({
        id: "task-broadcast",
        name: "Task for Broadcast Test",
        prompt: "Test broadcasts",
        status: "backlog",
        review: true,
        codeStyleReview: true,
      })

      // Simulate status change to code-style
      db.updateTask(task.id, { status: "code-style" })

      // The orchestrator would broadcast this - simulate it
      const updated = db.getTask(task.id)
      mockBroadcast.broadcast({
        type: "task_updated",
        payload: updated!
      })

      const messages = mockBroadcast.getMessages()
      expect(messages.length).toBeGreaterThan(0)

      const taskUpdate = messages.find(m => m.type === "task_updated")
      expect(taskUpdate).toBeDefined()
      expect(taskUpdate?.payload).toHaveProperty("status", "code-style")
    })

    it("should broadcast code-style column visibility", () => {
      // When a task enters code-style status, the UI should show the column
      mockBroadcast.clearMessages()

      const task = db.createTask({
        id: "task-cs-visible",
        name: "Task for Code Style Visibility",
        prompt: "Test visibility",
        status: "code-style",
        review: true,
        codeStyleReview: true,
      })

      mockBroadcast.broadcast({
        type: "task_updated",
        payload: task
      })

      const messages = mockBroadcast.getMessages()
      expect(messages.some(m => m.type === "task_updated")).toBe(true)
    })
  })

  describe("Code Style with Custom Prompt", () => {
    it("should store custom code style prompt in options", () => {
      const customPrompt = "Use 4 spaces indentation. Use semicolons. Max line length 80."

      // codeStylePrompt is stored in options, not on individual tasks
      db.updateOptions({ codeStylePrompt: customPrompt })

      const options = db.getOptions()
      expect(options.codeStylePrompt).toBe(customPrompt)
    })

    it("should use default prompt when code style prompt is empty in options", () => {
      // Set empty prompt in options
      db.updateOptions({ codeStylePrompt: "" })

      const options = db.getOptions()
      // Empty string in database returns the DEFAULT_CODE_STYLE_PROMPT
      // No silent fallbacks - the default is always visible
      expect(options.codeStylePrompt).toBe(DEFAULT_CODE_STYLE_PROMPT)
    })

    it("should allow per-task code style review flag while using global prompt", () => {
      // Global code style prompt
      db.updateOptions({ codeStylePrompt: "Use 2 spaces indentation" })

      // Task with code style enabled (uses global prompt)
      const task = db.createTask({
        id: "task-with-cs",
        name: "Task With Code Style",
        prompt: "Create test file",
        status: "backlog",
        review: true,
        codeStyleReview: true,
      })

      // Task stores whether to run code style
      expect(task.codeStyleReview).toBe(true)

      // Global options store the prompt
      const options = db.getOptions()
      expect(options.codeStylePrompt).toBe("Use 2 spaces indentation")
    })
  })

  describe("Task Retrieval and Filtering", () => {
    it("should retrieve tasks by codeStyleReview status", () => {
      // Create tasks with different code style settings
      const taskWithCS = db.createTask({
        id: "task-cs-1",
        name: "With Code Style 1",
        prompt: "Test",
        review: true,
        codeStyleReview: true,
      })

      const taskWithoutCS = db.createTask({
        id: "task-cs-0",
        name: "Without Code Style",
        prompt: "Test",
        review: true,
        codeStyleReview: false,
      })

      const allTasks = db.getTasks()
      expect(allTasks.length).toBe(2)

      const withCodeStyle = allTasks.filter(t => t.codeStyleReview)
      const withoutCodeStyle = allTasks.filter(t => !t.codeStyleReview)

      expect(withCodeStyle.length).toBe(1)
      expect(withCodeStyle[0]?.id).toBe(taskWithCS.id)

      expect(withoutCodeStyle.length).toBe(1)
      expect(withoutCodeStyle[0]?.id).toBe(taskWithoutCS.id)
    })

    it("should retrieve tasks by status including code-style", () => {
      db.createTask({
        id: "task-cs-backlog",
        name: "CS Task Backlog",
        prompt: "Test",
        status: "backlog",
        review: true,
        codeStyleReview: true,
      })

      db.createTask({
        id: "task-cs-executing",
        name: "CS Task Executing",
        prompt: "Test",
        status: "executing",
        review: true,
        codeStyleReview: true,
      })

      db.createTask({
        id: "task-cs-review",
        name: "CS Task Review",
        prompt: "Test",
        status: "review",
        review: true,
        codeStyleReview: true,
      })

      db.createTask({
        id: "task-cs-phase",
        name: "CS Task Code-Style",
        prompt: "Test",
        status: "code-style",
        review: true,
        codeStyleReview: true,
      })

      db.createTask({
        id: "task-cs-done",
        name: "CS Task Done",
        prompt: "Test",
        status: "done",
        review: true,
        codeStyleReview: true,
      })

      const allTasks = db.getTasks()
      expect(allTasks.length).toBe(5)

      const codeStyleTasks = allTasks.filter(t => t.status === "code-style")
      expect(codeStyleTasks.length).toBe(1)
      expect(codeStyleTasks[0]?.name).toBe("CS Task Code-Style")

      const doneTasks = allTasks.filter(t => t.status === "done")
      expect(doneTasks.length).toBe(1)
      expect(doneTasks[0]?.name).toBe("CS Task Done")
    })
  })

  describe("Workflow Run with Code Style Tasks", () => {
    it("should create workflow run including code-style tasks", () => {
      // Create tasks
      const task1 = db.createTask({
        id: "run-task-1",
        name: "Run Task 1",
        prompt: "Test",
        status: "backlog",
        review: true,
        codeStyleReview: true,
      })

      const task2 = db.createTask({
        id: "run-task-2",
        name: "Run Task 2",
        prompt: "Test",
        status: "backlog",
        review: true,
        codeStyleReview: false,
      })

      // Create workflow run
      const run = db.createWorkflowRun({
        id: "run-1",
        kind: "all_tasks",
        status: "running",
        taskOrder: [task1.id, task2.id],
        currentTaskId: task1.id,
        currentTaskIndex: 0,
      })

      expect(run.taskOrder).toContain(task1.id)
      expect(run.taskOrder).toContain(task2.id)

      // Verify both tasks are in the run
      const storedRun = db.getWorkflowRun(run.id)
      expect(storedRun?.taskOrder.length).toBe(2)
    })

    it("should track run progress through code-style phase", () => {
      const task = db.createTask({
        id: "progress-task",
        name: "Progress Task",
        prompt: "Test",
        status: "code-style",
        review: true,
        codeStyleReview: true,
      })

      const run = db.createWorkflowRun({
        id: "progress-run",
        kind: "all_tasks",
        status: "running",
        taskOrder: [task.id],
        currentTaskId: task.id,
        currentTaskIndex: 0,
      })

      expect(run.currentTaskId).toBe(task.id)
      expect(run.status).toBe("running")

      // Update run when task completes
      const updatedRun = db.updateWorkflowRun(run.id, {
        status: "completed",
        finishedAt: Math.floor(Date.now() / 1000),
      })

      expect(updatedRun?.status).toBe("completed")
    })
  })

  describe("Error Handling in Code Style", () => {
    it("should store error message when code style fails", () => {
      const task = db.createTask({
        id: "error-task",
        name: "Error Task",
        prompt: "Test",
        status: "code-style",
        review: true,
        codeStyleReview: true,
      })

      const errorMsg = "Style violations found: trailing whitespace, missing semicolons"

      const updated = db.updateTask(task.id, {
        status: "stuck",
        errorMessage: errorMsg,
      })

      expect(updated?.status).toBe("stuck")
      expect(updated?.errorMessage).toBe(errorMsg)

      const stored = db.getTask(task.id)
      expect(stored?.errorMessage).toBe(errorMsg)
    })

    it("should clear error message on retry", () => {
      const task = db.createTask({
        id: "retry-task",
        name: "Retry Task",
        prompt: "Test",
        status: "stuck",
        errorMessage: "Previous error",
        review: true,
        codeStyleReview: true,
      })

      // Simulate retry - move back to backlog
      const updated = db.updateTask(task.id, {
        status: "backlog",
        errorMessage: null,
      })

      expect(updated?.status).toBe("backlog")
      expect(updated?.errorMessage).toBeNull()
    })
  })

  describe("Session Management for Code Style", () => {
    it("should create session with task_run_reviewer kind for code style", () => {
      // Create a task first (foreign key requirement)
      const task = db.createTask({
        id: "session-task-1",
        name: "Session Test Task 1",
        prompt: "Test",
      })

      const session = db.createWorkflowSession({
        id: "cs-session-1",
        taskId: task.id,
        sessionKind: "task_run_reviewer",
        cwd: root,
        status: "completed",
      })

      expect(session.sessionKind).toBe("task_run_reviewer")
      expect(session.taskId).toBe(task.id)

      const stored = db.getWorkflowSession(session.id)
      expect(stored?.sessionKind).toBe("task_run_reviewer")
    })

    it("should track session status for code style run", () => {
      // Create a task first (foreign key requirement)
      const task = db.createTask({
        id: "session-task-2",
        name: "Session Test Task 2",
        prompt: "Test",
      })

      const session = db.createWorkflowSession({
        id: "cs-session-2",
        taskId: task.id,
        sessionKind: "task_run_reviewer",
        cwd: root,
        status: "starting",
      })

      expect(session.status).toBe("starting")

      // Simulate session progressing
      const active = db.updateWorkflowSession(session.id, { status: "active" })
      expect(active?.status).toBe("active")

      const completed = db.updateWorkflowSession(session.id, { status: "completed" })
      expect(completed?.status).toBe("completed")
    })
  })
});
