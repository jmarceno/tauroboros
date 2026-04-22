import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { createPiServerScopedEffect, type PiKanbanServer } from "../src/server.ts"
import { createTestSettings } from "./test-utils.ts"
import type { PiKanbanDB } from "../src/db.ts"
import { mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

describe("Archived Tasks API", () => {
  let server: PiKanbanServer
  let db: PiKanbanDB
  let port: number
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `archived-api-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const dbPath = join(tempDir, "test.db")

    const runtime = Effect.runSync(Effect.scoped(createPiServerScopedEffect({
      ...createTestSettings(),
      dbPath,
    })))
    server = runtime.server
    db = runtime.db
    port = await Effect.runPromise(Effect.scoped(server.startEffect(0)))
  })

  afterEach(() => {
    server.stop()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("GET /api/archived/tasks returns archived tasks grouped by run", async () => {
    // Create and archive a task
    const task = db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "done",
    })
    db.archiveTask(task.id)

    // Create a workflow run
    const run = db.createWorkflowRun({
      id: "run-1",
      kind: "single_task",
      taskOrder: [task.id],
      displayName: "Test Run",
      status: "completed",
    })

    const response = await fetch(`http://127.0.0.1:${port}/api/archived/tasks`)
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty("runs")
    expect(Array.isArray(data.runs)).toBe(true)
    expect(data.runs.length).toBeGreaterThan(0)

    // Verify structure
    const firstRun = data.runs[0]
    expect(firstRun).toHaveProperty("run")
    expect(firstRun).toHaveProperty("tasks")
    expect(Array.isArray(firstRun.tasks)).toBe(true)
  })

  it("GET /api/archived/runs returns runs with archived tasks", async () => {
    // Create and archive a task
    const task = db.createTask({
      id: "task-2",
      name: "Test Task 2",
      prompt: "Test prompt",
      status: "done",
    })
    db.archiveTask(task.id)

    // Create a workflow run
    db.createWorkflowRun({
      id: "run-2",
      kind: "single_task",
      taskOrder: [task.id],
      displayName: "Test Run 2",
      status: "completed",
    })

    const response = await fetch(`http://127.0.0.1:${port}/api/archived/runs`)
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty("runs")
    expect(Array.isArray(data.runs)).toBe(true)
    expect(data.runs.length).toBeGreaterThan(0)

    // Verify run structure
    const run = data.runs[0]
    expect(run).toHaveProperty("id")
    expect(run).toHaveProperty("displayName")
  })

  it("GET /api/archived/tasks/:taskId returns archived task", async () => {
    // Create and archive a task
    const task = db.createTask({
      id: "task-3",
      name: "Test Task 3",
      prompt: "Test prompt",
      status: "done",
    })
    const archived = db.archiveTask(task.id)
    expect(archived).not.toBeNull()

    const response = await fetch(`http://127.0.0.1:${port}/api/archived/tasks/task-3`)
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data.id).toBe("task-3")
    expect(data.name).toBe("Test Task 3")
    expect(data.isArchived).toBe(true)
  })

  it("GET /api/archived/tasks/:taskId returns 404 for non-archived task", async () => {
    // Create a task but don't archive it
    db.createTask({
      id: "task-4",
      name: "Test Task 4",
      prompt: "Test prompt",
      status: "backlog",
    })

    const response = await fetch(`http://127.0.0.1:${port}/api/archived/tasks/task-4`)
    expect(response.status).toBe(404)

    const data = await response.json()
    expect(data).toHaveProperty("error")
  })

  it("GET /api/archived/tasks/:taskId returns 404 for non-existent task", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/archived/tasks/non-existent`)
    expect(response.status).toBe(404)

    const data = await response.json()
    expect(data).toHaveProperty("error")
  })

  it("GET /api/archived/tasks returns empty runs when no archived tasks", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/archived/tasks`)
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty("runs")
    expect(Array.isArray(data.runs)).toBe(true)
    expect(data.runs.length).toBe(0)
  })

  it("GET /api/archived/runs returns empty runs when no archived tasks", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/archived/runs`)
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty("runs")
    expect(Array.isArray(data.runs)).toBe(true)
    expect(data.runs.length).toBe(0)
  })
})
