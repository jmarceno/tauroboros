import { randomUUID } from "crypto"
import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import type { Task, WorkflowRun, WSMessage } from "../../types.ts"
import type { SmartRepairAction } from "../../runtime/smart-repair.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import {
  HttpRouteError,
  badRequestError,
  conflictError,
  internalRouteError,
  notFoundError,
  serviceUnavailableError,
} from "../route-interpreter.ts"
import {
  getInvalidTaskBooleanField,
  isAutoDeployCondition,
  isExecutionStrategy,
  isThinkingLevel,
  normalizeTaskForClient,
  normalizeTaskRunForClient,
  validateBestOfNConfig,
} from "../validators.ts"

function parseJsonRecord(req: Request): Effect.Effect<Record<string, unknown>, HttpRouteError> {
  return Effect.tryPromise({
    try: () => req.json(),
    catch: () => badRequestError("Invalid JSON body", ErrorCode.INVALID_JSON_BODY),
  }).pipe(
    Effect.flatMap((body) => {
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        return Effect.succeed(body as Record<string, unknown>)
      }
      return Effect.fail(badRequestError("Request body must be an object", ErrorCode.INVALID_REQUEST_BODY))
    }),
  )
}

function requireTask(db: { getTask: (taskId: string) => Task | null }, taskId: string): Effect.Effect<Task, HttpRouteError> {
  const task = db.getTask(taskId)
  if (!task) {
    return Effect.fail(notFoundError("Task not found", ErrorCode.TASK_NOT_FOUND, { taskId }))
  }
  return Effect.succeed(task)
}

function requirePlanModeTask(db: { getTask: (taskId: string) => Task | null }, taskId: string): Effect.Effect<Task, HttpRouteError> {
  return requireTask(db, taskId).pipe(
    Effect.flatMap((task) =>
      task.planmode
        ? Effect.succeed(task)
        : Effect.fail(badRequestError("Task is not in plan mode", ErrorCode.INVALID_REQUEST_BODY, { taskId })),
    ),
  )
}

function requireBestOfNTask(db: { getTask: (taskId: string) => Task | null }, taskId: string): Effect.Effect<Task, HttpRouteError> {
  return requireTask(db, taskId).pipe(
    Effect.flatMap((task) =>
      task.executionStrategy === "best_of_n"
        ? Effect.succeed(task)
        : Effect.fail(badRequestError("Task is not a best_of_n task", ErrorCode.INVALID_REQUEST_BODY, { taskId })),
    ),
  )
}

export function registerTaskRoutes(router: Router, ctx: ServerRouteContext): void {
  const mapOrchestratorRouteError = (taskId: string, messagePrefix: string, error: unknown): HttpRouteError => {
    const message = error instanceof Error ? error.message : String(error)
    return internalRouteError(`${messagePrefix} ${taskId}: ${message}`, ErrorCode.EXECUTION_OPERATION_FAILED, error)
  }

  const startSingleTaskEffect = (taskId: string): Effect.Effect<WorkflowRun | null, HttpRouteError> =>
    ctx.onStartSingle(taskId).pipe(
      Effect.mapError((error) => mapOrchestratorRouteError(taskId, "Failed to start task", error)),
    )

  const manualSelfHealRecoverEffect = (
    taskId: string,
    reportId: string,
    action: "restart_task" | "keep_failed",
  ): Effect.Effect<{ ok: boolean; message: string }, HttpRouteError> =>
    ctx.onManualSelfHealRecover!(taskId, reportId, action).pipe(
      Effect.mapError((error) => mapOrchestratorRouteError(taskId, "Failed manual self-heal recovery for task", error)),
    )

  const buildPlanRevisionResponse = (
    taskId: string,
    req: Request,
    json: (data: unknown, status?: number) => Response,
    sessionUrlFor: (sessionId: string) => string,
    broadcast: (message: WSMessage) => void,
    db: { getTask: (taskId: string) => Task | null; getActiveWorkflowRunForTask: (taskId: string) => WorkflowRun | null; updateTask: (taskId: string, patch: Partial<Task>) => Task | null },
  ) =>
    Effect.gen(function* () {
      const task = yield* requirePlanModeTask(db, taskId)
      const body = yield* parseJsonRecord(req)
      if (typeof body.feedback !== "string" || !body.feedback.trim()) {
        return yield* badRequestError("feedback is required", ErrorCode.INVALID_REQUEST_BODY, { taskId })
      }
      if (typeof task.planRevisionCount !== "number") {
        return yield* 
          internalRouteError(
            `Task ${task.id} has invalid planRevisionCount: expected number, got ${typeof task.planRevisionCount}`,
            ErrorCode.INVALID_REQUEST_BODY,
          )
      }

      const feedback = body.feedback.trim()
      const nextPlanRevisionCount = task.planRevisionCount + 1
      const nextAgentOutput = `${task.agentOutput}\n[user-revision-request]\n${feedback}\n`

      const startRevisionRunWhenReady = (maxAttempts: number, delayMs: number): Effect.Effect<WorkflowRun | null, HttpRouteError> => Effect.gen(function* () {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const activeRun = db.getActiveWorkflowRunForTask(task.id)
          if (activeRun) {
            yield* Effect.sleep(delayMs)
            continue
          }

          const prepared = db.updateTask(task.id, {
            status: "backlog",
            awaitingPlanApproval: false,
            executionPhase: "plan_revision_pending",
            planRevisionCount: nextPlanRevisionCount,
            agentOutput: nextAgentOutput,
          })
          if (!prepared) {
            return null
          }

          const normalizedPrepared = normalizeTaskForClient(prepared, sessionUrlFor)
          broadcast({ type: "task_updated", payload: normalizedPrepared })
          broadcast({ type: "plan_revision_requested", payload: { taskId: task.id } })
          return yield* startSingleTaskEffect(task.id)
        }

        return null
      })

      const run = yield* startRevisionRunWhenReady(24, 50)

      if (run) {
        const taskForResponse = db.getTask(task.id)
        if (!taskForResponse) {
          return yield* internalRouteError(`Task ${task.id} not found after scheduling plan revision run`, ErrorCode.TASK_NOT_FOUND)
        }
        return json({ task: normalizeTaskForClient(taskForResponse, sessionUrlFor), run })
      }

      return yield* conflictError(
        `Could not queue plan revision for task ${task.id} because a prior run is still active`,
        ErrorCode.EXECUTION_OPERATION_FAILED,
        { taskId: task.id },
      )
    })

  router.get("/api/tasks", ({ json, sessionUrlFor, db }) => {
    const tasks = db.getTasks().map((task) => normalizeTaskForClient(task, sessionUrlFor))
    return json(tasks)
  })

  router.post("/api/tasks", async ({ req, json, sessionUrlFor, broadcast, db }) => {
    const body = await req.json()
    const invalidBooleanField = getInvalidTaskBooleanField(body)
    if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
    if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
      return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
    }
    if (body?.planThinkingLevel !== undefined && !isThinkingLevel(body.planThinkingLevel)) {
      return json({ error: "Invalid planThinkingLevel. Allowed values: default, low, medium, high" }, 400)
    }
    if (body?.executionThinkingLevel !== undefined && !isThinkingLevel(body.executionThinkingLevel)) {
      return json({ error: "Invalid executionThinkingLevel. Allowed values: default, low, medium, high" }, 400)
    }
    if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
      return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
    }
    if (body?.executionStrategy === "best_of_n") {
      const valid = validateBestOfNConfig(body.bestOfNConfig)
      if (!valid.valid) return json({ error: valid.error }, 400)
    }

    if (
      body?.autoDeployCondition !== undefined &&
      body.autoDeployCondition !== null &&
      !isAutoDeployCondition(body.autoDeployCondition)
    ) {
      return json(
        {
          error:
            "Invalid autoDeployCondition. Allowed values: before_workflow_start, after_workflow_end, workflow_done, workflow_failed",
        },
        400,
      )
    }

    const requestedStatus = body?.status ?? "backlog"
    if (body?.autoDeploy === true) {
      if (requestedStatus !== "template") {
        return json({ error: "autoDeploy can only be enabled for template tasks" }, 400)
      }
      if (!isAutoDeployCondition(body?.autoDeployCondition)) {
        return json({ error: "autoDeployCondition is required when autoDeploy is enabled" }, 400)
      }
    } else if (body?.autoDeployCondition !== undefined && body.autoDeployCondition !== null) {
      return json({ error: "autoDeployCondition requires autoDeploy=true" }, 400)
    }

    if (body?.containerImage !== undefined && body.containerImage !== null && body.containerImage !== "") {
      const imageExists = await ctx.validateContainerImage(String(body.containerImage))
      if (!imageExists) {
        return json({ error: `Container image '${body.containerImage}' not found. Build the image first.` }, 409)
      }
    }

    const allValidTaskIds = new Set(db.getTasks().map((t) => t.id))
    const rawRequirements = Array.isArray(body.requirements) ? body.requirements : []
    const validRequirements = rawRequirements.filter((reqId: string) => {
      if (!allValidTaskIds.has(reqId)) {
        console.warn(`[server] Task creation: Removing invalid dependency "${reqId}"`)
        return false
      }
      return true
    })
    const removedDeps = rawRequirements.filter((reqId: string) => !allValidTaskIds.has(reqId))

    const task = db.createTask({
      id: randomUUID().slice(0, 8),
      name: String(body.name ?? "").trim(),
      prompt: String(body.prompt ?? ""),
      status: body.status ?? "backlog",
      branch: body.branch,
      planModel: body.planModel,
      executionModel: body.executionModel,
      planmode: body.planmode,
      autoApprovePlan: body.autoApprovePlan,
      review: body.review,
      codeStyleReview: body.codeStyleReview,
      autoCommit: body.autoCommit,
      autoDeploy: body.autoDeploy,
      autoDeployCondition: body.autoDeployCondition,
      deleteWorktree: body.deleteWorktree,
      requirements: validRequirements,
      thinkingLevel: body.thinkingLevel,
      planThinkingLevel: body.planThinkingLevel,
      executionThinkingLevel: body.executionThinkingLevel,
      executionStrategy: body.executionStrategy,
      bestOfNConfig: body.bestOfNConfig,
      bestOfNSubstage: body.bestOfNSubstage,
      skipPermissionAsking: body.skipPermissionAsking,
      containerImage: body.containerImage,
    })

    const normalized = normalizeTaskForClient(task, sessionUrlFor)
    broadcast({ type: "task_created", payload: normalized })

    if (removedDeps.length > 0) {
      return json(
        { ...normalized, warning: `Invalid dependencies auto-removed: ${removedDeps.join(", ")}` },
        201,
      )
    }
    return json(normalized, 201)
  })

  router.post("/api/tasks/create-and-wait", ({ req, json, sessionUrlFor, broadcast, db }) =>
    Effect.gen(function* () {
      const body = yield* parseJsonRecord(req)
      const invalidBooleanField = getInvalidTaskBooleanField(body)
      if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.planThinkingLevel !== undefined && !isThinkingLevel(body.planThinkingLevel)) {
        return json({ error: "Invalid planThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionThinkingLevel !== undefined && !isThinkingLevel(body.executionThinkingLevel)) {
        return json({ error: "Invalid executionThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
        return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
      }
      if (body?.executionStrategy === "best_of_n") {
        const valid = validateBestOfNConfig(body.bestOfNConfig)
        if (!valid.valid) return json({ error: valid.error }, 400)
      }

      if (body?.autoDeploy !== undefined || body?.autoDeployCondition !== undefined) {
        return json(
          { error: "autoDeploy is only supported for template tasks and cannot be used with create-and-wait" },
          400,
        )
      }

      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 1800000, 60000), 7200000)
      const pollIntervalMs = Math.min(Math.max(Number(body.pollIntervalMs) || 2000, 1000), 30000)

      if (body?.containerImage !== undefined && body.containerImage !== null && body.containerImage !== "") {
        const imageExists = yield* Effect.tryPromise({
          try: () => ctx.validateContainerImage(String(body.containerImage)),
          catch: (error) => internalRouteError(
            `Failed to validate container image '${String(body.containerImage)}'`,
            ErrorCode.CONTAINER_OPERATION_FAILED,
            error,
          ),
        })
        if (!imageExists) {
          return json({ error: `Container image '${body.containerImage}' not found. Build the image first.` }, 409)
        }
      }

      const task = db.createTask({
        id: randomUUID().slice(0, 8),
        name: String(body.name ?? "").trim(),
        prompt: String(body.prompt ?? ""),
        status: "backlog",
        branch: body.branch,
        planModel: body.planModel,
        executionModel: body.executionModel,
        planmode: body.planmode,
        autoApprovePlan: body.autoApprovePlan,
        review: body.review,
        codeStyleReview: body.codeStyleReview,
        autoCommit: body.autoCommit,
        autoDeploy: false,
        autoDeployCondition: null,
        deleteWorktree: body.deleteWorktree,
        requirements: Array.isArray(body.requirements) ? body.requirements : [],
        thinkingLevel: body.thinkingLevel,
        planThinkingLevel: body.planThinkingLevel,
        executionThinkingLevel: body.executionThinkingLevel,
        executionStrategy: body.executionStrategy,
        bestOfNConfig: body.bestOfNConfig,
        bestOfNSubstage: body.bestOfNSubstage,
        skipPermissionAsking: body.skipPermissionAsking,
        containerImage: body.containerImage,
      })

      const normalized = normalizeTaskForClient(task, sessionUrlFor)
      broadcast({ type: "task_created", payload: normalized })

      const run = yield* ctx.onStartSingle(task.id).pipe(
        Effect.mapError((error) => mapOrchestratorRouteError(task.id, "Failed to start task", error)),
      )
      if (!run) {
        return json({ error: "Failed to start task execution" }, 500)
      }

      const startTime = Date.now()
      const terminalStatuses = ["done", "failed", "stuck"] as const

      while (true) {
        yield* Effect.sleep(pollIntervalMs)

        const currentTask = db.getTask(task.id)
        if (!currentTask) {
          return json(createApiError("Task was deleted during execution", ErrorCode.TASK_NOT_FOUND), 500)
        }

        if (terminalStatuses.includes(currentTask.status as (typeof terminalStatuses)[number])) {
          return json(
            {
              task: normalizeTaskForClient(currentTask, sessionUrlFor),
              run: db.getWorkflowRun(run.id),
              completedAt: Date.now(),
              durationMs: Date.now() - startTime,
              status: currentTask.status,
            },
            200,
          )
        }

        if (Date.now() - startTime >= timeoutMs) {
          const stopOutcome = ctx.onStopRun
            ? yield* Effect.either(
                ctx.onStopRun(run.id, { destructive: false }).pipe(
                  Effect.mapError((error) => mapOrchestratorRouteError(task.id, "Failed to stop timed out task", error)),
                ),
              )
            : null

          return json(
            createApiError("Timeout waiting for task completion", ErrorCode.EXECUTION_OPERATION_FAILED, {
              task: normalizeTaskForClient(currentTask, sessionUrlFor),
              run: db.getWorkflowRun(run.id),
              timeoutMs,
              elapsedMs: Date.now() - startTime,
              stopFailure:
                stopOutcome && stopOutcome._tag === "Left"
                  ? { message: stopOutcome.left.message, code: stopOutcome.left.code }
                  : undefined,
            }),
            408,
          )
        }
      }
    }),
  )

  router.put("/api/tasks/reorder", async ({ req, json, broadcast, db }) => {
    const body = await req.json()
    if (!body?.id || typeof body.newIdx !== "number") return json({ error: "id and newIdx are required" }, 400)
    db.reorderTask(String(body.id), Number(body.newIdx))
    broadcast({ type: "task_reordered", payload: {} })
    return json({ ok: true })
  })

  router.delete("/api/tasks/done/all", ({ json, broadcast, db }) => {
    const doneTasks = db.getTasksByStatus("done")
    let archived = 0
    let deleted = 0

    for (const task of doneTasks) {
      if (db.hasTaskExecutionHistory(task.id)) {
        db.archiveTask(task.id)
        broadcast({ type: "task_archived", payload: { id: task.id } })
        archived++
      } else {
        db.hardDeleteTask(task.id)
        broadcast({ type: "task_deleted", payload: { id: task.id } })
        deleted++
      }
    }

    return json({ archived, deleted })
  })

  router.get("/api/tasks/:id", ({ params, json, sessionUrlFor, db }) => {
    const task = db.getTask(params.id)
    if (!task) return json({ error: "Task not found" }, 404)
    return json(normalizeTaskForClient(task, sessionUrlFor))
  })

  router.patch("/api/tasks/:id", async ({ params, req, json, sessionUrlFor, broadcast, db }) => {
    const existing = db.getTask(params.id)
    if (!existing) return json({ error: "Task not found" }, 404)

    const activeRun = db.getActiveWorkflowRunForTask(params.id)
    if (activeRun) {
      return json(
        { error: `Cannot modify task "${existing.name}" while it is executing in run ${activeRun.id}.` },
        409,
      )
    }

    const body = await req.json()
    const invalidBooleanField = getInvalidTaskBooleanField(body)
    if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
    if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
      return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
    }
    if (body?.planThinkingLevel !== undefined && !isThinkingLevel(body.planThinkingLevel)) {
      return json({ error: "Invalid planThinkingLevel. Allowed values: default, low, medium, high" }, 400)
    }
    if (body?.executionThinkingLevel !== undefined && !isThinkingLevel(body.executionThinkingLevel)) {
      return json({ error: "Invalid executionThinkingLevel. Allowed values: default, low, medium, high" }, 400)
    }
    if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
      return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
    }
    if (
      body?.executionStrategy === "best_of_n" ||
      (body?.bestOfNConfig && existing.executionStrategy === "best_of_n")
    ) {
      const validation = validateBestOfNConfig(body.bestOfNConfig ?? existing.bestOfNConfig)
      if (!validation.valid) return json({ error: validation.error }, 400)
    }

    if (
      body?.autoDeployCondition !== undefined &&
      body.autoDeployCondition !== null &&
      !isAutoDeployCondition(body.autoDeployCondition)
    ) {
      return json(
        {
          error:
            "Invalid autoDeployCondition. Allowed values: before_workflow_start, after_workflow_end, workflow_done, workflow_failed",
        },
        400,
      )
    }

    const nextStatus = body?.status ?? existing.status
    if (nextStatus !== "template") {
      if (body?.autoDeploy === true) {
        return json({ error: "autoDeploy can only be enabled for template tasks" }, 400)
      }
      if (body?.autoDeployCondition !== undefined && body.autoDeployCondition !== null) {
        return json({ error: "autoDeployCondition can only be set for template tasks" }, 400)
      }
      if (body?.status !== undefined && body.status !== "template") {
        body.autoDeploy = false
        body.autoDeployCondition = null
      }
    } else {
      const nextAutoDeploy =
        body?.autoDeploy !== undefined ? body.autoDeploy === true : existing.autoDeploy === true
      const nextAutoDeployCondition =
        body?.autoDeployCondition !== undefined ? body.autoDeployCondition : existing.autoDeployCondition

      if (nextAutoDeploy) {
        if (!isAutoDeployCondition(nextAutoDeployCondition)) {
          return json({ error: "autoDeployCondition is required when autoDeploy is enabled" }, 400)
        }
      } else if (body?.autoDeployCondition !== undefined && body.autoDeployCondition !== null) {
        return json({ error: "autoDeployCondition requires autoDeploy=true" }, 400)
      }
    }

    if (body?.containerImage !== undefined && body.containerImage !== null && body.containerImage !== "") {
      const imageExists = await ctx.validateContainerImage(String(body.containerImage))
      if (!imageExists) {
        return json({ error: `Container image '${body.containerImage}' not found. Build the image first.` }, 409)
      }
    }

    if (body?.status === "backlog" && body?.executionPhase === undefined) {
      body.executionPhase = "not_started"
      body.awaitingPlanApproval = false
    }
    if (body?.status === "backlog" && body?.bestOfNSubstage === undefined) {
      body.bestOfNSubstage = "idle"
    }

    let removedFromGroupId: string | null = null
    if (body?.status === "template" && existing.groupId) {
      removedFromGroupId = existing.groupId
      db.removeTaskFromGroup(existing.groupId, params.id)
      body.groupId = null
    }

    const task = db.updateTask(params.id, body)
    if (!task) return json({ error: "Task not found" }, 404)

    if (removedFromGroupId) {
      broadcast({ type: "task_group_members_removed", payload: { groupId: removedFromGroupId, taskIds: [task.id] } })
      broadcast({ type: "group_task_removed", payload: { groupId: removedFromGroupId, taskId: task.id } })
    }

    const normalized = normalizeTaskForClient(task, sessionUrlFor)
    broadcast({ type: "task_updated", payload: normalized })
    return json(normalized)
  })

  router.delete("/api/tasks/:id", ({ params, json, broadcast, db }) => {
    const existing = db.getTask(params.id)
    if (!existing) return json({ error: "Task not found" }, 404)

    const activeRun = db.getActiveWorkflowRunForTask(params.id)
    if (activeRun) {
      return json(
        { error: `Cannot modify task "${existing.name}" while it is executing in run ${activeRun.id}.` },
        409,
      )
    }

    if (db.hasTaskExecutionHistory(params.id)) {
      db.archiveTask(params.id)
      broadcast({ type: "task_archived", payload: { id: params.id } })
      return json({ id: params.id, archived: true })
    }

    db.hardDeleteTask(params.id)
    broadcast({ type: "task_deleted", payload: { id: params.id } })
    return new Response(null, { status: 204 })
  })

  router.get("/api/tasks/:id/runs", ({ params, json, sessionUrlFor, db }) => {
    const task = db.getTask(params.id) ?? db.getArchivedTask(params.id)
    if (!task) return json({ error: "Task not found" }, 404)
    return json(db.getTaskRuns(params.id).map((run) => normalizeTaskRunForClient(run, sessionUrlFor)))
  })

  router.get("/api/tasks/:id/sessions", ({ params, json, db }) => {
    const task = db.getTask(params.id) ?? db.getArchivedTask(params.id)
    if (!task) return json({ error: "Task not found" }, 404)
    return json(db.getWorkflowSessionsByTask(params.id))
  })

  router.get("/api/tasks/:id/candidates", ({ params, json, db }) => {
    if (!db.getTask(params.id)) return json({ error: "Task not found" }, 404)
    return json(db.getTaskCandidates(params.id))
  })

  router.get("/api/tasks/:id/best-of-n-summary", ({ params, json, db }) =>
    Effect.gen(function* () {
      const task = yield* requireBestOfNTask(db, params.id)
      const summary = yield* Effect.try({
        try: () => db.getBestOfNSummary(params.id),
        catch: (error) => internalRouteError(`Failed to get summary for task ${params.id}`, ErrorCode.TASK_NOT_FOUND, error),
      })
      const candidates = db.getTaskCandidates(params.id)
      const expandedWorkerCount = task.bestOfNConfig
        ? task.bestOfNConfig.workers.reduce((sum, slot) => sum + slot.count, 0)
        : 0
      const expandedReviewerCount = task.bestOfNConfig
        ? task.bestOfNConfig.reviewers.reduce((sum, slot) => sum + slot.count, 0)
        : 0

      return json({
        taskId: params.id,
        substage: task.bestOfNSubstage,
        workersTotal: summary.workersTotal,
        workersDone: summary.workersDone + summary.workersFailed,
        workersFailed: summary.workersFailed,
        reviewersTotal: summary.reviewersTotal,
        reviewersDone: summary.reviewersDone + summary.reviewersFailed,
        reviewersFailed: summary.reviewersFailed,
        hasFinalApplier: summary.finalApplierStatus !== "not_started",
        finalApplierDone: summary.finalApplierStatus === "done",
        finalApplierStatus: summary.finalApplierStatus,
        expandedWorkerCount,
        expandedReviewerCount,
        totalExpandedRuns: expandedWorkerCount + expandedReviewerCount + 1,
        successfulCandidateCount: candidates.length,
        selectedCandidate: candidates.find((candidate) => candidate.status === "selected")?.id ?? null,
        availableCandidates: summary.availableCandidates,
        selectedCandidates: summary.selectedCandidates,
      })
    }),
  )

  router.post("/api/tasks/:id/best-of-n/select-candidate", ({ params, req, json, broadcast, db }) =>
    Effect.gen(function* () {
      const task = yield* requireBestOfNTask(db, params.id)
      const body = yield* parseJsonRecord(req)
      const candidateId = typeof body.candidateId === "string" ? body.candidateId : ""
      if (!candidateId) {
        return yield* badRequestError("candidateId is required", ErrorCode.INVALID_REQUEST_BODY, { taskId: params.id })
      }

      const candidates = db.getTaskCandidates(task.id)
      if (!candidates.some((candidate) => candidate.id === candidateId)) {
        return yield* notFoundError("Candidate not found", ErrorCode.TASK_NOT_FOUND, { taskId: params.id, candidateId })
      }

      const updatedCandidates = candidates
        .map((candidate) =>
          db.updateTaskCandidate(candidate.id, { status: candidate.id === candidateId ? "selected" : "rejected" }),
        )
        .filter(Boolean)

      for (const candidate of updatedCandidates) {
        broadcast({ type: "task_candidate_updated", payload: candidate })
      }

      return json({ ok: true, selectedCandidate: candidateId })
    }),
  )

  router.post("/api/tasks/:id/best-of-n/abort", ({ params, req, json, sessionUrlFor, broadcast, db }) =>
    Effect.gen(function* () {
      const task = yield* requireBestOfNTask(db, params.id)
      const body = yield* parseJsonRecord(req)
      const reason =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "Best-of-n execution aborted manually"

      const updated = db.updateTask(task.id, {
        status: "review",
        bestOfNSubstage: "blocked_for_manual_review",
        errorMessage: reason,
      })
      if (!updated) {
        return yield* notFoundError("Task not found", ErrorCode.TASK_NOT_FOUND, { taskId: task.id })
      }

      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json({ ok: true, task: normalized })
    }),
  )

  router.get("/api/tasks/:id/review-status", ({ params, json, db }) => {
    const task = db.getTask(params.id)
    if (!task) return json({ error: "Task not found" }, 404)
    const options = db.getOptions()
    return json({
      taskId: task.id,
      reviewCount: task.reviewCount,
      maxReviewRuns: options.maxReviews,
      maxReviewRunsOverride: task.maxReviewRunsOverride,
    })
  })

  router.post("/api/tasks/:id/approve-plan", ({ params, req, json, sessionUrlFor, broadcast, db }) =>
    Effect.gen(function* () {
      const task = yield* requirePlanModeTask(db, params.id)
      const body = yield* parseJsonRecord(req)

      const updated = db.updateTask(task.id, {
        status: "backlog",
        awaitingPlanApproval: false,
        executionPhase: "implementation_pending",
        errorMessage: null,
        ...(typeof body.approvalNote === "string" && body.approvalNote.trim().length > 0
          ? { agentOutput: `${task.agentOutput}\n[user-approval-note]\n${body.approvalNote.trim()}\n` }
          : typeof body.message === "string" && body.message.trim().length > 0
            ? { agentOutput: `${task.agentOutput}\n[user-approval-note]\n${body.message.trim()}\n` }
            : {}),
      })

      if (!updated) {
        return yield* notFoundError("Task not found", ErrorCode.TASK_NOT_FOUND, { taskId: task.id })
      }
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json(normalized)
    }),
  )

  router.post("/api/tasks/:id/request-plan-revision", ({ params, req, json, sessionUrlFor, broadcast, db }) =>
    buildPlanRevisionResponse(params.id, req, json, sessionUrlFor, broadcast, db),
  )

  router.post("/api/tasks/:id/request-revision", ({ params, req, json, sessionUrlFor, broadcast, db }) =>
    buildPlanRevisionResponse(params.id, req, json, sessionUrlFor, broadcast, db),
  )

  router.post("/api/tasks/:id/reset", async ({ params, json, sessionUrlFor, broadcast, db }) => {
    const task = db.getTask(params.id)
    if (!task) return json({ error: "Task not found" }, 404)

    const activeRun = db.getActiveWorkflowRunForTask(params.id)
    if (activeRun) {
      return json(
        { error: `Cannot modify task "${task.name}" while it is executing in run ${activeRun.id}.` },
        409,
      )
    }

    const membership = db.getTaskGroupMembership(params.id)

    const reset = db.updateTask(task.id, {
      status: "backlog",
      reviewCount: 0,
      errorMessage: null,
      completedAt: null,
      sessionId: null,
      sessionUrl: null,
      worktreeDir: null,
      executionPhase: "not_started",
      awaitingPlanApproval: false,
      planRevisionCount: 0,
    })

    if (!reset) return json({ error: "Task not found" }, 404)
    const normalized = normalizeTaskForClient(reset, sessionUrlFor)
    broadcast({ type: "task_updated", payload: normalized })

    if (membership.groupId && membership.group) {
      return json({ task: normalized, group: membership.group, wasInGroup: true })
    }

    return json({ task: normalized, wasInGroup: false })
  })

  router.post("/api/tasks/:id/reset-to-group", async ({ params, json, sessionUrlFor, broadcast, db }) => {
    const task = db.getTask(params.id)
    if (!task) return json({ error: "Task not found" }, 404)

    const activeRun = db.getActiveWorkflowRunForTask(params.id)
    if (activeRun) {
      return json(
        { error: `Cannot modify task "${task.name}" while it is executing in run ${activeRun.id}.` },
        409,
      )
    }

    const membership = db.getTaskGroupMembership(params.id)
    if (!membership.groupId || !membership.group) {
      return json({ error: "Task was not in a group" }, 400)
    }

    const groupId = membership.groupId
    const group = membership.group

    const reset = db.updateTask(task.id, {
      status: "backlog",
      reviewCount: 0,
      errorMessage: null,
      completedAt: null,
      sessionId: null,
      sessionUrl: null,
      worktreeDir: null,
      executionPhase: "not_started",
      awaitingPlanApproval: false,
      planRevisionCount: 0,
    })

    if (!reset) return json({ error: "Task not found" }, 404)

    db.addTaskToGroup(groupId, task.id)

    const normalized = normalizeTaskForClient(reset, sessionUrlFor)
    broadcast({ type: "task_updated", payload: normalized })
    broadcast({ type: "group_task_added", payload: { groupId, taskId: task.id } })
    broadcast({ type: "task_group_members_added", payload: { groupId, taskIds: [task.id] } })

    return json({ task: normalized, group, restoredToGroup: true })
  })

  router.post("/api/tasks/:id/move-to-group", ({ params, req, json, sessionUrlFor, broadcast, db }) =>
    Effect.gen(function* () {
      const task = yield* requireTask(db, params.id)

      const activeRun = db.getActiveWorkflowRunForTask(params.id)
      if (activeRun) {
        return yield* 
          internalRouteError(
            `Cannot modify task "${task.name}" while it is executing in run ${activeRun.id}.`,
            ErrorCode.EXECUTION_OPERATION_FAILED,
          )
      }

      const body = yield* parseJsonRecord(req)
      const groupIdRaw = body.groupId

      if (groupIdRaw !== undefined && groupIdRaw !== null && typeof groupIdRaw !== "string") {
        return yield* badRequestError("groupId must be a string, null, or undefined", ErrorCode.INVALID_REQUEST_BODY)
      }

      const groupId: string | null | undefined = groupIdRaw as string | null | undefined

      if (groupId === null) {
        if (task.groupId) {
          db.removeTaskFromGroup(task.groupId, task.id)
          broadcast({ type: "group_task_removed", payload: { groupId: task.groupId, taskId: task.id } })
          broadcast({ type: "task_group_members_removed", payload: { groupId: task.groupId, taskIds: [task.id] } })
        }
        const updated = db.updateTask(task.id, { groupId: null })
        const normalized = normalizeTaskForClient(updated ?? task, sessionUrlFor)
        broadcast({ type: "task_updated", payload: normalized })
        return json(normalized)
      }

      if (typeof groupId !== "string") {
        return yield* badRequestError("groupId must be a string or null", ErrorCode.INVALID_REQUEST_BODY)
      }

      const group = db.getTaskGroup(groupId)
      if (!group) {
        return yield* notFoundError("Group not found", ErrorCode.TASK_GROUP_NOT_FOUND, { groupId })
      }

      if (task.groupId && task.groupId !== groupId) {
        db.removeTaskFromGroup(task.groupId, task.id)
        broadcast({ type: "group_task_removed", payload: { groupId: task.groupId, taskId: task.id } })
        broadcast({ type: "task_group_members_removed", payload: { groupId: task.groupId, taskIds: [task.id] } })
      }

      db.addTaskToGroup(groupId, task.id)

      const updated = db.getTask(task.id)
      const normalized = normalizeTaskForClient(updated ?? task, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      broadcast({ type: "group_task_added", payload: { groupId, taskId: task.id } })
      broadcast({ type: "task_group_members_added", payload: { groupId, taskIds: [task.id] } })

      return json(normalized)
    }),
  )

  router.post("/api/tasks/:id/repair-state", ({ params, req, json, sessionUrlFor, broadcast, db }) =>
    Effect.gen(function* () {
      const task = yield* requireTask(db, params.id)
      const body = yield* parseJsonRecord(req)
      const requestedAction = typeof body.action === "string" ? body.action : "smart"

      if (requestedAction === "smart") {
        const smart = yield* ctx.smartRepair.repair(
          task.id,
          typeof body.smartRepairHints === "string" ? body.smartRepairHints : undefined,
        ).pipe(
          Effect.mapError((error) =>
            internalRouteError(`Failed smart repair for task ${task.id}`, ErrorCode.EXECUTION_OPERATION_FAILED, error),
          ),
        )
        const normalizedSmart = normalizeTaskForClient(smart.task, sessionUrlFor)
        broadcast({ type: "task_updated", payload: normalizedSmart })
        return json({ ok: true, action: smart.action, reason: smart.reason, task: normalizedSmart })
      }

      const action = requestedAction as SmartRepairAction
      if (
        !["queue_implementation", "restore_plan_approval", "reset_backlog", "mark_done", "fail_task", "continue_with_more_reviews"].includes(
          action,
        )
      ) {
        return yield* badRequestError(`Unsupported repair action: ${requestedAction}`, ErrorCode.INVALID_REQUEST_BODY)
      }

      const reason =
        typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Manual repair action"

      const updated = yield* ctx.smartRepair.applyAction(task.id, {
        action,
        reason,
        errorMessage:
          typeof body.errorMessage === "string" && body.errorMessage.trim()
            ? body.errorMessage.trim()
            : undefined,
      }).pipe(
        Effect.mapError((error) =>
          internalRouteError(`Failed to apply repair action for task ${task.id}`, ErrorCode.EXECUTION_OPERATION_FAILED, error),
        ),
      )
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json({ ok: true, action, reason, task: normalized })
    }),
  )

  router.get("/api/tasks/:id/self-heal-reports", ({ params, json, db }) =>
    Effect.gen(function* () {
      yield* requireTask(db, params.id)
      const runs = db.getWorkflowRuns().filter((run) => run.taskOrder.includes(params.id))
      const reports = runs.flatMap((run) =>
        db.getSelfHealReportsForRun(run.id).filter((report) => report.taskId === params.id),
      )
      return json(reports)
    }),
  )

  router.post("/api/tasks/:id/self-heal-recover", ({ params, req, json, db }) =>
    Effect.gen(function* () {
      if (!ctx.onManualSelfHealRecover) {
        return yield* serviceUnavailableError("Manual self-heal recovery not available", ErrorCode.SERVICE_UNAVAILABLE)
      }
      yield* requireTask(db, params.id)

      const body = yield* parseJsonRecord(req)
      const reportId = typeof body.reportId === "string" ? body.reportId.trim() : ""
      if (!reportId) {
        return yield* badRequestError("reportId is required", ErrorCode.INVALID_REQUEST_BODY, { taskId: params.id })
      }

      const action = body.action
      if (action !== "restart_task" && action !== "keep_failed") {
        return yield* badRequestError(
          "action must be 'restart_task' or 'keep_failed'",
          ErrorCode.INVALID_REQUEST_BODY,
          { taskId: params.id },
        )
      }

      const report = db.getSelfHealReport(reportId)
      if (!report) {
        return yield* notFoundError("Self-heal report not found", ErrorCode.TASK_NOT_FOUND, { taskId: params.id, reportId })
      }
      if (report.taskId !== params.id) {
        return yield* badRequestError("Report does not belong to this task", ErrorCode.INVALID_REQUEST_BODY, { taskId: params.id, reportId })
      }

      const result = yield* manualSelfHealRecoverEffect(params.id, reportId, action)
      return json(result)
    }),
  )
}
