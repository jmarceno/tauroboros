import { randomUUID } from "crypto"
import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { buildExecutionGraph, getExecutionGraphTasks } from "../../execution-plan.ts"
import { isTaskAwaitingPlanApproval } from "../../task-state.ts"
import { listPausedRunStates, loadPausedSessionState } from "../../runtime/session-pause-state.ts"
import type { BestOfNConfig, WorkflowRun } from "../../types.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import { HttpRouteError, badRequestError } from "../route-interpreter.ts"

function mapOperationError(error: unknown, messagePrefix: string): HttpRouteError {
  const message = error instanceof Error ? error.message : String(error)
  return new HttpRouteError({
    message: `${messagePrefix}: ${message}`,
    code: ErrorCode.EXECUTION_OPERATION_FAILED,
    status: 500,
    cause: error,
  })
}

function catchExecutionFailure(messagePrefix: string) {
  return Effect.catchAll((error: unknown) => Effect.fail(mapOperationError(error, messagePrefix)))
}

export function registerExecutionRoutes(router: Router, ctx: ServerRouteContext): void {
  router.post("/api/start", ({ json }) =>
    ctx.onStart().pipe(
      Effect.map((run) => json(run)),
      catchExecutionFailure("Failed to start execution"),
    ),
  )

  router.post("/api/execution/start", ({ json }) =>
    ctx.onStart().pipe(
      Effect.map((run) => json(run)),
      catchExecutionFailure("Failed to start execution"),
    ),
  )

  router.post("/api/stop", ({ json }) =>
    ctx.onStop().pipe(
      Effect.map((result) => json(result ?? { ok: true })),
      catchExecutionFailure("Failed to stop execution"),
    ),
  )

  router.post("/api/execution/stop", ({ json }) =>
    ctx.onStop().pipe(
      Effect.map((result) => json(result ?? { ok: true })),
      catchExecutionFailure("Failed to stop execution"),
    ),
  )

  router.post("/api/execution/pause", ({ json, broadcast, db }) =>
    Effect.sync(() => {
      const active = db.getWorkflowRuns().find((run) => run.status === "queued" || run.status === "running")
      if (!active) return json({ error: "No running workflow run" }, 404)
      const updated = db.updateWorkflowRun(active.id, {
        pauseRequested: true,
        status: "paused",
      })
      if (updated) broadcast({ type: "run_updated", payload: updated })
      return json(updated ?? { error: "Run not found" }, updated ? 200 : 404)
    }),
  )

  router.post("/api/tasks/:id/start", ({ params, json, db }) =>
    Effect.gen(function* () {
      const task = db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)

      const imageToUse = task.containerImage || ctx.settings?.workflow?.container?.image
      if (imageToUse) {
        const exists = yield* ctx.validateContainerImage(imageToUse).pipe(
          Effect.mapError((error) => mapOperationError(error, `Failed to validate container image for task ${params.id}`)),
        )
        if (!exists) {
          if (task.sessionId) {
            db.createSessionMessage({
              sessionId: task.sessionId,
              taskId: task.id,
              messageId: randomUUID(),
              role: "system",
              messageType: "error",
              contentJson: {
                eventType: "image_missing",
                timestamp: Date.now(),
                message: `Task start prevented: Container image '${imageToUse}' not found`,
                recommendation: "Build the image using the Image Builder or select a different image",
              },
            })
          }
          return json(
            { error: `Cannot start task: Container image '${imageToUse}' not found. Build the image first.` },
            409,
          )
        }
      }

      const run = yield* ctx.onStartSingle(params.id).pipe(
        catchExecutionFailure(`Failed to start task ${params.id}`),
      )
      return json(run)
    }),
  )

  router.post("/api/runs/:id/pause", ({ params, json, broadcast, db }) =>
    Effect.gen(function* () {
      if (ctx.onPauseRun) {
        const result = (yield* ctx.onPauseRun(params.id).pipe(
          catchExecutionFailure(`Failed to pause run ${params.id}`),
        )) as { success: boolean; run: WorkflowRun } | null
        if (result && result.success) {
          broadcast({ type: "run_paused", payload: { runId: params.id } })
          return json({ success: true, run: result.run })
        }
      }
      const updated = db.updateWorkflowRun(params.id, { pauseRequested: true, status: "paused" })
      if (!updated) {
        return yield* new HttpRouteError({
          message: "Run not found",
          code: ErrorCode.RUN_NOT_FOUND,
          status: 404,
        })
      }
      broadcast({ type: "run_updated", payload: updated })
      broadcast({ type: "run_paused", payload: { runId: params.id } })
      return json({ success: true, run: updated })
    }),
  )

  router.post("/api/runs/:id/resume", ({ params, json, broadcast, db }) =>
    Effect.gen(function* () {
      if (ctx.onResumeRun) {
        const run = yield* ctx.onResumeRun(params.id).pipe(
          catchExecutionFailure(`Failed to resume run ${params.id}`),
        )
        if (run) {
          broadcast({ type: "run_resumed", payload: { runId: params.id } })
          return json({ success: true, run })
        }
      }
      const updated = db.updateWorkflowRun(params.id, { pauseRequested: false, status: "running" })
      if (!updated) {
        return yield* new HttpRouteError({
          message: "Run not found",
          code: ErrorCode.RUN_NOT_FOUND,
          status: 404,
        })
      }
      broadcast({ type: "run_updated", payload: updated })
      broadcast({ type: "run_resumed", payload: { runId: params.id } })
      return json({ success: true, run: updated })
    }),
  )

  router.post("/api/runs/:id/stop", ({ params, req, json, broadcast }) =>
    Effect.gen(function* () {
      const body = yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: () => badRequestError("Invalid JSON body", ErrorCode.INVALID_JSON_BODY),
      })
      const destructive = body?.destructive === true

      if (!ctx.onStopRun) {
        return json(createApiError("Stop handler not available", ErrorCode.SERVICE_UNAVAILABLE), 503)
      }

      const result = yield* ctx.onStopRun(params.id, { destructive }).pipe(
        catchExecutionFailure(`Failed to stop run ${params.id}`),
      )
      if (!result || !result.run) {
        return yield* new HttpRouteError({
          message: "Failed to stop run - no result from orchestrator",
          code: ErrorCode.EXECUTION_OPERATION_FAILED,
          status: 500,
        })
      }
      if (destructive) {
        broadcast({ type: "run_stopped", payload: { runId: params.id, destructive: true } })
      }
      return json(result)
    }),
  )

  router.post("/api/runs/:id/force-stop", ({ params, json, broadcast }) =>
    Effect.gen(function* () {
      if (!ctx.onStopRun) {
        return json(createApiError("Force stop not available", ErrorCode.SERVICE_UNAVAILABLE), 503)
      }

      const result = yield* ctx.onStopRun(params.id, { destructive: true }).pipe(
        catchExecutionFailure(`Failed to force-stop run ${params.id}`),
      )
      broadcast({ type: "run_stopped", payload: { runId: params.id, destructive: true } })
      return json(result)
    }),
  )

  router.get("/api/runs/paused-state", ({ json, db }) =>
    listPausedRunStates(db).pipe(
      Effect.mapError((error) => mapOperationError(error, "Failed to load paused run state")),
      Effect.map((pausedRuns) => {
        const pausedState = pausedRuns[0] ?? null
        return json({
          hasPausedRun: pausedState !== null,
          state: pausedState,
        })
      }),
    ),
  )

  router.get("/api/runs/:id/paused-state", ({ params, json, db }) =>
    Effect.gen(function* () {
      const run = db.getWorkflowRun(params.id)
      if (!run) {
        return yield* mapOperationError(new Error("Run not found"), `Failed to load paused state for run ${params.id}`)
      }

      const pausedStates = yield* Effect.forEach(
        run.taskOrder,
        (taskId) => {
          const task = db.getTask(taskId)
          if (!task?.sessionId) {
            return Effect.succeed(null)
          }
          return loadPausedSessionState(db, task.sessionId).pipe(
            Effect.mapError((error) => mapOperationError(error, `Failed to load paused session for task ${taskId}`)),
          )
        },
        { concurrency: 1 },
      )

      const sessions = pausedStates.filter((state): state is NonNullable<typeof state> => state !== null)

      return json({
        runId: params.id,
        hasPausedSessions: sessions.length > 0,
        pausedSessions: sessions,
        runStatus: run.status,
      })
    }),
  )

  router.get("/api/execution-graph", ({ json, db, url }) =>
    Effect.sync(() => {
      const groupId = url.searchParams.get("groupId")
      let allTasks = db.getTasks()

      if (groupId) {
        const group = db.getTaskGroup(groupId)
        if (!group) {
          return json({ error: `Task group "${groupId}" not found` }, 404)
        }
        allTasks = allTasks.filter((task) => group.taskIds.includes(task.id))
      }

    const validTaskIds = new Set(allTasks.map((t) => t.id))

    const dependencyWarnings: string[] = []
    for (const task of allTasks) {
      const invalidDeps = task.requirements.filter((depId) => !validTaskIds.has(depId))
      if (invalidDeps.length > 0) {
        dependencyWarnings.push(
          `Task "${task.name}" has invalid dependencies: ${invalidDeps.join(", ")} (auto-removed)`,
        )
      }
    }

    const allExecutable = getExecutionGraphTasks(allTasks)
    if (allExecutable.length === 0) {
      return json(
        {
          error: "No tasks in backlog",
          warnings: dependencyWarnings.length > 0 ? dependencyWarnings : undefined,
        },
        400,
      )
    }

    const options = db.getOptions()
    const graph = buildExecutionGraph(allTasks, options.parallelTasks)

    if (dependencyWarnings.length > 0) {
      graph.warnings = dependencyWarnings
    }

    for (const node of graph.nodes) {
      const task = db.getTask(node.id)
      if (task?.executionStrategy === "best_of_n" && task.bestOfNConfig) {
        const cfg = task.bestOfNConfig as BestOfNConfig
        const workers = cfg.workers.reduce((sum, slot) => sum + slot.count, 0)
        const reviewers = cfg.reviewers.reduce((sum, slot) => sum + slot.count, 0)
        node.expandedWorkerRuns = workers
        node.expandedReviewerRuns = reviewers
        node.hasFinalApplier = true
        node.estimatedRunCount = workers + reviewers + 1
      } else {
        node.expandedWorkerRuns = 1
        node.expandedReviewerRuns = task?.review ? 1 : 0
        node.hasFinalApplier = false
        node.estimatedRunCount = 1 + (task?.review ? 1 : 0)
      }
    }

    graph.pendingApprovals = db
      .getTasks()
      .filter((task) => isTaskAwaitingPlanApproval(task))
      .map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status,
        awaitingPlanApproval: task.awaitingPlanApproval,
        planRevisionCount: task.planRevisionCount,
      }))

      return json(graph)
    }),
  )

  router.get("/api/runs", ({ json, db }) =>
    Effect.gen(function* () {
      const runs = db.getWorkflowRuns()
      if (!ctx.onGetRunQueueStatus) {
        return json(runs)
      }

      const enrichedRuns = yield* Effect.forEach(
        runs,
        (run) =>
          ctx.onGetRunQueueStatus!(run.id).pipe(
            Effect.map((queueStatus) => ({
              ...run,
              queuedTaskCount: queueStatus.queuedTasks,
              executingTaskCount: queueStatus.executingTasks,
            })),
            catchExecutionFailure(`Failed to load queue status for run ${run.id}`),
          ),
      )
      return json(enrichedRuns)
    }),
  )

  router.get("/api/slots", ({ json }) =>
    Effect.gen(function* () {
      if (!ctx.onGetSlots) {
        return json({ error: "Slot inspection not available" }, 503)
      }
      const result = yield* ctx.onGetSlots().pipe(
        catchExecutionFailure("Failed to inspect slots"),
      )
      return json(result)
    }),
  )

  router.get("/api/runs/:id/queue-status", ({ params, json }) =>
    Effect.gen(function* () {
      if (!ctx.onGetRunQueueStatus) {
        return json(createApiError("Run queue status not available", ErrorCode.SERVICE_UNAVAILABLE), 503)
      }

      const result = yield* ctx.onGetRunQueueStatus(params.id).pipe(
        catchExecutionFailure(`Failed to load queue status for run ${params.id}`),
      )
      return json(result)
    }),
  )

  router.get("/api/runs/:id/self-heal-reports", ({ params, json, db }) =>
    Effect.sync(() => {
      const run = db.getWorkflowRun(params.id)
      if (!run) {
        return json({ error: "Run not found" }, 404)
      }
      return json(db.getSelfHealReportsForRun(params.id))
    }),
  )

  router.delete("/api/runs/:id", ({ params, json, broadcast, db }) =>
    Effect.sync(() => {
      const run = db.getWorkflowRun(params.id)
      if (!run || run.isArchived) return json({ error: "Run not found" }, 404)
      if (
        run.status === "queued" ||
        run.status === "running" ||
        run.status === "stopping" ||
        run.status === "paused"
      ) {
        return json({ error: "Only completed or failed workflow runs can be archived" }, 409)
      }

      const archivedRun = db.archiveWorkflowRun(params.id)
      if (!archivedRun) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_archived", payload: { id: params.id } })
      return json({ id: params.id, archived: true })
    }),
  )

  router.post("/api/runs/:id/clean", ({ params, json, broadcast, db }) =>
    Effect.gen(function* () {
      const run = db.getWorkflowRun(params.id)
      if (!run) {
        return yield* new HttpRouteError({
          message: "Run not found",
          code: ErrorCode.RUN_NOT_FOUND,
          status: 404,
        })
      }

      if (!ctx.onCleanRun) {
        return json(createApiError("Clean run not available", ErrorCode.SERVICE_UNAVAILABLE), 503)
      }

      const result = yield* ctx.onCleanRun(params.id).pipe(
        catchExecutionFailure(`Failed to clean run ${params.id}`),
      )

      return json(result)
    }),
  )

  router.get("/api/archived/tasks", ({ json, sessionUrlFor, db }) =>
    Effect.sync(() => {
      const grouped = db.getArchivedTasksGroupedByRun()
      const runs = Array.from(grouped.entries()).map(([_key, data]) => ({
        run: data.run,
        tasks: data.tasks.map((task) => {
          if (!task.sessionId) return task
          if (!task.sessionUrl || task.sessionUrl.includes("opencode") || !task.sessionUrl.includes("#session/")) {
            return { ...task, sessionUrl: sessionUrlFor(task.sessionId) }
          }
          return task
        }),
      }))
      return json({ runs })
    }),
  )

  router.get("/api/archived/runs", ({ json, db }) => Effect.sync(() => json({ runs: db.getWorkflowRunsWithArchivedTasks() })))

  router.get("/api/archived/tasks/:taskId", ({ params, json, sessionUrlFor, db }) =>
    Effect.sync(() => {
      const task = db.getArchivedTask(params.taskId)
      if (!task) return json({ error: "Task not found" }, 404)
      if (!task.sessionId) return json(task)
      if (!task.sessionUrl || task.sessionUrl.includes("opencode") || !task.sessionUrl.includes("#session/")) {
        return json({ ...task, sessionUrl: sessionUrlFor(task.sessionId) })
      }
      return json(task)
    }),
  )
}
