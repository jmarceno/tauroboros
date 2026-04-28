import { Effect, Ref, Schema } from "effect"
import type { RunQueueStatus, SlotUtilization, TaskExecutionState, WorkflowRunStatus } from "../types.ts"

export class GlobalSchedulerError extends Schema.TaggedError<GlobalSchedulerError>()("GlobalSchedulerError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

interface QueuedTask {
  taskId: string
  runId: string
  queuedAt: number
  sequence: number
}

interface SchedulerState {
  maxSlots: number
  queuedTasks: Map<string, QueuedTask>
  executingTasks: Map<string, TaskExecutionState>
  slotAssignments: Map<number, string>
  sequence: number
}

export class GlobalScheduler {
  private readonly stateRef: Ref.Ref<SchedulerState>

  constructor(maxSlots: number) {
    this.stateRef = Ref.unsafeMake<SchedulerState>({
      maxSlots,
      queuedTasks: new Map(),
      executingTasks: new Map(),
      slotAssignments: new Map(),
      sequence: 0,
    })
  }

  static make(maxSlots: number): Effect.Effect<GlobalScheduler, GlobalSchedulerError> {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      return Effect.fail(new GlobalSchedulerError({
        operation: "make",
        message: `Invalid maxSlots: ${maxSlots}`,
      }))
    }
    return Effect.sync(() => new GlobalScheduler(maxSlots))
  }

  setMaxSlots(maxSlots: number): Effect.Effect<void, GlobalSchedulerError> {
    if (!Number.isInteger(maxSlots) || maxSlots < 1) {
      return Effect.fail(new GlobalSchedulerError({
        operation: "setMaxSlots",
        message: `Invalid maxSlots: ${maxSlots}`,
      }))
    }
    return Ref.update(this.stateRef, (state) => ({ ...state, maxSlots }))
  }

  getMaxSlots(): Effect.Effect<number> {
    return Ref.get(this.stateRef).pipe(Effect.map((state) => state.maxSlots))
  }

  getAvailableSlots(): Effect.Effect<number> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => state.maxSlots - state.executingTasks.size),
    )
  }

  enqueueRun(runId: string, taskIds: string[]): Effect.Effect<void, GlobalSchedulerError> {
    return Effect.forEach(taskIds, (taskId) => this.enqueueTask(runId, taskId), { discard: true })
  }

  enqueueTask(runId: string, taskId: string): Effect.Effect<void, GlobalSchedulerError> {
    return Ref.modify(this.stateRef, (state): readonly [Effect.Effect<void, GlobalSchedulerError>, SchedulerState] => {
      const current = state.executingTasks.get(taskId)
      if (current) {
        return [
          Effect.fail(new GlobalSchedulerError({
            operation: "enqueueTask",
            message: `Task ${taskId} is already executing in run ${current.runId}`,
          })),
          state,
        ] as const
      }
      if (state.queuedTasks.has(taskId)) {
        return [Effect.void, state] as const
      }
      const newQueuedTasks = new Map(state.queuedTasks)
      newQueuedTasks.set(taskId, {
        taskId,
        runId,
        queuedAt: Date.now(),
        sequence: state.sequence,
      })
      return [
        Effect.void,
        { ...state, queuedTasks: newQueuedTasks, sequence: state.sequence + 1 },
      ] as const
    }).pipe(Effect.flatten)
  }

  removeQueuedTask(taskId: string): Effect.Effect<boolean> {
    return Ref.modify(this.stateRef, (state) => {
      const newQueuedTasks = new Map(state.queuedTasks)
      const removed = newQueuedTasks.delete(taskId)
      return [removed, { ...state, queuedTasks: newQueuedTasks }] as const
    })
  }

  removeRun(runId: string): Effect.Effect<{ queuedTaskIds: string[]; executingTaskIds: string[] }, GlobalSchedulerError> {
    return Ref.modify(this.stateRef, (state): readonly [Effect.Effect<{ queuedTaskIds: string[]; executingTaskIds: string[] }, GlobalSchedulerError>, SchedulerState] => {
      const queuedTaskIds: string[] = []
      const executingTaskIds: string[] = []

      const newQueuedTasks = new Map(state.queuedTasks)
      for (const [taskId, queued] of state.queuedTasks) {
        if (queued.runId !== runId) continue
        newQueuedTasks.delete(taskId)
        queuedTaskIds.push(taskId)
      }

      const newExecutingTasks = new Map(state.executingTasks)
      const newSlotAssignments = new Map(state.slotAssignments)
      let error: GlobalSchedulerError | null = null

      for (const [taskId, execState] of state.executingTasks) {
        if (execState.runId !== runId) continue
        if (execState.slotIndex === null) {
          error = new GlobalSchedulerError({
            operation: "removeRun",
            message: `Executing task ${taskId} is missing slot assignment`,
          })
          break
        }
        newSlotAssignments.delete(execState.slotIndex)
        newExecutingTasks.delete(taskId)
        executingTaskIds.push(taskId)
      }

      if (error) {
        return [Effect.fail(error), state] as const
      }

      return [
        Effect.succeed({ queuedTaskIds, executingTaskIds }),
        { ...state, queuedTasks: newQueuedTasks, executingTasks: newExecutingTasks, slotAssignments: newSlotAssignments },
      ] as const
    }).pipe(Effect.flatten)
  }

  isTaskQueued(taskId: string): Effect.Effect<boolean> {
    return Ref.get(this.stateRef).pipe(Effect.map((state) => state.queuedTasks.has(taskId)))
  }

  isTaskExecuting(taskId: string): Effect.Effect<boolean> {
    return Ref.get(this.stateRef).pipe(Effect.map((state) => state.executingTasks.has(taskId)))
  }

  getQueuedTasks(runId?: string): Effect.Effect<string[]> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) =>
        Array.from(state.queuedTasks.values())
          .filter((task) => !runId || task.runId === runId)
          .sort((left, right) => left.sequence - right.sequence)
          .map((task) => task.taskId),
      ),
    )
  }

  getExecutingStates(runId?: string): Effect.Effect<TaskExecutionState[], GlobalSchedulerError> {
    return Ref.get(this.stateRef).pipe(
      Effect.flatMap((state) => {
        const filtered = Array.from(state.executingTasks.values()).filter(
          (execState) => !runId || execState.runId === runId,
        )
        for (const execState of filtered) {
          if (execState.slotIndex === null) {
            return Effect.fail(new GlobalSchedulerError({
              operation: "getExecutingStates",
              message: "Executing task is missing slot assignment",
            }))
          }
        }
        return Effect.succeed(
          filtered.sort((left, right) => (left.slotIndex as number) - (right.slotIndex as number)),
        )
      }),
    )
  }

  getTaskState(taskId: string): Effect.Effect<TaskExecutionState | null> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => state.executingTasks.get(taskId) ?? null),
    )
  }

  getAllQueuedTasks(): Effect.Effect<Array<{ taskId: string; runId: string }>> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) =>
        Array.from(state.queuedTasks.values())
          .sort((left, right) => left.sequence - right.sequence)
          .map((queued) => ({ taskId: queued.taskId, runId: queued.runId })),
      ),
    )
  }

  tryStartTask(taskId: string, runId: string): Effect.Effect<boolean, GlobalSchedulerError> {
    return Ref.modify(this.stateRef, (state): readonly [Effect.Effect<boolean, GlobalSchedulerError>, SchedulerState] => {
      const available = state.maxSlots - state.executingTasks.size
      if (available <= 0) return [Effect.succeed(false), state] as const

      const queued = state.queuedTasks.get(taskId)
      if (!queued || queued.runId !== runId) return [Effect.succeed(false), state] as const

      const slotIndex = allocateSlotFromState(state)
      if (slotIndex === null) {
        return [
          Effect.fail(new GlobalSchedulerError({
            operation: "tryStartTask",
            message: `No slot available despite free capacity (maxSlots=${state.maxSlots})`,
          })),
          state,
        ] as const
      }

      const execState: TaskExecutionState = {
        taskId: queued.taskId,
        runId: queued.runId,
        slotIndex,
        status: "executing",
        startedAt: Date.now(),
        finishedAt: null,
        sessionId: null,
      }

      const newQueuedTasks = new Map(state.queuedTasks)
      newQueuedTasks.delete(taskId)

      const newSlotAssignments = new Map(state.slotAssignments)
      newSlotAssignments.set(slotIndex, taskId)

      const newExecutingTasks = new Map(state.executingTasks)
      newExecutingTasks.set(taskId, execState)

      return [
        Effect.succeed(true),
        { ...state, queuedTasks: newQueuedTasks, executingTasks: newExecutingTasks, slotAssignments: newSlotAssignments },
      ] as const
    }).pipe(Effect.flatten)
  }

  completeTask(
    taskId: string,
    finalStatus: "done" | "failed" | "stuck",
    sessionId: string | null = null,
  ): Effect.Effect<TaskExecutionState | null, GlobalSchedulerError> {
    return Ref.modify(this.stateRef, (state): readonly [Effect.Effect<TaskExecutionState | null, GlobalSchedulerError>, SchedulerState] => {
      const execState = state.executingTasks.get(taskId)
      if (!execState) {
        const newQueuedTasks = new Map(state.queuedTasks)
        newQueuedTasks.delete(taskId)
        return [Effect.succeed(null as TaskExecutionState | null), { ...state, queuedTasks: newQueuedTasks }] as const
      }
      if (execState.slotIndex === null) {
        return [
          Effect.fail(new GlobalSchedulerError({
            operation: "completeTask",
            message: `Executing task ${taskId} is missing slot assignment`,
          })),
          state,
        ] as const
      }

      const newSlotAssignments = new Map(state.slotAssignments)
      newSlotAssignments.delete(execState.slotIndex)

      const newExecutingTasks = new Map(state.executingTasks)
      newExecutingTasks.delete(taskId)

      const completed: TaskExecutionState = {
        ...execState,
        status: finalStatus,
        sessionId,
        finishedAt: Date.now(),
      }

      return [
        Effect.succeed(completed as TaskExecutionState | null),
        { ...state, executingTasks: newExecutingTasks, slotAssignments: newSlotAssignments },
      ] as const
    }).pipe(Effect.flatten)
  }

  requeueExecutingTask(taskId: string): Effect.Effect<TaskExecutionState | null, GlobalSchedulerError> {
    return Ref.modify(this.stateRef, (state): readonly [Effect.Effect<TaskExecutionState | null, GlobalSchedulerError>, SchedulerState] => {
      const execState = state.executingTasks.get(taskId)
      if (!execState) return [Effect.succeed(null as TaskExecutionState | null), state] as const

      if (execState.slotIndex === null) {
        return [
          Effect.fail(new GlobalSchedulerError({
            operation: "requeueExecutingTask",
            message: `Executing task ${taskId} is missing slot assignment`,
          })),
          state,
        ] as const
      }

      const newSlotAssignments = new Map(state.slotAssignments)
      newSlotAssignments.delete(execState.slotIndex)

      const newExecutingTasks = new Map(state.executingTasks)
      newExecutingTasks.delete(taskId)

      const newQueuedTasks = new Map(state.queuedTasks)
      newQueuedTasks.set(taskId, {
        taskId,
        runId: execState.runId,
        queuedAt: Date.now(),
        sequence: state.sequence,
      })

      const requeued: TaskExecutionState = {
        ...execState,
        slotIndex: null,
        status: "queued",
        finishedAt: Date.now(),
      }

      return [
        Effect.succeed(requeued as TaskExecutionState | null),
        {
          ...state,
          executingTasks: newExecutingTasks,
          slotAssignments: newSlotAssignments,
          queuedTasks: newQueuedTasks,
          sequence: state.sequence + 1,
        },
      ] as const
    }).pipe(Effect.flatten)
  }

  getSlotUtilization(getTaskName: (taskId: string) => string): Effect.Effect<SlotUtilization, GlobalSchedulerError> {
    return this.getExecutingStates().pipe(
      Effect.flatMap((states) =>
        Ref.get(this.stateRef).pipe(
          Effect.map((state) => ({
            maxSlots: state.maxSlots,
            usedSlots: states.length,
            availableSlots: state.maxSlots - states.length,
            tasks: states.map((execState) => ({
              taskId: execState.taskId,
              runId: execState.runId,
              taskName: getTaskName(execState.taskId),
              slotIndex: execState.slotIndex as number,
            })),
          })),
        ),
      ),
    )
  }

  getRunQueueStatus(
    runId: string,
    runStatus: WorkflowRunStatus,
    taskIds: string[],
    getTaskStatus: (taskId: string) => string | null,
  ): Effect.Effect<RunQueueStatus> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => {
        let queuedTasks = 0
        let executingTasks = 0
        let completedTasks = 0

        for (const taskId of taskIds) {
          if (state.queuedTasks.get(taskId)?.runId === runId) {
            queuedTasks++
            continue
          }

          if (state.executingTasks.get(taskId)?.runId === runId) {
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
      }),
    )
  }
}

function allocateSlotFromState(state: SchedulerState): number | null {
  for (let index = 0; index < state.maxSlots; index++) {
    if (!state.slotAssignments.has(index)) {
      return index
    }
  }
  return null
}
