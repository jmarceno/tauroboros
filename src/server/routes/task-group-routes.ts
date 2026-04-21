import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { isTaskGroupStatus, isValidHexColor, validateTaskGroupName, validateTaskIds } from "../../db.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"
import { HttpRouteError, badRequestError, conflictError, internalRouteError, notFoundError } from "../route-interpreter.ts"
import { normalizeTaskForClient } from "../validators.ts"

export function registerTaskGroupRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/task-groups", ({ json, db }) => Effect.sync(() => json(db.getTaskGroups())))

  router.post("/api/task-groups", ({ req, json, broadcast, db }) =>
    Effect.gen(function* () {
      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => badRequestError(
          cause instanceof Error ? cause.message : "Invalid JSON body",
          ErrorCode.INVALID_JSON_BODY,
          { cause },
        ),
      })) as Record<string, unknown>

      const nameValidation = validateTaskGroupName(body?.name)
      if (!nameValidation.valid) {
        return yield* Effect.fail(badRequestError(
          nameValidation.error ?? "name is invalid",
          ErrorCode.INVALID_REQUEST_BODY,
        ))
      }

      if (body?.color !== undefined && !isValidHexColor(body.color)) {
        return yield* Effect.fail(badRequestError(
          "color must be a valid hex color (e.g., #888888)",
          ErrorCode.INVALID_COLOR,
        ))
      }

      if (body?.status !== undefined && !isTaskGroupStatus(body.status)) {
        return yield* Effect.fail(badRequestError(
          "status must be active, completed, or archived",
          ErrorCode.INVALID_TASK_GROUP_STATUS,
        ))
      }

      let memberTaskIds: string[] = []
      if (body?.taskIds !== undefined) {
        const taskValidation = validateTaskIds(body.taskIds, db)
        if (!taskValidation.valid) {
          return yield* Effect.fail(badRequestError(
            taskValidation.error ?? "taskIds are invalid",
            ErrorCode.INVALID_REQUEST_BODY,
          ))
        }
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
    }),
  )

  router.get("/api/task-groups/:id", ({ params, json, sessionUrlFor, db }) =>
    Effect.gen(function* () {
      const group = db.getTaskGroup(params.id)
      if (!group) {
        return yield* Effect.fail(notFoundError(
          "Task group not found",
          ErrorCode.TASK_GROUP_NOT_FOUND,
        ))
      }

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
    Effect.gen(function* () {
      const existing = db.getTaskGroup(params.id)
      if (!existing) {
        return yield* Effect.fail(notFoundError(
          "Task group not found",
          ErrorCode.TASK_GROUP_NOT_FOUND,
        ))
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => badRequestError(
          cause instanceof Error ? cause.message : "Invalid JSON body",
          ErrorCode.INVALID_JSON_BODY,
          { cause },
        ),
      })) as Record<string, unknown>

      if (body?.name !== undefined) {
        const nameValidation = validateTaskGroupName(body.name)
        if (!nameValidation.valid) {
          return yield* Effect.fail(badRequestError(
            nameValidation.error ?? "name is invalid",
            ErrorCode.INVALID_REQUEST_BODY,
          ))
        }
      }

      if (body?.color !== undefined && !isValidHexColor(body.color)) {
        return yield* Effect.fail(badRequestError(
          "color must be a valid hex color (e.g., #888888)",
          ErrorCode.INVALID_COLOR,
        ))
      }

      if (body?.status !== undefined && !isTaskGroupStatus(body.status)) {
        return yield* Effect.fail(badRequestError(
          "status must be active, completed, or archived",
          ErrorCode.INVALID_TASK_GROUP_STATUS,
        ))
      }

      const updated = db.updateTaskGroup(params.id, {
        name: body?.name !== undefined ? String(body.name).trim() : undefined,
        color: body?.color,
        status: body?.status,
        completedAt: body?.status === "completed" ? Math.floor(Date.now() / 1000) : undefined,
      })
      if (!updated) {
        return yield* Effect.fail(internalRouteError(
          "Failed to update task group",
          ErrorCode.CONTAINER_OPERATION_FAILED,
        ))
      }
      broadcast({ type: "task_group_updated", payload: updated })
      return json(updated)
    }),
  )

  router.delete("/api/task-groups/:id", ({ params, json, broadcast, db }) =>
    Effect.gen(function* () {
      const group = db.getTaskGroup(params.id)
      if (!group) {
        return yield* Effect.fail(notFoundError(
          "Task group not found",
          ErrorCode.TASK_GROUP_NOT_FOUND,
        ))
      }

      const success = db.deleteTaskGroup(params.id)
      if (!success) {
        return yield* Effect.fail(internalRouteError(
          "Failed to delete task group",
          ErrorCode.CONTAINER_OPERATION_FAILED,
        ))
      }

      broadcast({ type: "task_group_deleted", payload: { id: params.id } })
      return new Response(null, { status: 204 })
    }),
  )

  router.post("/api/task-groups/:id/tasks", ({ params, req, json, broadcast, db }) =>
    Effect.gen(function* () {
      const group = db.getTaskGroup(params.id)
      if (!group) {
        return yield* Effect.fail(notFoundError(
          "Task group not found",
          ErrorCode.TASK_GROUP_NOT_FOUND,
        ))
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => badRequestError(
          cause instanceof Error ? cause.message : "Invalid JSON body",
          ErrorCode.INVALID_JSON_BODY,
          { cause },
        ),
      })) as Record<string, unknown>

      if (!body?.taskIds || !Array.isArray(body.taskIds)) {
        return yield* Effect.fail(badRequestError(
          "taskIds array is required",
          ErrorCode.INVALID_REQUEST_BODY,
        ))
      }

      const taskValidation = validateTaskIds(body.taskIds, db)
      if (!taskValidation.valid) {
        return yield* Effect.fail(badRequestError(
          taskValidation.error ?? "taskIds are invalid",
          ErrorCode.INVALID_REQUEST_BODY,
        ))
      }

      const result = yield* Effect.try({
        try: () => {
          const addedCount = db.addTasksToGroup(params.id, body.taskIds)
          const updated = db.getTaskGroup(params.id)
          broadcast({
            type: "task_group_members_added",
            payload: { groupId: params.id, taskIds: body.taskIds, addedCount },
          })
          return updated
        },
        catch: (cause) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (message.includes("already in another group")) {
            return new HttpRouteError({
              message,
              code: ErrorCode.CONTAINER_OPERATION_FAILED,
              status: 409,
            })
          }
          return new HttpRouteError({
            message,
            code: ErrorCode.CONTAINER_OPERATION_FAILED,
            status: 500,
            cause,
          })
        },
      })

      if (result instanceof HttpRouteError) {
        return yield* Effect.fail(result)
      }

      return json(result)
    }),
  )

  router.delete("/api/task-groups/:id/tasks", ({ params, req, json, broadcast, db }) =>
    Effect.gen(function* () {
      const group = db.getTaskGroup(params.id)
      if (!group) {
        return yield* Effect.fail(notFoundError(
          "Task group not found",
          ErrorCode.TASK_GROUP_NOT_FOUND,
        ))
      }

      const body = (yield* Effect.tryPromise({
        try: () => req.json() as Promise<Record<string, unknown>>,
        catch: (cause) => badRequestError(
          cause instanceof Error ? cause.message : "Invalid JSON body",
          ErrorCode.INVALID_JSON_BODY,
          { cause },
        ),
      })) as Record<string, unknown>

      if (!body?.taskIds || !Array.isArray(body.taskIds)) {
        return yield* Effect.fail(badRequestError(
          "taskIds array is required",
          ErrorCode.INVALID_REQUEST_BODY,
        ))
      }

      const removedCount = db.removeTasksFromGroup(params.id, body.taskIds)
      const updated = db.getTaskGroup(params.id)
      broadcast({
        type: "task_group_members_removed",
        payload: { groupId: params.id, taskIds: body.taskIds, removedCount },
      })
      return json(updated)
    }),
  )

  router.post("/api/task-groups/:id/start", ({ params, json, broadcast, db }) =>
    Effect.gen(function* () {
      const group = db.getTaskGroup(params.id)
      if (!group) {
        return yield* Effect.fail(notFoundError(
          "Task group not found",
          ErrorCode.TASK_GROUP_NOT_FOUND,
        ))
      }

      if (group.taskIds.length === 0) {
        return yield* Effect.fail(badRequestError(
          "Cannot start group with no tasks",
          ErrorCode.INVALID_REQUEST_BODY,
        ))
      }

      if (db.hasRunningWorkflows()) {
        return yield* Effect.fail(conflictError(
          "A workflow is already running. Stop it first.",
          ErrorCode.EXECUTION_OPERATION_FAILED,
        ))
      }

      const tasks = group.taskIds.map((id) => db.getTask(id)).filter(Boolean)
      const nonBacklogTasks = tasks.filter((t) => t!.status !== "backlog" && t!.status !== "template")
      if (nonBacklogTasks.length > 0) {
        return yield* Effect.fail(conflictError(
          "Some tasks are not in backlog status",
          ErrorCode.EXECUTION_OPERATION_FAILED,
          { tasks: nonBacklogTasks.map((t) => ({ id: t!.id, name: t!.name, status: t!.status })) },
        ))
      }

      if (!ctx.onStartGroup) {
        return yield* Effect.fail(internalRouteError(
          "Group execution handler not available",
          ErrorCode.SERVICE_UNAVAILABLE,
        ))
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
    Effect.gen(function* () {
      if (!db.getTask(params.id)) {
        return yield* Effect.fail(notFoundError(
          "Task not found",
          ErrorCode.TASK_NOT_FOUND,
        ))
      }

      const membership = db.getTaskGroupMembership(params.id)

      if (!membership.groupId) {
        return json({ groupId: null, group: null })
      }

      return json(membership)
    }),
  )
}
