import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { PiKanbanDB } from "../src/db.ts"

const tempDirs: string[] = []

function createTempDb(): { db: PiKanbanDB; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tauroboros-db-"))
  tempDirs.push(root)
  const dbPath = join(root, "tasks.db")
  const db = new PiKanbanDB(dbPath)
  return { db, dbPath }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("PiKanbanDB", () => {
  it("creates schema, default options, and prompt template seeds", () => {
    const { db } = createTempDb()

    const options = db.getOptions()
    expect(options.parallelTasks).toBe(1)
    expect(options.commitPrompt.length).toBeGreaterThan(20)

    const prompts = db.getAllPromptTemplates()
    expect(prompts.length).toBeGreaterThanOrEqual(10)
    expect(prompts.some((item) => item.key === "execution")).toBe(true)
    expect(prompts.some((item) => item.key === "commit")).toBe(true)

    db.close()
  })

  it("codeStylePrompt defaults to DEFAULT_CODE_STYLE_PROMPT and can be updated", () => {
    const { db } = createTempDb()

    // Verify default falls back to DEFAULT_CODE_STYLE_PROMPT when empty in DB
    const options = db.getOptions()
    expect(options.codeStylePrompt.length).toBeGreaterThan(0)
    expect(options.codeStylePrompt.includes("code style")).toBe(true)

    // Update to a custom prompt
    const customPrompt = "Custom code style enforcement rules"
    const updated = db.updateOptions({ codeStylePrompt: customPrompt })
    expect(updated.codeStylePrompt).toBe(customPrompt)

    // Verify persistence
    const reloaded = db.getOptions()
    expect(reloaded.codeStylePrompt).toBe(customPrompt)

    // Reset to empty string - falls back to DEFAULT_CODE_STYLE_PROMPT
    const reset = db.updateOptions({ codeStylePrompt: "" })
    expect(reset.codeStylePrompt).not.toBe("")
    expect(reset.codeStylePrompt.length).toBeGreaterThan(0)

    db.close()
  })

  it("codeStyleReview defaults to false on tasks and can be updated", () => {
    const { db } = createTempDb()

    // Create a task without specifying codeStyleReview
    const task = db.createTask({
      id: "task-csr-1",
      name: "Code Style Review Test Task",
      prompt: "Test code style review field",
      status: "backlog",
    })

    // Verify default is false
    expect(task.codeStyleReview).toBe(false)

    // Verify persistence
    const reloaded = db.getTask("task-csr-1")
    expect(reloaded?.codeStyleReview).toBe(false)

    // Update to true
    const updated = db.updateTask("task-csr-1", { codeStyleReview: true })
    expect(updated?.codeStyleReview).toBe(true)

    // Verify persistence after update
    const reloadedAfterUpdate = db.getTask("task-csr-1")
    expect(reloadedAfterUpdate?.codeStyleReview).toBe(true)

    // Update back to false
    const reset = db.updateTask("task-csr-1", { codeStyleReview: false })
    expect(reset?.codeStyleReview).toBe(false)

    db.close()
  })

  it("supports task and workflow run storage", () => {
    const { db } = createTempDb()

    const task = db.createTask({
      id: "task-1",
      name: "Build DB layer",
      prompt: "Implement database layer",
      status: "backlog",
    })
    expect(task.id).toBe("task-1")
    expect(db.getTasks().length).toBe(1)

    const updatedTask = db.updateTask("task-1", { status: "executing", reviewCount: 1 })
    expect(updatedTask?.status).toBe("executing")
    expect(updatedTask?.reviewCount).toBe(1)

    const run = db.createWorkflowRun({
      id: "run-1",
      kind: "single_task",
      displayName: "Run 1",
      taskOrder: ["task-1"],
      currentTaskId: "task-1",
    })
    expect(run.id).toBe("run-1")

    const updatedRun = db.updateWorkflowRun("run-1", { status: "completed", finishedAt: Math.floor(Date.now() / 1000) })
    expect(updatedRun?.status).toBe("completed")

    const deleted = db.deleteTask("task-1")
    expect(deleted).toBe(true)
    expect(db.getTask("task-1")).toBeNull()

    db.close()
  })

  it("supports normalized session message storage", () => {
    const { db } = createTempDb()

    db.createWorkflowSession({
      id: "session-messages",
      sessionKind: "task",
      cwd: "/tmp/work",
    })

    const created = db.createSessionMessage({
      sessionId: "session-messages",
      role: "assistant",
      messageType: "assistant_response",
      contentJson: { text: "Done" },
      modelProvider: "pi",
      modelId: "default",
    })

    expect(created.id).toBeGreaterThan(0)
    expect(created.seq).toBe(1)
    expect(created.messageType).toBe("assistant_response")

    const updated = db.updateSessionMessage(created.id, {
      messageType: "text",
      contentJson: { text: "Done updated" },
    })
    expect(updated?.messageType).toBe("text")
    expect(updated?.contentJson.text).toBe("Done updated")

    const timeline = db.getSessionTimeline("session-messages")
    expect(timeline.length).toBe(1)
    expect(timeline[0]?.sessionId).toBe("session-messages")

    const filtered = db.getSessionMessagesByType("session-messages", "text")
    expect(filtered.length).toBe(1)

    db.close()
  })

  it("computes per-session token and cost rollups", () => {
    const { db } = createTempDb()

    db.createWorkflowSession({
      id: "session-usage",
      sessionKind: "task",
      cwd: "/tmp/work",
    })

    db.createSessionMessage({
      sessionId: "session-usage",
      timestamp: 100,
      role: "assistant",
      eventName: "message_end",
      messageType: "assistant_response",
      contentJson: { text: "first" },
      promptTokens: 100,
      completionTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 127,
      costTotal: 0.12,
    })

    db.createSessionMessage({
      sessionId: "session-usage",
      timestamp: 120,
      role: "assistant",
      eventName: "message_end",
      messageType: "assistant_response",
      contentJson: { text: "second" },
      promptTokens: 40,
      completionTokens: 10,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 54,
      costTotal: 0.05,
    })

    db.createSessionMessage({
      sessionId: "session-usage",
      timestamp: 130,
      role: "system",
      eventName: "agent_end",
      messageType: "step_finish",
      contentJson: { text: "done" },
    })

    const rollup = db.getSessionUsageRollup("session-usage")
    expect(rollup.sessionId).toBe("session-usage")
    expect(rollup.messageCount).toBe(3)
    expect(rollup.tokenizedMessageCount).toBe(2)
    expect(rollup.costedMessageCount).toBe(2)
    expect(rollup.firstTimestamp).toBe(100)
    expect(rollup.lastTimestamp).toBe(130)
    expect(rollup.promptTokens).toBe(140)
    expect(rollup.completionTokens).toBe(30)
    expect(rollup.cacheReadTokens).toBe(8)
    expect(rollup.cacheWriteTokens).toBe(3)
    expect(rollup.totalTokens).toBe(181)
    expect(rollup.totalCost).toBeCloseTo(0.17, 10)

    db.close()
  })

  it("creates a pi-native session_messages schema", () => {
    const { db, dbPath } = createTempDb()
    db.close()

    const sqlite = new Database(dbPath, { readonly: true })
    const columns = sqlite.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>
    const names = columns.map((column) => column.name)

    expect(names.includes("seq")).toBe(true)
    expect(names.includes("event_name")).toBe(true)
    expect(names.includes("cache_read_tokens")).toBe(true)
    expect(names.includes("cache_write_tokens")).toBe(true)
    expect(names.includes("cost_json")).toBe(true)
    expect(names.includes("cost_total")).toBe(true)
    expect(names.includes("tool_call_id")).toBe(true)
    expect(names.includes("task_id")).toBe(false)
    expect(names.includes("task_run_id")).toBe(false)

    sqlite.close(false)
  })

  it("supports best-of-n task runs and candidates mutation APIs", () => {
    const { db } = createTempDb()

    db.createTask({
      id: "bon-db-1",
      name: "Best of N task",
      prompt: "Run best of n",
      executionStrategy: "best_of_n",
      bestOfNConfig: {
        workers: [{ model: "default", count: 1 }],
        reviewers: [],
        finalApplier: { model: "default" },
        minSuccessfulWorkers: 1,
        selectionMode: "pick_best",
      },
    })

    const run = db.createTaskRun({
      taskId: "bon-db-1",
      phase: "worker",
      slotIndex: 0,
      attemptIndex: 0,
      model: "default",
      status: "running",
    })
    expect(run.id.length).toBeGreaterThan(0)

    const updatedRun = db.updateTaskRun(run.id, {
      status: "done",
      summary: "worker done",
      metadataJson: { reviewerOutput: null },
      completedAt: Math.floor(Date.now() / 1000),
    })
    expect(updatedRun?.status).toBe("done")
    expect(updatedRun?.summary).toBe("worker done")
    expect(db.getTaskRunsByPhase("bon-db-1", "worker").length).toBe(1)

    const candidate = db.createTaskCandidate({
      taskId: "bon-db-1",
      workerRunId: run.id,
      status: "available",
      changedFilesJson: ["src/index.ts"],
      diffStatsJson: { "src/index.ts": 12 },
      verificationJson: { status: "passed" },
      summary: "candidate summary",
    })
    expect(candidate.id.length).toBeGreaterThan(0)

    const updatedCandidate = db.updateTaskCandidate(candidate.id, { status: "selected" })
    expect(updatedCandidate?.status).toBe("selected")

    const summary = db.getBestOfNSummary("bon-db-1")
    expect(summary.workersTotal).toBe(1)
    expect(summary.workersDone).toBe(1)
    expect(summary.availableCandidates + summary.selectedCandidates).toBe(1)

    db.close()
  })

  it("renders prompt templates", () => {
    const { db } = createTempDb()

    const rendered = db.renderPromptAndCapture({
      key: "execution",
      variables: {
        task: { id: "task-2", name: "Task 2", prompt: "Do work" },
        execution_intro: "Implement now",
        approved_plan_block: "",
        user_guidance_block: "",
        additional_context_block: "",
      },
    })

    expect(rendered.renderedText.includes("Do work")).toBe(true)
    expect(rendered.renderedText.includes("Implement now")).toBe(true)

    const beforeVersions = db.getPromptTemplateVersions("execution").length
    db.upsertPromptTemplate({
      key: "execution",
      name: "Task Execution",
      description: "updated",
      templateText: "Execute task {{task.id}} quickly",
      variablesJson: ["task"],
    })
    const afterVersions = db.getPromptTemplateVersions("execution").length
    expect(afterVersions).toBe(beforeVersions + 1)

    db.close()
  })

  describe("archived tasks", () => {
    it("getArchivedTasks() returns only archived tasks ordered by archived_at DESC", async () => {
      const { db } = createTempDb()

      db.createTask({ id: "arch-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createTask({ id: "arch-2", name: "Task 2", prompt: "P2", status: "done" })
      db.createTask({ id: "arch-3", name: "Task 3", prompt: "P3", status: "backlog" })

      let archived = db.getArchivedTasks()
      expect(archived.length).toBe(0)

      db.archiveTask("arch-1")
      await new Promise((resolve) => setTimeout(resolve, 10))
      db.archiveTask("arch-2")

      archived = db.getArchivedTasks()
      expect(archived.length).toBe(2)
      expect(archived.some((t) => t.id === "arch-1")).toBe(true)
      expect(archived.some((t) => t.id === "arch-2")).toBe(true)
      expect(archived.some((t) => t.id === "arch-3")).toBe(false)

      expect(archived.every((t) => t.isArchived)).toBe(true)

      const firstTimestamp = archived[0]?.archivedAt
      const secondTimestamp = archived[1]?.archivedAt
      expect(firstTimestamp).not.toBeNull()
      expect(secondTimestamp).not.toBeNull()
      if (firstTimestamp !== null && secondTimestamp !== null) {
        expect(firstTimestamp).toBeGreaterThanOrEqual(secondTimestamp)
      }

      db.close()
    })

    it("getArchivedTasks() returns empty array when no archived tasks exist", () => {
      const { db } = createTempDb()

      db.createTask({ id: "no-arch-1", name: "Task 1", prompt: "P1", status: "backlog" })
      db.createTask({ id: "no-arch-2", name: "Task 2", prompt: "P2", status: "executing" })

      const archived = db.getArchivedTasks()
      expect(archived).toEqual([])

      db.close()
    })

    it("getArchivedTasksByRun() returns archived tasks for a specific run's task_order", () => {
      const { db } = createTempDb()

      db.createTask({ id: "run-arch-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createTask({ id: "run-arch-2", name: "Task 2", prompt: "P2", status: "done" })
      db.createTask({ id: "run-arch-3", name: "Task 3", prompt: "P3", status: "done" })

      db.createWorkflowRun({
        id: "run-with-archived",
        kind: "all_tasks",
        displayName: "Test Run",
        taskOrder: ["run-arch-1", "run-arch-2"],
        status: "completed",
        finishedAt: Math.floor(Date.now() / 1000),
      })

      db.archiveTask("run-arch-1")

      let archivedInRun = db.getArchivedTasksByRun("run-with-archived")
      expect(archivedInRun.length).toBe(1)
      expect(archivedInRun[0]?.id).toBe("run-arch-1")

      db.archiveTask("run-arch-2")

      archivedInRun = db.getArchivedTasksByRun("run-with-archived")
      expect(archivedInRun.length).toBe(2)
      expect(archivedInRun.some((t) => t.id === "run-arch-1")).toBe(true)
      expect(archivedInRun.some((t) => t.id === "run-arch-2")).toBe(true)

      db.archiveTask("run-arch-3")
      archivedInRun = db.getArchivedTasksByRun("run-with-archived")
      expect(archivedInRun.length).toBe(2)
      expect(archivedInRun.some((t) => t.id === "run-arch-3")).toBe(false)

      db.close()
    })

    it("getArchivedTasksByRun() returns empty array for non-existent runId", () => {
      const { db } = createTempDb()

      const archived = db.getArchivedTasksByRun("non-existent-run")
      expect(archived).toEqual([])

      db.close()
    })

    it("getArchivedTasksByRun() returns empty array when run has no archived tasks", () => {
      const { db } = createTempDb()

      db.createTask({ id: "no-run-arch-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createTask({ id: "no-run-arch-2", name: "Task 2", prompt: "P2", status: "done" })

      db.createWorkflowRun({
        id: "run-no-archived",
        kind: "all_tasks",
        displayName: "Test Run",
        taskOrder: ["no-run-arch-1", "no-run-arch-2"],
        status: "completed",
      })

      const archived = db.getArchivedTasksByRun("run-no-archived")
      expect(archived).toEqual([])

      db.close()
    })

    it("getArchivedTasksByRun() returns empty array when run has empty task_order", () => {
      const { db } = createTempDb()

      db.createWorkflowRun({
        id: "run-empty-order",
        kind: "all_tasks",
        displayName: "Test Run",
        taskOrder: [],
        status: "completed",
      })

      const archived = db.getArchivedTasksByRun("run-empty-order")
      expect(archived).toEqual([])

      db.close()
    })

    it("getWorkflowRunsWithArchivedTasks() returns only runs with archived tasks", () => {
      const { db } = createTempDb()

      db.createTask({ id: "wrat-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createTask({ id: "wrat-2", name: "Task 2", prompt: "P2", status: "done" })
      db.createTask({ id: "wrat-3", name: "Task 3", prompt: "P3", status: "done" })
      db.createTask({ id: "wrat-4", name: "Task 4", prompt: "P4", status: "done" })

      db.createWorkflowRun({
        id: "run-with-arch-1",
        kind: "all_tasks",
        displayName: "Run With Archived 1",
        taskOrder: ["wrat-1"],
        status: "completed",
        finishedAt: 1000,
      })

      db.createWorkflowRun({
        id: "run-with-arch-2",
        kind: "all_tasks",
        displayName: "Run With Archived 2",
        taskOrder: ["wrat-2", "wrat-3"],
        status: "completed",
        finishedAt: 2000,
      })

      db.createWorkflowRun({
        id: "run-without-arch",
        kind: "all_tasks",
        displayName: "Run Without Archived",
        taskOrder: ["wrat-4"],
        status: "completed",
        finishedAt: 3000,
      })

      let runsWithArchived = db.getWorkflowRunsWithArchivedTasks()
      expect(runsWithArchived.length).toBe(0)

      db.archiveTask("wrat-1")
      db.archiveTask("wrat-2")

      runsWithArchived = db.getWorkflowRunsWithArchivedTasks()
      expect(runsWithArchived.length).toBe(2)
      expect(runsWithArchived.some((r) => r.id === "run-with-arch-1")).toBe(true)
      expect(runsWithArchived.some((r) => r.id === "run-with-arch-2")).toBe(true)
      expect(runsWithArchived.some((r) => r.id === "run-without-arch")).toBe(false)

      expect(runsWithArchived[0]?.id).toBe("run-with-arch-2")
      expect(runsWithArchived[1]?.id).toBe("run-with-arch-1")

      db.close()
    })

    it("getWorkflowRunsWithArchivedTasks() returns empty array when no runs have archived tasks", () => {
      const { db } = createTempDb()

      db.createTask({ id: "no-wrat-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createWorkflowRun({
        id: "run-no-arch-tasks",
        kind: "all_tasks",
        displayName: "Run",
        taskOrder: ["no-wrat-1"],
        status: "completed",
      })

      const runsWithArchived = db.getWorkflowRunsWithArchivedTasks()
      expect(runsWithArchived).toEqual([])

      db.close()
    })

    it("getArchivedTasksGroupedByRun() returns correct Map structure with run and tasks", () => {
      const { db } = createTempDb()

      db.createTask({ id: "group-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createTask({ id: "group-2", name: "Task 2", prompt: "P2", status: "done" })
      db.createTask({ id: "group-3", name: "Task 3", prompt: "P3", status: "done" })

      db.createWorkflowRun({
        id: "run-group-1",
        kind: "all_tasks",
        displayName: "First Run",
        taskOrder: ["group-1", "group-2"],
        status: "completed",
        finishedAt: 1000,
      })

      db.createWorkflowRun({
        id: "run-group-2",
        kind: "all_tasks",
        displayName: "Second Run",
        taskOrder: ["group-3"],
        status: "completed",
        finishedAt: 2000,
      })

      db.archiveTask("group-1")
      db.archiveTask("group-2")
      db.archiveTask("group-3")

      const grouped = db.getArchivedTasksGroupedByRun()

      expect(grouped.size).toBe(2)
      expect(grouped.has("run-group-1")).toBe(true)
      expect(grouped.has("run-group-2")).toBe(true)

      const run1Data = grouped.get("run-group-1")
      expect(run1Data).toBeDefined()
      expect(run1Data?.run.id).toBe("run-group-1")
      expect(run1Data?.run.displayName).toBe("First Run")
      expect(run1Data?.tasks.length).toBe(2)
      expect(run1Data?.tasks.some((t) => t.id === "group-1")).toBe(true)
      expect(run1Data?.tasks.some((t) => t.id === "group-2")).toBe(true)

      const run2Data = grouped.get("run-group-2")
      expect(run2Data).toBeDefined()
      expect(run2Data?.run.id).toBe("run-group-2")
      expect(run2Data?.run.displayName).toBe("Second Run")
      expect(run2Data?.tasks.length).toBe(1)
      expect(run2Data?.tasks[0]?.id).toBe("group-3")

      for (const [, data] of grouped) {
        expect(data.tasks.every((t) => t.isArchived)).toBe(true)
      }

      db.close()
    })

    it("getArchivedTasksGroupedByRun() returns empty Map when no archived tasks exist", () => {
      const { db } = createTempDb()

      db.createTask({ id: "no-group-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createWorkflowRun({
        id: "run-no-group",
        kind: "all_tasks",
        displayName: "Run",
        taskOrder: ["no-group-1"],
        status: "completed",
      })

      const grouped = db.getArchivedTasksGroupedByRun()
      expect(grouped.size).toBe(0)

      db.close()
    })

    it("getArchivedTasksGroupedByRun() handles mixed archived/non-archived tasks in runs", () => {
      const { db } = createTempDb()

      db.createTask({ id: "mixed-1", name: "Task 1", prompt: "P1", status: "done" })
      db.createTask({ id: "mixed-2", name: "Task 2", prompt: "P2", status: "done" })
      db.createTask({ id: "mixed-3", name: "Task 3", prompt: "P3", status: "done" })

      db.createWorkflowRun({
        id: "run-mixed",
        kind: "all_tasks",
        displayName: "Mixed Run",
        taskOrder: ["mixed-1", "mixed-2", "mixed-3"],
        status: "completed",
      })

      db.archiveTask("mixed-1")
      db.archiveTask("mixed-3")

      const grouped = db.getArchivedTasksGroupedByRun()

      expect(grouped.size).toBe(1)
      expect(grouped.has("run-mixed")).toBe(true)

      const runData = grouped.get("run-mixed")
      expect(runData?.tasks.length).toBe(2)
      expect(runData?.tasks.some((t) => t.id === "mixed-1")).toBe(true)
      expect(runData?.tasks.some((t) => t.id === "mixed-2")).toBe(false)
      expect(runData?.tasks.some((t) => t.id === "mixed-3")).toBe(true)

      db.close()
    })

    it("archived tasks are excluded from getTasks() and getTask()", () => {
      const { db } = createTempDb()

      db.createTask({ id: "exclude-1", name: "Task 1", prompt: "P1", status: "done" })
      db.archiveTask("exclude-1")

      const allTasks = db.getTasks()
      expect(allTasks.some((t) => t.id === "exclude-1")).toBe(false)

      const retrieved = db.getTask("exclude-1")
      expect(retrieved).toBeNull()

      const archived = db.getArchivedTasks()
      expect(archived.some((t) => t.id === "exclude-1")).toBe(true)

      db.close()
    })
  })
})
