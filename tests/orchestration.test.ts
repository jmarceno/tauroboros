import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Effect } from "effect"
import { DEFAULT_INFRASTRUCTURE_SETTINGS, type InfrastructureSettings } from "../src/config/settings.ts"
import { PiKanbanDB } from "../src/db.ts"
import { PiOrchestrator } from "../src/orchestrator.ts"

const runEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)

function createTestSettings(mockPiBin: string): InfrastructureSettings {
  return {
    ...DEFAULT_INFRASTRUCTURE_SETTINGS,
    workflow: {
      ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow,
      container: {
        ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow.container,
        enabled: false,
        piBin: mockPiBin,
        piArgs: "",
      },
    },
  }
}

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim()
}

function initGitRepo(root: string): void {
  git(root, ["init"])
  git(root, ["checkout", "-b", "master"])
  writeFileSync(join(root, "README.md"), "# orchestration test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string): string {
  const filePath = join(root, "mock-pi-orchestration.js")
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
  const prompt = String(request?.message || "")

  if (type === "set_model" || type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: type, success: true }))
    return
  }

  if (type === "prompt") {
    const text = prompt.includes("Task A")
      ? "Completed Task A implementation"
      : prompt.includes("Task B")
        ? "Completed Task B implementation"
        : "Completed task"
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }

  if (type === "get_messages") {
    console.log(JSON.stringify({ id, type: "response", command: "get_messages", success: true, data: { messages: [{ role: "assistant", text: "Completed task" }] } }))
    return
  }

  console.log(JSON.stringify({ id, type: "response", command: type || "unknown", success: true, data: {} }))
})
`,
    "utf-8",
  )
  chmodSync(filePath, 0o755)
  return filePath
}

async function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for condition")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("PiOrchestrator dependency-aware workflow runs", () => {
  it("executes dependency chains in order for targeted task runs", async () => {
    const root = createTempDir("tauroboros-orchestration-")
    initGitRepo(root)
    const mockPiBin = createMockPiBinary(root)
    const settings = createTestSettings(mockPiBin)

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master", executionModel: "openai/gpt-4", planModel: "openai/gpt-4" })

    const taskA = db.createTask({
      id: "orch-a",
      name: "Task A",
      prompt: "Implement Task A",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [],
    })
    const taskB = db.createTask({
      id: "orch-b",
      name: "Task B",
      prompt: "Implement Task B after A",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [taskA.id],
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root, settings)
    const run = await runEffect(orchestrator.startSingle(taskB.id))

    await waitFor(() => {
      const latest = db.getWorkflowRun(run.id)
      return Boolean(latest && (latest.status === "completed" || latest.status === "failed"))
    })

    const finalRun = db.getWorkflowRun(run.id)
    expect(finalRun?.status).toBe("completed")
    expect(finalRun?.taskOrder).toEqual([taskA.id, taskB.id])
    expect(finalRun?.currentTaskIndex).toBeGreaterThanOrEqual(0)

    const finalA = db.getTask(taskA.id)
    const finalB = db.getTask(taskB.id)
    expect(finalA?.status).toBe("done")
    expect(finalB?.status).toBe("done")
    expect(finalA?.completedAt).not.toBeNull()
    expect(finalB?.completedAt).not.toBeNull()
    expect((finalA?.completedAt ?? 0) <= (finalB?.completedAt ?? 0)).toBe(true)

    const sessionsA = db.getWorkflowSessionsByTask(taskA.id)
    const sessionsB = db.getWorkflowSessionsByTask(taskB.id)
    expect(sessionsA.length).toBeGreaterThan(0)
    expect(sessionsB.length).toBeGreaterThan(0)

  })

  it("deploys before-workflow-start templates into the run and executes them", async () => {
    const root = createTempDir("tauroboros-auto-deploy-before-")
    initGitRepo(root)
    const mockPiBin = createMockPiBinary(root)
    const settings = createTestSettings(mockPiBin)

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master", executionModel: "openai/gpt-4", planModel: "openai/gpt-4" })

    const template = db.createTask({
      id: "tpl-before",
      name: "Before Workflow Template",
      prompt: "Run before workflow starts",
      status: "template",
      review: false,
      autoCommit: false,
      autoDeploy: true,
      autoDeployCondition: "before_workflow_start",
      deleteWorktree: true,
      requirements: [],
    })

    const backlog = db.createTask({
      id: "main-backlog",
      name: "Main Backlog Task",
      prompt: "Main workflow task",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [],
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root, settings)
    const run = await runEffect(orchestrator.startAll())

    await waitFor(() => {
      const latest = db.getWorkflowRun(run.id)
      return Boolean(latest && (latest.status === "completed" || latest.status === "failed"))
    })

    const deployedTask = db
      .getTasks()
      .find((task) => task.id !== template.id && task.name === template.name && task.status === "done")

    expect(deployedTask).toBeTruthy()

    const finalRun = db.getWorkflowRun(run.id)
    expect(finalRun?.status).toBe("completed")
    expect(finalRun?.taskOrder[0]).toBe(deployedTask?.id)
    expect(finalRun?.taskOrder.includes(backlog.id)).toBe(true)

  })

  it("triggers workflow_done auto-deploy tasks only from workflow runs (not single-task runs)", async () => {
    const root = createTempDir("tauroboros-auto-deploy-done-")
    initGitRepo(root)
    const mockPiBin = createMockPiBinary(root)
    const settings = createTestSettings(mockPiBin)

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master", executionModel: "openai/gpt-4", planModel: "openai/gpt-4" })

    db.createTask({
      id: "tpl-done",
      name: "Workflow Done Template",
      prompt: "Run when workflow finishes successfully",
      status: "template",
      review: false,
      autoCommit: false,
      autoDeploy: true,
      autoDeployCondition: "workflow_done",
      deleteWorktree: true,
      requirements: [],
    })

    const backlog = db.createTask({
      id: "done-source",
      name: "Done Source Task",
      prompt: "Source task for workflow_done trigger",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [],
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root, settings)
    const workflowRun = await runEffect(orchestrator.startAll())

    await waitFor(() => {
      const completedRuns = db.getWorkflowRuns().filter((candidate) => candidate.status === "completed")
      return completedRuns.length >= 2
    })

    const completedRuns = db.getWorkflowRuns().filter((candidate) => candidate.status === "completed")
    expect(completedRuns.some((candidate) => candidate.id === workflowRun.id && candidate.kind === "all_tasks")).toBe(true)
    expect(completedRuns.some((candidate) => candidate.kind === "single_task")).toBe(true)

    const autoDeployedDoneTask = db
      .getTasks()
      .find((task) => task.name === "Workflow Done Template" && task.status === "done")
    expect(autoDeployedDoneTask).toBeTruthy()

    const noTriggerSingle = db.createTask({
      id: "single-source",
      name: "Single Source Task",
      prompt: "Single task run should not trigger auto-deploy checks",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [],
    })

    const beforeSingleTaskCount = db.getTasks().length
    const singleRun = await runEffect(orchestrator.startSingle(noTriggerSingle.id))

    await waitFor(() => {
      const latest = db.getWorkflowRun(singleRun.id)
      return Boolean(latest && (latest.status === "completed" || latest.status === "failed"))
    })

    const afterSingleTaskCount = db.getTasks().length
    expect(afterSingleTaskCount).toBe(beforeSingleTaskCount)

  })

  it("checks auto-deploy conditions for group runs", async () => {
    const root = createTempDir("tauroboros-auto-deploy-group-")
    initGitRepo(root)
    const mockPiBin = createMockPiBinary(root)
    const settings = createTestSettings(mockPiBin)

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master", executionModel: "openai/gpt-4", planModel: "openai/gpt-4" })

    db.createTask({
      id: "tpl-group-done",
      name: "Group Done Template",
      prompt: "Run after group workflow success",
      status: "template",
      review: false,
      autoCommit: false,
      autoDeploy: true,
      autoDeployCondition: "workflow_done",
      deleteWorktree: true,
      requirements: [],
    })

    const groupTask = db.createTask({
      id: "group-task-1",
      name: "Grouped Task",
      prompt: "Task in virtual workflow",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [],
    })

    const group = db.createTaskGroup({ name: "Virtual Workflow" })
    db.addTasksToGroup(group.id, [groupTask.id])

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root, settings)
    const run = await runEffect(orchestrator.startGroup(group.id))

    await waitFor(() => {
      const completedRuns = db.getWorkflowRuns().filter((candidate) => candidate.status === "completed")
      return completedRuns.length >= 2
    })

    const completedRuns = db.getWorkflowRuns().filter((candidate) => candidate.status === "completed")
    expect(completedRuns.some((candidate) => candidate.id === run.id && candidate.kind === "group_tasks")).toBe(true)
    expect(completedRuns.some((candidate) => candidate.kind === "single_task")).toBe(true)

    const autoTask = db.getTasks().find((task) => task.name === "Group Done Template" && task.status === "done")
    expect(autoTask).toBeTruthy()

  })
})
