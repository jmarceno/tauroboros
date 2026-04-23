import { randomUUID } from "crypto"
import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import { PROMPT_CATALOG, joinPrompt, renderPromptTemplate } from "../../prompts/catalog.ts"
import type { SessionMessage } from "../../types.ts"
import type { Task } from "../../types.ts"
import type { ContextAttachment } from "../../runtime/planning-session.ts"
import { isThinkingLevel, normalizeTaskForClient } from "../validators.ts"
import { HttpRouteError, badRequestError, notFoundError, internalRouteError } from "../route-interpreter.ts"

function validateTasksPayload(
  tasks: unknown,
): Effect.Effect<Array<{ name: string; prompt: string; status: Task["status"]; requirements: string[] }>, HttpRouteError> {
  if (tasks === undefined) {
    return Effect.succeed([])
  }
  if (!Array.isArray(tasks)) {
    return Effect.fail(
      new HttpRouteError({
        message: "Invalid tasks payload. Expected an array.",
        code: ErrorCode.INVALID_TASK_CREATION_INPUT,
        status: 400,
      }),
    )
  }

  const validated: Array<{ name: string; prompt: string; status: Task["status"]; requirements: string[] }> = []
  for (const entry of tasks) {
    if (typeof entry !== "object" || entry === null) {
      return Effect.fail(
        new HttpRouteError({
          message: "Task entry must be an object.",
          code: ErrorCode.INVALID_TASK_CREATION_INPUT,
          status: 400,
        }),
      )
    }

    const candidate = entry as {
      name?: unknown
      prompt?: unknown
      status?: unknown
      requirements?: unknown
    }

    if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
      return Effect.fail(
        new HttpRouteError({
          message: "Task data missing required field: name",
          code: ErrorCode.INVALID_TASK_CREATION_INPUT,
          status: 400,
        }),
      )
    }

    if (typeof candidate.prompt !== "string" || candidate.prompt.trim() === "") {
      return Effect.fail(
        new HttpRouteError({
          message: "Task data missing required field: prompt",
          code: ErrorCode.INVALID_TASK_CREATION_INPUT,
          status: 400,
        }),
      )
    }

    if (typeof candidate.status !== "string" || candidate.status.trim() === "") {
      return Effect.fail(
        new HttpRouteError({
          message: "Task data missing required field: status",
          code: ErrorCode.INVALID_TASK_CREATION_INPUT,
          status: 400,
        }),
      )
    }

    if (!Array.isArray(candidate.requirements) || candidate.requirements.some((r) => typeof r !== "string")) {
      return Effect.fail(
        new HttpRouteError({
          message: "Task data missing or invalid field: requirements (must be an array)",
          code: ErrorCode.INVALID_TASK_CREATION_INPUT,
          status: 400,
        }),
      )
    }

    validated.push({
      name: candidate.name,
      prompt: candidate.prompt,
      status: candidate.status as Task["status"],
      requirements: candidate.requirements,
    })
  }

  return Effect.succeed(validated)
}

export function registerPlanningRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/planning/prompt", ({ json, db }) =>
    Effect.gen(function* () {
      const prompt = db.getPlanningPrompt("default")
      if (!prompt) {
        return yield* Effect.fail(notFoundError(
          "Planning prompt not found",
          ErrorCode.PLANNING_PROMPT_NOT_CONFIGURED,
        ))
      }
      return json(prompt)
    }),
  )

  router.get("/api/planning/prompts", ({ json, db }) => Effect.sync(() => json(db.getAllPlanningPrompts())))

  router.put("/api/planning/prompt", ({ req, json, broadcast, db }) =>
    Effect.gen(function* () {
      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => badRequestError(
          cause instanceof Error ? cause.message : "Invalid JSON body",
          ErrorCode.INVALID_JSON_BODY,
          { cause },
        ),
      })) as Record<string, unknown>

      const existing = db.getPlanningPrompt((body as Record<string, unknown>).key as string ?? "default")
      if (!existing) {
        return yield* Effect.fail(notFoundError(
          "Planning prompt not found",
          ErrorCode.PLANNING_PROMPT_NOT_CONFIGURED,
        ))
      }

      const updated = db.updatePlanningPrompt(existing.id, {
        name: (body as Record<string, unknown>).name,
        description: (body as Record<string, unknown>).description,
        promptText: (body as Record<string, unknown>).promptText,
        isActive: (body as Record<string, unknown>).isActive,
      })

      broadcast({ type: "planning_prompt_updated", payload: updated })
      return json(updated)
    }),
  )

  router.get("/api/planning/prompt/:key/versions", ({ params, json, db }) => Effect.sync(() => json(db.getPlanningPromptVersions(params.key))))

  router.get("/api/planning/sessions", ({ json, sessionUrlFor, db }) =>
    Effect.sync(() => {
      const sessions = db.getPlanningSessions()
      return json(sessions.map((s) => ({ ...s, sessionUrl: sessionUrlFor(s.id) })))
    }),
  )

  router.get("/api/planning/sessions/active", ({ json, sessionUrlFor, db }) =>
    Effect.sync(() => {
      const sessions = db.getActivePlanningSessions()
      return json(sessions.map((s) => ({ ...s, sessionUrl: sessionUrlFor(s.id) })))
    }),
  )

  router.post("/api/planning/sessions", ({ req, json, broadcast, sessionUrlFor, db }) =>
    Effect.gen(function* () {
      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => internalRouteError(cause instanceof Error ? cause.message : String(cause), ErrorCode.INVALID_JSON_BODY, cause),
      })) as Record<string, unknown>
      const sessionKind = (body.sessionKind as string | undefined) ?? "planning"
      const promptKey = sessionKind === "container_config" ? "container_config" : "default"
      const planningPrompt = db.getPlanningPrompt(promptKey)
      if (!planningPrompt) {
        return json(createApiError("Planning prompt not configured", ErrorCode.PLANNING_PROMPT_NOT_CONFIGURED), 500)
      }

      return yield* ctx.planningSessionManager.createSession({
        cwd: body.cwd ?? process.cwd(),
        systemPrompt: planningPrompt.promptText,
        model: body.model ?? "default",
        thinkingLevel: body.thinkingLevel ?? "default",
        sessionKind,
        onMessage: (message: SessionMessage) => {
          broadcast({ type: "planning_session_message", payload: { sessionId: message.sessionId, message } })
        },
        onStatusChange: (updatedSession) => {
          const withUrl = { ...updatedSession, sessionUrl: sessionUrlFor(updatedSession.id) }
          broadcast({ type: "planning_session_updated", payload: withUrl })
        },
      }).pipe(
        Effect.map(({ session }) => {
          const withUrl = { ...session, sessionUrl: sessionUrlFor(session.id) }
          broadcast({ type: "planning_session_created", payload: withUrl })
          return json(withUrl, 201)
        }),
        Effect.catchTag("PlanningSessionError", (error) =>
          Effect.fail(new HttpRouteError({
            message: `Failed to create planning session: ${error.message}`,
            code: ErrorCode.PLANNING_SESSION_CREATE_FAILED,
            status: 500,
            cause: error,
          }))),
      )
    }),
  )

  router.post("/api/planning/sessions/:id/messages", ({ params, req, json, db }) =>
    Effect.gen(function* () {
      const session = db.getWorkflowSession(params.id)
      if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
        return json(createApiError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION), 400)
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => internalRouteError(cause instanceof Error ? cause.message : String(cause), ErrorCode.INVALID_JSON_BODY, cause),
      })) as Record<string, unknown>
      const planningSession = ctx.planningSessionManager.getSession(params.id)

      if (!planningSession) {
        return json(createApiError("Planning session not active", ErrorCode.PLANNING_SESSION_NOT_ACTIVE), 400)
      }

      return yield* planningSession.sendMessage({
        content: body.content,
        contextAttachments: body.contextAttachments as ContextAttachment[] | undefined,
      }).pipe(
        Effect.as(json({ ok: true })),
        Effect.catchTag("PlanningSessionError", (error) =>
          Effect.fail(new HttpRouteError({
            message: `Failed to send message: ${error.message}`,
            code: ErrorCode.MESSAGE_SEND_FAILED,
            status: 500,
            cause: error,
          }))),
      )
    }),
  )

  router.post("/api/planning/sessions/:id/reconnect", ({ params, req, json, broadcast, sessionUrlFor, db }) =>
    Effect.gen(function* () {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
      return json(createApiError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION), 400)
    }

    // Check if already active
    const existingSession = ctx.planningSessionManager.getSession(params.id)
    if (existingSession?.isActive()) {
      return json({ ...session, sessionUrl: sessionUrlFor(session.id) })
    }

    const body = (yield* Effect.tryPromise({
      try: () => req.json() as Promise<Record<string, unknown>>,
      catch: (cause) => internalRouteError(cause instanceof Error ? cause.message : String(cause), ErrorCode.INVALID_JSON_BODY, cause),
    })) as Record<string, unknown>
    const planningPrompt = db.getPlanningPrompt("default")
    if (!planningPrompt) {
      return json(createApiError("Planning prompt not configured", ErrorCode.PLANNING_PROMPT_NOT_CONFIGURED), 500)
    }

    return yield* ctx.planningSessionManager.reconnectSession(params.id, {
        systemPrompt: planningPrompt.promptText,
        model: body.model ?? session.model ?? "default",
        thinkingLevel: body.thinkingLevel ?? session.thinkingLevel ?? "default",
        onMessage: (message: SessionMessage) => {
          broadcast({ type: "planning_session_message", payload: { sessionId: session.id, message } })
        },
        onStatusChange: (updatedSession) => {
          const withUrl = { ...updatedSession, sessionUrl: sessionUrlFor(updatedSession.id) }
          broadcast({ type: "planning_session_updated", payload: withUrl })
        },
      }).pipe(
        Effect.map((result) => {
          const withUrl = { ...result.session, sessionUrl: sessionUrlFor(result.session.id) }
          broadcast({ type: "planning_session_updated", payload: withUrl })
          return json(withUrl)
        }),
        Effect.catchTag("PlanningSessionError", (error) =>
          Effect.fail(new HttpRouteError({
            message: `Failed to reconnect to session: ${error.message}`,
            code: ErrorCode.PLANNING_SESSION_RECONNECT_FAILED,
            status: 500,
            cause: error,
          }))),
      )
    }),
  )

  router.post("/api/planning/sessions/:id/model", ({ params, req, json, broadcast, sessionUrlFor, db }) =>
    Effect.gen(function* () {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
      return json(createApiError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION), 400)
    }

    const body = (yield* Effect.tryPromise({
      try: () => req.json() as Promise<Record<string, unknown>>,
      catch: (cause) => internalRouteError(cause instanceof Error ? cause.message : String(cause), ErrorCode.INVALID_JSON_BODY, cause),
    })) as Record<string, unknown>

    if (body.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
      return json(
        createApiError("Invalid thinkingLevel. Allowed values: default, low, medium, high", ErrorCode.INVALID_THINKING_LEVEL),
        400,
      )
    }

    const planningSession = ctx.planningSessionManager.getSession(params.id)

    if (!planningSession || !planningSession.isActive()) {
      return json(createApiError("Planning session not active", ErrorCode.PLANNING_SESSION_NOT_ACTIVE), 400)
    }

    const setThinkingLevelEffect =
      body.thinkingLevel && body.thinkingLevel !== "default"
        ? planningSession.setThinkingLevel(body.thinkingLevel)
        : Effect.void

    return yield* Effect.gen(function* () {
        yield* planningSession.setModel(body.model)
        yield* setThinkingLevelEffect
        const updated = db.getWorkflowSession(params.id)
        const withUrl = updated ? { ...updated, sessionUrl: sessionUrlFor(updated.id) } : null
        if (withUrl) {
          broadcast({ type: "planning_session_updated", payload: withUrl })
        }
        return json({ ok: true, model: body.model, thinkingLevel: body.thinkingLevel })
      }).pipe(
        Effect.catchTag("PlanningSessionError", (error) =>
          Effect.fail(new HttpRouteError({
            message: `Failed to change model: ${error.message}`,
            code: ErrorCode.INVALID_MODEL,
            status: 500,
            cause: error,
          }))),
      )
    }),
  )

  router.post(
    "/api/planning/sessions/:id/create-tasks",
    ({ params, req, json, broadcast, sessionUrlFor, db }) =>
      Effect.gen(function* () {
      const session = db.getWorkflowSession(params.id)
      if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
        return json(createApiError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION), 400)
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => internalRouteError(cause instanceof Error ? cause.message : String(cause), ErrorCode.INVALID_JSON_BODY, cause),
      })) as Record<string, unknown>

      const serverPort = ctx.getPort()
      const planningSession = ctx.planningSessionManager.getSession(params.id)
      if (!planningSession) {
        return json(createApiError("Planning session not active", ErrorCode.PLANNING_SESSION_NOT_ACTIVE), 400)
      }

      const taskSetupPrompt = renderPromptTemplate(joinPrompt(PROMPT_CATALOG.taskSetupPromptLines), {
        server_port: String(serverPort),
      })

      return yield* Effect.gen(function* () {
          yield* planningSession.sendMessage({ content: taskSetupPrompt })

          const validatedTasks = yield* validateTasksPayload(body.tasks)
          if (validatedTasks.length > 0) {
            const createdTasks = []
            for (const taskData of validatedTasks) {
              const task = db.createTask({
                id: randomUUID().slice(0, 8),
                name: taskData.name,
                prompt: taskData.prompt,
                status: taskData.status,
                requirements: taskData.requirements,
              })
              createdTasks.push(normalizeTaskForClient(task, sessionUrlFor))
              broadcast({ type: "task_created", payload: normalizeTaskForClient(task, sessionUrlFor) })
            }
            return json({
              tasks: createdTasks,
              count: createdTasks.length,
              message:
                "Tasks created. The AI has also been instructed to review the conversation and create additional tasks if needed.",
            })
          }

          return json({
            message:
              "Task creation request sent to the AI. The agent will use the workflow-task-setup skill to analyze the conversation and create appropriate kanban tasks.",
          })
        }).pipe(
          Effect.catchTag("PlanningSessionError", (error) =>
            Effect.fail(new HttpRouteError({
              message: `Failed to create tasks: ${error.message}`,
              code: ErrorCode.MESSAGE_SEND_FAILED,
              status: 500,
              cause: error,
            }))),
          )
        }),
  )

    router.get("/api/planning/sessions/:id", ({ params, json, sessionUrlFor, db }) =>
      Effect.gen(function* () {
        const session = db.getWorkflowSession(params.id)
        if (!session) {
          return yield* Effect.fail(notFoundError("Session not found", ErrorCode.SESSION_NOT_FOUND))
        }
        if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
          return yield* Effect.fail(badRequestError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION))
        }
        return json({ ...session, sessionUrl: sessionUrlFor(session.id) })
      }),
    )

    router.patch("/api/planning/sessions/:id", ({ params, req, json, broadcast, sessionUrlFor, db }) =>
      Effect.gen(function* () {
        const session = db.getWorkflowSession(params.id)
        if (!session) {
          return yield* Effect.fail(notFoundError("Session not found", ErrorCode.SESSION_NOT_FOUND))
        }
        if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
          return yield* Effect.fail(badRequestError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION))
        }

        const body = (yield* Effect.tryPromise({
          try: () => req.json() as Promise<Record<string, unknown>>,
          catch: (cause) => badRequestError(
            cause instanceof Error ? cause.message : "Invalid JSON body",
            ErrorCode.INVALID_JSON_BODY,
            { cause },
          ),
        })) as Record<string, unknown>

        const updated = db.updateWorkflowSession(params.id, {
          status: body.status,
          errorMessage: body.errorMessage,
        })

        if (!updated) {
          return yield* Effect.fail(internalRouteError("Failed to update session", ErrorCode.EXECUTION_OPERATION_FAILED))
        }

        const withUrl = { ...updated, sessionUrl: sessionUrlFor(updated.id) }
        broadcast({ type: "planning_session_updated", payload: withUrl })
        return json(withUrl)
      }),
    )

    router.post("/api/planning/sessions/:id/close", ({ params, json, broadcast, db }) =>
      Effect.gen(function* () {
        const session = db.getWorkflowSession(params.id)
        if (!session) {
          return yield* Effect.fail(notFoundError("Session not found", ErrorCode.SESSION_NOT_FOUND))
        }
        if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
          return yield* Effect.fail(badRequestError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION))
        }

        return yield* ctx.planningSessionManager.closeSession(params.id).pipe(
          Effect.map(() => {
            const updated = db.updateWorkflowSession(params.id, {
              status: "completed",
              finishedAt: Math.floor(Date.now() / 1000),
            })

            if (!updated) {
              return json(createApiError("Failed to update session status", ErrorCode.EXECUTION_OPERATION_FAILED), 500)
            }

            broadcast({ type: "planning_session_closed", payload: { id: params.id } })
            return json(updated)
          }),
          Effect.catchTag("PlanningSessionError", (error) =>
            Effect.fail(new HttpRouteError({
              message: `Failed to close session: ${error.message}`,
              code: ErrorCode.PLANNING_SESSION_CLOSE_FAILED,
              status: 500,
              cause: error,
            }))),
        )
      }),
    )

  router.get("/api/planning/sessions/:id/messages", ({ params, url, json, db }) =>
    Effect.gen(function* () {
      const session = db.getWorkflowSession(params.id)
      if (!session) {
        return yield* Effect.fail(notFoundError("Session not found", ErrorCode.SESSION_NOT_FOUND))
      }
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
        return yield* Effect.fail(badRequestError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION))
      }

      const limit = Number(url.searchParams.get("limit") ?? 500)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      return json(db.getSessionMessages(params.id, { limit, offset }))
    }),
  )

    router.get("/api/planning/sessions/:id/timeline", ({ params, json, db }) =>
    Effect.gen(function* () {
      const session = db.getWorkflowSession(params.id)
      if (!session) {
        return yield* Effect.fail(notFoundError("Session not found", ErrorCode.SESSION_NOT_FOUND))
      }
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
        return yield* Effect.fail(badRequestError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION))
      }

      return json(db.getSessionTimelineEntries(params.id))
    }),
  )

  // Rename session endpoint
  router.put("/api/planning/sessions/:id/name", ({ params, req, json, broadcast, sessionUrlFor, db }) =>
    Effect.gen(function* () {
      const session = db.getWorkflowSession(params.id)
      if (!session) {
        return yield* Effect.fail(notFoundError("Session not found", ErrorCode.SESSION_NOT_FOUND))
      }
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
        return yield* Effect.fail(badRequestError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION))
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<{ name?: string }>,
        catch: (cause) => badRequestError(
          cause instanceof Error ? cause.message : "Invalid JSON body",
          ErrorCode.INVALID_JSON_BODY,
          { cause },
        ),
      })) as Record<string, unknown>

      if (!body.name || typeof body.name !== "string" || body.name.trim() === "") {
        return yield* Effect.fail(badRequestError("Name is required and must be a non-empty string", ErrorCode.INVALID_REQUEST_BODY))
      }

      const updated = db.updateWorkflowSession(params.id, {
        name: body.name.trim(),
      })

      if (!updated) {
        return yield* Effect.fail(internalRouteError("Failed to update session name", ErrorCode.EXECUTION_OPERATION_FAILED))
      }

      const withUrl = { ...updated, sessionUrl: sessionUrlFor(updated.id) }
      broadcast({ type: "planning_session_updated", payload: withUrl })
      return json(withUrl)
    }),
  )
}
