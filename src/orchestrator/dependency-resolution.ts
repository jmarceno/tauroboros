import { Effect } from "effect"
import type { Task, WorkflowRun } from "../types.ts"
import type { OrchestratorOperationError } from "./errors.ts"
import { OrchestratorOperationError as OrchestratorOperationErrorClass } from "./errors.ts"
import { isTaskExecutable } from "../execution-plan.ts"

/**
 * Interface for dependency resolution services.
 * This allows the module to work without direct database access.
 */
export interface DependencyResolutionContext {
  getTask(taskId: string): Task | null
  getWorkflowRun(runId: string): WorkflowRun | null
  getTasks(): Task[]
  isRunActiveStatus(status: WorkflowRun["status"]): boolean
  taskRunLookup: Map<string, string>
}

/**
 * Check if a dependency is satisfied by another active run.
 */
export function isDependencySatisfiedByAnotherRun(
  taskId: string,
  context: DependencyResolutionContext,
): boolean {
  const runId = context.taskRunLookup.get(taskId)
  if (!runId) return false
  const run = context.getWorkflowRun(runId)
  return Boolean(run && context.isRunActiveStatus(run.status))
}

/**
 * Resolve execution tasks with their active dependencies.
 * Returns tasks in dependency order, failing if any dependency is not runnable.
 */
export function resolveExecutionTasksWithActiveDependencies(
  allTasks: Task[],
  taskId: string,
  context: DependencyResolutionContext,
): Effect.Effect<Task[], OrchestratorOperationError> {
  return Effect.gen(function* () {
    const taskMap = new Map(allTasks.map((task) => [task.id, task]))
    const ordered: Task[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()
    let error: OrchestratorOperationError | null = null

    const visit = (candidateId: string, isTarget = false): boolean => {
      if (error) return false
      if (visiting.has(candidateId)) {
        error = new OrchestratorOperationErrorClass({
          operation: "resolveExecutionTasksWithActiveDependencies",
          message: `Circular dependency detected while resolving ${candidateId}`,
        })
        return false
      }
      if (visited.has(candidateId)) return true

      const candidate = taskMap.get(candidateId)
      if (!candidate) {
        error = new OrchestratorOperationErrorClass({
          operation: "resolveExecutionTasksWithActiveDependencies",
          message: `Task not found: ${candidateId}`,
        })
        return false
      }

      visiting.add(candidateId)
      for (const depId of candidate.requirements) {
        const dependency = taskMap.get(depId)
        if (!dependency) continue
        if (dependency.status === "done" || isDependencySatisfiedByAnotherRun(depId, context)) {
          continue
        }
        if (dependency.status === "failed" || dependency.status === "stuck") {
          error = new OrchestratorOperationErrorClass({
            operation: "resolveExecutionTasksWithActiveDependencies",
            message: `Dependency "${dependency.name}" is not done (status: ${dependency.status})`,
          })
          return false
        }
        if (!isTaskExecutable(dependency)) {
          error = new OrchestratorOperationErrorClass({
            operation: "resolveExecutionTasksWithActiveDependencies",
            message: isTarget
              ? `Task "${candidate.name}" is blocked by dependency "${dependency.name}" in status "${dependency.status}"`
              : `Dependency "${dependency.name}" is not done and cannot run from status "${dependency.status}" (phase: ${dependency.executionPhase})`,
          })
          return false
        }
        if (!visit(depId)) return false
      }
      visiting.delete(candidateId)
      visited.add(candidateId)

      if (candidate.status === "done") return true
      if (!isTaskExecutable(candidate)) {
        error = new OrchestratorOperationErrorClass({
          operation: "resolveExecutionTasksWithActiveDependencies",
          message: isTarget
            ? `Task "${candidate.name}" is not runnable from status "${candidate.status}" (phase: ${candidate.executionPhase})`
            : `Dependency "${candidate.name}" is not done and cannot run from status "${candidate.status}" (phase: ${candidate.executionPhase})`,
        })
        return false
      }
      ordered.push(candidate)
      return true
    }

    visit(taskId, true)
    
    if (error) {
      return yield* Effect.fail(error)
    }
    
    return ordered
  })
}

/**
 * Get execution graph tasks with active dependencies.
 * Selects all tasks that can be executed based on their dependencies.
 */
export function getExecutionGraphTasksWithActiveDependencies(
  tasks: Task[],
  context: DependencyResolutionContext,
): Effect.Effect<Task[], OrchestratorOperationError> {
  return Effect.gen(function* () {
    const taskMap = new Map(tasks.map((task) => [task.id, task]))
    const selectedIds = new Set<string>()
    let madeProgress = true

    while (madeProgress) {
      madeProgress = false

      for (const task of tasks) {
        if (selectedIds.has(task.id) || task.status === "done" || !isTaskExecutable(task)) {
          continue
        }

        const canQueue = task.requirements.every((depId) => {
          const dependency = taskMap.get(depId)
          if (!dependency) return true
          if (dependency.status === "failed" || dependency.status === "stuck") return false
          return dependency.status === "done" || selectedIds.has(depId) || isDependencySatisfiedByAnotherRun(depId, context)
        })

        if (!canQueue) continue

        selectedIds.add(task.id)
        madeProgress = true
      }
    }

    const result: Task[] = []
    for (const taskId of selectedIds) {
      const task = taskMap.get(taskId)
      if (!task) {
        return yield* new OrchestratorOperationErrorClass({
          operation: "getExecutionGraphTasksWithActiveDependencies",
          message: `Task not found while building execution graph: ${taskId}`,
        })
      }
      result.push(task)
    }
    return result
  })
}

/**
 * Validate that all tasks in the given array exist in the database.
 * Returns the loaded Task objects.
 */
export function validateGroupTasksExist(
  taskIds: string[],
  getTask: (taskId: string) => Task | null,
): Effect.Effect<Task[], OrchestratorOperationError> {
  return Effect.gen(function* () {
    const tasks: Task[] = []
    const missingIds: string[] = []

    for (const taskId of taskIds) {
      const task = getTask(taskId)
      if (!task) {
        missingIds.push(taskId)
      } else {
        tasks.push(task)
      }
    }

    if (missingIds.length > 0) {
      return yield* new OrchestratorOperationErrorClass({
        operation: "validateGroupTasksExist",
        message: `One or more tasks in group were not found in database: ${missingIds.join(', ')}`,
      })
    }

    return tasks
  })
}

/**
 * Find dependencies that are outside the group.
 * Returns array of objects with task and its external dependency.
 */
export function findExternalDependencies(
  groupTasks: Task[],
  allTasks: Task[],
): Array<{ task: Task; dependency: string }> {
  const groupTaskIds = new Set(groupTasks.map((t) => t.id))
  const allTaskIds = new Set(allTasks.map((t) => t.id))
  const externalDeps: Array<{ task: Task; dependency: string }> = []

  for (const task of groupTasks) {
    for (const depId of task.requirements) {
      // Check if dependency is NOT in the group AND is a valid task (exists in allTasks)
      if (!groupTaskIds.has(depId) && allTaskIds.has(depId)) {
        externalDeps.push({ task, dependency: depId })
      }
    }
  }

  return externalDeps
}
