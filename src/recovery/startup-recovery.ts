import { existsSync } from "fs"
import type { PiKanbanDB } from "../db.ts"
import type { WorkflowRun, WSMessage } from "../types.ts"
import { chooseDeterministicRepairAction } from "../task-state.ts"
import { SmartRepairService, type SmartRepairDecision } from "../runtime/smart-repair.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function log(line: string): void {
  console.log(`[startup-recovery] ${line}`)
}

function needsTaskRecovery(task: { status: string; reviewActivity: string }): boolean {
  return task.status === "executing" || (task.status === "review" && task.reviewActivity === "running")
}

/**
 * Detect stale workflow runs that are in active status but have no executing tasks.
 * A run is stale if:
 * 1. Status is "running", "stopping", or "paused"
 * 2. None of the tasks in taskOrder have status "executing"
 */
function needsWorkflowRunRecovery(run: WorkflowRun, db: PiKanbanDB): boolean {
  // Only consider runs in active statuses
  if (run.status !== "running" && run.status !== "stopping" && run.status !== "paused") {
    return false
  }

  // If no taskOrder, consider it stale (orphaned run)
  if (!run.taskOrder || run.taskOrder.length === 0) {
    return true
  }

  // Check if any tasks in the taskOrder are actually executing
  const tasks = db.getTasks()
  const hasExecutingTask = run.taskOrder.some((taskId) => {
    const task = tasks.find((t) => t.id === taskId)
    return task?.status === "executing"
  })

  // If no tasks are executing but run claims to be active, it's stale
  return !hasExecutingTask
}

export async function runStartupRecovery(args: {
  db: PiKanbanDB
  broadcast: (message: WSMessage) => void
}): Promise<void> {
  const { db, broadcast } = args
  const repair = new SmartRepairService(db)
  const recoveryStartedAt = nowUnix()

  const staleTasks = db.getTasks().filter(needsTaskRecovery)
  for (const task of staleTasks) {
    try {
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

      const updated = repair.applyAction(task.id, decision)
      broadcast({ type: "task_updated", payload: updated })
      log(`Recovered task ${task.id} with action=${decision.action}`)
    } catch (error) {
      log(`Failed to recover task ${task.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

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
    db.appendSessionIO({
      sessionId: session.id,
      stream: "server",
      recordType: "lifecycle",
      payloadJson: {
        type: "startup_recovery_session_failed",
        reason: "Server restarted during execution",
      },
    })
    log(`Marked orphaned session ${session.id} as failed`)
  }

  // Phase 1: Recover stale workflow runs
  const staleRuns = db.getWorkflowRuns().filter((run) => needsWorkflowRunRecovery(run, db))
  for (const run of staleRuns) {
    try {
      const updated = db.updateWorkflowRun(run.id, {
        status: "failed",
        errorMessage: "Server restarted during execution - run recovered as failed",
        finishedAt: recoveryStartedAt,
      })
      if (updated) {
        broadcast({ type: "run_updated", payload: updated })
        log(`Recovered stale workflow run ${run.id} (was ${run.status}, now failed)`)
      }
    } catch (error) {
      log(`Failed to recover workflow run ${run.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
