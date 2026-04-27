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

    
  })

  it("persists self-healing task state and reports", () => {
    const { db } = createTempDb()

    const task = db.createTask({
      id: "task-self-heal-1",
      name: "Self-heal task",
      prompt: "Investigate failure",
      status: "failed",
    })

    expect(task.selfHealStatus).toBe("idle")
    expect(task.selfHealMessage).toBeNull()
    expect(task.selfHealReportId).toBeNull()

    const run = db.createWorkflowRun({
      id: "run-self-heal-1",
      kind: "single_task",
      displayName: "Self-heal run",
      taskOrder: [task.id],
      currentTaskId: task.id,
      status: "running",
    })

    const report = db.createSelfHealReport({
      runId: run.id,
      taskId: task.id,
      taskStatus: "failed",
      errorMessage: "Boom",
      diagnosticsSummary: "Investigated Tauroboros codebase for bugs",
      isTauroborosBug: true,
      rootCause: {
        description: "Race condition in dependency state check",
        affectedFiles: ["src/scheduler.ts", "src/orchestrator.ts"],
        codeSnippet: "if (task.status === 'executing') { /* bug here */ }",
      },
      proposedSolution: "Guard scheduler transition with explicit check",
      implementationPlan: ["Add guard", "Add regression test"],
      confidence: "high",
      externalFactors: [],
      sourceMode: "local",
      sourcePath: "/tmp/source",
      githubUrl: "https://github.com/jmarceno/tauroboros",
      tauroborosVersion: "0.1.0",
      dbPath: db.getDatabasePath(),
      dbSchemaJson: db.getSchemaSnapshot(),
      rawResponse: "{\"isTauroborosBug\":true,\"confidence\":\"high\"}",
    })

    expect(report.runId).toBe(run.id)
    expect(report.taskId).toBe(task.id)
    expect(report.isTauroborosBug).toBe(true)
    expect(report.confidence).toBe("high")

    const reports = db.getSelfHealReportsForRun(run.id)
    expect(reports.length).toBe(1)
    expect(reports[0]?.id).toBe(report.id)

    const linked = db.updateTask(task.id, {
      selfHealStatus: "recovering",
      selfHealMessage: "Investigating",
      selfHealReportId: report.id,
    })

    expect(linked?.selfHealStatus).toBe("recovering")
    expect(linked?.selfHealReportId).toBe(report.id)

    
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

    
  })

  it("creates a pi-native session_messages schema", () => {
    const { db, dbPath } = createTempDb()
    

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

      
    })

    it("getArchivedTasks() returns empty array when no archived tasks exist", () => {
      const { db } = createTempDb()

      db.createTask({ id: "no-arch-1", name: "Task 1", prompt: "P1", status: "backlog" })
      db.createTask({ id: "no-arch-2", name: "Task 2", prompt: "P2", status: "executing" })

      const archived = db.getArchivedTasks()
      expect(archived).toEqual([])

      
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

      
    })

    it("getArchivedTasksByRun() returns empty array for non-existent runId", () => {
      const { db } = createTempDb()

      const archived = db.getArchivedTasksByRun("non-existent-run")
      expect(archived).toEqual([])

      
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

      
    })
  })

  describe("stats methods", () => {
    describe("getUsageStats", () => {
      it("returns zero stats for empty database", () => {
        const { db } = createTempDb()

        const stats = db.getUsageStats("lifetime")
        expect(stats.totalTokens).toBe(0)
        expect(stats.totalCost).toBe(0)
        expect(stats.tokenChange).toBe(0)
        expect(stats.costChange).toBe(0)

        
      })

      it("calculates lifetime stats correctly", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "stats-session-1",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "stats-session-1",
          timestamp: now - 86400 * 10,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "first" },
          totalTokens: 1000,
          costTotal: 0.05,
        })

        db.createSessionMessage({
          sessionId: "stats-session-1",
          timestamp: now - 86400 * 5,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "second" },
          totalTokens: 2000,
          costTotal: 0.10,
        })

        const stats = db.getUsageStats("lifetime")
        expect(stats.totalTokens).toBe(3000)
        expect(stats.totalCost).toBeCloseTo(0.15, 10)
        expect(stats.tokenChange).toBe(0)
        expect(stats.costChange).toBe(0)

        
      })

      it("calculates 24h stats with period comparison", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "stats-session-24h",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "stats-session-24h",
          timestamp: now - 86400 - 3600,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "previous" },
          totalTokens: 1000,
          costTotal: 0.05,
        })

        db.createSessionMessage({
          sessionId: "stats-session-24h",
          timestamp: now - 3600,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "current" },
          totalTokens: 2000,
          costTotal: 0.10,
        })

        const stats = db.getUsageStats("24h")
        expect(stats.totalTokens).toBe(2000)
        expect(stats.totalCost).toBeCloseTo(0.10, 10)
        expect(stats.tokenChange).toBe(100)
        expect(stats.costChange).toBe(100)

        
      })

      it("calculates 7d stats with period comparison", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "stats-session-7d",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "stats-session-7d",
          timestamp: now - 86400 * 8,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "previous" },
          totalTokens: 4000,
          costTotal: 0.20,
        })

        db.createSessionMessage({
          sessionId: "stats-session-7d",
          timestamp: now - 86400 * 3,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "current" },
          totalTokens: 2000,
          costTotal: 0.10,
        })

        const stats = db.getUsageStats("7d")
        expect(stats.totalTokens).toBe(2000)
        expect(stats.totalCost).toBeCloseTo(0.10, 10)
        expect(stats.tokenChange).toBe(-50)
        expect(stats.costChange).toBe(-50)

        
      })

      it("calculates 30d stats with period comparison", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "stats-session-30d",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "stats-session-30d",
          timestamp: now - 86400 * 35,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "previous" },
          totalTokens: 5000,
          costTotal: 0.25,
        })

        db.createSessionMessage({
          sessionId: "stats-session-30d",
          timestamp: now - 86400 * 15,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "current" },
          totalTokens: 10000,
          costTotal: 0.50,
        })

        const stats = db.getUsageStats("30d")
        expect(stats.totalTokens).toBe(10000)
        expect(stats.totalCost).toBeCloseTo(0.50, 10)
        expect(stats.tokenChange).toBe(100)
        expect(stats.costChange).toBe(100)

        
      })
    })

    describe("getTaskStats", () => {
      it("returns zero stats for empty database", () => {
        const { db } = createTempDb()

        const stats = db.getTaskStats()
        expect(stats.completed).toBe(0)
        expect(stats.failed).toBe(0)
        expect(stats.averageReviews).toBe(0)

        
      })

      it("counts completed and failed tasks correctly", () => {
        const { db } = createTempDb()

        db.createTask({ id: "stats-task-1", name: "Task 1", prompt: "P1", status: "done" })
        db.createTask({ id: "stats-task-2", name: "Task 2", prompt: "P2", status: "done" })
        db.createTask({ id: "stats-task-3", name: "Task 3", prompt: "P3", status: "failed" })
        db.createTask({ id: "stats-task-4", name: "Task 4", prompt: "P4", status: "backlog" })

        const stats = db.getTaskStats()
        expect(stats.completed).toBe(2)
        expect(stats.failed).toBe(1)
        expect(stats.averageReviews).toBe(0)

        
      })

      it("calculates average reviews for completed tasks", () => {
        const { db } = createTempDb()

        db.createTask({ id: "review-task-1", name: "Task 1", prompt: "P1", status: "done" })
        db.updateTask("review-task-1", { reviewCount: 2 })
        db.createTask({ id: "review-task-2", name: "Task 2", prompt: "P2", status: "done" })
        db.updateTask("review-task-2", { reviewCount: 4 })
        db.createTask({ id: "review-task-3", name: "Task 3", prompt: "P3", status: "done" })
        db.updateTask("review-task-3", { reviewCount: 0 })

        const stats = db.getTaskStats()
        expect(stats.completed).toBe(3)
        expect(stats.averageReviews).toBe(2)

        
      })
    })

    describe("getModelUsageByResponsibility", () => {
      it("returns empty stats when no sessions exist", () => {
        const { db } = createTempDb()

        const stats = db.getModelUsageByResponsibility()
        expect(stats.plan).toEqual([])
        expect(stats.execution).toEqual([])
        expect(stats.review).toEqual([])

        
      })

      it("categorizes planning sessions correctly", () => {
        const { db } = createTempDb()

        db.createWorkflowSession({
          id: "plan-session-1",
          sessionKind: "planning",
          cwd: "/tmp/work",
          model: "claude-3-5",
        })

        db.createWorkflowSession({
          id: "plan-session-2",
          sessionKind: "planning",
          cwd: "/tmp/work",
          model: "claude-3-5",
        })

        db.createWorkflowSession({
          id: "plan-session-3",
          sessionKind: "plan",
          cwd: "/tmp/work",
          model: "o4-mini",
        })

        const stats = db.getModelUsageByResponsibility()
        expect(stats.plan).toHaveLength(2)
        expect(stats.plan.find(m => m.model === "claude-3-5")?.count).toBe(2)
        expect(stats.plan.find(m => m.model === "o4-mini")?.count).toBe(1)
        expect(stats.execution).toEqual([])
        expect(stats.review).toEqual([])

        
      })

      it("categorizes execution sessions correctly", () => {
        const { db } = createTempDb()

        db.createWorkflowSession({
          id: "exec-session-1",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "o3-mini",
        })

        db.createWorkflowSession({
          id: "exec-session-2",
          sessionKind: "task_run_worker",
          cwd: "/tmp/work",
          model: "o3-mini",
        })

        db.createWorkflowSession({
          id: "exec-session-3",
          sessionKind: "task_run_final_applier",
          cwd: "/tmp/work",
          model: "default", // Should be excluded
        })

        const stats = db.getModelUsageByResponsibility()
        // Results are grouped by (session_kind, model), so o3-mini appears twice (once for task, once for task_run_worker)
        expect(stats.execution).toHaveLength(2)
        expect(stats.execution.every(e => e.model === "o3-mini")).toBe(true)
        expect(stats.execution.reduce((sum, e) => sum + e.count, 0)).toBe(2)

        
      })

      it("categorizes review sessions correctly", () => {
        const { db } = createTempDb()

        db.createWorkflowSession({
          id: "review-session-1",
          sessionKind: "review_scratch",
          cwd: "/tmp/work",
          model: "o4-mini",
        })

        db.createWorkflowSession({
          id: "review-session-2",
          sessionKind: "task_run_reviewer",
          cwd: "/tmp/work",
          model: "o4-mini",
        })

        const stats = db.getModelUsageByResponsibility()
        // Results are grouped by (session_kind, model), so o4-mini appears twice (once for each session kind)
        expect(stats.review).toHaveLength(2)
        expect(stats.review.every(r => r.model === "o4-mini")).toBe(true)
        expect(stats.review.reduce((sum, r) => sum + r.count, 0)).toBe(2)

        
      })

      it("sorts results by count descending", () => {
        const { db } = createTempDb()

        db.createWorkflowSession({
          id: "sort-session-1",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "popular-model",
        })

        db.createWorkflowSession({
          id: "sort-session-2",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "popular-model",
        })

        db.createWorkflowSession({
          id: "sort-session-3",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "rare-model",
        })

        const stats = db.getModelUsageByResponsibility()
        expect(stats.execution[0]?.model).toBe("popular-model")
        expect(stats.execution[0]?.count).toBe(2)
        expect(stats.execution[1]?.model).toBe("rare-model")
        expect(stats.execution[1]?.count).toBe(1)

        
      })

      it("excludes default and empty models", () => {
        const { db } = createTempDb()

        db.createWorkflowSession({
          id: "exclude-session-1",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "default",
        })

        db.createWorkflowSession({
          id: "exclude-session-2",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "",
        })

        db.createWorkflowSession({
          id: "exclude-session-3",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "valid-model",
        })

        const stats = db.getModelUsageByResponsibility()
        expect(stats.execution).toHaveLength(1)
        expect(stats.execution[0]?.model).toBe("valid-model")

        
      })
    })

    describe("getAverageTaskDuration", () => {
      it("returns zero for empty database", () => {
        const { db } = createTempDb()

        const duration = db.getAverageTaskDuration()
        expect(duration).toBe(0)

        
      })

      it("returns zero when no completed tasks", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createTask({
          id: "duration-task-1",
          name: "Task 1",
          prompt: "P1",
          status: "backlog",
        })
        db.getRawHandle().prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(now - 3600, "duration-task-1")

        const duration = db.getAverageTaskDuration()
        expect(duration).toBe(0)

        
      })

      it("calculates average duration correctly", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createTask({
          id: "duration-task-1",
          name: "Task 1",
          prompt: "P1",
          status: "done",
        })
        db.updateTask("duration-task-1", { completedAt: now })
        db.getRawHandle().prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(now - 3600, "duration-task-1")

        db.createTask({
          id: "duration-task-2",
          name: "Task 2",
          prompt: "P2",
          status: "done",
        })
        db.updateTask("duration-task-2", { completedAt: now })
        db.getRawHandle().prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(now - 7200, "duration-task-2")

        const duration = db.getAverageTaskDuration()
        expect(duration).toBe(90) // Average of 3600 and 7200 seconds, returned in minutes

        
      })
    })

    describe("getHourlyUsageTimeSeries", () => {
      it("returns empty array for empty database", () => {
        const { db } = createTempDb()

        const series = db.getHourlyUsageTimeSeries()
        expect(series).toEqual([])

        
      })

      it("returns hourly data for last 24 hours", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)
        const anchor = now - (now % 3600) - 1800

        db.createWorkflowSession({
          id: "hourly-session",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "hourly-session",
          timestamp: anchor - 7200,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg1" },
          totalTokens: 1000,
          costTotal: 0.05,
        })

        db.createSessionMessage({
          sessionId: "hourly-session",
          timestamp: anchor - 6900,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg2" },
          totalTokens: 500,
          costTotal: 0.025,
        })

        db.createSessionMessage({
          sessionId: "hourly-session",
          timestamp: anchor - 18000,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg3" },
          totalTokens: 2000,
          costTotal: 0.10,
        })

        db.createSessionMessage({
          sessionId: "hourly-session",
          timestamp: anchor - 90000,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg4" },
          totalTokens: 3000,
          costTotal: 0.15,
        })

        const series = db.getHourlyUsageTimeSeries()
        expect(series.length).toBe(2)

        expect(series[0]?.tokens).toBe(2000)
        expect(series[0]?.cost).toBeCloseTo(0.10, 10)
        expect(series[1]?.tokens).toBe(1500)
        expect(series[1]?.cost).toBeCloseTo(0.075, 10)

        expect(typeof series[0]?.hour).toBe("string")
        expect(series[0]?.hour).toContain("T")
        expect(series[0]?.hour).toContain("Z")

        
      })
    })

    describe("getDailyUsageTimeSeries", () => {
      it("returns empty array for empty database", () => {
        const { db } = createTempDb()

        const series = db.getDailyUsageTimeSeries(30)
        expect(series).toEqual([])

        
      })

      it("returns daily data for specified days", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "daily-session",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "daily-session",
          timestamp: now - 86400,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg1" },
          totalTokens: 1000,
          costTotal: 0.05,
        })

        db.createSessionMessage({
          sessionId: "daily-session",
          timestamp: now - 87000,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg2" },
          totalTokens: 500,
          costTotal: 0.025,
        })

        db.createSessionMessage({
          sessionId: "daily-session",
          timestamp: now - 86400 * 3,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg3" },
          totalTokens: 2000,
          costTotal: 0.10,
        })

        db.createSessionMessage({
          sessionId: "daily-session",
          timestamp: now - 86400 * 35,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg4" },
          totalTokens: 3000,
          costTotal: 0.15,
        })

        const series = db.getDailyUsageTimeSeries(30)
        expect(series.length).toBe(2)

        expect(series[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(series[0]?.tokens).toBe(2000)
        expect(series[0]?.cost).toBeCloseTo(0.10, 10)
        expect(series[1]?.tokens).toBe(1500)
        expect(series[1]?.cost).toBeCloseTo(0.075, 10)

        
      })

      it("respects days parameter", () => {
        const { db } = createTempDb()
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "daily-session-2",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "daily-session-2",
          timestamp: now - 86400 * 5,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg1" },
          totalTokens: 1000,
          costTotal: 0.05,
        })

        db.createSessionMessage({
          sessionId: "daily-session-2",
          timestamp: now - 86400 * 15,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "msg2" },
          totalTokens: 2000,
          costTotal: 0.10,
        })

        const series7d = db.getDailyUsageTimeSeries(7)
        expect(series7d.length).toBe(1)
        expect(series7d[0]?.tokens).toBe(1000)

        const series30d = db.getDailyUsageTimeSeries(30)
        expect(series30d.length).toBe(2)

        
      })
    })
  })
})
