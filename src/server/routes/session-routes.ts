import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import { internalRouteError } from "../route-interpreter.ts"

export function registerSessionRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/sessions/:id", ({ params, json, db }) =>
    Effect.sync(() => {
      const session = db.getWorkflowSession(params.id)
      if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
      return json(session)
    }),
  )

  router.get("/api/sessions/:id/messages", ({ params, url, json, db }) =>
    Effect.sync(() => {
      const session = db.getWorkflowSession(params.id)
      if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)

      const limit = Number(url.searchParams.get("limit") ?? 500)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      return json(db.getSessionMessages(params.id, { limit, offset }))
    }),
  )

  router.get("/api/sessions/:id/timeline", ({ params, json, db }) =>
    Effect.sync(() => {
      const session = db.getWorkflowSession(params.id)
      if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
      return json(db.getSessionTimelineEntries(params.id))
    }),
  )

  router.get("/api/sessions/:id/usage", ({ params, json, db }) =>
    Effect.sync(() => {
      const session = db.getWorkflowSession(params.id)
      if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
      return json(db.getSessionUsageRollup(params.id))
    }),
  )

  router.get("/api/tasks/:id/messages", ({ params, json, db }) =>
    Effect.sync(() => json(db.getSessionMessageViewsByTask(params.id))),
  )
  router.get("/api/task-runs/:id/messages", ({ params, json, db }) =>
    Effect.sync(() => json(db.getSessionMessageViewsByTaskRun(params.id))),
  )

  router.get("/api/tasks/:id/last-update", ({ params, json, db }) =>
    Effect.sync(() => {
      const task = db.getTask(params.id)
      if (!task) return json(createApiError("Task not found", ErrorCode.TASK_NOT_FOUND), 404)
      const lastUpdateAt = db.getTaskLastMessageTimestamp(params.id)
      return json({ taskId: params.id, lastUpdateAt })
    }),
  )

  router.post("/api/pi/sessions/:id/events", ({ params, req, json, broadcast, db, sessionUrlFor }) =>
    Effect.tryPromise({
      try: async () => {
        const session = db.getWorkflowSession(params.id)
        if (!session) return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)

        const body = await req.json()
        const eventType = String(body?.type ?? "")

        if (eventType === "start") {
          const updated = db.updateWorkflowSession(session.id, {
            status: "active",
            processPid: typeof body?.processPid === "number" ? body.processPid : session.processPid,
            piSessionId: typeof body?.piSessionId === "string" ? body.piSessionId : session.piSessionId,
            piSessionFile: typeof body?.piSessionFile === "string" ? body.piSessionFile : session.piSessionFile,
          })
          if (updated?.taskId) {
            db.updateTask(updated.taskId, {
              sessionId: updated.id,
              sessionUrl: sessionUrlFor(updated.id),
            })
          }
          broadcast({ type: "session_started", payload: updated ?? session })
          return json({ ok: true })
        }

        if (eventType === "message") {
          const eventMessage = body?.message ?? {}
          const usage = eventMessage.usage ?? body?.usage ?? {}
          const cost = usage.cost ?? {}

          const message = db.createSessionMessage({
            sessionId: session.id,
            taskId: session.taskId,
            taskRunId: session.taskRunId,
            role: body?.role ?? eventMessage.role ?? "assistant",
            eventName: body?.eventName ?? body?.type ?? null,
            messageType: body?.messageType ?? "text",
            contentJson: body?.contentJson ?? { text: String(body?.text ?? "") },
            modelProvider: body?.modelProvider ?? eventMessage.provider ?? null,
            modelId: body?.modelId ?? eventMessage.model ?? null,
            agentName: body?.agentName ?? null,
            promptTokens: typeof usage.input === "number" ? usage.input : null,
            completionTokens: typeof usage.output === "number" ? usage.output : null,
            cacheReadTokens: typeof usage.cacheRead === "number" ? usage.cacheRead : null,
            cacheWriteTokens: typeof usage.cacheWrite === "number" ? usage.cacheWrite : null,
            totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : null,
            costJson: Object.keys(cost).length > 0 ? cost : null,
            costTotal: typeof cost.total === "number" ? cost.total : null,
            rawEventJson: body,
          })
          broadcast({ type: "session_message_created", payload: message })
          return json({ ok: true, message })
        }

        if (eventType === "status") {
          const updated = db.updateWorkflowSession(session.id, {
            status: body?.status ?? session.status,
            errorMessage: body?.errorMessage ?? session.errorMessage,
          })
          broadcast({ type: "session_status_changed", payload: updated ?? session })
          return json({ ok: true })
        }

        if (eventType === "complete") {
          const updated = db.updateWorkflowSession(session.id, {
            status: body?.status ?? "completed",
            finishedAt: Math.floor(Date.now() / 1000),
            exitCode: body?.exitCode ?? null,
            exitSignal: body?.exitSignal ?? null,
            errorMessage: body?.errorMessage ?? null,
          })
          broadcast({ type: "session_completed", payload: updated ?? session })
          return json({ ok: true })
        }

        return json(createApiError("Unsupported event type", ErrorCode.UNSUPPORTED_EVENT_TYPE), 400)
      },
      catch: (cause) =>
        internalRouteError(
          cause instanceof Error ? cause.message : String(cause),
          ErrorCode.INTERNAL_SERVER_ERROR,
          cause,
        ),
    }),
  )
}
