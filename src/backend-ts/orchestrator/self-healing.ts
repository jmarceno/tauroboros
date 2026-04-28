import { Effect } from "effect"
import type { Task, WorkflowRun, WSMessage } from "../types.ts"
import type { PiKanbanDB } from "../db.ts"
import type { SelfHealingService } from "../runtime/self-healing.ts"
import { OrchestratorOperationError } from "./errors.ts"

export interface SelfHealingContext {
  db: PiKanbanDB
  selfHealingService: SelfHealingService
  broadcast: (message: WSMessage) => void
}

export interface SelfHealingScheduler {
  getExecutingStates(runId: string): Effect.Effect<Array<{ taskId: string }>, unknown>
  getQueuedTasks(runId: string): Effect.Effect<string[], unknown>
}

export interface SelfHealInvestigationResult {
  ok: boolean
  isBug: boolean
  message: string
  reportId: string
}

export function maybeSelfHealTask(
  runId: string,
  task: Task,
  context: SelfHealingContext,
  scheduler: SelfHealingScheduler,
  broadcastTask: (taskId: string) => void,
): Effect.Effect<SelfHealInvestigationResult, OrchestratorOperationError> {
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
      return { ok: false, isBug: false, message: "Retry limit reached", reportId: "" }
    }

    const run = context.db.getWorkflowRun(runId)
    if (run === null) {
      return yield* new OrchestratorOperationError({
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
      selfHealMessage: "Investigating failure for Tauroboros bugs...",
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
      Effect.mapError((cause) => new OrchestratorOperationError({
        operation: "maybeSelfHealTask",
        message: cause instanceof Error ? cause.message : String(cause),
      })),
    )

    const statusMessage = result.isTauroborosBug
      ? `Bug identified in Tauroboros (${result.confidence} confidence): ${result.rootCause.description.slice(0, 100)}...`
      : `No Tauroboros bug found. External factors: ${result.externalFactors.join(", ") || "none identified"}`

    context.db.updateTask(task.id, {
      selfHealStatus: "idle",
      selfHealMessage: statusMessage,
      selfHealReportId: result.reportId,
    })
    broadcastTask(task.id)
    context.broadcast({
      type: "self_heal_status",
      payload: {
        runId,
        taskId: task.id,
        status: result.isTauroborosBug ? "bug_found" : "no_bug_found",
        message: statusMessage,
        reportId: result.reportId,
        isTauroborosBug: result.isTauroborosBug,
        confidence: result.confidence,
      },
    })

    return {
      ok: true,
      isBug: result.isTauroborosBug,
      message: statusMessage,
      reportId: result.reportId,
    }
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
      return Effect.succeed({ ok: false, isBug: false, message, reportId: "" })
    }),
  )
}
