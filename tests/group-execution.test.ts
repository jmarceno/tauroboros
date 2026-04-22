import { describe, it, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { PiKanbanDB } from "../src/db.ts"
import { PiOrchestrator } from "../src/orchestrator.ts"
import type { WorkflowRun } from "../src/types.ts"

const runEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)

// Test-only subclass to expose private methods
class TestableOrchestrator extends PiOrchestrator {
  testValidateGroupTasksExist(taskIds: string[]) {
    return (this as any).validateGroupTasksExist(taskIds)
  }

  testFindExternalDependencies(groupTasks: any[], allTasks: any[]) {
    return (this as any).findExternalDependencies(groupTasks, allTasks)
  }

  testStartGroup(groupId: string): Effect.Effect<WorkflowRun, unknown> {
    return (this as any).startGroup(groupId)
  }
}

describe("Group Execution", () => {
  let db: PiKanbanDB
  let orchestrator: TestableOrchestrator

  beforeEach(() => {
    // Use in-memory database for tests
    db = new PiKanbanDB(":memory:")
    orchestrator = new TestableOrchestrator(
      db,
      () => {}, // broadcast
      (sessionId) => `/#session/${sessionId}`,
      process.cwd(),
      {
        workflow: {
          container: { enabled: false },
          server: { port: 0, dbPath: ":memory:" },
        },
      } as any,
    )
  })

  describe("validateGroupTasksExist", () => {
    it("should return tasks when all exist", async () => {
      const task1 = db.createTask({ id: "task-1", name: "Task 1", prompt: "Test prompt", status: "backlog" })
      const task2 = db.createTask({ id: "task-2", name: "Task 2", prompt: "Test prompt", status: "backlog" })

      const result = await runEffect(orchestrator.testValidateGroupTasksExist(["task-1", "task-2"]))

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe("task-1")
      expect(result[1].id).toBe("task-2")
    })

    it("should throw error when tasks are missing", async () => {
      db.createTask({ id: "task-1", name: "Task 1", prompt: "Test prompt", status: "backlog" })

      try {
        await runEffect(orchestrator.testValidateGroupTasksExist(["task-1", "missing-task"]))
        expect.fail("Should have thrown error")
      } catch (err) {
        expect((err as Error).message).toContain("One or more tasks in group were not found in database: missing-task")
      }
    })
  })

  describe("findExternalDependencies", () => {
    it("should return empty array when all dependencies are within group", () => {
      const task1 = { id: "task-1", name: "Task 1", requirements: [] as string[] }
      const task2 = { id: "task-2", name: "Task 2", requirements: ["task-1"] }
      const groupTasks = [task1, task2]
      const allTasks = [...groupTasks, { id: "other-task", name: "Other", requirements: [] }]

      const result = orchestrator.testFindExternalDependencies(groupTasks as any, allTasks as any)

      expect(result).toHaveLength(0)
    })

    it("should detect external dependencies", () => {
      const externalTask = { id: "external-1", name: "External Task", requirements: [] as string[] }
      const task1 = { id: "task-1", name: "Task 1", requirements: ["external-1"] }
      const groupTasks = [task1]
      const allTasks = [task1, externalTask]

      const result = orchestrator.testFindExternalDependencies(groupTasks as any, allTasks as any)

      expect(result).toHaveLength(1)
      expect(result[0].task.id).toBe("task-1")
      expect(result[0].dependency).toBe("external-1")
    })

    it("should ignore non-existent dependencies", () => {
      // Dependencies that don't exist in allTasks (orphaned) should be ignored
      const task1 = { id: "task-1", name: "Task 1", requirements: ["non-existent-dep"] as string[] }
      const groupTasks = [task1]
      const allTasks = [task1]

      const result = orchestrator.testFindExternalDependencies(groupTasks as any, allTasks as any)

      expect(result).toHaveLength(0)
    })

    it("should detect multiple external dependencies from multiple tasks", () => {
      const external1 = { id: "external-1", name: "External 1", requirements: [] as string[] }
      const external2 = { id: "external-2", name: "External 2", requirements: [] as string[] }
      const task1 = { id: "task-1", name: "Task 1", requirements: ["external-1"] }
      const task2 = { id: "task-2", name: "Task 2", requirements: ["external-1", "external-2"] }
      const groupTasks = [task1, task2]
      const allTasks = [task1, task2, external1, external2]

      const result = orchestrator.testFindExternalDependencies(groupTasks as any, allTasks as any)

      expect(result).toHaveLength(3) // task-1 -> external-1, task-2 -> external-1, task-2 -> external-2
    })
  })

  describe("startGroup integration", () => {
    it("should throw error for non-existent group", async () => {
      try {
        await runEffect(orchestrator.testStartGroup("non-existent-group"))
        expect.fail("Should have thrown error")
      } catch (err) {
        expect((err as Error).message).toContain('Task group with ID "non-existent-group" not found')
      }
    })

    it("should throw error for empty group", async () => {
      const group = db.createTaskGroup({ name: "Empty Group", memberTaskIds: [] })

      try {
        await runEffect(orchestrator.testStartGroup(group.id))
        expect.fail("Should have thrown error")
      } catch (err) {
        expect((err as Error).message).toContain("group has no tasks")
      }
    })

    it("should throw error when tasks have external dependencies", async () => {
      // Create external task that's not in the group
      const externalTask = db.createTask({
        id: "external",
        name: "External Task",
        prompt: "External",
        status: "backlog",
      })

      // Create group task that depends on external task
      const groupTask = db.createTask({
        id: "group-task",
        name: "Group Task",
        prompt: "Group task",
        status: "backlog",
        requirements: ["external"],
      })

      const group = db.createTaskGroup({
        name: "Test Group",
        memberTaskIds: ["group-task"],
      })

      try {
        await runEffect(orchestrator.testStartGroup(group.id))
        expect.fail("Should have thrown error")
      } catch (err) {
        expect((err as Error).message).toContain("external dependencies")
        expect((err as Error).message).toContain("Group Task")
      }
    })

    it("should start group when all dependencies are within group", async () => {
      // Create two tasks: one independent, one dependent on the first
      const task1 = db.createTask({
        id: "task-1",
        name: "Task 1",
        prompt: "First task",
        status: "backlog",
        requirements: [],
      })

      const task2 = db.createTask({
        id: "task-2",
        name: "Task 2",
        prompt: "Second task",
        status: "backlog",
        requirements: ["task-1"], // Depends on task-1 which is in the group
      })

      const group = db.createTaskGroup({
        name: "Dependency Group",
        memberTaskIds: ["task-1", "task-2"],
      })

      // This should fail due to container images not being available in test,
      // but it validates that external dependency check passes
      try {
        await runEffect(orchestrator.testStartGroup(group.id))
        expect.fail("Should have thrown error about container images")
      } catch (err) {
        // Should fail on container image validation, NOT on external dependencies
        const errorMessage = (err as Error).message
        expect(errorMessage).not.toContain("external dependencies")
        // Error should be about container/images, not external deps
        expect(
          errorMessage.includes("container") ||
          errorMessage.includes("image") ||
          errorMessage.includes("No container image available")
        ).toBe(true)
      }
    })
  })
})
