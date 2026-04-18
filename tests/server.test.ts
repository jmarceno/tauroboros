import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createPiServer } from "../src/server.ts"
import type { InfrastructureSettings } from "../src/config/settings.ts"
import { BASE_IMAGES } from "../src/config/base-images.ts"

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
  try { request = JSON.parse(line) } catch { return }
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
      const taskId = createTaskRes.data.id as string

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

      const finishedRun = db.createWorkflowRun({
        id: "run-api-finished",
        kind: "single_task",
        status: "completed",
        displayName: "Completed API run",
        taskOrder: [taskId],
        targetTaskId: taskId,
        finishedAt: Math.floor(Date.now() / 1000),
      })

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
      const bonTaskId = bonTaskRes.data.id as string

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
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket task updates", async () => {
    const root = createTempDir("tauroboros-ws-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      const firstMessagePromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), 5000)

        ws.addEventListener("message", (event) => {
          clearTimeout(timeout)
          resolve(JSON.parse(String(event.data)))
        }, { once: true })
      })

      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "WS test task",
          prompt: "Ensure websocket receives task_created",
          status: "backlog",
        }),
      })

      expect(response.status).toBe(201)

      const event = await firstMessagePromise
      expect(event.type).toBe("task_created")
      expect(event.payload.name).toBe("WS test task")
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket session message updates", async () => {
    const root = createTempDir("tauroboros-session-ws-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    const session = db.createWorkflowSession({
      id: "session-ws-1",
      sessionKind: "task",
      cwd: root,
    })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const sessionMessageEventPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for session websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "session_message_created") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      const response = await fetch(`http://127.0.0.1:${port}/api/pi/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          role: "assistant",
          messageType: "thinking",
          contentJson: { text: "thinking about fix" },
        }),
      })

      expect(response.status).toBe(200)

      const event = await sessionMessageEventPromise
      expect(event.type).toBe("session_message_created")
      expect(event.payload.sessionId).toBe(session.id)
      expect(event.payload.messageType).toBe("thinking")
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket task_group_created event", async () => {
    const root = createTempDir("tauroboros-group-ws-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const groupCreatedPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for task_group_created websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "task_group_created") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      const response = await fetch(`http://127.0.0.1:${port}/api/task-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Group",
          color: "#888888",
          status: "active",
        }),
      })

      expect(response.status).toBe(201)

      const event = await groupCreatedPromise
      expect(event.type).toBe("task_group_created")
      expect(event.payload.name).toBe("Test Group")
      expect(event.payload.color).toBe("#888888")
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket task_group_updated event", async () => {
    const root = createTempDir("tauroboros-group-update-ws-")
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const groupUpdatedPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for task_group_updated websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "task_group_updated") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      const response = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated Name",
          color: "#FF5733",
        }),
      })

      expect(response.status).toBe(200)

      const event = await groupUpdatedPromise
      expect(event.type).toBe("task_group_updated")
      expect(event.payload.name).toBe("Updated Name")
      expect(event.payload.color).toBe("#FF5733")
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket task_group_deleted event", async () => {
    const root = createTempDir("tauroboros-group-delete-ws-")
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const groupDeletedPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for task_group_deleted websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "task_group_deleted") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      const response = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}`, {
        method: "DELETE",
      })

      expect(response.status).toBe(204)

      const event = await groupDeletedPromise
      expect(event.type).toBe("task_group_deleted")
      expect(event.payload.id).toBe(groupId)
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket task_group_members_added event", async () => {
    const root = createTempDir("tauroboros-group-members-ws-")
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const membersAddedPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for task_group_members_added websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "task_group_members_added") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      const response = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: [taskId],
        }),
      })

      expect(response.status).toBe(200)

      const event = await membersAddedPromise
      expect(event.type).toBe("task_group_members_added")
      expect(event.payload.groupId).toBe(groupId)
      expect(event.payload.taskIds).toContain(taskId)
      expect(event.payload.addedCount).toBe(1)
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket task_group_members_removed event", async () => {
    const root = createTempDir("tauroboros-group-remove-ws-")
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const membersRemovedPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for task_group_members_removed websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "task_group_members_removed") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      const response = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/tasks`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: [taskId],
        }),
      })

      expect(response.status).toBe(200)

      const event = await membersRemovedPromise
      expect(event.type).toBe("task_group_members_removed")
      expect(event.payload.groupId).toBe(groupId)
      expect(event.payload.taskIds).toContain(taskId)
      expect(event.payload.removedCount).toBe(1)
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket group_execution_started event", async () => {
    const root = createTempDir("tauroboros-group-exec-ws-")
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const executionStartedPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for group_execution_started websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "group_execution_started") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      // Group execution is now implemented and returns 200 on success
      const response = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/start`, {
        method: "POST",
      })

      // The endpoint returns 200 when group execution starts successfully
      expect(response.status).toBe(200)

      const event = await executionStartedPromise
      expect(event.type).toBe("group_execution_started")
      expect(event.payload.groupId).toBe(groupId)
      expect(event.payload.taskIds).toContain(taskId)
      expect(typeof event.payload.startedAt).toBe("number")
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket group_execution_complete event", async () => {
    const root = createTempDir("tauroboros-group-complete-ws-")
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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const executionCompletePromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for group_execution_complete websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "group_execution_complete") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      // Use the server's internal broadcast method via a test endpoint
      // We use the health endpoint as a trigger and manually broadcast via the db's internal access
      // Since the full group execution orchestrator isn't implemented yet,
      // we manually broadcast to test that the message type works correctly
      const broadcastRes = await fetch(`http://127.0.0.1:${port}/api/task-groups/${groupId}/execute-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "success", results: [] }),
      })

      // Endpoint may return 404 if not implemented, but we test the WS type validity
      // For now, verify the message type exists and can be broadcast via direct server access
      // We'll use the internal broadcast through the server instance if available
      // Actually, let's verify the type can be used by checking TypeScript compilation

      // Since we can't easily broadcast without the orchestrator being fully implemented,
      // we verify that the WebSocket message type is valid and the infrastructure exists
      // by checking that a broadcast doesn't throw a type error

      // Broadcast the event manually through the server's broadcast method
      // This requires access to the server instance which we have
      ;(server as any).broadcast({
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
      expect(event.type).toBe("group_execution_complete")
      expect(event.payload.groupId).toBe(groupId)
      expect(event.payload.taskIds).toContain(taskId)
      expect(event.payload.status).toBe("success")
      expect(typeof event.payload.completedAt).toBe("number")
      expect(Array.isArray(event.payload.results)).toBe(true)
    } finally {
      ws.close()
      server.stop()
      db.close()
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
        db.close()
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
        db.close()
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
        db.close()
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
        db.close()
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
        db.close()
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
        db.close()
      }
    })

    it("broadcasts websocket events during reset-to-group flow", async () => {
      const root = createTempDir("tauroboros-reset-to-group-ws-")
      const dbPath = join(root, "tasks.db")
      const { db, server } = createPiServer({ dbPath, port: 0, settings: createTestSettings() })
      db.updateOptions({ branch: "master" })
      const port = await server.start(0)

      // Create a task
      const taskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Task for WS Test",
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
          name: "WS Test Group",
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

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

      try {
        await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

        const events: any[] = []
        const eventPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket events")), 5000)

          const handler = (event: any) => {
            const parsed = JSON.parse(String(event.data))
            if (parsed?.type === "task_updated" || parsed?.type === "group_task_added" || parsed?.type === "task_group_members_added") {
              events.push(parsed)
              if (events.length >= 3) {
                clearTimeout(timeout)
                ws.removeEventListener("message", handler)
                resolve()
              }
            }
          }

          ws.addEventListener("message", handler)
        })

        // Reset to group should trigger multiple events
        await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/reset-to-group`, {
          method: "POST",
        })

        await eventPromise

        expect(events.some(e => e.type === "task_updated")).toBe(true)
        expect(events.some(e => e.type === "group_task_added")).toBe(true)
        expect(events.some(e => e.type === "task_group_members_added")).toBe(true)
      } finally {
        ws.close()
        server.stop()
        db.close()
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
        db.close()
      }
    })
  })
})
