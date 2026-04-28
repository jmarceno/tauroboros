import { Effect, Schema } from "effect"
import { ErrorCode } from "../shared/error-codes.ts"
import type { PiKanbanDB } from "../db.ts"
import type { WSMessage, WorkflowRun } from "../types.ts"

/**
 * Tagged error for clean run operations
 */
export class CleanRunError extends Schema.TaggedError<CleanRunError>()("CleanRunError", {
  operation: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.Enums(ErrorCode)),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Result type for clean run operation
 */
export interface CleanRunResult {
  success: boolean
  tasksReset: number
  sessionsDeleted: number
  taskRunsDeleted: number
  candidatesDeleted: number
  reportsDeleted: number
  runsDeleted: number
  message: string
}

/**
 * Context required for clean run operation
 */
export interface CleanRunContext {
  db: PiKanbanDB
  broadcast: (message: WSMessage) => void
}

/**
 * Check if a run status is considered "active" (cannot be cleaned)
 */
function isRunActive(status: WorkflowRun["status"]): boolean {
  return status === "queued" || status === "running" || status === "stopping" || status === "paused"
}

/**
 * Clean/reset a workflow run and all its tasks
 * - Resets all tasks in the run to backlog status
 * - Deletes all associated sessions, messages, task runs, candidates, and self-heal reports
 * - Deletes the workflow run itself
 * - Broadcasts updates to all clients
 */
export function cleanWorkflowRun(
  runId: string,
  context: CleanRunContext,
): Effect.Effect<CleanRunResult, CleanRunError> {
  return Effect.gen(function* () {
    // 1. Validate run exists
    const run = context.db.getWorkflowRun(runId)
    if (!run) {
      return yield* new CleanRunError({
        operation: "cleanWorkflowRun",
        message: `Workflow run ${runId} not found`,
        code: ErrorCode.RUN_NOT_FOUND,
      })
    }

    // 2. Check run is not active
    if (isRunActive(run.status)) {
      return yield* new CleanRunError({
        operation: "cleanWorkflowRun",
        message: `Cannot clean an active workflow run (status: ${run.status}). Stop the run first.`,
        code: ErrorCode.EXECUTION_OPERATION_FAILED,
      })
    }

    // 3. Validate all tasks exist
    const tasks: Array<ReturnType<typeof context.db.getTask>> = []
    for (const taskId of run.taskOrder) {
      const task = context.db.getTask(taskId)
      if (!task) {
        return yield* new CleanRunError({
          operation: "cleanWorkflowRun",
          message: `Task ${taskId} not found in run ${runId}`,
          code: ErrorCode.TASK_NOT_FOUND,
        })
      }
      tasks.push(task)
    }

    // 4. Clean associated data first (before resetting tasks)
    const sessionsDeleted = context.db.deleteSessionsForTasks(run.taskOrder)
    const taskRunsDeleted = context.db.deleteTaskRunsForTasks(run.taskOrder)
    const candidatesDeleted = context.db.deleteCandidatesForTasks(run.taskOrder)
    const reportsDeleted = context.db.deleteSelfHealReportsForTasks(run.taskOrder)

    // 5. Reset all tasks to clean state
    let tasksReset = 0
    for (const task of tasks) {
      if (!task) continue

      context.db.updateTask(task.id, {
        status: "backlog",
        executionPhase: "not_started",
        errorMessage: null,
        agentOutput: "",
        worktreeDir: null,
        sessionId: null,
        sessionUrl: null,
        completedAt: null,
        selfHealStatus: "idle",
        selfHealMessage: null,
        selfHealReportId: null,
        reviewCount: 0,
        jsonParseRetryCount: 0,
        planRevisionCount: 0,
        awaitingPlanApproval: false,
        reviewActivity: "idle",
      })
      tasksReset++

      // Broadcast task update
      context.broadcast({
        type: "task_updated",
        payload: {
          id: task.id,
          status: "backlog",
          executionPhase: "not_started",
          errorMessage: null,
          agentOutput: "",
          worktreeDir: null,
          sessionId: null,
          sessionUrl: null,
          completedAt: null,
          selfHealStatus: "idle",
          selfHealMessage: null,
          selfHealReportId: null,
          reviewCount: 0,
          jsonParseRetryCount: 0,
          planRevisionCount: 0,
          awaitingPlanApproval: false,
          reviewActivity: "idle",
        },
      })
    }

    // 6. Delete the workflow run
    const runsDeleted = context.db.deleteWorkflowRun(runId) ? 1 : 0

    // 7. Broadcast run cleaned event
    context.broadcast({
      type: "run_cleaned",
      payload: { runId },
    })

    // 8. Return result
    const message = tasksReset === 0
      ? "No tasks to clean"
      : `Reset ${tasksReset} tasks, deleted ${sessionsDeleted} sessions, ${taskRunsDeleted} task runs, ${candidatesDeleted} candidates, ${reportsDeleted} reports. Ready to restart.`

    return {
      success: true,
      tasksReset,
      sessionsDeleted,
      taskRunsDeleted,
      candidatesDeleted,
      reportsDeleted,
      runsDeleted,
      message,
    }
  })
}
