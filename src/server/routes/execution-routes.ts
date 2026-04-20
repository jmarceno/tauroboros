import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { buildExecutionGraph, getExecutionGraphTasks } from "../../execution-plan.ts"
import { isTaskAwaitingPlanApproval } from "../../task-state.ts"
import { loadPausedRunState, loadPausedSessionState } from "../../runtime/session-pause-state.ts"
import type { BestOfNConfig, WorkflowRun } from "../../types.ts"

export function registerExecutionRoutes(router: Router, ctx: ServerRouteContext): void {
  router.post("/api/start", async ({ json }) => {
    try {
      const run = await ctx.onStart()
      return json(run)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("invalid container images") || message.includes("not found")) {
        return json({ error: message }, 409)
      }
      return json({ error: message }, 500)
    }
  })

  router.post("/api/execution/start", async ({ json }) => {
    try {
      const run = await ctx.onStart()
      return json(run)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("invalid container images") || message.includes("not found")) {
        return json({ error: message }, 409)
      }
      return json({ error: message }, 500)
    }
  })

  router.post("/api/stop", async ({ json }) => {
    const result = await ctx.onStop()
    return json(result ?? { ok: true })
  })

  router.post("/api/execution/stop", async ({ json }) => {
    const result = await ctx.onStop()
    return json(result ?? { ok: true })
  })

  router.post("/api/execution/pause", async ({ json, broadcast, db }) => {
    const active = db.getWorkflowRuns().find((run) => run.status === "queued" || run.status === "running")
    if (!active) return json({ error: "No running workflow run" }, 404)
    const updated = db.updateWorkflowRun(active.id, {
      pauseRequested: true,
      status: "paused",
    })
    if (updated) broadcast({ type: "run_updated", payload: updated })
    return json(updated ?? { error: "Run not found" }, updated ? 200 : 404)
  })

  router.post("/api/tasks/:id/start", async ({ params, json, db }) => {
    const task = db.getTask(params.id)
    if (!task) return json({ error: "Task not found" }, 404)

    const imageToUse = task.containerImage || ctx.settings?.workflow?.container?.image
    if (imageToUse) {
      const exists = await ctx.validateContainerImage(imageToUse)
      if (!exists) {
        if (task.sessionId) {
          db.createSessionMessage({
            sessionId: task.sessionId,
            taskId: task.id,
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

    try {
      const run = await ctx.onStartSingle(params.id)
      return json(run)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("invalid container images") || message.includes("not found")) {
        return json({ error: message }, 409)
      }
      return json({ error: message }, 500)
    }
  })

  router.post("/api/runs/:id/pause", async ({ params, json, broadcast, db }) => {
    try {
      if (ctx.onPauseRun) {
        const result = (await ctx.onPauseRun(params.id)) as { success: boolean; run: WorkflowRun } | null
        if (result && result.success) {
          broadcast({ type: "run_paused", payload: { runId: params.id } })
          return json({ success: true, run: result.run })
        }
      }
      const updated = db.updateWorkflowRun(params.id, { pauseRequested: true, status: "paused" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      broadcast({ type: "run_paused", payload: { runId: params.id } })
      return json({ success: true, run: updated })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 500)
    }
  })

  router.post("/api/runs/:id/resume", async ({ params, json, broadcast, db }) => {
    try {
      if (ctx.onResumeRun) {
        const run = await ctx.onResumeRun(params.id)
        if (run) {
          broadcast({ type: "run_resumed", payload: { runId: params.id } })
          return json({ success: true, run })
        }
      }
      const updated = db.updateWorkflowRun(params.id, { pauseRequested: false, status: "running" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      broadcast({ type: "run_resumed", payload: { runId: params.id } })
      return json({ success: true, run: updated })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 500)
    }
  })

  router.post("/api/runs/:id/stop", async ({ params, req, json, broadcast }) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch (_err) {
        return json({ error: "Invalid JSON body" }, 400)
      }
      const destructive = body?.destructive === true

      if (!ctx.onStopRun) {
        return json({ error: "Stop handler not available" }, 503)
      }

      const result = await ctx.onStopRun(params.id, { destructive })

      if (!result || !result.run) {
        return json({ error: "Failed to stop run - no result from orchestrator" }, 500)
      }

      if (destructive) {
        broadcast({ type: "run_stopped", payload: { runId: params.id, destructive: true } })
      }
      return json(result)
    } catch (error) {
      console.error(`[API /runs/:id/stop] Error stopping run ${params.id}:`, error)
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 500)
    }
  })

  router.post("/api/runs/:id/force-stop", async ({ params, json, broadcast }) => {
    try {
      if (ctx.onStopRun) {
        const result = await ctx.onStopRun(params.id, { destructive: true })
        broadcast({ type: "run_stopped", payload: { runId: params.id, destructive: true } })
        return json(result)
      }
      return json({ error: "Force stop not available" }, 503)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 500)
    }
  })

  router.get("/api/runs/paused-state", ({ json }) => {
    const pausedState = loadPausedRunState()
    return json({
      hasPausedRun: !!pausedState,
      state: pausedState,
    })
  })

  router.get("/api/runs/:id/paused-state", ({ params, json, db }) => {
    const run = db.getWorkflowRun(params.id)
    if (!run) return json({ error: "Run not found" }, 404)

    const pausedStates = []
    for (const taskId of run.taskOrder) {
      const task = db.getTask(taskId)
      if (task?.sessionId) {
        const state = loadPausedSessionState(db, task.sessionId)
        if (state) pausedStates.push(state)
      }
    }

    return json({
      runId: params.id,
      hasPausedSessions: pausedStates.length > 0,
      pausedSessions: pausedStates,
      runStatus: run.status,
    })
  })

  router.get("/api/execution-graph", ({ json, db }) => {
    const allTasks = db.getTasks()
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
  })

  router.get("/api/runs", async ({ json, db }) => {
    const runs = db.getWorkflowRuns()
    if (!ctx.onGetRunQueueStatus) {
      return json(runs)
    }

    const enrichedRuns = await Promise.all(
      runs.map(async (run) => {
        const queueStatus = await ctx.onGetRunQueueStatus!(run.id)
        return {
          ...run,
          queuedTaskCount: queueStatus.queuedTasks,
          executingTaskCount: queueStatus.executingTasks,
        }
      }),
    )

    return json(enrichedRuns)
  })

  router.get("/api/slots", async ({ json }) => {
    if (!ctx.onGetSlots) {
      return json({ error: "Slot inspection not available" }, 503)
    }
    return json(ctx.onGetSlots())
  })

  router.get("/api/runs/:id/queue-status", async ({ params, json }) => {
    if (!ctx.onGetRunQueueStatus) {
      return json({ error: "Run queue status not available" }, 503)
    }

    try {
      return json(await ctx.onGetRunQueueStatus(params.id))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("not found")) {
        return json({ error: message }, 404)
      }
      return json({ error: message }, 500)
    }
  })

  router.get("/api/runs/:id/self-heal-reports", ({ params, json, db }) => {
    const run = db.getWorkflowRun(params.id)
    if (!run) {
      return json({ error: "Run not found" }, 404)
    }
    return json(db.getSelfHealReportsForRun(params.id))
  })

  router.delete("/api/runs/:id", ({ params, json, broadcast, db }) => {
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
  })

  router.get("/api/archived/tasks", ({ json, sessionUrlFor, db }) => {
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
  })

  router.get("/api/archived/runs", ({ json, db }) => {
    return json({ runs: db.getWorkflowRunsWithArchivedTasks() })
  })

  router.get("/api/archived/tasks/:taskId", ({ params, json, sessionUrlFor, db }) => {
    const task = db.getArchivedTask(params.taskId)
    if (!task) return json({ error: "Task not found" }, 404)
    if (!task.sessionId) return json(task)
    if (!task.sessionUrl || task.sessionUrl.includes("opencode") || !task.sessionUrl.includes("#session/")) {
      return json({ ...task, sessionUrl: sessionUrlFor(task.sessionId) })
    }
    return json(task)
  })
}
