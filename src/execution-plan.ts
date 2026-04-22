import type { Task } from "./types.ts"
import { getPlanExecutionEligibility } from "./task-state.ts"
import { Schema } from "effect"

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
      continue
    }
    if (dep.status !== "done") {
      return false
    }
  }
  return true
}

function collectTaskAndDependencyIds(
  taskId: string,
  taskMap: Map<string, Task>,
  allowedTaskIds?: Set<string>
): string[] {
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: string[] = []

  const visit = (id: string, chain: string[]): void => {
    if (visiting.has(id)) {
      const cycleStart = chain.indexOf(id)
      const cycleIds = cycleStart >= 0 ? [...chain.slice(cycleStart), id] : [...chain, id]
      const cycleNames = cycleIds.map((cycleId) => taskMap.get(cycleId)?.name ?? cycleId)
      throw new ExecutionPlanError({
        operation: "collectTaskAndDependencyIds",
        message: `Circular dependency detected: ${cycleNames.join(" -> ")}`,
        taskId: id,
      })
    }

    if (visited.has(id)) return

    const task = taskMap.get(id)
    if (!task) {
      throw new ExecutionPlanError({
        operation: "collectTaskAndDependencyIds",
        message: `Task not found: ${id}`,
        taskId: id,
      })
    }

    if (allowedTaskIds && !allowedTaskIds.has(id) && id !== taskId) {
      return
    }

    visiting.add(id)
    for (const depId of task.requirements) {
      if (!taskMap.has(depId)) {
        continue
      }
      if (!(allowedTaskIds && !allowedTaskIds.has(depId))) {
        visit(depId, [...chain, id])
      }
    }
    visiting.delete(id)
    visited.add(id)
    ordered.push(id)
  }

  visit(taskId, [])
  return ordered
}

export function resolveExecutionTasks(
  tasks: Task[],
  taskId?: string,
  allowedTaskIds?: Set<string>
): Task[] {
  if (!taskId) {
    let executable = getExecutableTasks(tasks)
    if (allowedTaskIds) {
      executable = executable.filter((task) => allowedTaskIds.has(task.id))
    }
    return executable
  }

  const taskMap = new Map<string, Task>()
  for (const task of tasks) taskMap.set(task.id, task)

  const targetTask = taskMap.get(taskId)
  if (!targetTask) {
    throw new ExecutionPlanError({
      operation: "resolveExecutionTasks",
      message: `Task not found: ${taskId}`,
      taskId,
    })
  }

  const candidateIds = collectTaskAndDependencyIds(taskId, taskMap, allowedTaskIds)
  const executionTasks: Task[] = []

  for (const candidateId of candidateIds) {
    const candidate = taskMap.get(candidateId)!
    if (candidate.status === "done") continue
    if (allowedTaskIds && !allowedTaskIds.has(candidateId)) continue

    if (!isTaskExecutable(candidate)) {
      if (candidate.id === taskId) {
        throw new ExecutionPlanError({
          operation: "resolveExecutionTasks",
          message: `Task "${candidate.name}" is not runnable from status "${candidate.status}" (phase: ${candidate.executionPhase})`,
          taskId: candidate.id,
          taskName: candidate.name,
        })
      }
      throw new ExecutionPlanError({
        operation: "resolveExecutionTasks",
        message: `Dependency "${candidate.name}" is not done and cannot run from status "${candidate.status}" (phase: ${candidate.executionPhase})`,
        taskId: candidate.id,
        taskName: candidate.name,
      })
    }

    executionTasks.push(candidate)
  }

  if (executionTasks.length === 0) {
    throw new ExecutionPlanError({
      operation: "resolveExecutionTasks",
      message: `Task "${targetTask.name}" and its dependencies are already done`,
      taskId: targetTask.id,
      taskName: targetTask.name,
    })
  }

  return executionTasks
}

export function resolveBatches(
  tasks: Task[],
  parallelLimit: number
): Task[][] {
  const taskMap = new Map<string, Task>()
  for (const task of tasks) taskMap.set(task.id, task)

  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    inDegree.set(task.id, 0)
    dependents.set(task.id, [])
  }
  for (const task of tasks) {
    for (const dep of task.requirements) {
      if (taskMap.has(dep)) {
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
        dependents.get(dep)!.push(task.id)
      }
    }
  }

  const batches: Task[][] = []
  let queue = tasks.filter((task) => (inDegree.get(task.id) ?? 0) === 0)

  while (queue.length > 0) {
    queue.sort((a, b) => a.idx - b.idx)
    batches.push([...queue])

    const nextQueue: Task[] = []
    for (const task of queue) {
      for (const depId of dependents.get(task.id) ?? []) {
        const newDeg = (inDegree.get(depId) ?? 1) - 1
        inDegree.set(depId, newDeg)
        if (newDeg === 0) {
          nextQueue.push(taskMap.get(depId)!)
        }
      }
    }
    queue = nextQueue
  }

  const totalInBatch = batches.reduce((sum, batch) => sum + batch.length, 0)
  if (totalInBatch < tasks.length) {
    const stuck = tasks.filter((task) => !batches.some((batch) => batch.some((batchedTask) => batchedTask.id === task.id)))
    throw new ExecutionPlanError({
      operation: "resolveBatches",
      message: `Circular dependency detected among: ${stuck.map((task) => task.name).join(", ")}`,
    })
  }

  const finalBatches: Task[][] = []
  for (const batch of batches) {
    if (batch.length <= parallelLimit) {
      finalBatches.push(batch)
      continue
    }
    for (let i = 0; i < batch.length; i += parallelLimit) {
      finalBatches.push(batch.slice(i, i + parallelLimit))
    }
  }

  return finalBatches
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
