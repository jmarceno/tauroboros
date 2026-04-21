import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { isTaskGroupStatus, isValidHexColor, validateTaskGroupName, validateTaskIds } from "../../db.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import { badRequestError, conflictError, internalRouteError } from "../route-interpreter.ts"
import { normalizeTaskForClient } from "../validators.ts"

export function registerTaskGroupRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/task-groups", ({ json, db }) => Effect.sync(() => json(db.getTaskGroups())))

  router.post("/api/task-groups", ({ req, json, broadcast, db }) =>
    Effect.tryPromise({
      try: async () => {
        const body = await req.json()

        const nameValidation = validateTaskGroupName(body?.name)
        if (!nameValidation.valid) return json(createApiError(nameValidation.error ?? "name is invalid", ErrorCode.INVALID_REQUEST_BODY), 400)

        if (body?.color !== undefined && !isValidHexColor(body.color)) {
          return json(createApiError("color must be a valid hex color (e.g., #888888)", ErrorCode.INVALID_COLOR), 400)
        }

        if (body?.status !== undefined && !isTaskGroupStatus(body.status)) {
          return json(createApiError("status must be active, completed, or archived", ErrorCode.INVALID_TASK_GROUP_STATUS), 400)
        }

        let memberTaskIds: string[] = []
        if (body?.taskIds !== undefined) {
          const taskValidation = validateTaskIds(body.taskIds, db)
          if (!taskValidation.valid) return json(createApiError(taskValidation.error ?? "taskIds are invalid", ErrorCode.INVALID_REQUEST_BODY), 400)
          memberTaskIds = body.taskIds as string[]
        }

        const group = db.createTaskGroup({
          name: String(body.name).trim(),
          color: body.color,
          status: body.status,
          memberTaskIds,
        })
        broadcast({ type: "task_group_created", payload: group })
        return json(group, 201)
      },
      catch: (error) => conflictError(error instanceof Error ? error.message : String(error), ErrorCode.TASK_GROUP_NOT_FOUND),
    }),
  )

  router.get("/api/task-groups/:id", ({ params, json, sessionUrlFor, db }) =>
    Effect.sync(() => {
      const group = db.getTaskGroup(params.id)
      if (!group) return json(createApiError("Task group not found", ErrorCode.TASK_GROUP_NOT_FOUND), 404)

      const tasks = group.taskIds
        .map((taskId) => {
          const task = db.getTask(taskId)
          return task ? normalizeTaskForClient(task, sessionUrlFor) : null
        })
        .filter(Boolean)

      return json({ ...group, tasks })
    }),
  )

  router.patch("/api/task-groups/:id", ({ params, req, json, broadcast, db }) =>
    Effect.tryPromise({
      try: async () => {
        const existing = db.getTaskGroup(params.id)
        if (!existing) return json(createApiError("Task group not found", ErrorCode.TASK_GROUP_NOT_FOUND), 404)

        const body = await req.json()

        if (body?.name !== undefined) {
          const nameValidation = validateTaskGroupName(body.name)
          if (!nameValidation.valid) return json(createApiError(nameValidation.error ?? "name is invalid", ErrorCode.INVALID_REQUEST_BODY), 400)
        }

        if (body?.color !== undefined && !isValidHexColor(body.color)) {
          return json(createApiError("color must be a valid hex color (e.g., #888888)", ErrorCode.INVALID_COLOR), 400)
        }

        if (body?.status !== undefined && !isTaskGroupStatus(body.status)) {
          return json(createApiError("status must be active, completed, or archived", ErrorCode.INVALID_TASK_GROUP_STATUS), 400)
        }

        const updated = db.updateTaskGroup(params.id, {
          name: body?.name !== undefined ? String(body.name).trim() : undefined,
          color: body?.color,
          status: body?.status,
          completedAt: body?.status === "completed" ? Math.floor(Date.now() / 1000) : undefined,
        })
        if (!updated) {
          return json(createApiError("Failed to update task group", ErrorCode.CONTAINER_OPERATION_FAILED), 500)
        }
        broadcast({ type: "task_group_updated", payload: updated })
        return json(updated)
      },
      catch: (error) => internalRouteError(error instanceof Error ? error.message : String(error), ErrorCode.CONTAINER_OPERATION_FAILED, error),
    }),
  )

  router.delete("/api/task-groups/:id", ({ params, json, broadcast, db }) =>
    Effect.sync(() => {
      const group = db.getTaskGroup(params.id)
      if (!group) return json(createApiError("Task group not found", ErrorCode.TASK_GROUP_NOT_FOUND), 404)

      const success = db.deleteTaskGroup(params.id)
      if (!success) return json(createApiError("Failed to delete task group", ErrorCode.CONTAINER_OPERATION_FAILED), 500)

      broadcast({ type: "task_group_deleted", payload: { id: params.id } })
      return new Response(null, { status: 204 })
    }),
  )

  router.post("/api/task-groups/:id/tasks", ({ params, req, json, broadcast, db }) =>
    Effect.tryPromise({
      try: async () => {
        const group = db.getTaskGroup(params.id)
        if (!group) return json(createApiError("Task group not found", ErrorCode.TASK_GROUP_NOT_FOUND), 404)

        const body = await req.json()

        if (!body?.taskIds || !Array.isArray(body.taskIds)) {
          return json(createApiError("taskIds array is required", ErrorCode.INVALID_REQUEST_BODY), 400)
        }

        const taskValidation = validateTaskIds(body.taskIds, db)
        if (!taskValidation.valid) return json(createApiError(taskValidation.error ?? "taskIds are invalid", ErrorCode.INVALID_REQUEST_BODY), 400)

        const addedCount = db.addTasksToGroup(params.id, body.taskIds)
        const updated = db.getTaskGroup(params.id)
        broadcast({
          type: "task_group_members_added",
          payload: { groupId: params.id, taskIds: body.taskIds, addedCount },
        })
        return json(updated)
      },
      catch: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes("already in another group")
          ? conflictError(message, ErrorCode.CONTAINER_OPERATION_FAILED)
          : internalRouteError(message, ErrorCode.CONTAINER_OPERATION_FAILED, error)
      },
    }),
  )

  router.delete("/api/task-groups/:id/tasks", ({ params, req, json, broadcast, db }) =>
    Effect.tryPromise({
      try: async () => {
        const group = db.getTaskGroup(params.id)
        if (!group) return json(createApiError("Task group not found", ErrorCode.TASK_GROUP_NOT_FOUND), 404)

        const body = await req.json()

        if (!body?.taskIds || !Array.isArray(body.taskIds)) {
          return json(createApiError("taskIds array is required", ErrorCode.INVALID_REQUEST_BODY), 400)
        }

        const removedCount = db.removeTasksFromGroup(params.id, body.taskIds)
        const updated = db.getTaskGroup(params.id)
        broadcast({
          type: "task_group_members_removed",
          payload: { groupId: params.id, taskIds: body.taskIds, removedCount },
        })
        return json(updated)
      },
      catch: (error) => internalRouteError(error instanceof Error ? error.message : String(error), ErrorCode.CONTAINER_OPERATION_FAILED, error),
    }),
  )

  router.post("/api/task-groups/:id/start", ({ params, json, broadcast, db }) =>
    Effect.gen(function* () {
      const group = db.getTaskGroup(params.id)
      if (!group) return json(createApiError("Task group not found", ErrorCode.TASK_GROUP_NOT_FOUND), 404)

      if (group.taskIds.length === 0) {
        return json(createApiError("Cannot start group with no tasks", ErrorCode.INVALID_REQUEST_BODY), 400)
      }

      if (db.hasRunningWorkflows()) {
        return json(createApiError("A workflow is already running. Stop it first.", ErrorCode.EXECUTION_OPERATION_FAILED), 409)
      }

      const tasks = group.taskIds.map((id) => db.getTask(id)).filter(Boolean)
      const nonBacklogTasks = tasks.filter((t) => t!.status !== "backlog" && t!.status !== "template")
      if (nonBacklogTasks.length > 0) {
        return json(
          createApiError("Some tasks are not in backlog status", ErrorCode.EXECUTION_OPERATION_FAILED, {
            tasks: nonBacklogTasks.map((t) => ({ id: t!.id, name: t!.name, status: t!.status })),
          }),
          409,
        )
      }

      if (!ctx.onStartGroup) {
        return json(createApiError("Group execution handler not available", ErrorCode.SERVICE_UNAVAILABLE), 503)
      }

      return yield* ctx.onStartGroup(params.id).pipe(
        Effect.catchAll((err) => {
          const error = err instanceof Error ? err : new Error(String(err))
          const message = error.message
          if (
            message.includes("external dependencies") ||
            message.includes("blocked") ||
            message.includes("invalid container images") ||
            message.includes("container image") ||
            message.includes("Already executing")
          ) {
            return Effect.fail(conflictError(message, ErrorCode.EXECUTION_OPERATION_FAILED))
          }
          if (message.includes("not found")) {
            return Effect.fail(badRequestError(message, ErrorCode.TASK_GROUP_NOT_FOUND))
          }
          const operation = "operation" in (err as object) && typeof (err as { operation?: unknown }).operation === "string"
            ? (err as { operation: string }).operation
            : null
          if (operation) {
            return Effect.fail(internalRouteError(`Group execution unavailable: ${operation}`, ErrorCode.SERVICE_UNAVAILABLE, err))
          }
          return Effect.fail(internalRouteError(message, ErrorCode.EXECUTION_OPERATION_FAILED, err))
        }),
        Effect.map((run) => {
          broadcast({ type: "run_created", payload: run })
          broadcast({
            type: "group_execution_started",
            payload: { groupId: params.id, taskIds: group.taskIds, startedAt: Date.now() },
          })
          broadcast({ type: "execution_started", payload: {} })
          return json(run)
        }),
      )
    }),
  )

  router.get("/api/tasks/:id/group", ({ params, json, db }) =>
    Effect.sync(() => {
      if (!db.getTask(params.id)) {
        return json(createApiError("Task not found", ErrorCode.TASK_NOT_FOUND), 404)
      }

      const membership = db.getTaskGroupMembership(params.id)

      if (!membership.groupId) {
        return json({ groupId: null, group: null })
      }

      return json(membership)
    }),
  )
}
