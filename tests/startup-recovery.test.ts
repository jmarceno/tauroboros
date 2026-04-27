import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Effect } from "effect"
import { PiKanbanDB } from "../src/db.ts"
import { runStartupRecoveryEffect } from "../src/recovery/startup-recovery.ts"

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

describe("startup recovery", () => {
  it("repairs stale executing tasks and fails orphaned sessions", async () => {
    const root = createTempDir("tauroboros-startup-recovery-")
    const db = new PiKanbanDB(join(root, "tasks.db"))
    const existingWorktree = join(root, "worktree-a")
    mkdirSync(existingWorktree, { recursive: true })

    const staleTask = db.createTask({
      id: "recover-1",
      name: "Stale executing task",
      prompt: "Recover stale execution",
      status: "executing",
      planmode: false,
    })
    db.updateTask(staleTask.id, { worktreeDir: join(root, "missing-worktree") })

    const interruptedReviewTask = db.createTask({
      id: "recover-2",
      name: "Interrupted review task",
      prompt: "Recover interrupted review",
      status: "review",
      review: true,
      planmode: false,
    })
    db.updateTask(interruptedReviewTask.id, {
      status: "review",
      reviewActivity: "running",
      worktreeDir: existingWorktree,
    })

    const untouchedReviewTask = db.createTask({
      id: "recover-3",
      name: "Manual review task",
      prompt: "Do not auto recover",
      status: "review",
      review: true,
      planmode: false,
    })
    db.updateTask(untouchedReviewTask.id, { reviewActivity: "idle" })

    const oldStartedAt = Math.floor(Date.now() / 1000) - 3700
    db.createWorkflowSession({
      id: "orphan-1",
      taskId: staleTask.id,
      sessionKind: "task",
      cwd: root,
      status: "active",
      startedAt: oldStartedAt,
    })
    db.createWorkflowSession({
      id: "recent-1",
      taskId: staleTask.id,
      sessionKind: "task",
      cwd: root,
      status: "active",
      startedAt: Math.floor(Date.now() / 1000),
    })

    const broadcasts: string[] = []
    await Effect.runPromise(runStartupRecoveryEffect({
      db,
      broadcast: (message) => broadcasts.push(message.type),
    }))

    const recoveredTask = db.getTask(staleTask.id)
    expect(recoveredTask?.status).toBe("failed")
    expect(recoveredTask?.errorMessage).toBe("Task was interrupted by server restart")

    const reviewRecoveredTask = db.getTask(interruptedReviewTask.id)
    expect(reviewRecoveredTask?.status).toBe("failed")
    expect(reviewRecoveredTask?.reviewActivity).toBe("idle")
    expect(reviewRecoveredTask?.errorMessage).toBe("Task was interrupted by server restart during review")

    const unchangedTask = db.getTask(untouchedReviewTask.id)
    expect(unchangedTask?.status).toBe("review")
    expect(unchangedTask?.reviewActivity).toBe("idle")

    const orphan = db.getWorkflowSession("orphan-1")
    expect(orphan?.status).toBe("failed")
    expect(orphan?.errorMessage).toBe("Server restarted during execution")

    const recent = db.getWorkflowSession("recent-1")
    expect(recent?.status).toBe("active")
    expect(broadcasts.includes("task_updated")).toBe(true)

  })

  it("is idempotent when run multiple times", async () => {
    const root = createTempDir("tauroboros-startup-recovery-idempotent-")
    const db = new PiKanbanDB(join(root, "tasks.db"))

    const task = db.createTask({
      id: "recover-idempotent-1",
      name: "Idempotent stale task",
      prompt: "Idempotent recover",
      status: "executing",
      planmode: false,
    })
    db.updateTask(task.id, { worktreeDir: join(root, "missing") })

    await Effect.runPromise(runStartupRecoveryEffect({ db, broadcast: () => {} }))
    const first = db.getTask(task.id)
    await Effect.runPromise(runStartupRecoveryEffect({ db, broadcast: () => {} }))
    const second = db.getTask(task.id)

    expect(first?.status).toBe("failed")
    expect(second?.status).toBe("failed")
  })

  it("recovers stale workflow runs with no executing tasks", async () => {
    const root = createTempDir("tauroboros-startup-recovery-runs-")
    const db = new PiKanbanDB(join(root, "tasks.db"))

    // Create tasks in backlog (not executing)
    const task1 = db.createTask({
      id: "task-1",
      name: "Task 1",
      prompt: "Task 1 prompt",
      status: "backlog",
      planmode: false,
    })
    const task2 = db.createTask({
      id: "task-2",
      name: "Task 2",
      prompt: "Task 2 prompt",
      status: "done",
      planmode: false,
    })

    // Create a stale workflow run with status "running" but no executing tasks
    const staleRun = db.createWorkflowRun({
      id: "stale-run-1",
      kind: "all_tasks",
      status: "running",
      displayName: "Stale workflow run",
      taskOrder: [task1.id, task2.id],
      currentTaskId: task1.id,
      currentTaskIndex: 0,
      color: "#ff0000",
    })

    const broadcasts: string[] = []
    await Effect.runPromise(runStartupRecoveryEffect({
      db,
      broadcast: (message) => broadcasts.push(message.type),
    }))

    // Verify stale run was marked as failed
    const recoveredRun = db.getWorkflowRun(staleRun.id)
    expect(recoveredRun?.status).toBe("failed")
    expect(recoveredRun?.errorMessage).toBe("Server restarted during execution - run recovered as failed")
    expect(recoveredRun?.finishedAt).not.toBeNull()

    // Verify broadcasts were sent
    expect(broadcasts.includes("run_updated")).toBe(true)

  })

  it("recovers stale workflow runs in stopping and paused statuses", async () => {
    const root = createTempDir("tauroboros-startup-recovery-runs-statuses-")
    const db = new PiKanbanDB(join(root, "tasks.db"))

    // Create tasks in backlog (not executing)
    const task = db.createTask({
      id: "task-status",
      name: "Task status test",
      prompt: "Task prompt",
      status: "backlog",
      planmode: false,
    })

    // Create workflow runs in different active statuses
    const stoppingRun = db.createWorkflowRun({
      id: "stopping-run",
      kind: "all_tasks",
      status: "stopping",
      displayName: "Stopping run",
      taskOrder: [task.id],
      currentTaskId: task.id,
      currentTaskIndex: 0,
      color: "#ff0000",
    })

    const pausedRun = db.createWorkflowRun({
      id: "paused-run",
      kind: "all_tasks",
      status: "paused",
      displayName: "Paused run",
      taskOrder: [task.id],
      currentTaskId: task.id,
      currentTaskIndex: 0,
      color: "#0000ff",
    })

    await Effect.runPromise(runStartupRecoveryEffect({ db, broadcast: () => {} }))

    // Verify both were marked as failed
    const recoveredStopping = db.getWorkflowRun(stoppingRun.id)
    expect(recoveredStopping?.status).toBe("failed")

    const recoveredPaused = db.getWorkflowRun(pausedRun.id)
    expect(recoveredPaused?.status).toBe("failed")

  })

  it("does not recover completed or failed workflow runs", async () => {
    const root = createTempDir("tauroboros-startup-recovery-runs-terminal-")
    const db = new PiKanbanDB(join(root, "tasks.db"))

    const task = db.createTask({
      id: "task-terminal",
      name: "Task terminal test",
      prompt: "Task prompt",
      status: "backlog",
      planmode: false,
    })

    // Create already-terminal workflow runs
    const completedRun = db.createWorkflowRun({
      id: "completed-run",
      kind: "all_tasks",
      status: "completed",
      displayName: "Completed run",
      taskOrder: [task.id],
      currentTaskId: task.id,
      currentTaskIndex: 1,
      color: "#00ff00",
    })
    db.updateWorkflowRun(completedRun.id, { finishedAt: Math.floor(Date.now() / 1000) })

    const failedRun = db.createWorkflowRun({
      id: "failed-run",
      kind: "all_tasks",
      status: "failed",
      displayName: "Failed run",
      taskOrder: [task.id],
      currentTaskId: task.id,
      currentTaskIndex: 0,
      color: "#ff0000",
    })
    db.updateWorkflowRun(failedRun.id, { finishedAt: Math.floor(Date.now() / 1000) })

    await Effect.runPromise(runStartupRecoveryEffect({ db, broadcast: () => {} }))

    // Verify terminal runs were not touched
    const unchangedCompleted = db.getWorkflowRun(completedRun.id)
    expect(unchangedCompleted?.status).toBe("completed")

    const unchangedFailed = db.getWorkflowRun(failedRun.id)
    expect(unchangedFailed?.status).toBe("failed")

  })
})
