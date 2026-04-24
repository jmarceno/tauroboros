import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import type { MessageRole, MessageType } from "../../types.ts"
import type { PiSessionStatus } from "../../db/types.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import { HttpRouteError, badRequestError, internalRouteError } from "../route-interpreter.ts"

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
    Effect.gen(function* () {
      const session = db.getWorkflowSession(params.id)
      if (!session) {
        return json(createApiError("Session not found", ErrorCode.SESSION_NOT_FOUND), 404)
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => badRequestError(
          cause instanceof Error ? cause.message : "Invalid JSON body",
          ErrorCode.INVALID_JSON_BODY,
          { cause },
        ),
      })) as Record<string, unknown>
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
        const eventMessage = (body?.message ?? {}) as Record<string, unknown>
        const usage = (eventMessage.usage ?? body?.usage ?? {}) as Record<string, unknown>
        const cost = (usage.cost ?? {}) as Record<string, unknown>

        const message = db.createSessionMessage({
          sessionId: session.id,
          taskId: session.taskId,
          taskRunId: session.taskRunId,
          role: (body?.role ?? eventMessage.role ?? "assistant") as MessageRole,
          eventName: (body?.eventName ?? body?.type ?? null) as string | null,
          messageType: (body?.messageType ?? "text") as MessageType,
          contentJson: (body?.contentJson ?? { text: String(body?.text ?? "") }) as Record<string, unknown>,
          modelProvider: (body?.modelProvider ?? eventMessage.provider ?? null) as string | null,
          modelId: (body?.modelId ?? eventMessage.model ?? null) as string | null,
          agentName: (body?.agentName ?? null) as string | null,
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
          status: (body?.status as PiSessionStatus | undefined) ?? session.status,
          errorMessage: (body?.errorMessage as string | undefined) ?? session.errorMessage,
        })
        broadcast({ type: "session_status_changed", payload: updated ?? session })
        return json({ ok: true })
      }

      if (eventType === "complete") {
        const updated = db.updateWorkflowSession(session.id, {
          status: (body?.status as PiSessionStatus | undefined) ?? "completed",
          finishedAt: Math.floor(Date.now() / 1000),
          exitCode: (body?.exitCode as number | null | undefined) ?? null,
          exitSignal: (body?.exitSignal as string | null | undefined) ?? null,
          errorMessage: (body?.errorMessage as string | null | undefined) ?? null,
        })
        broadcast({ type: "session_completed", payload: updated ?? session })
        return json({ ok: true })
      }

      // Unsupported event type - use shared route interpreter
      return yield* badRequestError(
        `Unsupported event type: ${eventType}`,
        ErrorCode.UNSUPPORTED_EVENT_TYPE,
        { eventType },
      )
    }),
  )
}
