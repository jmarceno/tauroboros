import { Effect } from "effect"
import type { Task, WorkflowRun, WSMessage } from "../types.ts"
import type { PiKanbanDB } from "../db.ts"
import type { SelfHealingService } from "../runtime/self-healing.ts"
import type { OrchestratorOperationError } from "./errors.ts"
import { OrchestratorOperationError as OrchestratorOperationErrorClass } from "./errors.ts"

/**
 * Context for self-healing operations.
 */
export interface SelfHealingContext {
  db: PiKanbanDB
  selfHealingService: SelfHealingService
  broadcast: (message: WSMessage) => void
}

/**
 * Interface for scheduler operations needed for self-healing.
 */
export interface SelfHealingScheduler {
  requeueExecutingTask(taskId: string): Effect.Effect<boolean, unknown>
  enqueueTask(runId: string, taskId: string): Effect.Effect<void, unknown>
  getExecutingStates(runId: string): Effect.Effect<Array<{ taskId: string }>, unknown>
  getQueuedTasks(runId: string): Effect.Effect<string[], unknown>
}

/**
 * Result type for manual self-heal recovery.
 */
export interface ManualSelfHealResult {
  ok: boolean
  message: string
}

/**
 * Apply a manual self-heal recovery action from the UI.
 * This is called when the user explicitly selects a recovery action from a self-heal report.
 */
export function manualSelfHealRecover(
  taskId: string,
  reportId: string,
  action: "restart_task" | "keep_failed",
  context: SelfHealingContext,
  scheduler: SelfHealingScheduler,
  runId: string,
  broadcastTask: (taskId: string) => void,
  refreshRunProgressEffect: (runId: string) => Effect.Effect<void, OrchestratorOperationError>,
  triggerSchedulingEffect: () => Effect.Effect<void, OrchestratorOperationError>,
): Effect.Effect<ManualSelfHealResult, OrchestratorOperationError> {
  return Effect.gen(function* () {
    const task = context.db.getTask(taskId)
    if (!task) {
      return yield* new OrchestratorOperationErrorClass({
        operation: "manualSelfHealRecover",
        message: `Task not found: ${taskId}`,
      })
    }

    const report = context.db.getSelfHealReport(reportId)
    if (!report) {
      return yield* new OrchestratorOperationErrorClass({
        operation: "manualSelfHealRecover",
        message: `Self-heal report not found: ${reportId}`,
      })
    }
    if (report.taskId !== taskId) {
      return yield* new OrchestratorOperationErrorClass({
        operation: "manualSelfHealRecover",
        message: `Report ${reportId} does not belong to task ${taskId}`,
      })
    }

    if (action === "restart_task") {
      const requeued = yield* scheduler.requeueExecutingTask(taskId)
      if (!requeued) {
        yield* scheduler.enqueueTask(runId, taskId)
      }

      context.db.updateTask(taskId, {
        status: "queued",
        errorMessage: null,
        selfHealStatus: "idle",
        selfHealMessage: "Manually recovered: task requeued",
        sessionId: null,
        sessionUrl: null,
      })
      broadcastTask(taskId)
      context.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId,
          status: "recovered",
          message: "Task manually requeued from self-heal report",
          reportId,
        },
      })
      yield* refreshRunProgressEffect(runId)
      yield* triggerSchedulingEffect()
      return { ok: true, message: "Task requeued successfully" } as ManualSelfHealResult
    }

    context.db.updateTask(taskId, {
      selfHealStatus: "idle",
      selfHealMessage: null,
    })
    broadcastTask(taskId)
    context.broadcast({
      type: "self_heal_status",
      payload: {
        runId,
        taskId,
        status: "manual_required",
        message: "Manual recovery dismissed — task remains failed",
        reportId,
      },
    })
    return { ok: true, message: "Task kept as failed" } as ManualSelfHealResult
  }).pipe(
    Effect.catchAll((error: unknown) => {
      if (error instanceof OrchestratorOperationErrorClass) {
        return Effect.fail(error)
      }
      return Effect.fail(new OrchestratorOperationErrorClass({
        operation: "manualSelfHealRecover",
        message: error instanceof Error ? error.message : String(error),
      }))
    })
  )
}

/**
 * Attempt to self-heal a failed task.
 * Investigates the failure and may requeue the task for retry.
 */
export function maybeSelfHealTask(
  runId: string,
  task: Task,
  context: SelfHealingContext,
  scheduler: SelfHealingScheduler,
  broadcastTask: (taskId: string) => void,
): Effect.Effect<boolean, OrchestratorOperationError> {
  return Effect.gen(function* () {
    const reportCount = context.db.countSelfHealReportsForTaskInRun(runId, task.id)
    if (reportCount >= 2) {
      context.db.updateTask(task.id, {
        selfHealStatus: "idle",
        selfHealMessage: "Self-healing retry limit reached for this task in this run",
      })
      broadcastTask(task.id)
      context.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId: task.id,
          status: "skipped",
          message: "Self-healing retry limit reached",
        },
      })
      return false
    }

    const run = context.db.getWorkflowRun(runId)
    if (!run) {
      return yield* new OrchestratorOperationErrorClass({
        operation: "maybeSelfHealTask",
        message: `Run not found for self-heal flow: ${runId}`,
      })
    }

    const executingForSelfHeal = yield* scheduler.getExecutingStates(runId)
    const queuedForSelfHeal = yield* scheduler.getQueuedTasks(runId)
    const hasOtherActiveTasks =
      executingForSelfHeal.some((state) => state.taskId !== task.id)
      || queuedForSelfHeal.some((queuedTaskId) => queuedTaskId !== task.id)

    context.db.updateTask(task.id, {
      selfHealStatus: "investigating",
      selfHealMessage: "Investigating failure and drafting permanent fix...",
    })
    broadcastTask(task.id)
    context.broadcast({
      type: "self_heal_status",
      payload: {
        runId,
        taskId: task.id,
        status: "investigating",
        message: "Self-healing investigation started",
      },
    })

    const result = yield* context.selfHealingService.investigateFailure({
      run,
      task,
      errorMessage: task.errorMessage ?? "Task failed without explicit error message",
      hasOtherActiveTasks,
    }).pipe(
      Effect.mapError((cause) => new OrchestratorOperationErrorClass({
        operation: "maybeSelfHealTask",
        message: cause instanceof Error ? cause.message : String(cause),
      })),
    )

    context.db.updateTask(task.id, {
      selfHealStatus: "recovering",
      selfHealMessage: result.diagnosticsSummary,
      selfHealReportId: result.reportId,
    })
    broadcastTask(task.id)
    context.broadcast({
      type: "self_heal_status",
      payload: {
        runId,
        taskId: task.id,
        status: "recovering",
        message: "Self-healing generated diagnostics and recovery decision",
        reportId: result.reportId,
      },
    })

    if (result.recoverable && result.recommendedAction === "restart_task") {
      const requeued = yield* scheduler.requeueExecutingTask(task.id)
      if (!requeued) {
        yield* scheduler.enqueueTask(runId, task.id)
      }

      context.db.updateTask(task.id, {
        status: "queued",
        errorMessage: null,
        selfHealStatus: "idle",
        selfHealMessage: "Auto-recovered: task requeued",
        sessionId: null,
        sessionUrl: null,
      })
      broadcastTask(task.id)
      context.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId: task.id,
          status: "recovered",
          message: "Task requeued after self-healing",
          reportId: result.reportId,
        },
      })
      return true
    }

    context.db.updateTask(task.id, {
      selfHealStatus: "idle",
      selfHealMessage: `Manual recovery required: ${result.actionRationale}`,
    })
    broadcastTask(task.id)
    context.broadcast({
      type: "self_heal_status",
      payload: {
        runId,
        taskId: task.id,
        status: "manual_required",
        message: result.actionRationale,
        reportId: result.reportId,
      },
    })
    return false
  }).pipe(
    Effect.catchAll((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      context.db.updateTask(task.id, {
        selfHealStatus: "idle",
        selfHealMessage: `Self-healing failed: ${message}`,
      })
      broadcastTask(task.id)
      context.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId: task.id,
          status: "error",
          message,
        },
      })
      return Effect.succeed(false)
    }),
  )
}
