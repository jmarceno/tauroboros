import { existsSync } from "fs"
import { Effect } from "effect"
import type { PiKanbanDB } from "../db.ts"
import type { WorkflowRun, WSMessage } from "../types.ts"
import { chooseDeterministicRepairAction } from "../task-state.ts"
import { SmartRepairService, type SmartRepairDecision } from "../runtime/smart-repair.ts"
import { hasPausedRunState, loadPausedRunState, listPausedRunStates, listPausedSessions } from "../runtime/session-pause-state.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function needsTaskRecovery(task: { status: string; reviewActivity: string }): boolean {
  return task.status === "queued" || task.status === "executing" || (task.status === "review" && task.reviewActivity === "running")
}

/**
 * Detect stale workflow runs that are in active status but have no executing tasks.
 * A run is stale if:
 * 1. Status is "queued", "running", "stopping", or "paused"
 * 2. None of the tasks in taskOrder have status "queued", "executing", or "review"
 */
function needsWorkflowRunRecovery(run: WorkflowRun, db: PiKanbanDB): boolean {
  // Only consider runs in active statuses
  if (run.status !== "queued" && run.status !== "running" && run.status !== "stopping" && run.status !== "paused") {
    return false
  }

  // If no taskOrder, consider it stale (orphaned run)
  if (!run.taskOrder || run.taskOrder.length === 0) {
    return true
  }

  // Check if any tasks in the taskOrder are actually executing or in review
  const tasks = db.getTasks()
  const hasActiveTask = run.taskOrder.some((taskId) => {
    const task = tasks.find((t) => t.id === taskId)
    return task?.status === "queued" || task?.status === "executing" || task?.status === "review"
  })

  // If no tasks are active but run claims to be active, it's stale
  return !hasActiveTask
}

export const runStartupRecoveryEffect = Effect.fn("runStartupRecoveryEffect")(
  function* (args: { db: PiKanbanDB; broadcast: (message: WSMessage) => void }) {
  const { db, broadcast } = args
  const repair = new SmartRepairService(db)
  const recoveryStartedAt = nowUnix()

  const staleTasks = db.getTasks().filter(needsTaskRecovery)
  yield* Effect.forEach(staleTasks, (task) =>
    Effect.gen(function* () {
      let decision: SmartRepairDecision
      if (task.status === "executing" && (!task.worktreeDir || !existsSync(task.worktreeDir))) {
        decision = {
          action: "reset_backlog",
          reason: "Startup recovery: task was executing without a valid worktree directory",
        }
      } else {
        const deterministic = chooseDeterministicRepairAction(task)
        decision = {
          action: deterministic.action,
          reason: `Startup recovery: ${deterministic.reason}`,
        }
      }

      const updated = yield* repair.applyAction(task.id, decision)
      broadcast({ type: "task_updated", payload: updated })
      yield* Effect.logInfo(`[startup-recovery] Recovered task ${task.id}`)
    }).pipe(
      Effect.catchAll((error) => Effect.logError(`[startup-recovery] Failed to recover task ${task.id}: ${error}`)),
    ),
  { concurrency: 1 })

  const orphanSessions = db
    .getActiveWorkflowSessions()
    .filter((session) => {
      if (session.status !== "starting" && session.status !== "active") return false
      return session.startedAt < (recoveryStartedAt - 3600)
    })

  for (const session of orphanSessions) {
    db.updateWorkflowSession(session.id, {
      status: "failed",
      errorMessage: "Server restarted during execution",
      finishedAt: recoveryStartedAt,
    })
    yield* Effect.logInfo(`[startup-recovery] Marked orphaned session ${session.id} as failed`)
  }

  const pausedRuns = listPausedRunStates(db)
  const pausedSessions = listPausedSessions(db)

  if (pausedRuns.length > 0 || pausedSessions.length > 0) {
    yield* Effect.logInfo(`[startup-recovery] Found ${pausedRuns.length} paused run(s) and ${pausedSessions.length} paused session(s) in database`)

    for (const pauseState of pausedRuns) {
      const run = db.getWorkflowRun(pauseState.runId)
      if (run && run.status === "paused") {
        yield* Effect.logInfo(`[startup-recovery] Found paused run ${run.id} that can be resumed`)
        for (const session of pauseState.sessions) {
          if (session.containerId) {
            yield* Effect.logInfo(`[startup-recovery] Session ${session.sessionId} was using container ${session.containerId} (may need restart)`)
          }
        }
      } else if (run && (run.status === "queued" || run.status === "running" || run.status === "stopping")) {
        yield* Effect.logInfo(`[startup-recovery] Run ${run.id} was active but pause state exists - marking as paused`)
        db.updateWorkflowRun(run.id, {
          status: "paused",
          pauseRequested: true,
        })
        broadcast({ type: "run_paused", payload: { runId: run.id } })
      }
    }
  }

  // Check for legacy file-based paused state
  if (hasPausedRunState()) {
    const pauseState = loadPausedRunState()
    if (pauseState) {
      const run = db.getWorkflowRun(pauseState.runId)
      if (run && run.status === "paused") {
        yield* Effect.logInfo(`[startup-recovery] Found file-based paused run ${run.id} that can be resumed`)
        for (const session of pauseState.sessions) {
          if (session.containerId) {
            yield* Effect.logInfo(`[startup-recovery] Session ${session.sessionId} was using container ${session.containerId} (may need restart)`)
          }
        }
      } else if (run && (run.status === "queued" || run.status === "running" || run.status === "stopping")) {
        yield* Effect.logInfo(`[startup-recovery] Run ${run.id} was active but file-based pause state exists - marking as paused`)
        db.updateWorkflowRun(run.id, {
          status: "paused",
          pauseRequested: true,
        })
        broadcast({ type: "run_paused", payload: { runId: run.id } })
      }
    }
  }

  const staleRuns = db.getWorkflowRuns().filter((run) => needsWorkflowRunRecovery(run, db))
  yield* Effect.forEach(staleRuns, (run) =>
    Effect.try({
      try: () => {
        const updated = db.updateWorkflowRun(run.id, {
          status: "failed",
          errorMessage: "Server restarted during execution - run recovered as failed",
          finishedAt: recoveryStartedAt,
        })
        if (updated) {
          broadcast({ type: "run_updated", payload: updated })
        }
      },
      catch: (error) => String(error),
    }).pipe(
      Effect.tap(() => Effect.logInfo(`[startup-recovery] Recovered stale workflow run ${run.id} (was ${run.status}, now failed)`)),
      Effect.catchAll((error) => Effect.logError(`[startup-recovery] Failed to recover workflow run ${run.id}: ${error}`)),
    ),
  { concurrency: 1 })
})
