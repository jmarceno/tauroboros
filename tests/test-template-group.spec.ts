import { describe, it, expect, afterEach } from "bun:test"
import { createPiServer, createTestSettings } from "./test-utils"
import { join } from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"

const tempRoots: string[] = []

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("Template Conversion Group Removal", () => {
  it("removes task from group when converted to template via PATCH", async () => {
    const root = createTempDir("tauroboros-task-template-group-remove-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a task
    const createTaskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Task to Template", prompt: "Test task", status: "backlog" }),
    })
    const task = await createTaskRes.json()
    const taskId = task.id

    // Create a group and add the task to it
    const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Group", color: "#888888", status: "active", taskIds: [taskId] }),
    })
    const group = await groupRes.json()
    const groupId = group.id

    // Verify task is in group
    const groupBefore = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`).then(r => r.json())
    expect(groupBefore.tasks).toContainEqual(expect.objectContaining({ id: taskId }))

    // Convert task to template via PATCH
    const patchRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "template" }),
    })
    expect(patchRes.status).toBe(200)

    const updatedTask = await patchRes.json()
    expect(updatedTask.status).toBe("template")
    expect(updatedTask.groupId === null || updatedTask.groupId === undefined).toBe(true)

    // Verify task is no longer in group
    const groupAfter = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`).then(r => r.json())
    expect(groupAfter.tasks).not.toContainEqual(expect.objectContaining({ id: taskId }))

    server.stop()
    db.close()
  })

  it("does NOT remove task from group when setting other status", async () => {
    const root = createTempDir("tauroboros-task-other-status-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a task
    const createTaskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Task to Execute", prompt: "Test task", status: "backlog" }),
    })
    const task = await createTaskRes.json()
    const taskId = task.id

    // Create a group and add the task to it
    const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Group", color: "#888888", status: "active", taskIds: [taskId] }),
    })
    const group = await groupRes.json()
    const groupId = group.id

    // Set task to executing (should NOT remove from group)
    const patchRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "executing" }),
    })
    expect(patchRes.status).toBe(200)

    const updatedTask = await patchRes.json()
    expect(updatedTask.status).toBe("executing")
    expect(updatedTask.groupId).toBe(groupId) // Should still be in group

    // Verify task is still in group
    const groupAfter = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`).then(r => r.json())
    expect(groupAfter.tasks).toContainEqual(expect.objectContaining({ id: taskId }))

    server.stop()
    db.close()
  })
})