import type { Task } from "./types.ts"
import { getPlanExecutionEligibility } from "./task-state.ts"
import { Effect, Schema } from "effect"

/**
 * Error for execution plan operations
 */
export class ExecutionPlanError extends Schema.TaggedError<ExecutionPlanError>()("ExecutionPlanError", {
  operation: Schema.String,
  message: Schema.String,
  taskId: Schema.optional(Schema.String),
  taskName: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export function getExecutableTasks(tasks: Task[]): Task[] {
  const taskMap = new Map<string, Task>()
  for (const task of tasks) taskMap.set(task.id, task)

  const seen = new Set<string>()
  const executable: Task[] = []

  for (const task of tasks) {
    if (!isTaskExecutable(task)) continue
    if (!areTaskRequirementsDone(task, taskMap)) continue
    if (seen.has(task.id)) continue
    seen.add(task.id)
    executable.push(task)
  }

  return executable
}

export function isTaskExecutable(task: Task): boolean {
  if (!getPlanExecutionEligibility(task).ok) {
    return false
  }

  const isBacklogTask = task.status === "backlog" && task.executionPhase !== "plan_complete_waiting_approval"
  const isApprovedPlanTask = task.executionPhase === "implementation_pending"
  const isRevisionPendingTask = task.executionPhase === "plan_revision_pending"
  return isBacklogTask || isApprovedPlanTask || isRevisionPendingTask
}

function areTaskRequirementsDone(task: Task, taskMap: Map<string, Task>): boolean {
  for (const depId of task.requirements) {
    const dep = taskMap.get(depId)
    if (!dep) {
      // Log warning about invalid dependency and treat it as satisfied
      Effect.runSync(Effect.logWarning(`[execution-plan] Task "${task.name}" has invalid dependency "${depId}" - ignoring`))
      continue
    }
    if (dep.status !== "done") {
      return false
    }
  }
  return true
}

function collectTaskAndDependencyIdsEffect(
  taskId: string,
  taskMap: Map<string, Task>,
  allowedTaskIds?: Set<string>
): Effect.Effect<string[], ExecutionPlanError> {
  return Effect.gen(function* () {
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const ordered: string[] = []

    const visit = (id: string, chain: string[]): Effect.Effect<void, ExecutionPlanError> => {
      return Effect.gen(function* () {
        if (visiting.has(id)) {
          const cycleStart = chain.indexOf(id)
          const cycleIds = cycleStart >= 0 ? [...chain.slice(cycleStart), id] : [...chain, id]
          const cycleNames = cycleIds.map((cycleId) => taskMap.get(cycleId)?.name ?? cycleId)
          return yield* new ExecutionPlanError({
            operation: "collectTaskAndDependencyIds",
            message: `Circular dependency detected: ${cycleNames.join(" -> ")}`,
            taskId: id,
          })
        }

        if (visited.has(id)) return

        const task = taskMap.get(id)
        if (!task) {
          return yield* new ExecutionPlanError({
            operation: "collectTaskAndDependencyIds",
            message: `Task not found: ${id}`,
            taskId: id,
          })
        }

        // Skip dependencies not in allowedTaskIds (new tasks added during execution)
        // Their dependencies are treated as satisfied
        if (allowedTaskIds && !allowedTaskIds.has(id) && id !== taskId) {
          return
        }

        visiting.add(id)
        for (const depId of task.requirements) {
          if (!taskMap.has(depId)) {
            // Log warning about invalid dependency and skip it
            Effect.runSync(Effect.logWarning(`[execution-plan] Task "${task.name}" depends on missing task "${depId}" - ignoring`))
            continue
          }
          // If depId is not in allowedTaskIds, skip it (treat as satisfied)
          if (!(allowedTaskIds && !allowedTaskIds.has(depId))) {
            yield* visit(depId, [...chain, id])
          }
        }
        visiting.delete(id)
        visited.add(id)
        ordered.push(id)
      })
    }

    yield* visit(taskId, [])
    return ordered
  })
}

/** @deprecated Use collectTaskAndDependencyIdsEffect instead */
function collectTaskAndDependencyIds(taskId: string, taskMap: Map<string, Task>, allowedTaskIds?: Set<string>): string[] {
  const result = Effect.runSync(collectTaskAndDependencyIdsEffect(taskId, taskMap, allowedTaskIds).pipe(
    Effect.catchAll((error: ExecutionPlanError) => Effect.fail(new Error(error.message))),
    Effect.either,
  ))
  if (result._tag === "Left") {
    throw result.left
  }
  return result.right
}

export function resolveExecutionTasksEffect(
  tasks: Task[],
  taskId?: string,
  allowedTaskIds?: Set<string>
): Effect.Effect<Task[], ExecutionPlanError> {
  return Effect.gen(function* () {
    if (!taskId) {
      let executable = getExecutableTasks(tasks)
      if (allowedTaskIds) {
        executable = executable.filter(t => allowedTaskIds.has(t.id))
      }
      return executable
    }

    const taskMap = new Map<string, Task>()
    for (const task of tasks) taskMap.set(task.id, task)

    const targetTask = taskMap.get(taskId)
    if (!targetTask) {
      return yield* new ExecutionPlanError({
        operation: "resolveExecutionTasks",
        message: `Task not found: ${taskId}`,
        taskId,
      })
    }

    const candidateIds = yield* collectTaskAndDependencyIdsEffect(taskId, taskMap, allowedTaskIds)
    const executionTasks: Task[] = []

    for (const candidateId of candidateIds) {
      const candidate = taskMap.get(candidateId)!
      if (candidate.status === "done") continue

      // Skip tasks not in the allowed set (new tasks added during execution)
      if (allowedTaskIds && !allowedTaskIds.has(candidateId)) continue

      if (!isTaskExecutable(candidate)) {
        if (candidate.id === taskId) {
          return yield* new ExecutionPlanError({
            operation: "resolveExecutionTasks",
            message: `Task "${candidate.name}" is not runnable from status "${candidate.status}" (phase: ${candidate.executionPhase})`,
            taskId: candidate.id,
            taskName: candidate.name,
          })
        }
        return yield* new ExecutionPlanError({
          operation: "resolveExecutionTasks",
          message: `Dependency "${candidate.name}" is not done and cannot run from status "${candidate.status}" (phase: ${candidate.executionPhase})`,
          taskId: candidate.id,
          taskName: candidate.name,
        })
      }

      executionTasks.push(candidate)
    }

    if (executionTasks.length === 0) {
      return yield* new ExecutionPlanError({
        operation: "resolveExecutionTasks",
        message: `Task "${targetTask.name}" and its dependencies are already done`,
        taskId: targetTask.id,
        taskName: targetTask.name,
      })
    }

    return executionTasks
  })
}

/** @deprecated Use resolveExecutionTasksEffect instead */
export function resolveExecutionTasks(tasks: Task[], taskId?: string, allowedTaskIds?: Set<string>): Task[] {
  const result = Effect.runSync(resolveExecutionTasksEffect(tasks, taskId, allowedTaskIds).pipe(
    Effect.catchAll((error: ExecutionPlanError) => Effect.fail(new Error(error.message))),
    Effect.either,
  ))
  if (result._tag === "Left") {
    throw result.left
  }
  return result.right
}

export function resolveBatchesEffect(
  tasks: Task[],
  parallelLimit: number
): Effect.Effect<Task[][], ExecutionPlanError> {
  return Effect.gen(function* () {
    const taskMap = new Map<string, Task>()
    for (const t of tasks) taskMap.set(t.id, t)

    const inDegree = new Map<string, number>()
    const dependents = new Map<string, string[]>()
    for (const t of tasks) {
      inDegree.set(t.id, 0)
      dependents.set(t.id, [])
    }
    for (const t of tasks) {
      for (const dep of t.requirements) {
        if (taskMap.has(dep)) {
          inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1)
          dependents.get(dep)!.push(t.id)
        }
      }
    }

    const batches: Task[][] = []
    let queue = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0)

    while (queue.length > 0) {
      queue.sort((a, b) => a.idx - b.idx)
      batches.push([...queue])

      const nextQueue: Task[] = []
      for (const t of queue) {
        for (const depId of dependents.get(t.id) ?? []) {
          const newDeg = (inDegree.get(depId) ?? 1) - 1
          inDegree.set(depId, newDeg)
          if (newDeg === 0) {
            nextQueue.push(taskMap.get(depId)!)
          }
        }
      }
      queue = nextQueue
    }

    const totalInBatch = batches.reduce((sum, b) => sum + b.length, 0)
    if (totalInBatch < tasks.length) {
      const stuck = tasks.filter(t => !batches.some(b => b.some(bt => bt.id === t.id)))
      return yield* new ExecutionPlanError({
        operation: "resolveBatches",
        message: `Circular dependency detected among: ${stuck.map(t => t.name).join(", ")}`,
      })
    }

    const finalBatches: Task[][] = []
    for (const batch of batches) {
      if (batch.length <= parallelLimit) {
        finalBatches.push(batch)
      } else {
        for (let i = 0; i < batch.length; i += parallelLimit) {
          finalBatches.push(batch.slice(i, i + parallelLimit))
        }
      }
    }

    return finalBatches
  })
}

/** @deprecated Use resolveBatchesEffect instead */
export function resolveBatches(tasks: Task[], parallelLimit: number): Task[][] {
  const result = Effect.runSync(resolveBatchesEffect(tasks, parallelLimit).pipe(
    Effect.catchAll((error: ExecutionPlanError) => Effect.fail(new Error(error.message))),
    Effect.either,
  ))
  if (result._tag === "Left") {
    throw result.left
  }
  return result.right
}

export interface ExecutionGraph {
  batches: { idx: number; taskIds: string[]; taskNames: string[] }[]
  nodes: {
    id: string
    name: string
    status: string
    requirements: string[]
    expandedWorkerRuns?: number
    expandedReviewerRuns?: number
    hasFinalApplier?: boolean
    estimatedRunCount?: number
  }[]
  edges: { from: string; to: string }[]
  totalTasks: number
  parallelLimit: number
  warnings?: string[]
  pendingApprovals?: {
    id: string
    name: string
    status: string
    awaitingPlanApproval: boolean
    planRevisionCount?: number
  }[]
}

export function resolveDependencyChain(
  targetTaskId: string,
  allTasks: Task[],
  allowedTaskIds?: Set<string>
): Task[] {
  return resolveExecutionTasks(allTasks, targetTaskId, allowedTaskIds)
}

export function getExecutionGraphTasks(tasks: Task[]): Task[] {
  const taskMap = new Map<string, Task>()
  for (const task of tasks) taskMap.set(task.id, task)

  const pendingTasks = tasks.filter(task => task.status !== "done" && isTaskExecutable(task))
  const scheduledIds = new Set<string>()

  let madeProgress = true
  while (madeProgress) {
    madeProgress = false

    for (const task of pendingTasks) {
      if (scheduledIds.has(task.id)) continue

      const requirementsSatisfied = task.requirements.every(depId => {
        const dependency = taskMap.get(depId)
        if (!dependency) {
          // Log warning about invalid dependency and treat it as satisfied
          Effect.runSync(Effect.logWarning(`[execution-plan] Task "${task.name}" has invalid dependency "${depId}" - ignoring`))
          return true
        }
        return dependency.status === "done" || scheduledIds.has(depId)
      })

      if (!requirementsSatisfied) continue

      scheduledIds.add(task.id)
      madeProgress = true
    }
  }

  return Array.from(scheduledIds).map(id => taskMap.get(id)!)
}

export function buildExecutionGraph(tasks: Task[], parallelLimit: number): ExecutionGraph {
  const executableTasks = getExecutionGraphTasks(tasks)
  const batches = resolveBatches(executableTasks, parallelLimit)

  const nodes = executableTasks.map(t => ({
    id: t.id,
    name: t.name,
    status: t.status,
    requirements: t.requirements,
  }))

  const edges: { from: string; to: string }[] = []
  for (const t of executableTasks) {
    for (const dep of t.requirements) {
      if (executableTasks.some(et => et.id === dep)) {
        edges.push({ from: dep, to: t.id })
      }
    }
  }

  return {
    batches: batches.map((batch, idx) => ({
      idx,
      taskIds: batch.map(t => t.id),
      taskNames: batch.map(t => t.name),
    })),
    nodes,
    edges,
    totalTasks: executableTasks.length,
    parallelLimit,
  }
}
