import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createPiServer } from "./test-utils"
import type { InfrastructureSettings } from "../src/backend-ts/config/settings.ts"
import { BASE_IMAGES } from "../src/backend-ts/config/base-images.ts"

function createTestSettings(): InfrastructureSettings {
  return {
    skills: {
      localPath: "./skills",
      autoLoad: true,
      allowGlobal: false,
    },
    project: {
      name: "tauroboros-test",
      type: "workflow",
    },
    workflow: {
      server: {
        port: 0,
        dbPath: ".tauroboros/tasks.db",
      },
      runtime: {
        mode: "native",
        piBin: "mock-pi",
        piArgs: "",
      },
      container: {
        enabled: false,  // Disable container mode for tests
        image: BASE_IMAGES.piAgent,
        memoryMb: 512,
        cpuCount: 1,
        portRangeStart: 30000,
        portRangeEnd: 40000,
      },
    },
  }
}

const tempDirs: string[] = []

/** Safely extract a string property from API response data */
function getStringProperty(data: unknown, key: string): string {
  if (data === null || typeof data !== "object") {
    throw new Error(`Expected object with property "${key}", got ${data === null ? "null" : typeof data}`)
  }
  const value = (data as Record<string, unknown>)[key]
  if (typeof value !== "string") {
    throw new Error(`Expected property "${key}" to be string, got ${typeof value}`)
  }
  return value
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim()
}

function initGitRepo(root: string): void {
  git(root, ["init"])
  git(root, ["checkout", "-b", "master"])
  writeFileSync(join(root, "README.md"), "# server test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string): string {
  const filePath = join(root, "mock-pi-server.js")
  writeFileSync(
    filePath,
    `#!/usr/bin/env bun
import { createInterface } from "readline"
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try {
    request = JSON.parse(line)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error("Mock PI: Failed to parse JSON request: " + errMsg)
    console.error("Mock PI: Invalid line: " + line)
    return
  }
  const id = request?.id
  const type = request?.type

  // Handle set_model command
  if (type === "set_model") {
    console.log(JSON.stringify({ id, type: "response", command: "set_model", success: true, data: { provider: request.provider, id: request.modelId } }))
    return
  }

  // Handle set_thinking_level command
  if (type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: "set_thinking_level", success: true }))
    return
  }

  // Handle prompt command - returns immediately, then sends events
  if (type === "prompt") {
    // Send success response first
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))
    // Then send streaming events
    const text = "Local session viewer execution output"
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }

  // Handle get_messages command
  if (type === "get_messages") {
    console.log(JSON.stringify({
      id,
      type: "response",
      command: "get_messages",
      success: true,
      data: {
        messages: [
          { role: "user", text: "test prompt" },
          { role: "assistant", text: "Local session viewer execution output" }
        ]
      }
    }))
    return
  }

  // Handle get_state command
  if (type === "get_state") {
    console.log(JSON.stringify({
      id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        isStreaming: false,
        messageCount: 2,
        thinkingLevel: "medium",
        steeringMode: "all",
        followUpMode: "all",
        autoCompactionEnabled: false
      }
    }))
    return
  }

  // Default response for unknown commands
  console.log(JSON.stringify({ id, type: "response", command: type || "unknown", success: true, data: {} }))
})
`,
    "utf-8",
  )
  chmodSync(filePath, 0o755)
  return filePath
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for condition")
}

/** Helper to read SSE events from a response */
async function readSseEvents(response: Response, targetEventType: string, timeoutMs = 5000): Promise<any> {
  const start = Date.now()
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("Response body is not readable")
  }

  const decoder = new TextDecoder()
  let buffer = ""

  while (Date.now() - start < timeoutMs) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // Parse SSE events
    const events = buffer.split("\n\n")
    buffer = events.pop() || ""

    for (const event of events) {
      const lines = event.split("\n")
      let eventType = ""
      let data = ""

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          data = line.slice(5).trim()
        }
      }

      if (eventType === targetEventType && data) {
        reader.cancel()
        return JSON.parse(data)
      }
    }
  }

  reader.cancel()
  throw new Error(`Timeout waiting for SSE event: ${targetEventType}`)
}

/** Helper to read all SSE events until a condition is met */
async function readSseEventsUntil(
  response: Response,
  predicate: (event: any) => boolean,
  timeoutMs = 5000
): Promise<any[]> {
  const start = Date.now()
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("Response body is not readable")
  }

  const decoder = new TextDecoder()
  let buffer = ""
  const events: any[] = []

  while (Date.now() - start < timeoutMs) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // Parse SSE events
    const eventBlocks = buffer.split("\n\n")
    buffer = eventBlocks.pop() || ""

    for (const block of eventBlocks) {
      const lines = block.split("\n")
      let eventType = ""
      let data = ""

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          data = line.slice(5).trim()
        }
      }

      if (data) {
        const parsed = JSON.parse(data)
        events.push({ type: eventType, data: parsed })
        if (predicate({ type: eventType, data: parsed })) {
          reader.cancel()
          return events
        }
      }
    }
  }

  reader.cancel()
  return events
}

function createTestSettings(mockPiPath: string): InfrastructureSettings {
  return {
    skills: {
      localPath: "./skills",
      autoLoad: true,
      allowGlobal: false,
    },
    project: {
      name: "tauroboros-test",
      type: "workflow",
    },
    workflow: {
      server: {
        port: 0, // Use dynamic port assignment for tests
        dbPath: ".tauroboros/tasks.db",
      },
      runtime: {
        mode: "native",
        piBin: mockPiPath,
        piArgs: "",
      },
      container: {
        enabled: false,
        image: BASE_IMAGES.piAgent,
        memoryMb: 512,
        cpuCount: 1,
        portRangeStart: 30000,
        portRangeEnd: 40000,
      },
    },
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("PiKanbanServer API", () => {
  it("supports tasks/options/runs/models and session endpoints", async () => {
    const root = createTempDir("tauroboros-server-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })

    const port = await server.start(0)
    const baseUrl = `http://127.0.0.1:${port}`

    const api = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, init)
      const text = await response.text()
      const data = text ? JSON.parse(text) : null
      return { response, data }
    }

    try {
      const optionsRes = await api("/api/options")
      expect(optionsRes.response.status).toBe(200)
      expect(optionsRes.data.parallelTasks).toBe(1)

      const createTaskRes = await api("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Server API test task",
          prompt: "Verify server endpoints",
          status: "backlog",
          executionStrategy: "standard",
          planmode: false,
          review: true,
        }),
      })
      expect(createTaskRes.response.status).toBe(201)
      expect(createTaskRes.data.name).toBe("Server API test task")
      const taskId = getStringProperty(createTaskRes.data, "id")

      const listTasksRes = await api("/api/tasks")
      expect(listTasksRes.response.status).toBe(200)
      expect(Array.isArray(listTasksRes.data)).toBe(true)
      expect(listTasksRes.data.length).toBe(1)

      const patchTaskRes = await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "review", awaitingPlanApproval: true, executionPhase: "plan_complete_waiting_approval" }),
      })
      expect(patchTaskRes.response.status).toBe(200)
      expect(patchTaskRes.data.status).toBe("review")

      const reviewStatusRes = await api(`/api/tasks/${taskId}/review-status`)
      expect(reviewStatusRes.response.status).toBe(200)
      expect(reviewStatusRes.data.taskId).toBe(taskId)

      const runsRes = await api("/api/runs")
      expect(runsRes.response.status).toBe(200)
      expect(Array.isArray(runsRes.data)).toBe(true)

      const slotsRes = await api("/api/slots")
      expect(slotsRes.response.status).toBe(200)
      expect(typeof slotsRes.data.maxSlots).toBe("number")
      expect(typeof slotsRes.data.usedSlots).toBe("number")
      expect(Array.isArray(slotsRes.data.tasks)).toBe(true)

      const finishedRun = db.createWorkflowRun({
        id: "run-api-finished",
        kind: "single_task",
        status: "completed",
        displayName: "Completed API run",
        taskOrder: [taskId],
        targetTaskId: taskId,
        finishedAt: Math.floor(Date.now() / 1000),
      })

      db.updateTask(taskId, { status: "done" })

      const queueStatusRes = await api(`/api/runs/${finishedRun.id}/queue-status`)
      expect(queueStatusRes.response.status).toBe(200)
      expect(queueStatusRes.data.runId).toBe(finishedRun.id)
      expect(queueStatusRes.data.totalTasks).toBe(1)
      expect(queueStatusRes.data.completedTasks).toBe(1)

      const runsWithFinishedRes = await api("/api/runs")
      expect(runsWithFinishedRes.response.status).toBe(200)
      expect(runsWithFinishedRes.data.some((run: any) => run.id === finishedRun.id)).toBe(true)

      const archiveRunRes = await api(`/api/runs/${finishedRun.id}`, { method: "DELETE" })
      expect(archiveRunRes.response.status).toBe(200)
      expect(archiveRunRes.data.archived).toBe(true)

      const runsAfterArchiveRes = await api("/api/runs")
      expect(runsAfterArchiveRes.response.status).toBe(200)
      expect(runsAfterArchiveRes.data.some((run: any) => run.id === finishedRun.id)).toBe(false)

      const graphRes = await api("/api/execution-graph")
      expect([200, 400]).toContain(graphRes.response.status)

      const modelsRes = await api("/api/models")
      expect(modelsRes.response.status).toBe(200)
      expect(Array.isArray(modelsRes.data.providers)).toBe(true)
      expect(typeof modelsRes.data.defaults).toBe("object")

      const session = db.createWorkflowSession({
        id: "session-api-1",
        taskId,
        sessionKind: "task",
        cwd: root,
      })
      db.updateTask(taskId, { sessionId: session.id, sessionUrl: "https://opencode.ai/session/legacy-id" })
      db.createSessionMessage({
        sessionId: session.id,
        taskId,
        role: "assistant",
        messageType: "assistant_response",
        contentJson: { text: "hello from session" },
        promptTokens: 120,
        completionTokens: 30,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        totalTokens: 165,
        costTotal: 0.125,
      })

      db.getRawHandle().prepare(
        `
        INSERT INTO task_runs (id, task_id, phase, model, status, session_id, session_url, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'worker', 'default', 'running', ?, ?, '{}', unixepoch(), unixepoch())
        `,
      ).run("run-session-api-1", taskId, session.id, "https://opencode.ai/session/task-run-legacy")

      const sessionRes = await api(`/api/sessions/${session.id}`)
      expect(sessionRes.response.status).toBe(200)
      expect(sessionRes.data.id).toBe(session.id)

      const taskRes = await api(`/api/tasks/${taskId}`)
      expect(taskRes.response.status).toBe(200)
      expect(taskRes.data.sessionUrl).toBe(`/#session/${session.id}`)

      const sessionMessagesRes = await api(`/api/sessions/${session.id}/messages`)
      expect(sessionMessagesRes.response.status).toBe(200)
      expect(Array.isArray(sessionMessagesRes.data)).toBe(true)
      expect(sessionMessagesRes.data.length).toBe(1)

      const sessionUsageRes = await api(`/api/sessions/${session.id}/usage`)
      expect(sessionUsageRes.response.status).toBe(200)
      expect(sessionUsageRes.data.sessionId).toBe(session.id)
      expect(sessionUsageRes.data.messageCount).toBe(1)
      expect(sessionUsageRes.data.tokenizedMessageCount).toBe(1)
      expect(sessionUsageRes.data.promptTokens).toBe(120)
      expect(sessionUsageRes.data.completionTokens).toBe(30)
      expect(sessionUsageRes.data.cacheReadTokens).toBe(10)
      expect(sessionUsageRes.data.cacheWriteTokens).toBe(5)
      expect(sessionUsageRes.data.totalTokens).toBe(165)
      expect(sessionUsageRes.data.totalCost).toBe(0.125)

      const taskRunsRes = await api(`/api/tasks/${taskId}/runs`)
      expect(taskRunsRes.response.status).toBe(200)
      expect(Array.isArray(taskRunsRes.data)).toBe(true)
      expect(taskRunsRes.data[0]?.sessionUrl).toBe(`/#session/${session.id}`)

      const bonTaskRes = await api("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Best of N API task",
          prompt: "Run best-of-n",
          status: "backlog",
          executionStrategy: "best_of_n",
          bestOfNConfig: {
            workers: [{ model: "default", count: 1 }],
            reviewers: [{ model: "default", count: 1 }],
            finalApplier: { model: "default" },
            minSuccessfulWorkers: 1,
            selectionMode: "pick_best",
          },
        }),
      })
      expect(bonTaskRes.response.status).toBe(201)
      const bonTaskId = getStringProperty(bonTaskRes.data, "id")

      db.createTaskRun({
        id: "bon-run-worker",
        taskId: bonTaskId,
        phase: "worker",
        slotIndex: 0,
        attemptIndex: 0,
        model: "default",
        status: "done",
      })
      const bonCandidate = db.createTaskCandidate({
        id: "bon-candidate-1",
        taskId: bonTaskId,
        workerRunId: "bon-run-worker",
        status: "available",
        summary: "candidate output",
      })

      const bonSummaryRes = await api(`/api/tasks/${bonTaskId}/best-of-n-summary`)
      expect(bonSummaryRes.response.status).toBe(200)
      expect(bonSummaryRes.data.taskId).toBe(bonTaskId)
      expect(typeof bonSummaryRes.data.expandedWorkerCount).toBe("number")
      expect(typeof bonSummaryRes.data.finalApplierDone).toBe("boolean")

      const selectCandidateRes = await api(`/api/tasks/${bonTaskId}/best-of-n/select-candidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: bonCandidate.id }),
      })
      expect(selectCandidateRes.response.status).toBe(200)
      expect(selectCandidateRes.data.selectedCandidate).toBe(bonCandidate.id)

      const abortBonRes = await api(`/api/tasks/${bonTaskId}/best-of-n/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual hold" }),
      })
      expect(abortBonRes.response.status).toBe(200)
      expect(abortBonRes.data.task.status).toBe("review")
      expect(abortBonRes.data.task.bestOfNSubstage).toBe("blocked_for_manual_review")

      const sessionTimelineRes = await api(`/api/sessions/${session.id}/timeline`)
      expect(sessionTimelineRes.response.status).toBe(200)
      expect(Array.isArray(sessionTimelineRes.data)).toBe(true)

      const taskMessagesRes = await api(`/api/tasks/${taskId}/messages`)
      expect(taskMessagesRes.response.status).toBe(200)
      expect(Array.isArray(taskMessagesRes.data)).toBe(true)
      expect(taskMessagesRes.data.length).toBe(1)

      const sessionEventRes = await api(`/api/pi/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          role: "assistant",
          messageType: "text",
          text: "stream update",
          contentJson: { text: "stream update" },
        }),
      })
      expect(sessionEventRes.response.status).toBe(200)
      expect(sessionEventRes.data.ok).toBe(true)
    } finally {
      
    }
  })

  it("broadcasts SSE task updates", async () => {
    const root = createTempDir("tauroboros-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toBe("text/event-stream")

      // Create a task and listen for the event
      const createTaskPromise = readSseEvents(response, "task_created", 5000)

      const taskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "SSE test task",
          prompt: "Ensure SSE receives task_created",
          status: "backlog",
        }),
      })

      expect(taskResponse.status).toBe(201)

      const event = await createTaskPromise
      expect(event.payload.name).toBe("SSE test task")
    } finally {
      server.stop()
    }
  })

  it("broadcasts SSE session message updates", async () => {
    const root = createTempDir("tauroboros-session-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    const session = db.createWorkflowSession({
      id: "session-sse-1",
      sessionKind: "task",
      cwd: root,
    })

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for session_message_created event
      const sessionMessageEventPromise = readSseEvents(response, "session_message_created", 5000)

      const sessionEventResponse = await fetch(`http://127.0.0.1:${port}/api/pi/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          role: "assistant",
          messageType: "thinking",
          contentJson: { text: "thinking about fix" },
        }),
      })

      expect(sessionEventResponse.status).toBe(200)

      const event = await sessionMessageEventPromise
      expect(event.payload.sessionId).toBe(session.id)
      expect(event.payload.messageType).toBe("thinking")
    } finally {
      server.stop()
    }
  })

  it("broadcasts SSE task_group_created event", async () => {
    const root = createTempDir("tauroboros-group-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for task_group_created event
      const groupCreatedPromise = readSseEvents(response, "task_group_created", 5000)

      const groupResponse = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Group",
          color: "#888888",
          status: "active",
        }),
      })

      expect(groupResponse.status).toBe(201)

      const event = await groupCreatedPromise
      expect(event.payload.name).toBe("Test Group")
      expect(event.payload.color).toBe("#888888")
    } finally {
      server.stop()
    }
  })

  it("only broadcasts single task_group_created event (no duplicate group_created)", async () => {
    const root = createTempDir("tauroboros-group-no-dup-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    try {
      // Connect to SSE endpoint first
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Start collecting SSE events
      const eventsPromise = readSseEventsUntil(
        response,
        (e) => e.type === "task_group_created" && e.data?.payload?.name === "No Duplicate Test",
        3000
      )

      // Wait for initial connection open event
      await Bun.sleep(100)

      // Create a group (this will trigger the events)
      const groupResponse = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "No Duplicate Test",
          color: "#888888",
          status: "active",
        }),
      })

      expect(groupResponse.status).toBe(201)

      // Get the collected events
      const events = await eventsPromise

      // Verify only one task_group_created event
      const taskGroupCreatedEvents = events.filter(e => e.type === "task_group_created")
      expect(taskGroupCreatedEvents.length).toBe(1)

      // Verify NO group_created event is broadcast (the duplicate)
      const groupCreatedEvents = events.filter(e => e.type === "group_created")
      expect(groupCreatedEvents.length).toBe(0)

      // Verify the event has correct payload
      expect(taskGroupCreatedEvents[0].data.payload.name).toBe("No Duplicate Test")
    } finally {
      server.stop()
    }
  })

  it("broadcasts SSE task_group_updated event", async () => {
    const root = createTempDir("tauroboros-group-update-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a group first
    const createRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Original Name",
        color: "#888888",
        status: "active",
      }),
    })
    const group = await createRes.json()
    const groupId = group.id

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for task_group_updated event
      const groupUpdatedPromise = readSseEvents(response, "task_group_updated", 5000)

      const updateResponse = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated Name",
          color: "#FF5733",
        }),
      })

      expect(updateResponse.status).toBe(200)

      const event = await groupUpdatedPromise
      expect(event.payload.name).toBe("Updated Name")
      expect(event.payload.color).toBe("#FF5733")
    } finally {
      server.stop()
    }
  })

  it("broadcasts SSE task_group_deleted event", async () => {
    const root = createTempDir("tauroboros-group-delete-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a group first
    const createRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Group To Delete",
        color: "#888888",
        status: "active",
      }),
    })
    const group = await createRes.json()
    const groupId = group.id

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for task_group_deleted event
      const groupDeletedPromise = readSseEvents(response, "task_group_deleted", 5000)

      const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`, {
        method: "DELETE",
      })

      expect(deleteResponse.status).toBe(204)

      const event = await groupDeletedPromise
      expect(event.payload.id).toBe(groupId)
    } finally {
      server.stop()
    }
  })

  it("broadcasts SSE task_group_members_added event", async () => {
    const root = createTempDir("tauroboros-group-members-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a task first
    const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Task for Group",
        prompt: "Test task",
        status: "backlog",
      }),
    })
    const task = await taskRes.json()
    const taskId = task.id

    // Create a group
    const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Group With Members",
        color: "#888888",
        status: "active",
      }),
    })
    const group = await groupRes.json()
    const groupId = group.id

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for task_group_members_added event
      const membersAddedPromise = readSseEvents(response, "task_group_members_added", 5000)

      const addResponse = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: [taskId],
        }),
      })

      expect(addResponse.status).toBe(200)

      const event = await membersAddedPromise
      expect(event.payload.groupId).toBe(groupId)
      expect(event.payload.taskIds).toContain(taskId)
      expect(event.payload.addedCount).toBe(1)
    } finally {
      server.stop()
    }
  })

  it("broadcasts SSE task_group_members_removed event", async () => {
    const root = createTempDir("tauroboros-group-remove-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a task first
    const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Task to Remove",
        prompt: "Test task",
        status: "backlog",
      }),
    })
    const task = await taskRes.json()
    const taskId = task.id

    // Create a group with the task
    const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Group With Task",
        color: "#888888",
        status: "active",
        taskIds: [taskId],
      }),
    })
    const group = await groupRes.json()
    const groupId = group.id

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for task_group_members_removed event
      const membersRemovedPromise = readSseEvents(response, "task_group_members_removed", 5000)

      const removeResponse = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/tasks`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: [taskId],
        }),
      })

      expect(removeResponse.status).toBe(200)

      const event = await membersRemovedPromise
      expect(event.payload.groupId).toBe(groupId)
      expect(event.payload.taskIds).toContain(taskId)
      expect(event.payload.removedCount).toBe(1)
    } finally {
      server.stop()
    }
  })

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

    // Connect to SSE endpoint and collect events in background
    const response = await fetch(`http://127.0.0.1:${port}/sse`)
    expect(response.status).toBe(200)

    const events: any[] = []
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    // Start collecting events in the background
    const collectEvents = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const eventBlocks = buffer.split("\n\n")
        buffer = eventBlocks.pop() || ""

        for (const block of eventBlocks) {
          const lines = block.split("\n")
          let eventType = ""
          let data = ""

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim()
            } else if (line.startsWith("data:")) {
              data = line.slice(5).trim()
            }
          }

          if (data) {
            events.push({ type: eventType, data: JSON.parse(data) })
          }
        }

        // Stop if we have the events we need
        const foundEvents = events.filter(e =>
          e.type === "task_group_members_removed" || e.type === "group_task_removed"
        )
        if (foundEvents.length >= 2) break
      }
    })()

    // Wait a moment for SSE connection to be ready
    await Bun.sleep(100)

    // Convert task to template via PATCH
    const patchRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "template" }),
    })
    expect(patchRes.status).toBe(200)

    const updatedTask = await patchRes.json()
    expect(updatedTask.status).toBe("template")
    expect(updatedTask.groupId).toBeUndefined()

    // Verify task is no longer in group
    const groupAfter = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`).then(r => r.json())
    expect(groupAfter.tasks).not.toContainEqual(expect.objectContaining({ id: taskId }))

    // Wait for events to be collected
    await Promise.race([collectEvents, Bun.sleep(1000)])

    // Verify SSE events were broadcast
    expect(events.some(e => e.type === "task_group_members_removed" && e.data?.payload?.groupId === groupId)).toBe(true)
    expect(events.some(e => e.type === "group_task_removed" && e.data?.payload?.groupId === groupId && e.data?.payload?.taskId === taskId)).toBe(true)

    reader.cancel()
    server.stop()
  })

  it("broadcasts SSE group_execution_started event", async () => {
    const root = createTempDir("tauroboros-group-exec-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a task first
    const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Task for Execution",
        prompt: "Test task",
        status: "backlog",
      }),
    })
    const task = await taskRes.json()
    const taskId = task.id

    // Create a group with the task
    const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Group for Execution",
        color: "#888888",
        status: "active",
        taskIds: [taskId],
      }),
    })
    const group = await groupRes.json()
    const groupId = group.id

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for group_execution_started event
      const executionStartedPromise = readSseEvents(response, "group_execution_started", 5000)

      // Group execution is now implemented and returns 200 on success
      const startResponse = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/start`, {
        method: "POST",
      })

      // The endpoint returns 200 when group execution starts successfully
      expect(startResponse.status).toBe(200)

      const event = await executionStartedPromise
      expect(event.payload.groupId).toBe(groupId)
      expect(typeof event.payload.runId).toBe("string")
    } finally {
      server.stop()
    }
  })

  it("broadcasts SSE group_execution_complete event", async () => {
    const root = createTempDir("tauroboros-group-complete-sse-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    // Create a task first
    const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Task for Group Completion",
        prompt: "Test task for completion",
        status: "backlog",
      }),
    })
    const task = await taskRes.json()
    const taskId = task.id

    // Create a group with the task
    const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Group for Completion",
        color: "#888888",
        status: "active",
        taskIds: [taskId],
      }),
    })
    const group = await groupRes.json()
    const groupId = group.id

    try {
      // Connect to SSE endpoint
      const response = await fetch(`http://127.0.0.1:${port}/sse`)
      expect(response.status).toBe(200)

      // Listen for group_execution_complete event
      const executionCompletePromise = readSseEvents(response, "group_execution_complete", 5000)

      // Use the server's internal broadcast method to test the message type
      server.broadcast({
        type: "group_execution_complete",
        payload: {
          groupId,
          taskIds: [taskId],
          status: "success",
          completedAt: Date.now(),
          results: [{ taskId, status: "done" }],
        },
      })

      const event = await executionCompletePromise
      expect(event.payload.groupId).toBe(groupId)
      expect(event.payload.taskIds).toContain(taskId)
      expect(event.payload.status).toBe("success")
      expect(typeof event.payload.completedAt).toBe("number")
      expect(Array.isArray(event.payload.results)).toBe(true)
    } finally {
      server.stop()
    }
  })

  // Restore-to-group functionality tests
  describe("Restore to Group Functionality", () => {
    it("POST /api/tasks/:id/reset returns group info when task was in a group", async () => {
      const root = createTempDir("tauroboros-reset-group-info-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      try {
        // Create a task and move it to done
        const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Task in Group",
            prompt: "Test task",
            status: "done",
            completedAt: Math.floor(Date.now() / 1000),
          }),
        })
        const task = await taskRes.json()
        const taskId = task.id

        // Create a group
        const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Test Group",
            color: "#FF5733",
            status: "active",
          }),
        })
        const group = await groupRes.json()
        const groupId = group.id

        // Add task to group
        await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskIds: [taskId] }),
        })

        // Reset the task - should return group info
        const resetRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/reset`, {
          method: "POST",
        })
        const resetData = await resetRes.json()

        expect(resetRes.status).toBe(200)
        expect(resetData.wasInGroup).toBe(true)
        expect(resetData.group).toBeDefined()
        expect(resetData.group.id).toBe(groupId)
        expect(resetData.group.name).toBe("Test Group")
        expect(resetData.task.status).toBe("backlog")
        expect(resetData.task.completedAt).toBeNull()
      } finally {
        server.stop()
      }
    })

    it("POST /api/tasks/:id/reset returns wasInGroup false when task was not in a group", async () => {
      const root = createTempDir("tauroboros-reset-no-group-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      try {
        // Create a task and move it to done
        const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Task Not in Group",
            prompt: "Test task",
            status: "done",
            completedAt: Math.floor(Date.now() / 1000),
          }),
        })
        const task = await taskRes.json()
        const taskId = task.id

        // Reset the task - should not return group info
        const resetRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/reset`, {
          method: "POST",
        })
        const resetData = await resetRes.json()

        expect(resetRes.status).toBe(200)
        expect(resetData.wasInGroup).toBe(false)
        expect(resetData.group).toBeUndefined()
        expect(resetData.task.status).toBe("backlog")
      } finally {
        server.stop()
      }
    })

    it("POST /api/tasks/:id/reset-to-group restores task to its previous group", async () => {
      const root = createTempDir("tauroboros-reset-to-group-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      try {
        // Create a task and move it to done
        const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Task to Restore",
            prompt: "Test task",
            status: "done",
            completedAt: Math.floor(Date.now() / 1000),
          }),
        })
        const task = await taskRes.json()
        const taskId = task.id

        // Create a group
        const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Restore Group",
            color: "#33FF57",
            status: "active",
          }),
        })
        const group = await groupRes.json()
        const groupId = group.id

        // Add task to group
        await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskIds: [taskId] }),
        })

        // Reset to group - should restore task to the group
        const resetToGroupRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/reset-to-group`, {
          method: "POST",
        })
        const resetData = await resetToGroupRes.json()

        expect(resetToGroupRes.status).toBe(200)
        expect(resetData.restoredToGroup).toBe(true)
        expect(resetData.group.id).toBe(groupId)
        expect(resetData.task.status).toBe("backlog")
        expect(resetData.task.groupId).toBe(groupId)

        // Verify task is actually in the group
        const taskGetRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`)
        const updatedTask = await taskGetRes.json()
        expect(updatedTask.groupId).toBe(groupId)
      } finally {
        server.stop()
      }
    })

    it("POST /api/tasks/:id/reset-to-group returns 400 when task was not in a group", async () => {
      const root = createTempDir("tauroboros-reset-to-group-no-group-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      try {
        // Create a task and move it to done (not in any group)
        const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Task Without Group",
            prompt: "Test task",
            status: "done",
            completedAt: Math.floor(Date.now() / 1000),
          }),
        })
        const task = await taskRes.json()
        const taskId = task.id

        // Reset to group should fail since task wasn't in a group
        const resetToGroupRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/reset-to-group`, {
          method: "POST",
        })
        const resetData = await resetToGroupRes.json()

        expect(resetToGroupRes.status).toBe(400)
        expect(resetData.error).toBe("Task was not in a group")
      } finally {
        server.stop()
      }
    })

    it("POST /api/tasks/:id/move-to-group with null groupId removes task from group", async () => {
      const root = createTempDir("tauroboros-move-to-group-null-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      try {
        // Create a task
        const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Task to Remove from Group",
            prompt: "Test task",
            status: "backlog",
          }),
        })
        const task = await taskRes.json()
        const taskId = task.id

        // Create a group and add the task
        const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Group to Leave",
            color: "#5733FF",
            status: "active",
            taskIds: [taskId],
          }),
        })
        const group = await groupRes.json()
        const groupId = group.id

        // Verify task is in the group
        const taskBeforeRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`)
        const taskBefore = await taskBeforeRes.json()
        expect(taskBefore.groupId).toBe(groupId)

        // Move to group with null - should remove from group
        const moveRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/move-to-group`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId: null }),
        })
        const moveData = await moveRes.json()

        expect(moveRes.status).toBe(200)
        // groupId can be null or undefined in JSON response (both represent "no group")
        expect(moveData.groupId === null || moveData.groupId === undefined).toBe(true)

        // Verify task is no longer in the group
        const taskAfterRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`)
        const taskAfter = await taskAfterRes.json()
        // groupId can be null or undefined in JSON response
        expect(taskAfter.groupId === null || taskAfter.groupId === undefined).toBe(true)
      } finally {
        server.stop()
      }
    })

    it("POST /api/tasks/:id/move-to-group with valid groupId adds task to group", async () => {
      const root = createTempDir("tauroboros-move-to-group-valid-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      try {
        // Create a task
        const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Task to Add to Group",
            prompt: "Test task",
            status: "backlog",
          }),
        })
        const task = await taskRes.json()
        const taskId = task.id

        // Create a group
        const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Target Group",
            color: "#FF33A1",
            status: "active",
          }),
        })
        const group = await groupRes.json()
        const groupId = group.id

        // Move to group - should add task to the group
        const moveRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/move-to-group`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId }),
        })
        const moveData = await moveRes.json()

        expect(moveRes.status).toBe(200)
        expect(moveData.groupId).toBe(groupId)

        // Verify task is now in the group
        const taskAfterRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`)
        const taskAfter = await taskAfterRes.json()
        expect(taskAfter.groupId).toBe(groupId)
      } finally {
        server.stop()
      }
    })

    it("broadcasts SSE events during reset-to-group flow", async () => {
      const root = createTempDir("tauroboros-reset-to-group-sse-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      // Create a task
      const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Task for SSE Test",
          prompt: "Test task",
          status: "done",
          completedAt: Math.floor(Date.now() / 1000),
        }),
      })
      const task = await taskRes.json()
      const taskId = task.id

      // Create a group
      const groupRes = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "SSE Test Group",
          color: "#33A1FF",
          status: "active",
        }),
      })
      const group = await groupRes.json()
      const groupId = group.id

      // Add task to group
      await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [taskId] }),
      })

      try {
        // Connect to SSE endpoint
        const response = await fetch(`http://127.0.0.1:${port}/sse`)
        expect(response.status).toBe(200)

        const events: any[] = []
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        // Start collecting events in the background
        const collectEvents = (async () => {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const eventBlocks = buffer.split("\n\n")
            buffer = eventBlocks.pop() || ""

            for (const block of eventBlocks) {
              const lines = block.split("\n")
              let eventType = ""
              let data = ""

              for (const line of lines) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim()
                } else if (line.startsWith("data:")) {
                  data = line.slice(5).trim()
                }
              }

              if (data) {
                events.push({ type: eventType, data: JSON.parse(data) })
              }
            }

            // Stop if we have the events we need
            const relevantEvents = events.filter(e =>
              e.type === "task_updated" || e.type === "group_task_added" || e.type === "task_group_members_added"
            )
            if (relevantEvents.length >= 3) break
          }
        })()

        // Wait a moment for SSE connection to be ready
        await Bun.sleep(100)

        // Reset to group should trigger multiple events
        await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/reset-to-group`, {
          method: "POST",
        })

        // Wait for events to be collected
        await Promise.race([collectEvents, Bun.sleep(1000)])

        expect(events.some(e => e.type === "task_updated")).toBe(true)
        expect(events.some(e => e.type === "group_task_added")).toBe(true)
        expect(events.some(e => e.type === "task_group_members_added")).toBe(true)
      } finally {
        server.stop()
      }
    })

    it("POST /api/tasks/:id/move-to-group returns 400 for invalid groupId type", async () => {
      const root = createTempDir("tauroboros-move-to-group-invalid-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      try {
        // Create a task
        const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Task for Invalid GroupId Test",
            prompt: "Test task",
            status: "backlog",
          }),
        })
        const task = await taskRes.json()
        const taskId = task.id

        // Try to move with invalid groupId type (number instead of string)
        const moveRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/move-to-group`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId: 123 }),
        })
        const moveData = await moveRes.json()

        expect(moveRes.status).toBe(400)
        expect(moveData.error).toContain("groupId must be a string, null, or undefined")
      } finally {
        server.stop()
      }
    })
  })

  describe("Stats API", () => {
    it("GET /api/stats/usage returns usage stats with default lifetime range", async () => {
      const root = createTempDir("tauroboros-stats-usage-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        // Seed some usage data
        const now = Math.floor(Date.now() / 1000)
        db.createWorkflowSession({
          id: "stats-api-session",
          sessionKind: "task",
          cwd: "/tmp/work",
        })
        db.createSessionMessage({
          sessionId: "stats-api-session",
          timestamp: now - 86400,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "test" },
          totalTokens: 5000,
          costTotal: 0.25,
        })

        const response = await fetch(`http://127.0.0.1:${port}/api/stats/usage`)
        expect(response.status).toBe(200)

        const data = await response.json()
        expect(typeof data.totalTokens).toBe("number")
        expect(typeof data.totalCost).toBe("number")
        expect(typeof data.tokenChange).toBe("number")
        expect(typeof data.costChange).toBe("number")
        expect(data.totalTokens).toBe(5000)
        expect(data.totalCost).toBeCloseTo(0.25, 10)
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/usage accepts valid range query parameter", async () => {
      const root = createTempDir("tauroboros-stats-range-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        const ranges = ["24h", "7d", "30d", "lifetime"]
        for (const range of ranges) {
          const response = await fetch(`http://127.0.0.1:${port}/api/stats/usage?range=${range}`)
          expect(response.status).toBe(200)
          const data = await response.json()
          expect(typeof data.totalTokens).toBe("number")
          expect(typeof data.totalCost).toBe("number")
        }
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/usage returns 400 for invalid range", async () => {
      const root = createTempDir("tauroboros-stats-invalid-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/stats/usage?range=invalid`)
        expect(response.status).toBe(400)

        const data = await response.json()
        expect(data.error).toContain("Invalid range")
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/tasks returns task completion stats", async () => {
      const root = createTempDir("tauroboros-stats-tasks-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        // Seed task data - need to update after creation to set reviewCount
        db.createTask({ id: "api-task-1", name: "Task 1", prompt: "P1", status: "done" })
        db.updateTask("api-task-1", { reviewCount: 2 })
        db.createTask({ id: "api-task-2", name: "Task 2", prompt: "P2", status: "done" })
        db.updateTask("api-task-2", { reviewCount: 0 })
        db.createTask({ id: "api-task-3", name: "Task 3", prompt: "P3", status: "failed" })
        db.createTask({ id: "api-task-4", name: "Task 4", prompt: "P4", status: "backlog" })

        const response = await fetch(`http://127.0.0.1:${port}/api/stats/tasks`)
        expect(response.status).toBe(200)

        const data = await response.json()
        expect(typeof data.completed).toBe("number")
        expect(typeof data.failed).toBe("number")
        expect(typeof data.averageReviews).toBe("number")
        expect(data.completed).toBe(2)
        expect(data.failed).toBe(1)
        expect(data.averageReviews).toBe(1) // (2+0)/2 = 1
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/models returns model usage by responsibility", async () => {
      const root = createTempDir("tauroboros-stats-models-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        // Seed session data with different models and kinds
        db.createWorkflowSession({
          id: "api-plan-session",
          sessionKind: "planning",
          cwd: "/tmp/work",
          model: "claude-3-5",
        })
        db.createWorkflowSession({
          id: "api-exec-session",
          sessionKind: "task",
          cwd: "/tmp/work",
          model: "o3-mini",
        })
        db.createWorkflowSession({
          id: "api-review-session",
          sessionKind: "task_run_reviewer",
          cwd: "/tmp/work",
          model: "o4-mini",
        })

        const response = await fetch(`http://127.0.0.1:${port}/api/stats/models`)
        expect(response.status).toBe(200)

        const data = await response.json()
        expect(Array.isArray(data.plan)).toBe(true)
        expect(Array.isArray(data.execution)).toBe(true)
        expect(Array.isArray(data.review)).toBe(true)

        expect(data.plan.some((m: { model: string }) => m.model === "claude-3-5")).toBe(true)
        expect(data.execution.some((m: { model: string }) => m.model === "o3-mini")).toBe(true)
        expect(data.review.some((m: { model: string }) => m.model === "o4-mini")).toBe(true)
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/duration returns average task duration in minutes", async () => {
      const root = createTempDir("tauroboros-stats-duration-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        const now = Math.floor(Date.now() / 1000)

        // Seed completed tasks with different durations
        // Need to update timestamps after creation since createTask sets created_at automatically
        db.createTask({
          id: "api-duration-1",
          name: "Task 1",
          prompt: "P1",
          status: "done",
        })
        db.updateTask("api-duration-1", { completedAt: now })
        db.getRawHandle().prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(now - 3600, "api-duration-1")

        db.createTask({
          id: "api-duration-2",
          name: "Task 2",
          prompt: "P2",
          status: "done",
        })
        db.updateTask("api-duration-2", { completedAt: now })
        db.getRawHandle().prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(now - 7200, "api-duration-2")

        const response = await fetch(`http://127.0.0.1:${port}/api/stats/duration`)
        expect(response.status).toBe(200)

        // The endpoint returns a number directly
        const data = await response.json()
        expect(typeof data).toBe("number")
        expect(data).toBeGreaterThan(0)
        // Average of 3600 and 7200 = 5400 seconds, returned in minutes
        expect(data).toBe(90)
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/timeseries/hourly returns hourly usage data", async () => {
      const root = createTempDir("tauroboros-stats-hourly-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "api-hourly-session",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "api-hourly-session",
          timestamp: now - 7200,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "test" },
          totalTokens: 1000,
          costTotal: 0.05,
        })

        const response = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/hourly`)
        expect(response.status).toBe(200)

        const data = await response.json()
        expect(Array.isArray(data)).toBe(true)

        if (data.length > 0) {
          expect(typeof data[0].hour).toBe("string")
          expect(typeof data[0].tokens).toBe("number")
          expect(typeof data[0].cost).toBe("number")
        }
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/timeseries/daily returns daily usage data with default 30 days", async () => {
      const root = createTempDir("tauroboros-stats-daily-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "api-daily-session",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        db.createSessionMessage({
          sessionId: "api-daily-session",
          timestamp: now - 86400,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "test" },
          totalTokens: 5000,
          costTotal: 0.25,
        })

        const response = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/daily`)
        expect(response.status).toBe(200)

        const data = await response.json()
        expect(Array.isArray(data)).toBe(true)

        if (data.length > 0) {
          expect(typeof data[0].date).toBe("string")
          expect(typeof data[0].tokens).toBe("number")
          expect(typeof data[0].cost).toBe("number")
        }
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/timeseries/daily respects days query parameter", async () => {
      const root = createTempDir("tauroboros-stats-daily-days-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        const now = Math.floor(Date.now() / 1000)

        db.createWorkflowSession({
          id: "api-daily-days-session",
          sessionKind: "task",
          cwd: "/tmp/work",
        })

        // Add message 5 days ago
        db.createSessionMessage({
          sessionId: "api-daily-days-session",
          timestamp: now - 86400 * 5,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "5 days ago" },
          totalTokens: 1000,
          costTotal: 0.05,
        })

        // Add message 20 days ago
        db.createSessionMessage({
          sessionId: "api-daily-days-session",
          timestamp: now - 86400 * 20,
          role: "assistant",
          messageType: "assistant_response",
          contentJson: { text: "20 days ago" },
          totalTokens: 2000,
          costTotal: 0.10,
        })

        // Query with 7 days - should only get 1 entry
        const response7d = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/daily?days=7`)
        const data7d = await response7d.json()
        expect(Array.isArray(data7d)).toBe(true)

        // Query with 30 days - should get both entries
        const response30d = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/daily?days=30`)
        const data30d = await response30d.json()
        expect(Array.isArray(data30d)).toBe(true)
        expect(data30d.length).toBeGreaterThanOrEqual(data7d.length)
      } finally {
        server.stop()
      }
    })

    it("GET /api/stats/timeseries/daily clamps days parameter to valid range", async () => {
      const root = createTempDir("tauroboros-stats-daily-clamp-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        // Test with days=0 (should clamp to 1)
        const response0 = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/daily?days=0`)
        expect(response0.status).toBe(200)

        // Test with days=500 (should clamp to 365)
        const response500 = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/daily?days=500`)
        expect(response500.status).toBe(200)

        const data = await response500.json()
        expect(Array.isArray(data)).toBe(true)
      } finally {
        server.stop()
      }
    })

    it("handles empty database gracefully for all stats endpoints", async () => {
      const root = createTempDir("tauroboros-stats-empty-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      const port = await server.start(0)

      try {
        // Test all endpoints with empty database
        const usageRes = await fetch(`http://127.0.0.1:${port}/api/stats/usage`)
        expect(usageRes.status).toBe(200)
        const usageData = await usageRes.json()
        expect(usageData.totalTokens).toBe(0)
        expect(usageData.totalCost).toBe(0)

        const tasksRes = await fetch(`http://127.0.0.1:${port}/api/stats/tasks`)
        expect(tasksRes.status).toBe(200)
        const tasksData = await tasksRes.json()
        expect(tasksData.completed).toBe(0)
        expect(tasksData.failed).toBe(0)

        const modelsRes = await fetch(`http://127.0.0.1:${port}/api/stats/models`)
        expect(modelsRes.status).toBe(200)
        const modelsData = await modelsRes.json()
        expect(modelsData.plan).toEqual([])
        expect(modelsData.execution).toEqual([])
        expect(modelsData.review).toEqual([])

        const durationRes = await fetch(`http://127.0.0.1:${port}/api/stats/duration`)
        expect(durationRes.status).toBe(200)
        const durationData = await durationRes.json()
        expect(durationData).toBe(0)

        const hourlyRes = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/hourly`)
        expect(hourlyRes.status).toBe(200)
        const hourlyData = await hourlyRes.json()
        expect(hourlyData).toEqual([])

        const dailyRes = await fetch(`http://127.0.0.1:${port}/api/stats/timeseries/daily`)
        expect(dailyRes.status).toBe(200)
        const dailyData = await dailyRes.json()
        expect(dailyData).toEqual([])
      } finally {
        server.stop()
      }
    })
  })
})
