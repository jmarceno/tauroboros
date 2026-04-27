import { beforeEach, afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { PiKanbanDB } from "../src/db.ts"
import { PiOrchestrator } from "../src/orchestrator.ts"
import { DEFAULT_INFRASTRUCTURE_SETTINGS, type InfrastructureSettings } from "../src/config/settings.ts"
import { execFileSync } from "child_process"
import { existsSync } from "fs"

const runEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)

function createSettings(): InfrastructureSettings {
  return {
    ...DEFAULT_INFRASTRUCTURE_SETTINGS,
    workflow: {
      ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow,
      container: {
        ...DEFAULT_INFRASTRUCTURE_SETTINGS.workflow.container,
        enabled: false,
      },
    },
  }
}

function cleanupWorktrees(): void {
  // CRITICAL: Skip cleanup when running inside Tauroboros task container
  // This prevents the AI from deleting worktree metadata during task execution
  if (process.env.TAUROBOROS_TASK_ID || process.env.PI_CODING_AGENT) {
    console.log("[orchestrator-stale-running.test] Skipping worktree cleanup inside Tauroboros container")
    return
  }
  
  try {
    // List all worktrees and remove non-main ones
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: process.cwd(),
      encoding: "utf-8",
    })
    
    const worktrees = output.trim().split(/\n\s*\n/)
    for (const block of worktrees) {
      const lines = block.split("\n")
      let worktreePath = ""
      let isMain = false
      
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice("worktree ".length).trim()
        }
        if (line === "bare") {
          isMain = true
        }
      }
      
      // Remove non-main worktrees in the .worktrees directory
      if (worktreePath && !isMain && worktreePath.includes(".worktrees")) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
            cwd: process.cwd(),
            stdio: "pipe",
          })
        } catch {
          // Ignore errors - worktree might already be gone
        }
      }
    }
    
    // Prune any stale worktree references
    execFileSync("git", ["worktree", "prune"], { cwd: process.cwd(), stdio: "pipe" })
  } catch {
    // Ignore cleanup errors
  }
}

describe("PiOrchestrator multi-workflow scheduling", () => {
  let db: PiKanbanDB
  let orchestrator: PiOrchestrator

  beforeEach(() => {
    // Clean up any leftover worktrees from previous test runs
    cleanupWorktrees()
    
    db = new PiKanbanDB(":memory:")
    db.updateOptions({ parallelTasks: 2, branch: "master", executionModel: "openai/gpt-4", planModel: "openai/gpt-4" })

    orchestrator = new PiOrchestrator(
      db,
      () => {},
      (sessionId) => `/#session/${sessionId}`,
      process.cwd(),
      createSettings(),
    )

    // Keep tests deterministic and isolated from worktree/git execution side effects.
    ;(orchestrator as any).triggerScheduling = async () => {}
    ;(orchestrator as any).validateWorkflowImages = async () => ({ valid: true, invalid: [] })
  })

  afterEach(() => {
    // Clean up any worktrees created during tests
    cleanupWorktrees()
  })

  it("allows starting multiple workflows without Already executing", async () => {
    const taskA = db.createTask({ id: "task-a", name: "Task A", prompt: "A", status: "backlog", review: false })
    const taskB = db.createTask({ id: "task-b", name: "Task B", prompt: "B", status: "backlog", review: false })

    const runA = await runEffect(orchestrator.startSingle(taskA.id))
    const runB = await runEffect(orchestrator.startSingle(taskB.id))

    expect(runA.status).toBe("queued")
    expect(runB.status).toBe("queued")
    expect(runA.id).not.toBe(runB.id)
  })

  it("treats active dependency runs as satisfiable when starting a dependent task", async () => {
    const dep = db.createTask({ id: "dep", name: "Dependency", prompt: "dep", status: "backlog", review: false })
    const target = db.createTask({ id: "target", name: "Target", prompt: "target", status: "backlog", requirements: [dep.id], review: false })

    const depRun = await runEffect(orchestrator.startSingle(dep.id))
    const targetRun = await runEffect(orchestrator.startSingle(target.id))

    expect(depRun.status).toBe("queued")
    expect(targetRun.status).toBe("queued")
    expect(targetRun.taskOrder).toEqual([target.id])
  })

  it("reports queued counts for each run", async () => {
    const task1 = db.createTask({ id: "queue-1", name: "Queue 1", prompt: "q1", status: "backlog", review: false })
    const task2 = db.createTask({ id: "queue-2", name: "Queue 2", prompt: "q2", status: "backlog", review: false })

    const run1 = await runEffect(orchestrator.startSingle(task1.id))
    const run2 = await runEffect(orchestrator.startSingle(task2.id))

    const queue1 = await runEffect(orchestrator.getRunQueueStatus(run1.id))
    const queue2 = await runEffect(orchestrator.getRunQueueStatus(run2.id))

    expect(queue1.queuedTasks + queue1.executingTasks + queue1.completedTasks).toBe(1)
    expect(queue1.totalTasks).toBe(1)

    expect(queue2.queuedTasks + queue2.executingTasks + queue2.completedTasks).toBe(1)
    expect(queue2.totalTasks).toBe(1)
  })

  it("returns global slot utilization", async () => {
    const task1 = db.createTask({ id: "slot-1", name: "Slot 1", prompt: "s1", status: "backlog", review: false })
    await runEffect(orchestrator.startSingle(task1.id))

    const slots = await runEffect(orchestrator.getSlotUtilization())

    expect(slots.maxSlots).toBe(2)
    expect(slots.usedSlots).toBeGreaterThanOrEqual(0)
    expect(slots.usedSlots).toBeLessThanOrEqual(slots.maxSlots)
    expect(slots.availableSlots).toBe(slots.maxSlots - slots.usedSlots)
    expect(slots.tasks.length).toBe(slots.usedSlots)
  })

  it("stops a queued run and resets its tasks to backlog", async () => {
    const task1 = db.createTask({ id: "stop-1", name: "Stop 1", prompt: "stop", status: "backlog", review: false })
    const run = await runEffect(orchestrator.startSingle(task1.id))

    await runEffect(orchestrator.stopRun(run.id))

    const updatedRun = db.getWorkflowRun(run.id)
    const updatedTask = db.getTask(task1.id)

    expect(updatedRun?.status).toBe("completed")
    expect(updatedTask?.status).toBe("backlog")
  })
})
