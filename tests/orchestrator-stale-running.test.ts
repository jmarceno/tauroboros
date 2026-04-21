import { beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { PiKanbanDB } from "../src/db.ts"
import { PiOrchestrator } from "../src/orchestrator.ts"
import { DEFAULT_INFRASTRUCTURE_SETTINGS, type InfrastructureSettings } from "../src/config/settings.ts"

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

describe("PiOrchestrator multi-workflow scheduling", () => {
  let db: PiKanbanDB
  let orchestrator: PiOrchestrator

  beforeEach(() => {
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

    const queue1 = orchestrator.getRunQueueStatus(run1.id)
    const queue2 = orchestrator.getRunQueueStatus(run2.id)

    expect(queue1.queuedTasks).toBe(1)
    expect(queue1.executingTasks).toBe(0)
    expect(queue1.completedTasks).toBe(0)

    expect(queue2.queuedTasks).toBe(1)
    expect(queue2.executingTasks).toBe(0)
    expect(queue2.completedTasks).toBe(0)
  })

  it("returns global slot utilization", async () => {
    const task1 = db.createTask({ id: "slot-1", name: "Slot 1", prompt: "s1", status: "backlog", review: false })
    await runEffect(orchestrator.startSingle(task1.id))

    const slots = orchestrator.getSlotUtilization()

    expect(slots.maxSlots).toBe(2)
    expect(slots.usedSlots).toBe(0)
    expect(slots.availableSlots).toBe(2)
    expect(slots.tasks.length).toBe(0)
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
