import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { isTaskGroupStatus, isValidHexColor, validateTaskGroupName, validateTaskIds } from "../../db.ts"
import { normalizeTaskForClient } from "../validators.ts"

export function registerTaskGroupRoutes(router: Router, ctx: ServerRouteContext): void {
  router.get("/api/task-groups", ({ json, db }) => {
    return json(db.getTaskGroups())
  })

  router.post("/api/task-groups", async ({ req, json, broadcast, db }) => {
    const body = await req.json()

    const nameValidation = validateTaskGroupName(body?.name)
    if (!nameValidation.valid) return json({ error: nameValidation.error }, 400)

    if (body?.color !== undefined && !isValidHexColor(body.color)) {
      return json({ error: "color must be a valid hex color (e.g., #888888)" }, 400)
    }

    if (body?.status !== undefined && !isTaskGroupStatus(body.status)) {
      return json({ error: "status must be active, completed, or archived" }, 400)
    }

    let memberTaskIds: string[] = []
    if (body?.taskIds !== undefined) {
      const taskValidation = validateTaskIds(body.taskIds, db)
      if (!taskValidation.valid) return json({ error: taskValidation.error }, 400)
      memberTaskIds = body.taskIds as string[]
    }

    try {
      const group = db.createTaskGroup({
        name: String(body.name).trim(),
        color: body.color,
        status: body.status,
        memberTaskIds,
      })

      broadcast({ type: "task_group_created", payload: group })
      return json(group, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 409)
    }
  })

  router.get("/api/task-groups/:id", ({ params, json, sessionUrlFor, db }) => {
    const group = db.getTaskGroup(params.id)
    if (!group) return json({ error: "Task group not found" }, 404)

    const tasks = group.taskIds
      .map((taskId) => {
        const task = db.getTask(taskId)
        return task ? normalizeTaskForClient(task, sessionUrlFor) : null
      })
      .filter(Boolean)

    return json({ ...group, tasks })
  })

  router.patch("/api/task-groups/:id", async ({ params, req, json, broadcast, db }) => {
    const existing = db.getTaskGroup(params.id)
    if (!existing) return json({ error: "Task group not found" }, 404)

    const body = await req.json()

    if (body?.name !== undefined) {
      const nameValidation = validateTaskGroupName(body.name)
      if (!nameValidation.valid) return json({ error: nameValidation.error }, 400)
    }

    if (body?.color !== undefined && !isValidHexColor(body.color)) {
      return json({ error: "color must be a valid hex color (e.g., #888888)" }, 400)
    }

    if (body?.status !== undefined && !isTaskGroupStatus(body.status)) {
      return json({ error: "status must be active, completed, or archived" }, 400)
    }

    try {
      const updated = db.updateTaskGroup(params.id, {
        name: body?.name !== undefined ? String(body.name).trim() : undefined,
        color: body?.color,
        status: body?.status,
        completedAt: body?.status === "completed" ? Math.floor(Date.now() / 1000) : undefined,
      })

      if (!updated) return json({ error: "Failed to update task group" }, 500)

      broadcast({ type: "task_group_updated", payload: updated })
      return json(updated)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 500)
    }
  })

  router.delete("/api/task-groups/:id", ({ params, json, broadcast, db }) => {
    const group = db.getTaskGroup(params.id)
    if (!group) return json({ error: "Task group not found" }, 404)

    const success = db.deleteTaskGroup(params.id)
    if (!success) return json({ error: "Failed to delete task group" }, 500)

    broadcast({ type: "task_group_deleted", payload: { id: params.id } })
    return new Response(null, { status: 204 })
  })

  router.post("/api/task-groups/:id/tasks", async ({ params, req, json, broadcast, db }) => {
    const group = db.getTaskGroup(params.id)
    if (!group) return json({ error: "Task group not found" }, 404)

    const body = await req.json()

    if (!body?.taskIds || !Array.isArray(body.taskIds)) {
      return json({ error: "taskIds array is required" }, 400)
    }

    const taskValidation = validateTaskIds(body.taskIds, db)
    if (!taskValidation.valid) return json({ error: taskValidation.error }, 400)

    try {
      const addedCount = db.addTasksToGroup(params.id, body.taskIds)
      const updated = db.getTaskGroup(params.id)

      broadcast({
        type: "task_group_members_added",
        payload: { groupId: params.id, taskIds: body.taskIds, addedCount },
      })
      return json(updated)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("already in another group")) {
        return json({ error: message }, 409)
      }
      return json({ error: message }, 500)
    }
  })

  router.delete("/api/task-groups/:id/tasks", async ({ params, req, json, broadcast, db }) => {
    const group = db.getTaskGroup(params.id)
    if (!group) return json({ error: "Task group not found" }, 404)

    const body = await req.json()

    if (!body?.taskIds || !Array.isArray(body.taskIds)) {
      return json({ error: "taskIds array is required" }, 400)
    }

    try {
      const removedCount = db.removeTasksFromGroup(params.id, body.taskIds)
      const updated = db.getTaskGroup(params.id)

      broadcast({
        type: "task_group_members_removed",
        payload: { groupId: params.id, taskIds: body.taskIds, removedCount },
      })
      return json(updated)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: message }, 500)
    }
  })

  router.post("/api/task-groups/:id/start", async ({ params, json, broadcast, db }) => {
    const group = db.getTaskGroup(params.id)
    if (!group) return json({ error: "Task group not found" }, 404)

    if (group.taskIds.length === 0) {
      return json({ error: "Cannot start group with no tasks" }, 400)
    }

    if (db.hasRunningWorkflows()) {
      return json({ error: "A workflow is already running. Stop it first." }, 409)
    }

    const tasks = group.taskIds.map((id) => db.getTask(id)).filter(Boolean)
    const nonBacklogTasks = tasks.filter((t) => t!.status !== "backlog" && t!.status !== "template")
    if (nonBacklogTasks.length > 0) {
      return json(
        {
          error: "Some tasks are not in backlog status",
          tasks: nonBacklogTasks.map((t) => ({ id: t!.id, name: t!.name, status: t!.status })),
        },
        409,
      )
    }

    if (!ctx.onStartGroup) {
      return json({ error: "Group execution handler not available" }, 503)
    }

    try {
      const run = await ctx.onStartGroup(params.id)
      broadcast({ type: "run_created", payload: run })
      broadcast({
        type: "group_execution_started",
        payload: { groupId: params.id, taskIds: group.taskIds, startedAt: Date.now() },
      })
      broadcast({ type: "execution_started", payload: {} })
      return json(run)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("not found")) {
        return json({ error: message }, 404)
      }
      if (message.includes("external dependencies") || message.includes("blocked")) {
        return json({ error: message }, 409)
      }
      if (message.includes("invalid container images") || message.includes("container image")) {
        return json({ error: message }, 409)
      }
      if (message.includes("Already executing")) {
        return json({ error: message }, 409)
      }
      return json({ error: message }, 500)
    }
  })

  router.get("/api/tasks/:id/group", ({ params, json, db }) => {
    if (!db.getTask(params.id)) {
      return json({ error: "Task not found" }, 404)
    }

    const membership = db.getTaskGroupMembership(params.id)

    if (!membership.groupId) {
      return json({ groupId: null, group: null })
    }

    return json(membership)
  })
}
