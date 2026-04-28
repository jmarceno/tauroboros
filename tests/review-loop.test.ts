import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Effect } from "effect"
import { PiKanbanDB } from "../src/backend-ts/db.ts"
import { PiOrchestrator } from "../src/backend-ts/orchestrator.ts"
import { InfrastructureSettings, DEFAULT_INFRASTRUCTURE_SETTINGS } from "../src/backend-ts/config/settings.ts"

const runEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)

const tempDirs: string[] = []
const TEST_MODEL = "openai/gpt-4"

function createTestSettings(mockPiPath: string): InfrastructureSettings {
  return {
    ...DEFAULT_INFRASTRUCTURE_SETTINGS,
    workflow: {
      ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow,
      container: {
        ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow.container,
        enabled: false,
        piBin: mockPiPath,
        piArgs: "",
      },
    },
  }
}

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
  writeFileSync(join(root, "README.md"), "# review loop test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string, mode: "one_gap_then_pass" | "always_gaps"): string {
  const filePath = join(root, "mock-pi-review.js")
  const counterPath = join(root, "review-counter.txt")

  const mockScript = `#!/usr/bin/env bun
import { createInterface } from "readline"
import { readFileSync, writeFileSync } from "fs"
const mode = ${JSON.stringify(mode)}
const counterPath = ${JSON.stringify(counterPath)}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try { request = JSON.parse(line) } catch {
    return
  }
  const id = request?.id
  const type = request?.type
  const message = String(request?.message || "")

  // Handle set_model and set_thinking_level
  if (type === "set_model" || type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: type, success: true }))
    return
  }

  // Handle prompt command
  if (type === "prompt") {
    // Send success response first
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))

    // Then send message_update events and agent_end
    if (message.includes("Review the current repository state") || message.includes("Review the task review file at:")) {
      let reviewCount = 0
      try { reviewCount = Number(readFileSync(counterPath, "utf-8")) || 0 } catch {}
      reviewCount += 1
      writeFileSync(counterPath, String(reviewCount), "utf-8")

      let textContent = ""
      if (mode === "always_gaps") {
        textContent = JSON.stringify({ status: "gaps_found", summary: "Still missing pieces", gaps: ["Gap A"], recommendedPrompt: "Fix Gap A" })
      } else {
        const payload = reviewCount === 1
          ? { status: "gaps_found", summary: "Need one fix", gaps: ["Missing guard"], recommendedPrompt: "Add the missing guard and tests" }
          : { status: "pass", summary: "Looks good", gaps: [], recommendedPrompt: "" }
        textContent = JSON.stringify(payload)
      }

      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text: textContent } }))
      console.log(JSON.stringify({ type: "agent_end" }))
      return
    }
    if (message.includes("Address the issues found during review")) {
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text: "Applied review fixes" } }))
      console.log(JSON.stringify({ type: "agent_end" }))
      return
    }
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text: "Implemented baseline task" } }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }

  // Handle get_messages
  if (type === "get_messages") {
    console.log(JSON.stringify({ id, type: "response", command: "get_messages", success: true, data: { messages: [{ text: "snapshot" }] } }))
    return
  }

  // Default response for unknown commands
  console.log(JSON.stringify({ id, type: "response", command: type, success: true }))
})`

  writeFileSync(filePath, mockScript, "utf-8")
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

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("review loop", () => {
  it("runs review scratch sessions, sends fix prompts, and completes", async () => {
    const root = createTempDir("tauroboros-review-")
    initGitRepo(root)
    const settings = createTestSettings(createMockPiBinary(root, "one_gap_then_pass"))

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master", executionModel: TEST_MODEL, reviewModel: TEST_MODEL })
    const task = db.createTask({
      id: "review-1",
      name: "Review loop task",
      prompt: "Implement review flow",
      status: "backlog",
      review: true,
      autoCommit: false,
      deleteWorktree: false,
      planmode: false,
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root, settings)
    await runEffect(orchestrator.startSingle(task.id))

    await waitFor(() => {
      const current = db.getTask(task.id)
      return Boolean(current && (current.status === "done" || current.status === "failed" || current.status === "stuck"))
    })

    const current = db.getTask(task.id)
    expect(current?.status).toBe("done")
    // reviewCount is 2 because: first review found gaps (count=1), fix applied, second review passed (count=2)
    expect(current?.reviewCount).toBe(2)
    expect(current?.reviewActivity).toBe("idle")
    expect(current?.agentOutput.includes("[review-fix-1]")).toBe(true)
    const sessions = db.getWorkflowSessionsByTask(task.id)
    expect(sessions.some((session) => session.sessionKind === "review_scratch")).toBe(true)

    const reviewFilePath = join(String(current?.worktreeDir), ".pi", "tauroboros", `review-${task.id}.md`)
    expect(existsSync(reviewFilePath)).toBe(false)
  })

  it("enforces review limit and marks task stuck", async () => {
    const root = createTempDir("tauroboros-review-limit-")
    initGitRepo(root)
    const settings = createTestSettings(createMockPiBinary(root, "always_gaps"))

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ maxReviews: 1, branch: "master", executionModel: TEST_MODEL, reviewModel: TEST_MODEL })

    const task = db.createTask({
      id: "review-3",
      name: "Review max limit",
      prompt: "Implement max review scenario",
      status: "backlog",
      review: true,
      autoCommit: false,
      planmode: false,
    })
    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root, settings)
    await runEffect(orchestrator.startSingle(task.id))

    await waitFor(() => {
      const current = db.getTask(task.id)
      return Boolean(current && (current.status === "stuck" || current.status === "failed"))
    })

    const current = db.getTask(task.id)
    expect(current?.status).toBe("stuck")
    expect(current?.reviewCount).toBe(1)
    expect(current?.errorMessage?.includes("Max reviews (1) reached")).toBe(true)
  })
})
