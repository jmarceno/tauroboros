import type { RunQueueStatus, SlotUtilization, TaskExecutionState, WorkflowRunStatus } from "../types.ts"

interface QueuedTask {
  taskId: string
  runId: string
  queuedAt: number
  sequence: number
}

export class GlobalScheduler {
  private maxSlots: number
  private readonly queuedTasks = new Map<string, QueuedTask>()
  private readonly executingTasks = new Map<string, TaskExecutionState>()
  private readonly slotAssignments = new Map<number, string>()
  private sequence = 0

  constructor(maxSlots: number) {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      throw new Error(`Invalid maxSlots: ${maxSlots}`)
    }
    this.maxSlots = maxSlots
  }

  setMaxSlots(maxSlots: number): void {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      throw new Error(`Invalid maxSlots: ${maxSlots}`)
    }
    this.maxSlots = maxSlots
  }

  getMaxSlots(): number {
    return this.maxSlots
  }

  getAvailableSlots(): number {
    return this.maxSlots - this.executingTasks.size
  }

  enqueueRun(runId: string, taskIds: string[]): void {
    for (const taskId of taskIds) {
      this.enqueueTask(runId, taskId)
    }
  }

  enqueueTask(runId: string, taskId: string): void {
    const current = this.executingTasks.get(taskId)
    if (current) {
      throw new Error(`Task ${taskId} is already executing in run ${current.runId}`)
    }
    if (this.queuedTasks.has(taskId)) {
      return
    }
    this.queuedTasks.set(taskId, {
      taskId,
      runId,
      queuedAt: Date.now(),
      sequence: this.sequence++,
    })
  }

  removeQueuedTask(taskId: string): boolean {
    return this.queuedTasks.delete(taskId)
  }

  removeRun(runId: string): { queuedTaskIds: string[]; executingTaskIds: string[] } {
    const queuedTaskIds: string[] = []
    const executingTaskIds: string[] = []

    for (const [taskId, queued] of this.queuedTasks) {
      if (queued.runId !== runId) continue
      this.queuedTasks.delete(taskId)
      queuedTaskIds.push(taskId)
    }

    for (const [taskId, state] of this.executingTasks) {
      if (state.runId !== runId) continue
      if (state.slotIndex === null) {
        throw new Error(`Executing task ${taskId} is missing slot assignment`)
      }
      this.slotAssignments.delete(state.slotIndex)
      this.executingTasks.delete(taskId)
      executingTaskIds.push(taskId)
    }

    return { queuedTaskIds, executingTaskIds }
  }

  isTaskQueued(taskId: string): boolean {
    return this.queuedTasks.has(taskId)
  }

  isTaskExecuting(taskId: string): boolean {
    return this.executingTasks.has(taskId)
  }

  getQueuedTasks(runId?: string): string[] {
    return Array.from(this.queuedTasks.values())
      .filter((task) => !runId || task.runId === runId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((task) => task.taskId)
  }

  getExecutingStates(runId?: string): TaskExecutionState[] {
    return Array.from(this.executingTasks.values())
      .filter((state) => !runId || state.runId === runId)
      .sort((left, right) => {
        if (left.slotIndex === null || right.slotIndex === null) {
          throw new Error("Executing task is missing slot assignment")
        }
        return left.slotIndex - right.slotIndex
      })
  }

  getTaskState(taskId: string): TaskExecutionState | null {
    return this.executingTasks.get(taskId) ?? null
  }

  schedule(isReady: (taskId: string, runId: string) => boolean): TaskExecutionState[] {
    const started: TaskExecutionState[] = []
    const readyTasks = Array.from(this.queuedTasks.values())
      .sort((left, right) => left.sequence - right.sequence)

    for (const queued of readyTasks) {
      if (this.getAvailableSlots() <= 0) break
      if (!isReady(queued.taskId, queued.runId)) continue

      const slotIndex = this.allocateSlot()
      const state: TaskExecutionState = {
        taskId: queued.taskId,
        runId: queued.runId,
        slotIndex,
        status: "executing",
        startedAt: Date.now(),
        finishedAt: null,
        sessionId: null,
      }

      this.queuedTasks.delete(queued.taskId)
      this.slotAssignments.set(slotIndex, queued.taskId)
      this.executingTasks.set(queued.taskId, state)
      started.push(state)
    }

    return started
  }

  completeTask(taskId: string, finalStatus: "done" | "failed" | "stuck", sessionId: string | null = null): TaskExecutionState | null {
    const state = this.executingTasks.get(taskId)
    if (!state) {
      this.queuedTasks.delete(taskId)
      return null
    }
    if (state.slotIndex === null) {
      throw new Error(`Executing task ${taskId} is missing slot assignment`)
    }

    this.slotAssignments.delete(state.slotIndex)
    this.executingTasks.delete(taskId)
    return {
      ...state,
      status: finalStatus,
      sessionId,
      finishedAt: Date.now(),
    }
  }

  requeueExecutingTask(taskId: string): TaskExecutionState | null {
    const state = this.executingTasks.get(taskId)
    if (!state) return null
    if (state.slotIndex === null) {
      throw new Error(`Executing task ${taskId} is missing slot assignment`)
    }

    this.slotAssignments.delete(state.slotIndex)
    this.executingTasks.delete(taskId)
    this.queuedTasks.set(taskId, {
      taskId,
      runId: state.runId,
      queuedAt: Date.now(),
      sequence: this.sequence++,
    })

    return {
      ...state,
      slotIndex: null,
      status: "queued",
      finishedAt: Date.now(),
    }
  }

  getSlotUtilization(getTaskName: (taskId: string) => string): SlotUtilization {
    const tasks = this.getExecutingStates().map((state) => {
      if (state.slotIndex === null) {
        throw new Error(`Executing task ${state.taskId} is missing slot assignment`)
      }

      return {
        taskId: state.taskId,
        runId: state.runId,
        taskName: getTaskName(state.taskId),
        slotIndex: state.slotIndex,
      }
    })

    return {
      maxSlots: this.maxSlots,
      usedSlots: tasks.length,
      availableSlots: this.getAvailableSlots(),
      tasks,
    }
  }

  getRunQueueStatus(
    runId: string,
    runStatus: WorkflowRunStatus,
    taskIds: string[],
    getTaskStatus: (taskId: string) => string | null,
  ): RunQueueStatus {
    let queuedTasks = 0
    let executingTasks = 0
    let completedTasks = 0

    for (const taskId of taskIds) {
      if (this.queuedTasks.get(taskId)?.runId === runId) {
        queuedTasks++
        continue
      }

      if (this.executingTasks.get(taskId)?.runId === runId) {
        executingTasks++
        continue
      }

      const status = getTaskStatus(taskId)
      if (status === "done" || status === "failed" || status === "stuck") {
        completedTasks++
      }
    }

    return {
      runId,
      status: runStatus,
      totalTasks: taskIds.length,
      queuedTasks,
      executingTasks,
      completedTasks,
    }
  }

  private allocateSlot(): number {
    for (let index = 0; index < this.maxSlots; index++) {
      if (!this.slotAssignments.has(index)) {
        return index
      }
    }

    throw new Error(`No slot available despite free capacity (maxSlots=${this.maxSlots})`)
  }
}