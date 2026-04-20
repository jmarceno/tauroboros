import { randomUUID } from "crypto"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import { PROMPT_CATALOG, joinPrompt, renderPromptTemplate } from "../../prompts/catalog.ts"
import type { SessionMessage } from "../../types.ts"
import type { Task } from "../../types.ts"
import type { ContextAttachment } from "../../runtime/planning-session.ts"
import { isThinkingLevel, normalizeTaskForClient } from "../validators.ts"

export function registerPlanningRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/planning/prompt", ({ json, db }) => {
    const prompt = db.getPlanningPrompt("default")
    if (!prompt) return json({ error: "Planning prompt not found" }, 404)
    return json(prompt)
  })

  router.get("/api/planning/prompts", ({ json, db }) => {
    return json(db.getAllPlanningPrompts())
  })

  router.put("/api/planning/prompt", async ({ req, json, broadcast, db }) => {
    const body = await req.json()
    const existing = db.getPlanningPrompt(body.key ?? "default")
    if (!existing) return json({ error: "Planning prompt not found" }, 404)

    const updated = db.updatePlanningPrompt(existing.id, {
      name: body.name,
      description: body.description,
      promptText: body.promptText,
      isActive: body.isActive,
    })

    broadcast({ type: "planning_prompt_updated", payload: updated })
    return json(updated)
  })

  router.get("/api/planning/prompt/:key/versions", ({ params, json, db }) => {
    return json(db.getPlanningPromptVersions(params.key))
  })

  router.get("/api/planning/sessions", ({ json, sessionUrlFor, db }) => {
    const sessions = db.getPlanningSessions()
    return json(sessions.map((s) => ({ ...s, sessionUrl: sessionUrlFor(s.id) })))
  })

  router.get("/api/planning/sessions/active", ({ json, sessionUrlFor, db }) => {
    const sessions = db.getActivePlanningSessions()
    return json(sessions.map((s) => ({ ...s, sessionUrl: sessionUrlFor(s.id) })))
  })

  router.post("/api/planning/sessions", async ({ req, json, broadcast, sessionUrlFor, db }) => {
    const body = await req.json()
    const sessionKind = body.sessionKind ?? "planning"
    const promptKey = sessionKind === "container_config" ? "container_config" : "default"
    const planningPrompt = db.getPlanningPrompt(promptKey)
    if (!planningPrompt) {
      return json(createApiError("Planning prompt not configured", ErrorCode.PLANNING_PROMPT_NOT_CONFIGURED), 500)
    }

    try {
      const { session } = await ctx.planningSessionManager.createSession({
        cwd: body.cwd ?? process.cwd(),
        systemPrompt: planningPrompt.promptText,
        model: body.model ?? "default",
        thinkingLevel: body.thinkingLevel ?? "default",
        sessionKind,
        onMessage: (message: SessionMessage) => {
          broadcast({ type: "planning_session_message", payload: { sessionId: session.id, message } })
        },
        onStatusChange: (updatedSession) => {
          const withUrl = { ...updatedSession, sessionUrl: sessionUrlFor(updatedSession.id) }
          broadcast({ type: "planning_session_updated", payload: withUrl })
        },
      })

      const withUrl = { ...session, sessionUrl: sessionUrlFor(session.id) }
      broadcast({ type: "planning_session_created", payload: withUrl })
      return json(withUrl, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: `Failed to create planning session: ${message}` }, 500)
    }
  })

  router.post("/api/planning/sessions/:id/messages", async ({ params, req, json, db }) => {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
      return json(createApiError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION), 400)
    }

    const body = await req.json()
    const planningSession = ctx.planningSessionManager.getSession(params.id)

    if (!planningSession) {
      return json(createApiError("Planning session not active", ErrorCode.PLANNING_SESSION_NOT_ACTIVE), 400)
    }

    try {
      await planningSession.sendMessage({
        content: body.content,
        contextAttachments: body.contextAttachments as ContextAttachment[] | undefined,
      })

      return json({ ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(createApiError(`Failed to send message: ${message}`, ErrorCode.MESSAGE_SEND_FAILED), 500)
    }
  })

  router.post("/api/planning/sessions/:id/reconnect", async ({ params, req, json, broadcast, sessionUrlFor, db }) => {
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

    const body = await req.json()
    const planningPrompt = db.getPlanningPrompt("default")
    if (!planningPrompt) {
      return json(createApiError("Planning prompt not configured", ErrorCode.PLANNING_PROMPT_NOT_CONFIGURED), 500)
    }

    try {
      const result = await ctx.planningSessionManager.reconnectSession(params.id, {
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
      })

      if (!result) {
        return json(createApiError("Failed to reconnect to session", ErrorCode.PLANNING_SESSION_RECONNECT_FAILED), 500)
      }

      const withUrl = { ...result.session, sessionUrl: sessionUrlFor(result.session.id) }
      broadcast({ type: "planning_session_updated", payload: withUrl })
      return json(withUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(
        createApiError(`Failed to reconnect to session: ${message}`, ErrorCode.PLANNING_SESSION_RECONNECT_FAILED),
        500,
      )
    }
  })

  router.post("/api/planning/sessions/:id/model", async ({ params, req, json, broadcast, sessionUrlFor, db }) => {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
      return json(createApiError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION), 400)
    }

    const body = await req.json()

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

    try {
      await planningSession.setModel(body.model)

      if (body.thinkingLevel && body.thinkingLevel !== "default") {
        await planningSession.setThinkingLevel(body.thinkingLevel)
      }

      const updated = db.getWorkflowSession(params.id)
      const withUrl = updated ? { ...updated, sessionUrl: sessionUrlFor(updated.id) } : null
      if (withUrl) {
        broadcast({ type: "planning_session_updated", payload: withUrl })
      }
      return json({ ok: true, model: body.model, thinkingLevel: body.thinkingLevel })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(createApiError(`Failed to change model: ${message}`, ErrorCode.INVALID_MODEL), 500)
    }
  })

  router.post(
    "/api/planning/sessions/:id/create-tasks",
    async ({ params, req, json, broadcast, sessionUrlFor, db }) => {
      const session = db.getWorkflowSession(params.id)
      if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") {
        return json(createApiError("Not a planning session", ErrorCode.NOT_A_PLANNING_SESSION), 400)
      }

      const body = await req.json()

      try {
        const serverPort = ctx.getPort()
        const planningSession = ctx.planningSessionManager.getSession(params.id)
        if (!planningSession) {
          return json({ error: "Planning session not active" }, 400)
        }

        const taskSetupPrompt = renderPromptTemplate(joinPrompt(PROMPT_CATALOG.taskSetupPromptLines), {
          server_port: String(serverPort),
        })

        await planningSession.sendMessage({ content: taskSetupPrompt })

        const tasks = body.tasks as
          | Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>
          | undefined

        if (tasks && tasks.length > 0) {
          const createdTasks = []
          for (const taskData of tasks) {
            if (!taskData.name) {
              throw new Error("Task data missing required field: name")
            }
            if (!taskData.prompt) {
              throw new Error("Task data missing required field: prompt")
            }
            const taskStatus = taskData.status as Task["status"]
            if (!taskStatus) {
              throw new Error("Task data missing required field: status")
            }
            if (!Array.isArray(taskData.requirements)) {
              throw new Error("Task data missing or invalid field: requirements (must be an array)")
            }
            const task = db.createTask({
              id: randomUUID().slice(0, 8),
              name: taskData.name,
              prompt: taskData.prompt,
              status: taskStatus,
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to create tasks: ${message}` }, 500)
      }
    },
  )

  router.get("/api/planning/sessions/:id", ({ params, json, sessionUrlFor, db }) => {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json({ error: "Session not found" }, 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config")
      return json({ error: "Not a planning session" }, 400)
    return json({ ...session, sessionUrl: sessionUrlFor(session.id) })
  })

  router.patch("/api/planning/sessions/:id", async ({ params, req, json, broadcast, sessionUrlFor, db }) => {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json({ error: "Session not found" }, 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config")
      return json({ error: "Not a planning session" }, 400)

    const body = await req.json()
    const updated = db.updateWorkflowSession(params.id, {
      status: body.status,
      errorMessage: body.errorMessage,
    })

    const withUrl = { ...updated!, sessionUrl: sessionUrlFor(updated!.id) }
    broadcast({ type: "planning_session_updated", payload: withUrl })
    return json(withUrl)
  })

  router.post("/api/planning/sessions/:id/close", async ({ params, json, broadcast, db }) => {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json({ error: "Session not found" }, 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config")
      return json({ error: "Not a planning session" }, 400)

    await ctx.planningSessionManager.closeSession(params.id)

    const updated = db.updateWorkflowSession(params.id, {
      status: "completed",
      finishedAt: Math.floor(Date.now() / 1000),
    })

    broadcast({ type: "planning_session_closed", payload: { id: params.id } })
    return json(updated)
  })

  router.get("/api/planning/sessions/:id/messages", ({ params, url, json, db }) => {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json({ error: "Session not found" }, 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config")
      return json({ error: "Not a planning session" }, 400)

    const limit = Number(url.searchParams.get("limit") ?? 500)
    const offset = Number(url.searchParams.get("offset") ?? 0)
    return json(db.getSessionMessages(params.id, { limit, offset }))
  })

  router.get("/api/planning/sessions/:id/timeline", ({ params, json, db }) => {
    const session = db.getWorkflowSession(params.id)
    if (!session) return json({ error: "Session not found" }, 404)
    if (session.sessionKind !== "planning" && session.sessionKind !== "container_config")
      return json({ error: "Not a planning session" }, 400)

    return json(db.getSessionTimelineEntries(params.id))
  })
}
