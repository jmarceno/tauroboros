import { randomUUID } from "crypto"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { Effect, Fiber, Either } from "effect"
import { ErrorCode } from "./shared/error-codes.ts"
import type { InfrastructureSettings } from "./config/settings.ts"
import { BASE_IMAGES } from "./config/base-images.ts"
import { buildExecutionVariables, buildPlanningVariables, buildPlanRevisionVariables, buildCommitVariables, buildReviewFixVariables } from "./prompts/index.ts"
import { PROMPT_CATALOG, joinPrompt, renderPromptTemplate } from "./prompts/catalog.ts"
import { getLatestTaggedOutput, getPlanExecutionEligibility } from "./task-state.ts"
import type { PiKanbanDB } from "./db.ts"
import type { PiSessionKind, PiWorkflowSession } from "./db/types.ts"
import {
  type AutoDeployCondition,
  resolveContainerImage,
  type Options,
  type RunContext,
  type RunQueueStatus,
  type SlotUtilization,
  type Task,
  type SessionMessage,
  type WSMessage,
  type WorkflowRun,
} from "./types.ts"
import { isTaskExecutable } from "./execution-plan.ts"
import { PiSessionManager, SessionManagerExecuteError } from "./runtime/session-manager.ts"
import { PiReviewSessionRunner } from "./runtime/review-session.ts"
import { CodeStyleSessionRunner } from "./runtime/codestyle-session.ts"
import { BestOfNRunner } from "./runtime/best-of-n.ts"
import { GlobalScheduler, GlobalSchedulerError } from "./runtime/global-scheduler.ts"
import { WorktreeLifecycle, resolveTargetBranch, listWorktrees, type WorktreeInfo, WorktreeError } from "./runtime/worktree.ts"
import { PiContainerManager } from "./runtime/container-manager.ts"
import { PiRpcProcess, CollectEventsTimeoutError, PiProcessError } from "./runtime/pi-process.ts"
import { ContainerPiProcess } from "./runtime/container-pi-process.ts"
import { SelfHealingService } from "./runtime/self-healing.ts"
import {
  savePausedRunState,
  loadPausedRunState,
  clearPausedRunState as clearGlobalPausedRunState,
  hasPausedRunState,
  listPausedRunStates,
  type PausedRunState,
  type PausedSessionState,
  sessionPauseStateManager,
  savePausedSessionState,
  loadPausedSessionState,
  clearPausedSessionState,
  clearAllPausedSessionStates,
} from "./runtime/session-pause-state.ts"

import {
  OrchestratorOperationError,
  type ContainerImageOperations,
  nowUnix,
  stripAndNormalize,
  tagOutput,
  asRecord,
  isMergeConflictWorktreeError,
  checkEssentialCompletion,
  runShellCommandEffect,
  getAutoDeployTemplates,
  shouldCheckAutoDeploy,
  deployTemplateTask,
  deployTemplatesForCondition,
  launchAutoDeployPostRunTasks,
  isDependencySatisfiedByAnotherRun,
  resolveExecutionTasksWithActiveDependencies,
  getExecutionGraphTasksWithActiveDependencies,
  validateGroupTasksExist,
  findExternalDependencies,
  checkImageExistsEffect,
  validateWorkflowImagesEffect,
  isCustomImage,
  getContainerImageOperations as getContainerImageOps,
  maybeSelfHealTask,
  cleanWorkflowRun,
  type CleanRunResult,
} from "./orchestrator/index.ts"

export { OrchestratorOperationError }

export class PiOrchestrator {
  private running = false
  private isPaused = false
  private currentRunId: string | null = null
  private readonly activeRuns = new Map<string, RunContext>()
  private readonly runControls = new Map<string, { shouldStop: boolean; shouldPause: boolean; isPaused: boolean }>()
  private readonly taskRunLookup = new Map<string, string>()
  private readonly activeTaskIds = new Set<string>()
  private readonly runTaskFibers = new Map<string, Set<Fiber.Fiber<void, unknown>>>()
  private readonly scheduler: GlobalScheduler
  private scheduling = false
  private sessionManager: PiSessionManager
  private reviewRunner: PiReviewSessionRunner
  private readonly worktree: WorktreeLifecycle
  private containerManager?: PiContainerManager
  private readonly selfHealingService: SelfHealingService

  // Track active processes for pause/stop operations
  private activeSessionProcesses = new Map<string, {
    process: PiRpcProcess | ContainerPiProcess
    session: PiWorkflowSession
    onPause?: () => Effect.Effect<void, OrchestratorOperationError>
  }>()
  private activeBestOfNRunner: BestOfNRunner | null = null
  private activeWorktreeInfo: WorktreeInfo | null = null
  // TODO: Support multiple active tasks for parallel execution
  // Currently only tracks one task, but with parallelTasks > 1, there could be multiple
  // For proper pause coordination, this should be a Set<Task> or Map<string, Task>
  private activeTask: Task | null = null

  constructor(
    private readonly db: PiKanbanDB,
    private readonly broadcast: (message: WSMessage) => void,
    private readonly sessionUrlFor: (sessionId: string) => string,
    private readonly projectRoot = process.cwd(),
    private readonly settings?: InfrastructureSettings,
    containerManager?: PiContainerManager,
  ) {
    this.sessionManager = new PiSessionManager(db, containerManager, settings)
    // Pass the same session manager to review runner for proper process tracking
    this.reviewRunner = new PiReviewSessionRunner(db, settings, containerManager, this.sessionManager)
    this.worktree = new WorktreeLifecycle({ baseDirectory: this.projectRoot })
    this.containerManager = containerManager
    const configuredParallelTasks = this.db.getOptions().parallelTasks
    const maxSlots = Number.isInteger(configuredParallelTasks) && configuredParallelTasks > 0
      ? configuredParallelTasks
      : 1
    this.scheduler = new GlobalScheduler(maxSlots)
    this.selfHealingService = new SelfHealingService(this.db, this.projectRoot, this.settings, containerManager)
  }

  private toOperationError(operation: string, cause: unknown): OrchestratorOperationError {
    return cause instanceof OrchestratorOperationError
      ? cause
      : new OrchestratorOperationError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
        })
  }

  private wrapOperation<A>(operation: string, effect: Effect.Effect<A, unknown>): Effect.Effect<A, OrchestratorOperationError> {
    return effect.pipe(Effect.mapError((cause) => this.toOperationError(operation, cause)))
  }

  private getContainerImageOperations(operation: string): Effect.Effect<ContainerImageOperations, OrchestratorOperationError> {
    return getContainerImageOps(operation, this.containerManager)
  }

  private updateSchedulerCapacityEffect(): Effect.Effect<void, GlobalSchedulerError> {
    return this.scheduler.setMaxSlots(Math.max(1, this.db.getOptions().parallelTasks ?? 1))
  }

  private getRunControl(runId: string): { shouldStop: boolean; shouldPause: boolean; isPaused: boolean } {
    let control = this.runControls.get(runId)
    if (!control) {
      control = { shouldStop: false, shouldPause: false, isPaused: false }
      this.runControls.set(runId, control)
    }
    return control
  }

  private isRunActiveStatus(status: WorkflowRun["status"]): boolean {
    return status === "queued" || status === "running" || status === "stopping" || status === "paused"
  }

  private isTaskTerminalStatus(status: Task["status"]): boolean {
    return status === "done" || status === "failed" || status === "stuck"
  }

  private isTaskRunTerminal(task: Task): boolean {
    if (this.isTaskTerminalStatus(task.status)) {
      return true
    }

    // Plan mode pauses at manual approval with status=review; treat this as run-terminal
    // so the current run can complete and the next plan revision/implementation run can start.
    if (
      task.planmode
      && task.status === "review"
      && task.awaitingPlanApproval
      && task.executionPhase === "plan_complete_waiting_approval"
    ) {
      return true
    }

    return false
  }

  private shouldCheckAutoDeploy(kind: WorkflowRun["kind"]): boolean {
    return shouldCheckAutoDeploy(kind)
  }

  private getAutoDeployTemplates(condition: AutoDeployCondition): Task[] {
    return getAutoDeployTemplates(condition, this.db)
  }

  private deployTemplateTask(template: Task): Task {
    return deployTemplateTask(template, { db: this.db, broadcast: this.broadcast })
  }

  private deployTemplatesForCondition(condition: AutoDeployCondition): Task[] {
    return deployTemplatesForCondition(condition, { db: this.db, broadcast: this.broadcast })
  }

  private launchAutoDeployPostRunTasks(runKind: WorkflowRun["kind"], hasFailures: boolean): Effect.Effect<void, OrchestratorOperationError> {
    return launchAutoDeployPostRunTasks(
      runKind,
      hasFailures,
      { db: this.db, broadcast: this.broadcast },
      (taskId) => this.startSingle(taskId),
    ).pipe(
      Effect.mapError((cause) => this.toOperationError("launchAutoDeployPostRunTasks", cause)),
    )
  }

  private finalizeRunIfCompleteEffect(runId: string): Effect.Effect<void, OrchestratorOperationError, never> {
    return Effect.gen(this, function* () {
      yield* this.failTasksBlockedByDependencyEffect(runId)

      const run = this.db.getWorkflowRun(runId)
      if (!run) return

      const tasks = run.taskOrder.map((taskId) => this.db.getTask(taskId)).filter((task): task is Task => Boolean(task))
      if (tasks.length !== run.taskOrder.length) {
        return yield* new OrchestratorOperationError({
          operation: "finalizeRunIfComplete",
          message: `Run ${runId} references missing tasks`,
        })
      }

      if (tasks.some((task) => !this.isTaskRunTerminal(task))) {
        yield* this.refreshRunProgressEffect(runId)
        return
      }

      const hasFailures = tasks.some((task) => task.status === "failed" || task.status === "stuck")
      const updated = this.db.updateWorkflowRun(runId, {
        status: hasFailures ? "failed" : "completed",
        currentTaskId: null,
        currentTaskIndex: run.taskOrder.length,
        finishedAt: nowUnix(),
        errorMessage: hasFailures ? "One or more tasks in the run failed" : null,
      })

      yield* this.scheduler.removeRun(runId).pipe(Effect.orDie)
      this.unregisterRun(runId)

      if (updated) {
        const enrichedRun = yield* this.enrichWorkflowRunEffect(updated)
        if (enrichedRun) {
          this.broadcast({ type: "run_updated", payload: enrichedRun })
        }
      }

      if (run.kind === "group_tasks" && run.groupId && !hasFailures) {
        const completedGroup = this.db.updateTaskGroup(run.groupId, {
          status: "completed",
          completedAt: nowUnix(),
        })
        if (completedGroup) {
          this.broadcast({ type: "task_group_updated", payload: completedGroup })
          this.broadcast({ type: "group_execution_complete", payload: { groupId: run.groupId, runId } })
        }
      }

      this.broadcast({ type: "execution_complete", payload: { runId } })
      yield* this.launchAutoDeployPostRunTasks(run.kind, hasFailures)
    })
  }

  private buildRunContext(run: WorkflowRun): RunContext {
    return {
      id: run.id,
      kind: run.kind,
      status: run.status,
      displayName: run.displayName,
      targetTaskId: run.targetTaskId,
      groupId: run.groupId,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      taskIds: [...run.taskOrder],
    }
  }

  private registerRun(run: WorkflowRun): void {
    this.activeRuns.set(run.id, this.buildRunContext(run))
    this.runControls.set(run.id, { shouldStop: false, shouldPause: false, isPaused: false })
    this.runTaskFibers.set(run.id, new Set())
    for (const taskId of run.taskOrder) {
      this.taskRunLookup.set(taskId, run.id)
    }
  }

  private unregisterRun(runId: string): void {
    this.activeRuns.delete(runId)
    this.runControls.delete(runId)
    this.runTaskFibers.delete(runId)

    for (const [taskId, mappedRunId] of this.taskRunLookup) {
      if (mappedRunId === runId) {
        this.taskRunLookup.delete(taskId)
      }
    }

    if (this.currentRunId === runId) {
      const nextRun = this.db.getWorkflowRuns().find((run) => this.isRunActiveStatus(run.status) && run.id !== runId)
      this.currentRunId = nextRun?.id ?? null
    }
  }

  private registerRunTaskFiber(runId: string, fiber: Fiber.Fiber<void, unknown>): void {
    const runFibers = this.runTaskFibers.get(runId)
    if (!runFibers) {
      this.runTaskFibers.set(runId, new Set([fiber]))
      return
    }
    runFibers.add(fiber)
  }

  private interruptRunTaskFibers(runId: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const runFibers = this.runTaskFibers.get(runId)
      if (!runFibers || runFibers.size === 0) return

      const fibers = [...runFibers]
      runFibers.clear()
      for (const fiber of fibers) {
        yield* Fiber.interrupt(fiber)
      }
    })
  }

  private enrichWorkflowRunEffect(run: WorkflowRun | null): Effect.Effect<WorkflowRun | null> {
    if (!run) return Effect.succeed(null)
    return this.scheduler.getRunQueueStatus(
      run.id,
      run.status,
      run.taskOrder,
      (taskId) => this.db.getTask(taskId)?.status ?? null,
    ).pipe(
      Effect.map((queueStatus) => ({
        ...run,
        queuedTaskCount: queueStatus.queuedTasks,
        executingTaskCount: queueStatus.executingTasks,
      })),
    )
  }

  private broadcastRunEffect(runId: string): Effect.Effect<void> {
    return this.enrichWorkflowRunEffect(this.db.getWorkflowRun(runId)).pipe(
      Effect.flatMap((run) => {
        if (!run) return Effect.void
        return Effect.sync(() => this.broadcast({ type: "run_updated", payload: run }))
      }),
    )
  }

  private queueRunTasksEffect(taskIds: string[]): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      for (const taskId of taskIds) {
        const task = this.db.getTask(taskId)
        if (!task) {
          return yield* new OrchestratorOperationError({
            operation: "queueRunTasks",
            message: `Task not found: ${taskId}`,
          })
        }
        if (task.status === "done") {
          return yield* new OrchestratorOperationError({
            operation: "queueRunTasks",
            message: `Cannot queue completed task ${task.name} (${taskId})`,
          })
        }

        this.db.updateTask(taskId, {
          status: "queued",
          errorMessage: null,
        })
        this.broadcastTask(taskId)
      }
    })
  }

  private getDependencyResolutionContext() {
    return {
      getTask: (taskId: string) => this.db.getTask(taskId),
      getWorkflowRun: (runId: string) => this.db.getWorkflowRun(runId),
      getTasks: () => this.db.getTasks(),
      isRunActiveStatus: (status: WorkflowRun["status"]) => this.isRunActiveStatus(status),
      taskRunLookup: this.taskRunLookup,
    }
  }

  private isDependencySatisfiedByAnotherRun(taskId: string): boolean {
    return isDependencySatisfiedByAnotherRun(taskId, this.getDependencyResolutionContext())
  }

  private resolveExecutionTasksWithActiveDependencies(allTasks: Task[], taskId: string): Effect.Effect<Task[], OrchestratorOperationError> {
    return resolveExecutionTasksWithActiveDependencies(
      allTasks,
      taskId,
      this.getDependencyResolutionContext(),
    )
  }

  private getExecutionGraphTasksWithActiveDependencies(
    tasks: Task[],
  ): Effect.Effect<Task[], OrchestratorOperationError> {
    return getExecutionGraphTasksWithActiveDependencies(
      tasks,
      this.getDependencyResolutionContext(),
    )
  }

  private startRunEffect(input: {
    kind: WorkflowRun["kind"]
    displayName: string
    taskOrder: string[]
    targetTaskId?: string | null
    groupId?: string
  }): Effect.Effect<WorkflowRun, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      let resolvedTaskOrder = [...input.taskOrder]
      if (this.shouldCheckAutoDeploy(input.kind)) {
        const beforeStartTasks = this.deployTemplatesForCondition("before_workflow_start")
        resolvedTaskOrder = [...beforeStartTasks.map((task) => task.id), ...resolvedTaskOrder]
      }

      yield* this.cleanupStaleRunsEffect()

      for (const taskId of resolvedTaskOrder) {
        const existingRunId = this.taskRunLookup.get(taskId)
        if (!existingRunId) continue
        const existingRun = this.db.getWorkflowRun(existingRunId)
        if (existingRun && this.isRunActiveStatus(existingRun.status)) {
          return yield* new OrchestratorOperationError({
            operation: "startRun",
            message: `Task ${taskId} is already part of active run ${existingRunId}`,
          })
        }
      }

      const run = this.db.createWorkflowRun({
        id: randomUUID().slice(0, 8),
        kind: input.kind,
        status: "queued",
        displayName: input.displayName,
        targetTaskId: input.targetTaskId ?? null,
        groupId: input.groupId,
        taskOrder: resolvedTaskOrder,
        currentTaskId: resolvedTaskOrder[0] ?? null,
        currentTaskIndex: 0,
        color: this.db.getNextRunColor(),
      })

      this.registerRun(run)
      this.currentRunId = run.id
      yield* this.queueRunTasksEffect(resolvedTaskOrder)
      yield* this.scheduler.enqueueRun(run.id, resolvedTaskOrder).pipe(Effect.orDie)

      const enrichedRun = yield* this.enrichWorkflowRunEffect(this.db.getWorkflowRun(run.id))
      if (!enrichedRun) {
        return yield* new OrchestratorOperationError({
          operation: "startRun",
          message: `Failed to reload run ${run.id} after creation`,
        })
      }

      this.broadcast({ type: "run_created", payload: enrichedRun })
      this.broadcast({ type: "execution_queued", payload: { runId: run.id } })
      if (run.kind === "group_tasks" && run.groupId) {
        this.broadcast({ type: "group_execution_started", payload: { groupId: run.groupId, runId: run.id } })
      }

      yield* this.triggerSchedulingEffect()
      return enrichedRun
    })
  }

  private refreshRunProgressEffect(runId: string): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const run = this.db.getWorkflowRun(runId)
      if (!run) return

      const completedCount = run.taskOrder.reduce((count, taskId) => {
        const task = this.db.getTask(taskId)
        return task && this.isTaskRunTerminal(task) ? count + 1 : count
      }, 0)

      const executingStates = yield* this.scheduler.getExecutingStates(runId).pipe(Effect.orDie)
      const queuedTasks = yield* this.scheduler.getQueuedTasks(runId)
      const currentTaskId = executingStates[0]?.taskId ?? queuedTasks[0] ?? null

      const updated = this.db.updateWorkflowRun(runId, {
        currentTaskIndex: completedCount,
        currentTaskId,
      })

      if (updated) {
        yield* this.broadcastRunEffect(runId)
      }
    }).pipe(
      Effect.mapError((cause) => this.toOperationError("refreshRunProgress", cause)),
    )
  }

  private isTaskReadyForScheduling(taskId: string, runId: string): Effect.Effect<boolean, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const run = this.db.getWorkflowRun(runId)
      if (!run || !this.isRunActiveStatus(run.status) || run.status === "paused" || run.status === "stopping") {
        return false
      }

      const control = this.getRunControl(runId)
      if (control.shouldPause || control.shouldStop || control.isPaused) {
        return false
      }

      const task = this.db.getTask(taskId)
      if (!task) {
        return yield* new OrchestratorOperationError({
          operation: "isTaskReadyForScheduling",
          message: `Task not found: ${taskId}`,
        })
      }
      if (task.status !== "queued") {
        return false
      }

      for (const depId of task.requirements) {
        const dep = this.db.getTask(depId)
        if (!dep) continue
        if (dep.status === "failed" || dep.status === "stuck") return false
        if (dep.status !== "done") return false
      }

      return true
    })
  }

  private failTasksBlockedByDependencyEffect(runId: string): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const run = this.db.getWorkflowRun(runId)
      if (!run) return

      // Check if any task has a failed/stuck dependency
      let hasFailedDependency = false
      let failedDependencyName = ""
      let failedTaskId = ""

      for (const taskId of run.taskOrder) {
        if (!(yield* this.scheduler.isTaskQueued(taskId))) continue
        const task = this.db.getTask(taskId)
        if (!task) continue

        const failedDependency = task.requirements
          .map((depId) => this.db.getTask(depId))
          .find((dep) => dep && (dep.status === "failed" || dep.status === "stuck"))

        if (failedDependency) {
          hasFailedDependency = true
          failedDependencyName = failedDependency.name
          failedTaskId = taskId
          break // Stop at first failed dependency - we need to stop the run
        }
      }

      // If a failed dependency was found, stop the run immediately
      // This keeps dependent tasks in backlog instead of marking them as failed
      if (hasFailedDependency) {
        yield* Effect.logWarning(
          `[orchestrator] Run ${runId} stopped due to dependency failure: ${failedDependencyName} (blocking task ${failedTaskId})`,
        )
        yield* this.stopRunDueToFailure(runId, failedDependencyName)
      }
    }).pipe(
      Effect.mapError((cause) => this.toOperationError("failTasksBlockedByDependency", cause)),
    )
  }

  /**
   * Stops a workflow run due to a task failure.
   * Unlike stopRun(), this marks the run as failed and preserves dependent tasks in backlog.
   * Dependent tasks remain in "backlog" status instead of being marked as "failed".
   */
  private stopRunDueToFailure(runId: string, failedDependencyName: string): Effect.Effect<void, OrchestratorOperationError> {
    return this.wrapOperation("stopRunDueToFailure", Effect.gen(this, function* () {
      const run = this.db.getWorkflowRun(runId)
      if (!run) {
        yield* Effect.logError(`[orchestrator] Cannot stop run due to failure: run ${runId} not found`)
        return
      }

      // Only stop if the run is still active
      if (run.status !== "queued" && run.status !== "running" && run.status !== "paused") {
        yield* Effect.logInfo(`[orchestrator] Run ${runId} already terminal (status: ${run.status}), skipping failure stop`)
        return
      }

      yield* Effect.logInfo(`[orchestrator] Stopping run ${runId} due to task failure`)
      
      const control = this.getRunControl(runId)
      control.shouldStop = true
      yield* this.interruptRunTaskFibers(runId)

      // Kill active processes for this run
      for (const [sessionId, activeProcess] of [...this.activeSessionProcesses]) {
        const taskId = activeProcess.session.taskId
        if (!taskId || !run.taskOrder.includes(taskId)) continue
        if ("forceKill" in activeProcess.process) {
          yield* activeProcess.process.forceKill("SIGKILL")
        }
        this.activeSessionProcesses.delete(sessionId)
      }

      // Move all non-terminal tasks to backlog (not failed!)
      // This prevents cascade failures - dependent tasks stay in backlog for retry
      for (const taskId of run.taskOrder ?? []) {
        const task = this.db.getTask(taskId)
        if (!task) continue

        // Only process tasks that aren't already in a terminal state
        const isTerminal = task.status === "done" || task.status === "failed" || task.status === "stuck"
        if (isTerminal) continue

        if (yield* this.scheduler.isTaskExecuting(taskId)) {
          yield* this.scheduler.completeTask(taskId, "failed", task?.sessionId ?? null).pipe(Effect.orDie)
        } else if (yield* this.scheduler.isTaskQueued(taskId)) {
          yield* this.scheduler.removeQueuedTask(taskId)
        }

        // Move to backlog instead of failed - this is the key change for cascade prevention
        if (task.status === "queued" || task.status === "executing" || task.status === "review") {
          this.db.updateTask(taskId, {
            status: "backlog",
            errorMessage: `Workflow stopped: dependency "${failedDependencyName}" failed`,
            sessionId: null,
            sessionUrl: null,
          })
          this.broadcastTask(taskId)
        }
      }

      // Mark run as failed (not completed like stopRun does)
      const updated = this.db.updateWorkflowRun(runId, {
        status: "failed",
        currentTaskId: null,
        currentTaskIndex: run.taskOrder.length,
        finishedAt: nowUnix(),
        errorMessage: `Task failed: ${failedDependencyName}`,
      })

      if (updated) {
        const enriched = yield* this.enrichWorkflowRunEffect(updated)
        if (enriched) {
          this.broadcast({ type: "run_updated", payload: enriched })
        }
        this.broadcast({ type: "execution_failed", payload: { runId, reason: "task_failure" } })
        yield* Effect.logInfo(`[orchestrator] Run ${runId} stopped due to failure, dependent tasks preserved in backlog`)
      }

      yield* this.scheduler.removeRun(runId).pipe(Effect.orDie)
      this.unregisterRun(runId)
    }))
  }

  private handleScheduledTaskLifecycleFailureEffect(
    taskId: string,
    runId: string,
    error: OrchestratorOperationError,
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      yield* Effect.logError(
        `[orchestrator] Scheduled task lifecycle failed for task ${taskId} in run ${runId}: ${error.message}`,
      )

      this.activeTaskIds.delete(taskId)

      const run = this.db.getWorkflowRun(runId)
      if (!run) {
        return
      }

      // Only fail the specific task that had the lifecycle failure
      // Other tasks should remain queued/backlog for retry
      const failedTask = this.db.getTask(taskId)
      if (yield* this.scheduler.isTaskExecuting(taskId)) {
        yield* this.scheduler.completeTask(taskId, "failed", failedTask?.sessionId ?? null).pipe(Effect.orDie)
      } else if (yield* this.scheduler.isTaskQueued(taskId)) {
        yield* this.scheduler.removeQueuedTask(taskId)
      }

      if (failedTask && !this.isTaskRunTerminal(failedTask)) {
        this.db.updateTask(taskId, {
          status: "failed",
          errorMessage: `Workflow orchestration failed: ${error.message}`,
        })
        this.broadcastTask(taskId)
      }

      const completedCount = run.taskOrder.reduce((count, runTaskId) => {
        const runTask = this.db.getTask(runTaskId)
        return runTask && this.isTaskRunTerminal(runTask) ? count + 1 : count
      }, 0)

      const updated = this.db.updateWorkflowRun(runId, {
        status: "failed",
        currentTaskId: null,
        currentTaskIndex: completedCount,
        finishedAt: nowUnix(),
        errorMessage: `Workflow orchestration failed while processing task ${taskId}: ${error.message}`,
      })

      yield* this.scheduler.removeRun(runId).pipe(Effect.orDie)
      this.unregisterRun(runId)

      if (updated) {
        const enriched = yield* this.enrichWorkflowRunEffect(updated)
        if (enriched) {
          this.broadcast({ type: "run_updated", payload: enriched })
        }
      }

      this.broadcast({ type: "execution_complete", payload: { runId } })
    })
  }

  private startScheduledTaskEffect(taskId: string, runId: string, task: Task): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      yield* this.refreshRunProgressEffect(runId)

      const executionResult = yield* this.executeTaskEffect(task, this.db.getOptions(), runId).pipe(
        Effect.either,
      )

      if (Either.isLeft(executionResult)) {
        yield* Effect.logError(`[orchestrator] Task ${taskId} in run ${runId} failed: ${executionResult.left.message}`)
      }

      this.activeTaskIds.delete(taskId)

      let latestTask: Task | null
      try {
        latestTask = this.db.getTask(taskId)
      } catch (error) {
        return yield* new OrchestratorOperationError({
          operation: "startScheduledTaskEffect",
          message: `Failed to load task ${taskId} after execution: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      if (!latestTask) {
        return yield* new OrchestratorOperationError({
          operation: "startScheduledTaskEffect",
          message: `Task ${taskId} disappeared after execution completed`,
        })
      }

      if (latestTask.status === "queued") {
        yield* this.refreshRunProgressEffect(runId)
        yield* this.triggerSchedulingEffect()
        return
      }

      // Self-healing temporarily disabled until architecture is fixed
      // See: plans/fix-self-healing.md for the full refactoring plan
      // if (latestTask.status === "failed" || latestTask.status === "stuck") {
      //   const selfHealResult = yield* this.maybeSelfHealTask(runId, latestTask).pipe(Effect.either)
      //   if (Either.isRight(selfHealResult) && selfHealResult.right) {
      //     yield* this.refreshRunProgressEffect(runId)
      //     yield* this.triggerSchedulingEffect()
      //     return
      //   }
      //   if (Either.isLeft(selfHealResult)) {
      //     yield* Effect.logError(`[orchestrator] Self-heal failed for task ${taskId}: ${selfHealResult.left.message}`)
      //   }
      // }

      const finalStatus = latestTask.status === "done"
        ? "done"
        : latestTask.status === "stuck"
          ? "stuck"
          : "failed"
      yield* this.scheduler.completeTask(taskId, finalStatus, latestTask.sessionId).pipe(Effect.orDie)

      yield* this.finalizeRunIfCompleteEffect(runId)
      yield* this.triggerSchedulingEffect()
    })
  }

  private startScheduledTask(taskId: string, runId: string): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const task = this.db.getTask(taskId)
      if (!task) {
        return yield* new OrchestratorOperationError({
          operation: "startScheduledTask",
          message: `Task not found: ${taskId}`,
        })
      }

      this.activeTaskIds.add(taskId)
      const run = this.db.getWorkflowRun(runId)
      if (!run) {
        return yield* new OrchestratorOperationError({
          operation: "startScheduledTask",
          message: `Run not found: ${runId}`,
        })
      }

      if (run.status === "queued") {
        const updated = this.db.updateWorkflowRun(runId, { status: "running" })
        if (updated) {
          const context = this.activeRuns.get(runId)
          if (context) context.status = "running"
          this.broadcast({ type: "execution_started", payload: { runId } })
        }
      }

      const taskFiber = yield* this.startScheduledTaskEffect(taskId, runId, task).pipe(
        Effect.catchAll((error) => this.handleScheduledTaskLifecycleFailureEffect(taskId, runId, error)),
        Effect.forkDaemon,
      )
      this.registerRunTaskFiber(runId, taskFiber)
    })
  }

  private triggerSchedulingEffect(): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      if (this.scheduling) return

      this.scheduling = true
      try {
        yield* this.updateSchedulerCapacityEffect().pipe(Effect.orDie)

        while (true) {
          for (const runId of this.activeRuns.keys()) {
            yield* this.failTasksBlockedByDependencyEffect(runId)
          }

          // Get all queued tasks from the scheduler and check readiness using Effect
          const queuedTasks = yield* this.scheduler.getAllQueuedTasks()
          const readyTasks: Array<{ taskId: string; runId: string }> = []
          
          for (const { taskId, runId } of queuedTasks) {
            const isReady = yield* this.isTaskReadyForScheduling(taskId, runId).pipe(
              Effect.either,
              Effect.map((result) => Either.isRight(result) && result.right),
            )
            if (isReady) {
              readyTasks.push({ taskId, runId })
            }
          }

          // Start ready tasks through the scheduler
          const started: Array<{ taskId: string; runId: string }> = []
          for (const { taskId, runId } of readyTasks) {
            const didStart = yield* this.scheduler.tryStartTask(taskId, runId).pipe(Effect.orDie)
            if (didStart) {
              started.push({ taskId, runId })
            }
          }
          
          if (started.length === 0) break

          for (const state of started) {
            yield* this.startScheduledTask(state.taskId, state.runId)
          }
        }

        for (const runId of [...this.activeRuns.keys()]) {
          yield* this.refreshRunProgressEffect(runId)
          yield* this.finalizeRunIfCompleteEffect(runId)
        }
      } finally {
        this.scheduling = false
      }
    })
  }

  getSlotUtilization(): Effect.Effect<SlotUtilization, GlobalSchedulerError> {
    return this.updateSchedulerCapacityEffect().pipe(
      Effect.flatMap(() => this.scheduler.getSlotUtilization((taskId) => this.db.getTask(taskId)?.name ?? taskId)),
    )
  }

  getRunQueueStatus(runId: string): Effect.Effect<RunQueueStatus, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const run = this.db.getWorkflowRun(runId)
      if (!run) {
        return yield* new OrchestratorOperationError({
          operation: "getRunQueueStatus",
          message: `Run ${runId} not found`,
        })
      }

      return yield* this.scheduler.getRunQueueStatus(
        run.id,
        run.status,
        run.taskOrder,
        (taskId) => this.db.getTask(taskId)?.status ?? null,
      )
    })
  }

  /**
   * Detect and clean up stale workflow runs that are in active status but have no executing tasks.
   * This is a defensive check to prevent ghost runs from blocking new executions.
   */
  private cleanupStaleRunsEffect(): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const activeRuns = this.db.getWorkflowRuns().filter((run) => this.isRunActiveStatus(run.status))

      for (const run of activeRuns) {
        if (this.activeRuns.has(run.id) || run.status === "paused") {
          continue
        }

        const queuedForRun = yield* this.scheduler.getQueuedTasks(run.id)
        const executingForRun = yield* this.scheduler.getExecutingStates(run.id).pipe(Effect.orDie)
        const hasTrackedSchedulerState = queuedForRun.length > 0 || executingForRun.length > 0
        if (hasTrackedSchedulerState) {
          continue
        }

        const hasTaskActivity = run.taskOrder.some((taskId) => {
          const task = this.db.getTask(taskId)
          return task?.status === "queued" || task?.status === "executing" || task?.status === "review"
        })

        if (!hasTaskActivity) {
          const updated = this.db.updateWorkflowRun(run.id, {
            status: "failed",
            errorMessage: "Auto-recovered: active run had no queued or executing tasks",
            finishedAt: nowUnix(),
          })
          if (updated) {
            const enriched = yield* this.enrichWorkflowRunEffect(updated)
            if (enriched) {
              this.broadcast({ type: "run_updated", payload: enriched })
            }
          }
          continue
        }

        for (const taskId of run.taskOrder) {
          const task = this.db.getTask(taskId)
          if (!task) continue
          if (task.status !== "queued" && task.status !== "executing" && task.status !== "review") {
            continue
          }

          this.db.updateTask(taskId, {
            status: "backlog",
            errorMessage: "Auto-recovered: workflow run lost scheduler state",
            sessionId: null,
            sessionUrl: null,
          })
          this.broadcastTask(taskId)
        }

        const updated = this.db.updateWorkflowRun(run.id, {
          status: "failed",
          errorMessage: "Auto-recovered: active run lost in-memory scheduler state",
          finishedAt: nowUnix(),
        })
        if (updated) {
          const enriched = yield* this.enrichWorkflowRunEffect(updated)
          if (enriched) {
            this.broadcast({ type: "run_updated", payload: enriched })
          }
        }
      }
    }).pipe(
      Effect.mapError((cause) => this.toOperationError("cleanupStaleRuns", cause)),
    )
  }

  startAll(): Effect.Effect<WorkflowRun, OrchestratorOperationError> {
    return this.wrapOperation("startAll", Effect.gen(this, function* () {
        const allTasks = this.db.getTasks()
        const validTaskIds = new Set(allTasks.map((task) => task.id))

        for (const task of allTasks) {
          const invalidDeps = task.requirements.filter((depId) => !validTaskIds.has(depId))
          if (invalidDeps.length > 0) {
            yield* Effect.logWarning(`[orchestrator] Task "${task.name}" has invalid dependencies: ${invalidDeps.join(', ')} - will be ignored during execution`)
          }
        }

        const tasks = yield* this.getExecutionGraphTasksWithActiveDependencies(allTasks)

        if (tasks.length === 0 && this.getAutoDeployTemplates("before_workflow_start").length === 0) {
          return yield* new OrchestratorOperationError({
            operation: "startAll",
            message: "No tasks in backlog",
          })
        }

        yield* Effect.logInfo(`[orchestrator] startAll: ${tasks.length} tasks to execute: ${tasks.map((task) => `${task.name}(${task.id})`).join(', ')}`)

        const imageValidation = yield* this.validateWorkflowImagesEffect(tasks.map((task) => task.id))
        if (!imageValidation.valid) {
          for (const invalid of imageValidation.invalid) {
            yield* this.logTaskEventEffect(invalid.taskId, "execution_blocked", {
              reason: "missing_container_image",
              image: invalid.image,
              message: `Task execution blocked: Container image '${invalid.image}' not found`,
              recommendation: "Build the image in Image Builder or select a valid image in task settings",
            })
          }
          const details = imageValidation.invalid
            .map((invalid) => `"${invalid.taskName}" (${invalid.taskId}): ${invalid.image}`)
            .join("; ")
          return yield* new OrchestratorOperationError({
            operation: "startAll",
            message: `Cannot start workflow: The following tasks have invalid container images: ${details}. Build the images first.`,
            code: ErrorCode.INVALID_CONTAINER_IMAGES,
          })
        }

        return yield* this.startRunEffect({
          kind: "all_tasks",
          displayName: "Workflow run",
          taskOrder: tasks.map((task) => task.id),
        })
      }))
  }

  startSingle(taskId: string): Effect.Effect<WorkflowRun, OrchestratorOperationError> {
    return this.wrapOperation("startSingle", Effect.gen(this, function* () {
        const allTasks = this.db.getTasks()
        const validTaskIds = new Set(allTasks.map((task) => task.id))

        for (const task of allTasks) {
          const invalidDeps = task.requirements.filter((depId) => !validTaskIds.has(depId))
          if (invalidDeps.length > 0) {
            yield* Effect.logWarning(`[orchestrator] Task "${task.name}" has invalid dependencies: ${invalidDeps.join(', ')} - will be ignored during execution`)
          }
        }

        const chain = yield* this.resolveExecutionTasksWithActiveDependencies(allTasks, taskId)
        if (chain.length === 0) {
          return yield* new OrchestratorOperationError({
            operation: "startSingle",
            message: "No tasks in backlog",
          })
        }
        const target = this.db.getTask(taskId)
        if (!target) {
          return yield* new OrchestratorOperationError({
            operation: "startSingle",
            message: "Task not found",
          })
        }

        const imageValidation = yield* this.validateWorkflowImagesEffect(chain.map((task) => task.id))
        if (!imageValidation.valid) {
          for (const invalid of imageValidation.invalid) {
            yield* this.logTaskEventEffect(invalid.taskId, "execution_blocked", {
              reason: "missing_container_image",
              image: invalid.image,
              message: `Task execution blocked: Container image '${invalid.image}' not found`,
              recommendation: "Build the image in Image Builder or select a valid image in task settings",
            })
          }
          const details = imageValidation.invalid
            .map((invalid) => `"${invalid.taskName}" (${invalid.taskId}): ${invalid.image}`)
            .join("; ")
          return yield* new OrchestratorOperationError({
            operation: "startSingle",
            message: `Cannot start workflow: The following tasks have invalid container images: ${details}. Build the images first.`,
            code: ErrorCode.INVALID_CONTAINER_IMAGES,
          })
        }

        return yield* this.startRunEffect({
          kind: "single_task",
          displayName: `Single task: ${target.name}`,
          targetTaskId: target.id,
          taskOrder: chain.map((task) => task.id),
        })
      }))
  }

  /**
   * Validate that all tasks in the given array exist in the database.
   * Returns the loaded Task objects.
   * Throws an error if any task is not found.
   */
  private validateGroupTasksExist(taskIds: string[]): Effect.Effect<Task[], OrchestratorOperationError> {
    return validateGroupTasksExist(taskIds, (taskId) => this.db.getTask(taskId))
  }

  /**
   * Find dependencies that are outside the group.
   * Returns array of objects with task and its external dependency.
   */
  private findExternalDependencies(
    groupTasks: Task[],
    allTasks: Task[],
  ): Array<{ task: Task; dependency: string }> {
    return findExternalDependencies(groupTasks, allTasks)
  }

  /**
   * Start execution of a task group.
   * Loads group members, validates dependencies, checks container images,
   * and executes tasks in dependency order.
   */
  startGroup(groupId: string): Effect.Effect<WorkflowRun, OrchestratorOperationError> {
    return this.wrapOperation("startGroup", Effect.gen(this, function* () {
        const group = this.db.getTaskGroup(groupId)
        if (!group) {
          return yield* new OrchestratorOperationError({
            operation: "startGroup",
            message: `Task group with ID "${groupId}" not found`,
          })
        }

        if (group.taskIds.length === 0) {
          return yield* new OrchestratorOperationError({
            operation: "startGroup",
            message: `Cannot start group "${group.name}": group has no tasks`,
          })
        }

        const groupTasks = yield* this.validateGroupTasksExist(group.taskIds)
        const allTasks = this.db.getTasks()
        const externalDeps = this.findExternalDependencies(groupTasks, allTasks)

        if (externalDeps.length > 0) {
          const taskNamesWithExternalDeps = [...new Set(externalDeps.map((dependency) => dependency.task.name))]
          return yield* new OrchestratorOperationError({
            operation: "startGroup",
            message: `Group execution blocked: ${externalDeps.length} tasks have external dependencies that must be completed first: ${taskNamesWithExternalDeps.join(', ')}`,
            code: ErrorCode.EXTERNAL_DEPENDENCIES_BLOCKED,
          })
        }

        const imageValidation = yield* this.validateWorkflowImagesEffect(group.taskIds)
        if (!imageValidation.valid) {
          for (const invalid of imageValidation.invalid) {
            yield* this.logTaskEventEffect(invalid.taskId, "execution_blocked", {
              reason: "missing_container_image",
              image: invalid.image,
              message: `Task execution blocked: Container image '${invalid.image}' not found`,
              recommendation: "Build the image in Image Builder or select a valid image in task settings",
            })
          }
          const details = imageValidation.invalid
            .map((invalid) => `"${invalid.taskName}" (${invalid.taskId}): ${invalid.image}`)
            .join("; ")
          return yield* new OrchestratorOperationError({
            operation: "startGroup",
            message: `Cannot start group: The following tasks have invalid container images: ${details}`,
            code: ErrorCode.INVALID_CONTAINER_IMAGES,
          })
        }

        return yield* this.startRunEffect({
          kind: "group_tasks",
          displayName: `Group: ${group.name}`,
          groupId: group.id,
          taskOrder: group.taskIds,
        })
      }))
  }

  /**
   * Stop (kill - SIGKILL) of a specific workflow run by ID.
   * Sets flags that will be checked in the execution loop and kills active sessions.
   */
  stopRun(runId: string): Effect.Effect<void, OrchestratorOperationError> {
    return this.wrapOperation("stopRun", Effect.gen(this, function* () {
        const run = this.db.getWorkflowRun(runId)
        if (!run) {
          yield* Effect.logError(`[orchestrator] Cannot stop: run ${runId} not found`)
          return
        }

        if (run.status !== "queued" && run.status !== "running" && run.status !== "paused" && run.status !== "stopping") {
          yield* Effect.logError(`[orchestrator] Cannot stop: run ${runId} is not running, paused, or stopping (status: ${run.status})`)
          return
        }

        yield* Effect.logInfo(`[orchestrator] Graceful stop requested for run ${runId}`)
        const control = this.getRunControl(runId)
        control.shouldStop = true
        yield* this.interruptRunTaskFibers(runId)

        for (const [sessionId, activeProcess] of [...this.activeSessionProcesses]) {
          const taskId = activeProcess.session.taskId
          if (!taskId || !run.taskOrder.includes(taskId)) continue
          if ("forceKill" in activeProcess.process) {
            yield* activeProcess.process.forceKill("SIGKILL")
          }
          this.activeSessionProcesses.delete(sessionId)
        }

        for (const taskId of run.taskOrder ?? []) {
          const task = this.db.getTask(taskId)
          if (yield* this.scheduler.isTaskExecuting(taskId)) {
            yield* this.scheduler.completeTask(taskId, "failed", task?.sessionId ?? null).pipe(Effect.orDie)
          } else if (yield* this.scheduler.isTaskQueued(taskId)) {
            yield* this.scheduler.removeQueuedTask(taskId)
          }

          if (task && (task.status === "queued" || task.status === "executing" || task.status === "review")) {
            this.db.updateTask(taskId, {
              status: "backlog",
              errorMessage: "Workflow stopped by user",
              sessionId: null,
              sessionUrl: null,
            })
            this.broadcastTask(taskId)
          }
        }

        const updated = this.db.updateWorkflowRun(runId, {
          status: "completed",
          stopRequested: true,
          currentTaskId: null,
          currentTaskIndex: run.taskOrder.length,
          finishedAt: nowUnix(),
        })
        if (updated) {
          const enriched = yield* this.enrichWorkflowRunEffect(updated)
          if (enriched) {
            this.broadcast({ type: "run_updated", payload: enriched })
          }
          this.broadcast({ type: "execution_stopped", payload: { runId } })
          yield* Effect.logInfo(`[orchestrator] Run ${runId} stopped immediately`)
        }

        yield* this.scheduler.removeRun(runId).pipe(Effect.orDie)
        this.unregisterRun(runId)
        yield* this.triggerSchedulingEffect()
      }))
  }

  /**
   * Request destructive stop of current workflow run.
   * This is the main STOP action - it kills everything and loses data.
   */
  stop(): Effect.Effect<void, OrchestratorOperationError> {
    return this.wrapOperation("stop", Effect.gen(this, function* () {
        const activeRunId = this.currentRunId ?? this.db.getWorkflowRuns().find((run) => this.isRunActiveStatus(run.status))?.id ?? null
        if (!activeRunId) return
        yield* this.destructiveStop(activeRunId)
      }))
  }

  /**
   * Emergency stop - kill all containers immediately.
   */
  emergencyStop(): Effect.Effect<number, OrchestratorOperationError> {
    return this.wrapOperation("emergencyStop", Effect.gen(this, function* () {
      if (!this.containerManager) {
        return 0
      }
      return yield* this.containerManager.emergencyStop().pipe(
        Effect.mapError((cause) => this.toOperationError("emergencyStop", cause)),
      )
    }))
  }

  /**
   * Destructive stop - immediately kill all processes and clean up for a specific run.
   * This is destructive and requires user confirmation.
   * Kills all sessions, containers, worktrees for the run's tasks and marks them as failed.
   */
  destructiveStop(runId: string): Effect.Effect<{ killed: number; cleaned: number }, OrchestratorOperationError> {
    return this.wrapOperation("destructiveStop", Effect.gen(this, function* () {
        const run = this.db.getWorkflowRun(runId)
        if (!run) {
          return yield* new OrchestratorOperationError({
            operation: "destructiveStop",
            message: `Run ${runId} not found`,
          })
        }

        yield* Effect.logInfo(`[orchestrator] Destructive stop for run ${runId}`)
        const result = { killed: 0, cleaned: 0 }
        const control = this.getRunControl(runId)
        control.shouldStop = true
        yield* this.interruptRunTaskFibers(runId)

    // 1. Stop all active sessions for tasks in this run
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.sessionId) {
          // Use either to capture success/failure without failing the whole operation
          const killResult = yield* this.killSessionImmediately(task.sessionId).pipe(
            Effect.either
          )
          if (killResult._tag === "Left") {
            const errorMessage = killResult.left instanceof Error ? killResult.left.message : String(killResult.left)
            yield* Effect.logWarning(`[orchestrator] Failed to kill session ${task.sessionId}: ${errorMessage}`)
          }
          result.killed++
      }
    }

    // 2. Kill all containers for this run's tasks
    if (this.containerManager) {
      for (const taskId of run.taskOrder) {
        const task = this.db.getTask(taskId)
        if (task?.sessionId) {
          // forceKillContainer never fails - it returns boolean
          yield* this.containerManager!.forceKillContainer(task.sessionId!)
        }
      }
      // Run a final emergency sweep to terminate any container that may have escaped targeted kills.
      result.killed += yield* this.containerManager!.emergencyStop()
    }

    // 3. Delete all worktrees for this run's tasks
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.worktreeDir && existsSync(task.worktreeDir)) {
        yield* Effect.logInfo(`[orchestrator] Removing worktree: ${task.worktreeDir}`)
        // Use either to capture success/failure without failing the whole operation
        const worktreeResult = yield* this.worktree.complete(task.worktreeDir!, {
          branch: "",
          targetBranch: "",
          shouldMerge: false,
          shouldRemove: true,
        }).pipe(
          Effect.either
        )
        if (worktreeResult._tag === "Left") {
          const errorMessage = worktreeResult.left instanceof Error ? worktreeResult.left.message : String(worktreeResult.left)
          yield* Effect.logWarning(`[orchestrator] Failed to remove worktree ${task.worktreeDir}: ${errorMessage}`)
        } else {
          this.db.updateTask(taskId, { worktreeDir: null })
          result.cleaned++
        }
      }
    }

    // 4. Delete any custom container images used by tasks in this run
    // Custom images (pi-agent:custom-*, pi-agent:${profile}-*) are built for specific
    // workflows and should be cleaned up when the workflow is destroyed.
    if (this.containerManager) {
      const defaultImage = this.settings?.workflow?.container?.image || BASE_IMAGES.piAgent
      for (const taskId of run.taskOrder) {
        const task = this.db.getTask(taskId)
        if (task?.containerImage && task.containerImage !== defaultImage) {
          // Only delete custom-tagged images, never the default base image
          if (this.isCustomImage(task.containerImage)) {
            yield* Effect.logInfo(`[orchestrator] Deleting custom container image: ${task.containerImage}`)
            const containerManager = yield* this.getContainerImageOperations("destructiveStop")
            // Use either to capture success/failure without failing the whole operation
            const imageResult = yield* containerManager.deleteImage(task.containerImage!).pipe(
              Effect.either
            )
            if (imageResult._tag === "Left") {
              const errorMessage = imageResult.left instanceof Error ? imageResult.left.message : String(imageResult.left)
              yield* Effect.logWarning(`[orchestrator] Failed to delete custom image ${task.containerImage}: ${errorMessage}`)
            } else {
              this.db.updateTask(taskId, { containerImage: undefined })
            }
          }
        }
      }
    }

    // 5. Clear any paused states for all sessions in this run
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.sessionId) {
        clearPausedSessionState(this.db, task.sessionId)
      }
    }

    // 6. Mark all incomplete tasks as failed
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (yield* this.scheduler.isTaskExecuting(taskId)) {
        yield* this.scheduler.completeTask(taskId, "failed", task?.sessionId ?? null).pipe(Effect.orDie)
      } else if (yield* this.scheduler.isTaskQueued(taskId)) {
        yield* this.scheduler.removeQueuedTask(taskId)
      }

      if (task && (task.status === "queued" || task.status === "executing" || task.status === "review")) {
        this.db.updateTask(taskId, {
          status: "failed",
          errorMessage: "Workflow stopped by user - all work discarded",
          sessionId: null,
          sessionUrl: null,
        })
        this.broadcastTask(taskId)
      }
    }

    // 7. Update run status
    const updated = this.db.updateWorkflowRun(runId, {
      status: "failed",
      stopRequested: true,
      errorMessage: "Workflow stopped by user - all work discarded",
      currentTaskId: null,
      currentTaskIndex: run.taskOrder.length,
      finishedAt: nowUnix(),
    })
    if (updated) {
      const enriched = yield* this.enrichWorkflowRunEffect(updated)
      if (enriched) {
        this.broadcast({ type: "run_updated", payload: enriched })
      }
    }

    yield* this.scheduler.removeRun(runId).pipe(Effect.orDie)
    this.unregisterRun(runId)

    // Clear any persisted pause state
    clearGlobalPausedRunState(runId, this.db)
    clearAllPausedSessionStates(this.db)

    this.broadcast({ type: "execution_stopped", payload: { runId, destructive: true } })

        yield* this.triggerSchedulingEffect()

        return result
      }))
  }

  /**
   * Force stop - immediately kill all processes and clean up (backward compatibility).
   * Uses destructiveStop on the current run.
   */
  forceStop(): Effect.Effect<{ killed: number; cleaned: number }, OrchestratorOperationError> {
    return this.wrapOperation("forceStop", Effect.gen(this, function* () {
        const activeRunId = this.currentRunId ?? this.db.getWorkflowRuns().find((run) => this.isRunActiveStatus(run.status))?.id ?? null
        if (!activeRunId) {
          return { killed: 0, cleaned: 0 }
        }
        return yield* this.destructiveStop(activeRunId)
      }))
  }

  /**
   * Pause a specific workflow run by ID.
   * Kills the active processes but preserves state for resume.
   * Saves session state to disk for resume after server restart.
   * Iterates through all tasks in the run to pause their sessions.
   */
  pauseRun(runId: string): Effect.Effect<boolean, OrchestratorOperationError> {
    return this.wrapOperation("pauseRun", Effect.gen(this, function* () {
        const run = this.db.getWorkflowRun(runId)
        if (!run) {
          yield* Effect.logError(`[orchestrator] Cannot pause: run ${runId} not found`)
          return false
        }

    if (run.status !== "queued" && run.status !== "running" && run.status !== "stopping") {
      yield* Effect.logError(`[orchestrator] Cannot pause: run ${runId} is not running (status: ${run.status})`)
      return false
    }

    yield* Effect.logInfo(`[orchestrator] Pausing run ${runId}`)
    const control = this.getRunControl(runId)
    control.shouldPause = true
    yield* this.interruptRunTaskFibers(runId)

    const pausedSessions: PausedSessionState[] = []

    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (!task) continue

      if ((yield* this.scheduler.isTaskExecuting(taskId)) && task.sessionId) {
        const activeProcess = this.activeSessionProcesses.get(task.sessionId)
        if (activeProcess) {
          const pausedState = yield* this.pauseSession(task.sessionId, activeProcess)
          if (pausedState) {
            pausedSessions.push(pausedState)
            // Save individual session state
            savePausedSessionState(this.db, pausedState)
          }
        } else {
          this.db.updateWorkflowSession(task.sessionId, { status: "paused" })
          this.broadcast({
            type: "session_status_changed",
            payload: { sessionId: task.sessionId, status: "paused", taskId },
          })
        }
      }

      if (yield* this.scheduler.isTaskExecuting(taskId)) {
        yield* this.scheduler.requeueExecutingTask(taskId).pipe(Effect.orDie)
      }

      if (task.status === "executing" || task.status === "review") {
        this.db.updateTask(taskId, {
          status: "queued",
          errorMessage: null,
        })
        this.broadcastTask(taskId)
      }
    }

    // Clear active processes for this run
    for (const pausedSession of pausedSessions) {
      if (pausedSession.sessionId) {
        this.activeSessionProcesses.delete(pausedSession.sessionId)
      }
    }

    const pauseState: PausedRunState = {
      runId: run.id,
      kind: run.kind,
      taskOrder: run.taskOrder,
      currentTaskIndex: run.currentTaskIndex,
      currentTaskId: run.currentTaskId,
      targetTaskId: run.targetTaskId,
      pausedAt: nowUnix(),
      sessions: pausedSessions,
      executionPhase: pausedSessions.some((session) => session.executionPhase === "implementation_done") ? "reviewing" : "executing",
    }

    savePausedRunState(pauseState, this.db)

    const updated = this.db.updateWorkflowRun(runId, {
      status: "paused",
      pauseRequested: true,
      currentTaskId: (yield* this.scheduler.getQueuedTasks(runId))[0] ?? null,
    })
    if (updated) {
      const enriched = yield* this.enrichWorkflowRunEffect(updated)
      if (enriched) {
        this.broadcast({ type: "run_updated", payload: enriched })
      }
    }

    control.shouldPause = false
    control.isPaused = true
    if (this.currentRunId === runId) {
      this.isPaused = true
    }

    this.broadcast({ type: "execution_paused", payload: { runId } })

        return true
      }))
  }

  /**
   * Pause the current workflow run (backward compatibility).
   * Delegates to pauseRun with the current run ID.
   */
  pause(): Effect.Effect<boolean, OrchestratorOperationError> {
    return this.wrapOperation("pause", Effect.gen(this, function* () {
        const pausedRunId = this.currentRunId ?? this.db.getWorkflowRuns().find((run) => run.status === "queued" || run.status === "running")?.id ?? null
        if (!pausedRunId) {
          return false
        }
        return yield* this.pauseRun(pausedRunId)
      }))
  }

  /**
   * Resume a specific workflow run by ID.
   * Restores state from database and continues execution.
   * Can resume after server restart.
   * Iterates through all tasks in the run to resume their sessions.
   */
  resumeRun(runId: string): Effect.Effect<WorkflowRun | null, OrchestratorOperationError> {
    return this.wrapOperation("resumeRun", Effect.gen(this, function* () {
        const run = this.db.getWorkflowRun(runId)
        if (!run) {
          yield* Effect.logError(`[orchestrator] Cannot resume: run ${runId} not found`)
          return null
        }

        if (run.status !== "paused") {
          return yield* new OrchestratorOperationError({
            operation: "resumeRun",
            message: `Run ${runId} is not paused (status: ${run.status})`,
          })
        }

        yield* Effect.logInfo(`[orchestrator] Resuming run ${runId}`)
        clearGlobalPausedRunState(runId, this.db)

        const control = this.getRunControl(runId)
        control.shouldPause = false
        control.shouldStop = false
        control.isPaused = false
        if (this.currentRunId === runId) {
          this.isPaused = false
        }

        const updated = this.db.updateWorkflowRun(runId, {
          status: "queued",
          pauseRequested: false,
          currentTaskId: (yield* this.scheduler.getQueuedTasks(runId))[0] ?? run.currentTaskId,
        })
        if (updated) {
          const enriched = yield* this.enrichWorkflowRunEffect(updated)
          if (enriched) {
            this.broadcast({ type: "run_updated", payload: enriched })
          }
        }

        this.currentRunId = runId

        this.broadcast({ type: "execution_resumed", payload: { runId } })

        yield* this.triggerSchedulingEffect()

        return yield* this.enrichWorkflowRunEffect(this.db.getWorkflowRun(runId))
      }))
  }

  /**
   * Resume a paused workflow run (backward compatibility).
   * If no runId provided, checks for persisted pause state in database or uses current run.
   */
  resume(runId?: string): Effect.Effect<WorkflowRun | null, OrchestratorOperationError> {
    return this.wrapOperation("resume", Effect.gen(this, function* () {
        const targetRunId = runId || this.currentRunId

        if (!targetRunId) {
          const pausedRuns = yield* listPausedRunStates(this.db).pipe(
            Effect.mapError((cause) => this.toOperationError("resume", cause)),
          )
          if (pausedRuns.length > 0) {
            const mostRecent = pausedRuns[0]
            if (mostRecent) {
              return yield* this.resumeFromPauseStateEffect(mostRecent)
            }
          }
          return null
        }

        return yield* this.resumeRun(targetRunId)
      }))
  }

  /**
   * Resume from a loaded pause state.
   */
  private resumeFromPauseStateEffect(pauseState: PausedRunState): Effect.Effect<WorkflowRun | null, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const updated = this.db.updateWorkflowRun(pauseState.runId, {
        status: "queued",
        pauseRequested: false,
      })
      if (updated) {
        const enriched = yield* this.enrichWorkflowRunEffect(updated)
        if (enriched) {
          this.broadcast({ type: "run_updated", payload: enriched })
        }
      }

      clearGlobalPausedRunState(pauseState.runId, this.db)

      this.currentRunId = pauseState.runId
      this.isPaused = false
      const control = this.getRunControl(pauseState.runId)
      control.shouldStop = false
      control.shouldPause = false
      control.isPaused = false

      this.broadcast({ type: "execution_resumed", payload: { runId: pauseState.runId } })

      yield* this.triggerSchedulingEffect()

      return yield* this.enrichWorkflowRunEffect(this.db.getWorkflowRun(pauseState.runId))
    })
  }

  /**
   * Check if there's a paused run that can be resumed.
   */
  hasPausedRun(): Effect.Effect<boolean, OrchestratorOperationError> {
    return listPausedRunStates(this.db).pipe(
      Effect.map((pausedRuns) => pausedRuns.length > 0),
      Effect.mapError((cause) => this.toOperationError("hasPausedRun", cause)),
    )
  }

  /**
   * Get the paused run state if available.
   */
  getPausedRunState(): Effect.Effect<PausedRunState | null, OrchestratorOperationError> {
    return listPausedRunStates(this.db).pipe(
      Effect.map((pausedRuns) => pausedRuns[0] ?? null),
      Effect.mapError((cause) => this.toOperationError("getPausedRunState", cause)),
    )
  }

  /**
   * Pause an individual session.
   * Saves state for resume and kills the process.
   */
  private pauseSession(
    sessionId: string,
    activeProcess: { process: PiRpcProcess | ContainerPiProcess; session: PiWorkflowSession; onPause?: () => Effect.Effect<void, OrchestratorOperationError> },
  ): Effect.Effect<PausedSessionState | null, OrchestratorOperationError | PiProcessError> {
    return Effect.gen(this, function* () {
      const session = this.db.getWorkflowSession(sessionId)
      if (!session) return null

      if (activeProcess.onPause) {
        yield* activeProcess.onPause()
      }

      let containerId: string | null = null
      if ("getContainerId" in activeProcess.process && typeof activeProcess.process.getContainerId === "function") {
        containerId = yield* activeProcess.process.getContainerId()
      }

      const task = session.taskId ? this.db.getTask(session.taskId) : null

      const containerImage = this.settings?.workflow?.container?.image || null
      const executionPhase = task?.executionPhase || null

      const pausedState: PausedSessionState = {
        sessionId,
        taskId: session.taskId,
        taskRunId: session.taskRunId,
        sessionKind: session.sessionKind,
        cwd: session.cwd,
        worktreeDir: session.worktreeDir,
        branch: session.branch,
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        lastPrompt: null,
        lastPromptTimestamp: nowUnix(),
        containerId,
        containerName: `tauroboros-${sessionId}`,
        containerImage,
        piSessionId: session.piSessionId,
        piSessionFile: session.piSessionFile,
        executionPhase,
        pauseReason: "user_pause",
        context: task ? {
          agentOutputSnapshot: task.agentOutput || null,
          pendingToolCalls: null,
          reviewCount: task.reviewCount || 0,
        } : null,
      }

      yield* Effect.catchAll(
        Effect.gen(function* () {
          if ("forceKill" in activeProcess.process) {
            yield* activeProcess.process.forceKill("SIGTERM")
          }
        }),
        (error) => Effect.gen(function* () {
          const msg = error instanceof Error ? error.message : String(error)
          yield* Effect.logWarning(`[orchestrator] Failed to pause session ${sessionId}: ${msg}`)
        }),
      )

      this.db.updateWorkflowSession(sessionId, { status: "paused" })

      this.broadcast({ type: "session_status_changed", payload: {
        sessionId,
        status: "paused",
        taskId: session.taskId,
      }})

      return pausedState
    })
  }

  private resumeTaskExecution(task: Task, pausedState: PausedSessionState): Effect.Effect<void, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError> {
    return Effect.gen(this, function* () {
      const agentOutputSnapshot = pausedState.context?.agentOutputSnapshot ?? task.agentOutput ?? ""
      const continuePrompt = renderPromptTemplate(
        joinPrompt(PROMPT_CATALOG.resumeTaskContinuationPromptLines),
        {
          agent_output_snapshot: agentOutputSnapshot.slice(-2000) || "Task execution paused",
        },
      )

      const execution = yield* this.runSessionPrompt({
        task,
        sessionKind: pausedState.sessionKind,
        cwd: pausedState.cwd ?? pausedState.worktreeDir ?? "",
        worktreeDir: pausedState.worktreeDir,
        branch: pausedState.branch,
        model: pausedState.model,
        thinkingLevel: pausedState.thinkingLevel ?? undefined,
        promptText: continuePrompt,
        isResume: true,
        resumedSessionId: pausedState.sessionId,
        continuationPrompt: continuePrompt,
        // Pass container image for container recreation on resume
        containerImage: pausedState.containerImage,
        appendStreamingOutput: false,
      })

      this.activeSessionProcesses.delete(execution.session.id)
    })
  }

  private killSessionImmediately(sessionId: string): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      const activeProcess = this.activeSessionProcesses.get(sessionId)
      if (activeProcess) {
        if ("forceKill" in activeProcess.process) {
          yield* activeProcess.process.forceKill()
        }
        this.activeSessionProcesses.delete(sessionId)
      }

      this.db.updateWorkflowSession(sessionId, {
        status: "aborted",
        finishedAt: nowUnix(),
        errorMessage: "Session killed by workflow stop",
      })
    })
  }

  private executeTaskEffect(
    task: Task,
    options: Options,
    runId: string,
  ): Effect.Effect<void, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError | CollectEventsTimeoutError, never> {
    return Effect.gen(this, function* () {
      const eligibility = getPlanExecutionEligibility(task)
      if (!eligibility.ok) {
        return yield* new OrchestratorOperationError({
          operation: "executeTask",
          message: `Task state is invalid: ${eligibility.reason}`,
        })
      }
      const runControl = this.getRunControl(runId)

      yield* Effect.logInfo(
        `[orchestrator] executeTask START: ${task.name}(${task.id}), requirements: ${task.requirements.length > 0 ? task.requirements.join(', ') : 'none'}`,
      ).pipe(Effect.annotateLogs({ taskId: task.id, runId }))

      for (const depId of task.requirements) {
        const dep = this.db.getTask(depId)
        if (dep && dep.status !== "done") {
          yield* Effect.logInfo(
            `[orchestrator] executeTask BLOCKED: ${task.name}(${task.id}) - dependency "${dep.name}"(${depId}) status is ${dep.status}`,
          )
          return yield* new OrchestratorOperationError({
            operation: "executeTask",
            message: `Dependency "${dep.name}" is not done (status: ${dep.status})`,
          })
        }
      }

      // Track active task for pause/stop operations
      this.activeTask = task

      if (task.executionStrategy === "best_of_n") {
        return yield* this.runBestOfNExecution(task, options)
      }

      const isPlanResume = task.planmode && (task.executionPhase === "implementation_pending" || task.executionPhase === "plan_revision_pending")
      this.db.updateTask(task.id, {
        status: "executing",
        errorMessage: null,
        selfHealStatus: "idle",
        selfHealMessage: null,
        ...(isPlanResume ? {} : { agentOutput: "" }),
      })
      this.broadcastTask(task.id)

      let worktreeInfo: WorktreeInfo | null = null

      // Execute main task logic with error handling and cleanup
      const executeMain = Effect.gen(this, function* () {
        if (task.worktreeDir && existsSync(task.worktreeDir)) {
          const worktrees = yield* listWorktrees(this.projectRoot).pipe(
            Effect.mapError((error) => {
              const msg = error instanceof Error ? error.message : String(error)
              return new OrchestratorOperationError({
                operation: "executeTask.verifyWorktree",
                message: `Failed to verify worktree ${task.worktreeDir}: ${msg}`,
                cause: error,
              })
            }),
          )
          const existingWorktree = worktrees.find(w => w.directory === task.worktreeDir)
          if (existingWorktree) {
            worktreeInfo = existingWorktree
          }
        }

        if (!worktreeInfo) {
          const targetBranch = yield* resolveTargetBranch({
            baseDirectory: this.projectRoot,
            taskBranch: task.branch,
            optionBranch: options.branch,
          }).pipe(
            Effect.mapError((error) =>
              new OrchestratorOperationError({
                operation: "executeTask.resolveTargetBranch",
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
            ),
          )
          worktreeInfo = yield* this.worktree.createForTask(task.id, task.name, undefined, targetBranch).pipe(
            Effect.mapError((error) =>
              new OrchestratorOperationError({
                operation: "executeTask.createWorktree",
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
            ),
          )
          this.db.updateTask(task.id, { worktreeDir: worktreeInfo.directory })
        }
        this.activeWorktreeInfo = worktreeInfo
        this.broadcastTask(task.id)

        const command = options.command.trim()
        if (command) {
          yield* this.runPreExecutionCommand(task.id, command, worktreeInfo.directory)
        }

        const pausedSession = task.sessionId
          ? yield* loadPausedSessionState(this.db, task.sessionId).pipe(
              Effect.mapError((cause) => this.toOperationError("executeTask.loadPausedSessionState", cause)),
            )
          : null
        if (pausedSession) {
          yield* this.resumeTaskExecution(task, pausedSession)
          clearPausedSessionState(this.db, pausedSession.sessionId)
        } else if (task.planmode) {
          const planContinue = yield* this.runPlanMode(task.id, task, options, worktreeInfo)
          if (!planContinue) return
        } else {
          yield* this.runStandardPrompt(task.id, task, options, worktreeInfo)
        }

        if (task.review) {
          const reviewPassed = yield* this.runReviewLoop(task.id, options, worktreeInfo)
          if (!reviewPassed) return
        }

        if (task.review && task.codeStyleReview) {
          const success = yield* this.runCodeStyleCheck(task.id, options, worktreeInfo)
          if (!success) {
            this.db.updateTask(task.id, { status: "stuck", errorMessage: "Code style enforcement failed" })
            this.broadcastTask(task.id)
            return
          }
        }

        if (task.autoCommit) {
          yield* this.runCommitPrompt(task.id, task, options, worktreeInfo)
        }

        const targetBranch = yield* resolveTargetBranch({
          baseDirectory: this.projectRoot,
          taskBranch: task.branch,
          optionBranch: options.branch,
        }).pipe(
          Effect.mapError((error) =>
            new OrchestratorOperationError({
              operation: "executeTask.resolveTargetBranch.final",
              message: error instanceof Error ? error.message : String(error),
              cause: error,
            }),
          ),
        )

        yield* this.worktree.complete(worktreeInfo!.directory, {
          branch: worktreeInfo!.branch,
          targetBranch,
          shouldMerge: true,
          shouldRemove: task.deleteWorktree !== false,
          customMessage: `${task.name} (${task.id})`,
        }).pipe(
          Effect.mapError((error) =>
            new OrchestratorOperationError({
              operation: "executeTask.completeWorktree",
              message: error instanceof Error ? error.message : String(error),
              cause: error,
            }),
          ),
        )

        this.db.updateTask(task.id, {
          status: "done",
          completedAt: nowUnix(),
          worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
          executionPhase: task.planmode ? "implementation_done" : undefined,
        })
        this.broadcastTask(task.id)
      })

      // Add error handling and cleanup
      const executeWithHandling = executeMain.pipe(
        // Handle all errors
        Effect.catchAll((error: OrchestratorOperationError | SessionManagerExecuteError | PiProcessError | CollectEventsTimeoutError) => {
          // Don't mark as failed if we were stopped
          if (runControl.shouldStop || runControl.shouldPause || runControl.isPaused) {
            return Effect.fail(error)
          }

          // Special handling for CollectEventsTimeoutError
          if (error instanceof CollectEventsTimeoutError) {
            const completionCheck = checkEssentialCompletion(error.collectedEvents)
            if (completionCheck.isEssentiallyComplete) {
              return Effect.gen(this, function* () {
                yield* Effect.logInfo(
                  `[orchestrator] Task ${task.name}(${task.id}) timed out but was essentially complete: ${completionCheck.reason}`,
                )
                yield* this.completeTaskSuccessfullyEffect(task, worktreeInfo!, options)
              })
            } else {
              return Effect.gen(this, function* () {
                yield* Effect.logInfo(
                  `[orchestrator] Task ${task.name}(${task.id}) timed out with insufficient progress: ${completionCheck.reason}`,
                )
                const message = `${error.message} - ${completionCheck.reason}`
                this.db.updateTask(task.id, {
                  status: "failed",
                  errorMessage: message,
                  worktreeDir: worktreeInfo?.directory ?? task.worktreeDir,
                })
                this.broadcastTask(task.id)
                return yield* error
              })
            }
          }

          // Special handling for explicit worktree merge failures
          if (isMergeConflictWorktreeError(error)) {
            return Effect.gen(this, function* () {
              const result = yield* this.handleMergeConflictEffect(task, options, worktreeInfo!, error).pipe(Effect.either)
              if (Either.isLeft(result)) {
                return yield* result.left
              }
            })
          }

          // Default error handling
          const message = error instanceof Error ? error.message : String(error)
          this.db.updateTask(task.id, {
            status: "failed",
            errorMessage: message,
            worktreeDir: worktreeInfo?.directory ?? task.worktreeDir,
          })
          this.broadcastTask(task.id)
          return Effect.fail(error)
        }),
        Effect.ensuring(
          Effect.sync(() => {
            this.activeWorktreeInfo = null
            this.activeTask = null
          }),
        ),
      )

      return yield* executeWithHandling
    })
  }

  private handleMergeConflictEffect(
    task: Task,
    options: Options,
    worktreeInfo: WorktreeInfo,
    error: WorktreeError,
  ): Effect.Effect<{ handled: boolean }, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError, never> {
    return Effect.gen(this, function* () {
      yield* Effect.logInfo(
        `[orchestrator] Merge conflict detected for task ${task.name}(${task.id}), attempting repair`,
      )

      const targetBranch = yield* resolveTargetBranch({
        baseDirectory: this.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      }).pipe(
        Effect.mapError((err) =>
          new OrchestratorOperationError({
            operation: "handleMergeConflict.resolveTargetBranch",
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          }),
        ),
      )

      const repairSuccess = yield* this.runMergeRepairPrompt(
        task.id,
        task,
        options,
        worktreeInfo,
        targetBranch,
        error,
      )

      if (repairSuccess) {
        yield* Effect.logInfo(
          `[orchestrator] Merge repair succeeded for task ${task.name}(${task.id}), completing task`,
        )

        const completeResult = yield* this.worktree.complete(worktreeInfo.directory, {
          branch: worktreeInfo.branch,
          targetBranch,
          shouldMerge: true,
          shouldRemove: task.deleteWorktree !== false,
        }).pipe(
          Effect.mapError((err) => {
            const message = err instanceof Error ? err.message : String(err)
            return new OrchestratorOperationError({
              operation: "handleMergeConflict.completeWorktree",
              message,
              cause: err,
            })
          }),
          Effect.either,
        )

        if (Either.isLeft(completeResult)) {
          const message = completeResult.left.message
          yield* Effect.logError(
            `[orchestrator] Worktree completion failed after merge repair: ${message}`,
          )
          this.db.updateTask(task.id, {
            status: "failed",
            errorMessage: `Merge repair succeeded but worktree completion failed: ${message}`,
            worktreeDir: worktreeInfo.directory,
          })
          this.broadcastTask(task.id)
          return yield* completeResult.left
        }

        this.db.updateTask(task.id, {
          status: "done",
          completedAt: nowUnix(),
          worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
          executionPhase: task.planmode ? "implementation_done" : undefined,
        })
        this.broadcastTask(task.id)
        return { handled: true }
      } else {
        yield* Effect.logError(
          `[orchestrator] Merge repair failed for task ${task.name}(${task.id})`,
        )
        this.db.updateTask(task.id, {
          status: "stuck",
          errorMessage: `Merge conflict could not be resolved automatically. Manual intervention required to merge '${worktreeInfo.branch}' into '${targetBranch}'`,
          worktreeDir: worktreeInfo.directory,
        })
        this.broadcastTask(task.id)
        return yield* new OrchestratorOperationError({
          operation: "handleMergeConflict",
          message: "Merge repair failed",
        })
      }
    })
  }

  private buildReviewFile(task: Task, worktreeDir: string): string {
    const reviewDir = join(worktreeDir, ".pi", "tauroboros")
    mkdirSync(reviewDir, { recursive: true })
    const reviewFilePath = join(reviewDir, `review-${task.id}.md`)
    const reviewContent = [
      `# Review Task: ${task.name}`,
      "",
      "## Goals",
      task.prompt,
      "",
      "## Review Instructions",
      "- Validate implementation completeness against goals.",
      "- Identify bugs, security issues, edge cases, and missing tests.",
      "- Return strict JSON only as instructed by prompt contract.",
    ].join("\n")
    writeFileSync(reviewFilePath, reviewContent, "utf-8")
    return reviewFilePath
  }

  private runReviewLoop(taskId: string, options: Options, worktreeInfo: WorktreeInfo): Effect.Effect<boolean, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError> {
    return Effect.gen(this, function* () {
      const originalTask = this.db.getTask(taskId)
      if (!originalTask) return false

      const state: { reviewCount: number; jsonParseRetryCount: number } = {
        reviewCount: originalTask.reviewCount,
        jsonParseRetryCount: originalTask.jsonParseRetryCount,
      }
      const maxRuns = originalTask.maxReviewRunsOverride ?? options.maxReviews
      const maxJsonParseRetries = options.maxJsonParseRetries || 5
      const reviewFilePath = this.buildReviewFile(originalTask, worktreeInfo.directory)

      try {
        while (state.reviewCount < maxRuns) {
          const task = this.db.getTask(taskId)
          if (!task) return false

          this.db.updateTask(taskId, {
            status: "review",
            reviewCount: state.reviewCount,
            reviewActivity: "running",
          })
          this.broadcastTask(taskId)

          const reviewRun = yield* this.reviewRunner.run({
            task,
            cwd: worktreeInfo.directory,
            worktreeDir: worktreeInfo.directory,
            branch: worktreeInfo.branch,
            reviewFilePath,
            model: options.reviewModel,
            thinkingLevel: options.reviewThinkingLevel,
            maxJsonParseRetries,
            currentJsonParseRetryCount: state.jsonParseRetryCount,
            onSessionCreated: (process, startedSession) => {
              this.activeSessionProcesses.set(startedSession.id, {
                process,
                session: startedSession,
              })
            },
          }).pipe(
            Effect.mapError((cause) => this.toOperationError("runReviewLoop", cause)),
          )

          this.db.updateTask(taskId, {
            sessionId: reviewRun.sessionId,
            sessionUrl: this.sessionUrlFor(reviewRun.sessionId),
            reviewActivity: "idle",
            jsonParseRetryCount: reviewRun.jsonParseRetryCount,
          })
          this.broadcastTask(taskId)

          state.reviewCount += 1
          state.jsonParseRetryCount = reviewRun.jsonParseRetryCount
          this.db.updateTask(taskId, { reviewCount: state.reviewCount, reviewActivity: "idle", jsonParseRetryCount: state.jsonParseRetryCount })
          this.broadcastTask(taskId)

          if (reviewRun.reviewResult.status === "pass") {
            this.db.updateTask(taskId, { status: "executing", reviewActivity: "idle", jsonParseRetryCount: 0 })
            this.broadcastTask(taskId)
            return true
          }

          if (reviewRun.reviewResult.status === "json_parse_max_retries") {
            this.db.updateTask(taskId, {
              status: "stuck",
              reviewCount: state.reviewCount,
              reviewActivity: "idle",
              jsonParseRetryCount: reviewRun.jsonParseRetryCount,
              errorMessage: reviewRun.reviewResult.summary,
            })
            this.broadcastTask(taskId)
            return false
          }

          if (reviewRun.reviewResult.status === "blocked") {
            this.db.updateTask(taskId, {
              status: "stuck",
              reviewCount: state.reviewCount,
              reviewActivity: "idle",
              errorMessage: `Review blocked: ${reviewRun.reviewResult.summary}`,
            })
            this.broadcastTask(taskId)
            return false
          }

          if (state.reviewCount >= maxRuns) {
            this.db.updateTask(taskId, {
              status: "stuck",
              reviewCount: state.reviewCount,
              reviewActivity: "idle",
              errorMessage: `Max reviews (${maxRuns}) reached. Gaps: ${reviewRun.reviewResult.gaps.join("; ") || reviewRun.reviewResult.summary}`,
            })
            this.broadcastTask(taskId)
            return false
          }

          const currentTask = this.db.getTask(taskId)
          if (!currentTask) return false
          const fixPromptRendered = this.db.renderPrompt(
            "review_fix",
            buildReviewFixVariables(currentTask, reviewRun.reviewResult.summary, reviewRun.reviewResult.gaps),
          )
          const fixPrompt = reviewRun.reviewResult.recommendedPrompt
            ? `${fixPromptRendered.renderedText}\n\nReviewer recommended prompt:\n${reviewRun.reviewResult.recommendedPrompt}`
            : fixPromptRendered.renderedText

          const fixImageToUse = resolveContainerImage(currentTask, this.settings?.workflow?.container?.image)

          const fixSession = yield* this.runSessionPrompt({
            task: currentTask,
            taskId,
            sessionKind: "task",
            cwd: worktreeInfo.directory,
            worktreeDir: worktreeInfo.directory,
            branch: worktreeInfo.branch,
            model: currentTask.executionModel !== "default" ? currentTask.executionModel : options.executionModel,
            thinkingLevel: currentTask.executionThinkingLevel,
            promptText: fixPrompt,
            containerImage: fixImageToUse,
            appendStreamingOutput: false,
          })

          this.db.updateTask(taskId, {
            status: "executing",
            sessionId: fixSession.session.id,
            sessionUrl: this.sessionUrlFor(fixSession.session.id),
          })
          if (fixSession.responseText.trim()) {
            this.db.appendAgentOutput(taskId, tagOutput(`review-fix-${state.reviewCount}`, fixSession.responseText))
          }
          this.broadcastTask(taskId)
        }

        return true
      } finally {
        this.db.updateTask(taskId, { reviewActivity: "idle" })
        this.broadcastTask(taskId)
        try {
          unlinkSync(reviewFilePath)
        } catch (error) {
          yield* Effect.logWarning(`Failed to cleanup review file ${reviewFilePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
  }

  private runStandardPrompt(taskId: string, task: Task, options: Options, worktreeInfo: WorktreeInfo): Effect.Effect<void, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError> {
    return Effect.gen(this, function* () {
      // Container mode is the default - only disabled when explicitly set to false
      const isContainerMode = this.settings?.workflow?.container?.enabled !== false
      const prompt = this.db.renderPrompt("execution", buildExecutionVariables(task, options, worktreeInfo.directory, { isPlanMode: false }, isContainerMode))
      const execution = yield* this.runSessionPrompt({
        task,
        sessionKind: "task",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: task.executionModel !== "default" ? task.executionModel : options.executionModel,
        thinkingLevel: task.executionThinkingLevel,
        promptText: prompt.renderedText,
      })

      if (execution.responseText.trim()) {
        this.db.appendAgentOutput(taskId, `${execution.responseText.trim()}\n`)
        this.broadcastTask(taskId)
      }
    })
  }

  private runPlanMode(taskId: string, originalTask: Task, options: Options, worktreeInfo: WorktreeInfo): Effect.Effect<boolean, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError> {
    return Effect.gen(this, function* () {
      let task = this.db.getTask(taskId) ?? originalTask
      const isImplementationResume = task.executionPhase === "implementation_pending"
      const isRevisionResume = task.executionPhase === "plan_revision_pending"

      const planModel = task.planModel !== "default" ? task.planModel : options.planModel

      if (!isImplementationResume && !isRevisionResume) {
        const planningPrompt = this.db.renderPrompt("planning", buildPlanningVariables(task, options))
        const planning = yield* this.runSessionPrompt({
          task,
          sessionKind: "plan",
          cwd: worktreeInfo.directory,
          worktreeDir: worktreeInfo.directory,
          branch: worktreeInfo.branch,
          model: planModel,
          thinkingLevel: task.planThinkingLevel,
          promptText: planningPrompt.renderedText,
        })

        this.db.appendAgentOutput(taskId, tagOutput("plan", planning.responseText))
        this.broadcastTask(task.id)

        task = this.db.getTask(taskId) ?? task
        if (!task.autoApprovePlan) {
          // Do NOT delete worktree during plan approval - it must persist for implementation
          this.db.updateTask(taskId, {
            status: "review",
            awaitingPlanApproval: true,
            executionPhase: "plan_complete_waiting_approval",
            worktreeDir: worktreeInfo.directory,
          })
          this.broadcastTask(taskId)
          return false
        }

        this.db.updateTask(taskId, {
          awaitingPlanApproval: false,
          executionPhase: "implementation_pending",
        })
        this.broadcastTask(taskId)
        task = this.db.getTask(taskId) ?? task
      }

      if (isRevisionResume) {
        const currentPlan = getLatestTaggedOutput(task.agentOutput, "plan")
        const revisionFeedback = getLatestTaggedOutput(task.agentOutput, "user-revision-request")
        if (!currentPlan || !revisionFeedback) {
          return yield* new OrchestratorOperationError({
            operation: "runPlanMode",
            message: "Plan revision is missing captured [plan] or [user-revision-request] data",
          })
        }

        const revisionPrompt = this.db.renderPrompt("plan_revision", buildPlanRevisionVariables(task, currentPlan, revisionFeedback, options))
        const revised = yield* this.runSessionPrompt({
          task,
          sessionKind: "plan_revision",
          cwd: worktreeInfo.directory,
          worktreeDir: worktreeInfo.directory,
          branch: worktreeInfo.branch,
          model: planModel,
          thinkingLevel: task.planThinkingLevel,
          promptText: revisionPrompt.renderedText,
        })

        this.db.appendAgentOutput(taskId, tagOutput("plan", revised.responseText))
        this.broadcastTask(task.id)

        task = this.db.getTask(taskId) ?? task
        if (!task.autoApprovePlan) {
          // Do NOT delete worktree during plan approval - it must persist for implementation
          this.db.updateTask(taskId, {
            status: "review",
            awaitingPlanApproval: true,
            executionPhase: "plan_complete_waiting_approval",
            worktreeDir: worktreeInfo.directory,
          })
          this.broadcastTask(taskId)
          return false
        }

        this.db.updateTask(taskId, {
          awaitingPlanApproval: false,
          executionPhase: "implementation_pending",
        })
        this.broadcastTask(taskId)
        task = this.db.getTask(taskId) ?? task
      }

      const approvedPlan = getLatestTaggedOutput(task.agentOutput, "plan")
      if (!approvedPlan) {
        return yield* new OrchestratorOperationError({
          operation: "runPlanMode",
          message: "Execution prompt failed: no approved [plan] block found",
        })
      }
      const revisionRequests = task.agentOutput
        .match(/\[user-revision-request\]\s*[\s\S]*?(?=\n\[[a-z0-9-]+\]|$)/g)
        ?.map((item) => item.replace(/^\[user-revision-request\]\s*/i, "").trim())
        .filter(Boolean) ?? []
      const approvalNote = getLatestTaggedOutput(task.agentOutput, "user-approval-note")
      const userGuidance = [
        ...revisionRequests.map((value, idx) => `Revision request ${idx + 1}:\n${value}`),
        approvalNote ? `Final approval note:\n${approvalNote}` : "",
      ].filter(Boolean).join("\n\n")

      // Container mode is the default - only disabled when explicitly set to false
      const isContainerMode = this.settings?.workflow?.container?.enabled !== false
      const executionPrompt = this.db.renderPrompt(
        "execution",
        buildExecutionVariables(task, options, worktreeInfo.directory, {
          approvedPlan,
          userGuidance,
          isPlanMode: true,
        }, isContainerMode),
      )

      const execution = yield* this.runSessionPrompt({
        task,
        sessionKind: "task",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: task.executionModel !== "default" ? task.executionModel : options.executionModel,
        thinkingLevel: task.executionThinkingLevel,
        promptText: executionPrompt.renderedText,
      })

      this.db.appendAgentOutput(taskId, tagOutput("exec", execution.responseText))
      this.db.updateTask(taskId, { executionPhase: "implementation_done" })
      this.broadcastTask(task.id)
      return true
    })
  }

  private runCodeStyleCheck(taskId: string, options: Options, worktreeInfo: WorktreeInfo): Effect.Effect<boolean, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const task = this.db.getTask(taskId)
      if (!task) return false

      this.db.updateTask(taskId, { status: "code-style" })
      this.broadcastTask(taskId)

      const codeStyleRunner = new CodeStyleSessionRunner(
        this.db,
        this.settings,
        this.containerManager,
        this.sessionManager
      )

      const result = yield* codeStyleRunner.run({
        task,
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        codeStylePrompt: options.codeStylePrompt,
        model: options.reviewModel,
        thinkingLevel: options.reviewThinkingLevel,
        onOutput: (chunk) => {
          if (chunk.trim()) {
            this.db.appendAgentOutput(taskId, `${stripAndNormalize(chunk)}\n`)
          }
        },
        onSessionCreated: (process, startedSession) => {
          this.activeSessionProcesses.set(startedSession.id, {
            process,
            session: startedSession,
          })
        },
      }).pipe(
        Effect.map((result) => {
          if (result.sessionId) {
            this.activeSessionProcesses.delete(result.sessionId)
          }

          if (result.responseText.trim()) {
            this.db.appendAgentOutput(taskId, tagOutput("code-style", result.responseText))
            this.broadcastTask(taskId)
          }

          return result.success
        }),
        Effect.catchAll((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.db.appendAgentOutput(taskId, `\n[code-style-error]\n${message}\n`)
          this.broadcastTask(taskId)
          return Effect.succeed(false)
        }),
      )

      return result
    })
  }

  private runCommitPrompt(taskId: string, task: Task, options: Options, worktreeInfo: WorktreeInfo): Effect.Effect<void, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError> {
    return Effect.gen(this, function* () {
      const targetBranch = yield* resolveTargetBranch({
        baseDirectory: this.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      }).pipe(Effect.mapError((error) => this.toOperationError("runCommitPrompt", error)))
      const commitPrompt = this.db.renderPrompt("commit", buildCommitVariables(targetBranch, task.deleteWorktree !== false, task.name, task.id))

      const commit = yield* this.runSessionPrompt({
        task,
        sessionKind: "task",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: task.executionModel !== "default" ? task.executionModel : options.executionModel,
        thinkingLevel: task.executionThinkingLevel,
        promptText: commitPrompt.renderedText,
      })
      if (commit.responseText.trim()) {
        this.db.appendAgentOutput(taskId, tagOutput("commit", commit.responseText))
        this.broadcastTask(taskId)
      }
    })
  }

  /**
   * Repair a merge conflict by sending a prompt to the agent.
   * The agent will resolve the conflicts and complete the merge.
   */
  private runMergeRepairPrompt(
    taskId: string,
    task: Task,
    options: Options,
    worktreeInfo: WorktreeInfo,
    targetBranch: string,
    mergeError: WorktreeError | Error,
  ): Effect.Effect<boolean, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      yield* Effect.logInfo(`[orchestrator] Running merge repair for task ${task.name}(${taskId})`)

      const mergeOutput = mergeError instanceof WorktreeError ? mergeError.gitOutput : ""
      const repairPrompt = renderPromptTemplate(
        joinPrompt(PROMPT_CATALOG.mergeConflictRepairPromptLines),
        {
          worktree_branch: worktreeInfo.branch,
          target_branch: targetBranch,
          merge_output: mergeOutput || mergeError.message,
        },
      )

      const repair = yield* this.runSessionPrompt({
        task,
        sessionKind: "repair",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: options.repairModel !== "default" ? options.repairModel : options.executionModel,
        thinkingLevel: options.repairThinkingLevel,
        promptText: repairPrompt,
      }).pipe(
        Effect.mapError((error) => this.toOperationError("runMergeRepairPrompt", error)),
      )

      if (repair.responseText.trim()) {
        this.db.appendAgentOutput(taskId, tagOutput("merge-repair", repair.responseText))
        this.broadcastTask(taskId)
      }

      // Verify the merge was resolved by checking git status
      const status = yield* this.worktree.inspect(worktreeInfo.directory).pipe(
        Effect.mapError((error) => this.toOperationError("runMergeRepairPrompt", error)),
      )

      if (status.stagedFiles.length > 0 || status.modifiedFiles.length > 0) {
        // There are still uncommitted changes - try to commit them
        yield* Effect.logInfo(`[orchestrator] Merge repair has uncommitted changes, attempting commit`)
        const commitResult = yield* runShellCommandEffect(`git commit -m "Resolve merge conflicts"`, worktreeInfo.directory)
        if (commitResult.exitCode !== 0) {
          yield* Effect.logWarning(`[orchestrator] Automatic commit after merge repair failed: ${commitResult.stderr}`)
        }
      }

      return true
    }).pipe(
      Effect.catchAll((error) => {
        const message = error instanceof Error ? error.message : String(error)
        return Effect.gen(this, function* () {
          yield* Effect.logError(`[orchestrator] Merge repair failed: ${message}`)
          this.db.appendAgentOutput(taskId, `\n[merge-repair-error]\n${message}\n`)
          this.broadcastTask(taskId)
          return false
        })
      }),
    )
  }

  private runBestOfNExecution(task: Task, options: Options): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const command = options.command.trim()
      if (command) {
        const commandResult = yield* runShellCommandEffect(command, this.projectRoot)
        if (commandResult.stdout.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stdout]\n${commandResult.stdout.trim()}\n`)
        }
        if (commandResult.stderr.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stderr]\n${commandResult.stderr.trim()}\n`)
        }
        this.broadcastTask(task.id)
        if (commandResult.exitCode !== 0) {
          return yield* new OrchestratorOperationError({
            operation: "executeTask",
            message: `Pre-execution command failed with exit code ${commandResult.exitCode}`,
          })
        }
      }

      const bestOfNRunner = new BestOfNRunner({
        db: this.db,
        projectRoot: this.projectRoot,
        worktree: this.worktree,
        broadcast: this.broadcast,
        sessionUrlFor: this.sessionUrlFor,
        containerManager: this.containerManager,
        settings: this.settings,
        externalSessionManager: this.sessionManager,
        onSessionCreated: (process, startedSession) => {
          this.activeSessionProcesses.set(startedSession.id, {
            process,
            session: startedSession,
          })
        },
      })
      this.activeBestOfNRunner = bestOfNRunner
      yield* bestOfNRunner.run(task, options).pipe(
        Effect.mapError((cause) => this.toOperationError("runBestOfNExecution", cause)),
      )
      this.activeBestOfNRunner = null
    })
  }

  private runPreExecutionCommand(taskId: string, command: string, cwd: string): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const commandResult = yield* runShellCommandEffect(command, cwd)
      if (commandResult.stdout.trim()) {
        this.db.appendAgentOutput(taskId, `\n[command stdout]\n${commandResult.stdout.trim()}\n`)
      }
      if (commandResult.stderr.trim()) {
        this.db.appendAgentOutput(taskId, `\n[command stderr]\n${commandResult.stderr.trim()}\n`)
      }
      this.broadcastTask(taskId)
      if (commandResult.exitCode !== 0) {
        return yield* new OrchestratorOperationError({
          operation: "executeTask",
          message: `Pre-execution command failed with exit code ${commandResult.exitCode}`,
        })
      }
    })
  }

  private runSessionPrompt(input: {
    task: Task
    taskId?: string
    sessionKind: PiSessionKind
    cwd: string
    worktreeDir?: string | null
    branch?: string | null
    model?: string
    thinkingLevel?: string
    promptText: string
    containerImage?: string | null
    isResume?: boolean
    resumedSessionId?: string
    continuationPrompt?: string
    appendStreamingOutput?: boolean
    onSessionCreated?: (process: PiRpcProcess | ContainerPiProcess, session: PiWorkflowSession) => void
    onSessionStart?: (session: PiWorkflowSession) => void
    onSessionMessage?: (message: SessionMessage) => void
  }): Effect.Effect<{ session: PiWorkflowSession; responseText: string }, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError> {
    return Effect.gen(this, function* () {
      const createdSession: { current: PiWorkflowSession | null } = { current: null }

      const imageToUse = input.containerImage ?? resolveContainerImage(input.task, this.settings?.workflow?.container?.image)
      const targetTaskId = input.taskId ?? input.task.id

      const session = yield* this.sessionManager.executePrompt({
        taskId: targetTaskId,
        sessionKind: input.sessionKind,
        cwd: input.cwd,
        worktreeDir: input.worktreeDir,
        branch: input.branch,
        model: input.model,
        thinkingLevel: (input.thinkingLevel ?? input.task.thinkingLevel) as import("./types.ts").ThinkingLevel,
        promptText: input.promptText,
        isResume: input.isResume,
        resumedSessionId: input.resumedSessionId,
        continuationPrompt: input.continuationPrompt,
        containerImage: imageToUse,
      }, {
        onSessionCreated: (process, startedSession) => {
          createdSession.current = startedSession
          // Track the process for pause/stop operations
          this.activeSessionProcesses.set(startedSession.id, {
            process,
            session: startedSession,
            onPause: () => Effect.void,
          })
          input.onSessionCreated?.(process, startedSession)
        },
        onSessionStart: (startedSession) => {
          const updated = this.db.updateTask(targetTaskId, {
            sessionId: startedSession.id,
            sessionUrl: this.sessionUrlFor(startedSession.id),
          })
          if (updated) this.broadcast({ type: "task_updated", payload: updated })
          input.onSessionStart?.(startedSession)
        },
        onOutput: (chunk) => {
          if (input.appendStreamingOutput === false) return
          if (!chunk.trim()) return
          this.db.appendAgentOutput(targetTaskId, `${stripAndNormalize(chunk)}\n`)
        },
        onSessionMessage: (message) => {
          input.onSessionMessage?.(message)
          this.broadcast({
            type: "session_message_created",
            payload: message,
          })
        },
      })

      // Clean up tracking after session completes
      if (createdSession.current) {
        this.activeSessionProcesses.delete((createdSession.current as import("./db/types.ts").PiWorkflowSession).id)
      }

      return { session: session.session, responseText: session.responseText }
    })
  }



  /**
   * Clean/reset a workflow run and all its tasks
   * Resets all tasks in the run to backlog status and deletes all associated data
   */
  cleanRun(runId: string): Effect.Effect<CleanRunResult, OrchestratorOperationError> {
    return this.wrapOperation("cleanRun", Effect.gen(this, function* () {
      const result = yield* cleanWorkflowRun(runId, {
        db: this.db,
        broadcast: this.broadcast,
      }).pipe(
        Effect.mapError((error) => new OrchestratorOperationError({
          operation: "cleanRun",
          message: error.message,
          code: error.code,
          cause: error,
        }))
      )
      return result
    }))
  }

  private broadcastTask(taskId: string): void {
    const updated = this.db.getTask(taskId)
    if (!updated) return
    this.broadcast({ type: "task_updated", payload: updated })
  }

  private maybeSelfHealTask(runId: string, task: Task): Effect.Effect<import("./orchestrator/self-healing.ts").SelfHealInvestigationResult, OrchestratorOperationError> {
    return maybeSelfHealTask(
      runId,
      task,
      { db: this.db, selfHealingService: this.selfHealingService, broadcast: this.broadcast },
      {
        getExecutingStates: (runId) => this.scheduler.getExecutingStates(runId).pipe(Effect.orDie),
        getQueuedTasks: (runId) => this.scheduler.getQueuedTasks(runId),
      },
      (taskId) => this.broadcastTask(taskId),
    )
  }

  /**
   * Complete a task successfully after work is done (Effect version).
   * Used when a task timed out but was essentially complete.
   * Skips re-running review/commit as they already happened.
   */
  private completeTaskSuccessfullyEffect(
    task: Task,
    worktreeInfo: WorktreeInfo,
    options: Options,
  ): Effect.Effect<void, OrchestratorOperationError, never> {
    return Effect.gen(this, function* () {
      const targetBranch = yield* resolveTargetBranch({
        baseDirectory: this.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      }).pipe(
        Effect.mapError((error) =>
          new OrchestratorOperationError({
            operation: "completeTaskSuccessfully.resolveTargetBranch",
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
        ),
      )

      yield* this.worktree.complete(worktreeInfo.directory, {
        branch: worktreeInfo.branch,
        targetBranch,
        shouldMerge: true,
        shouldRemove: task.deleteWorktree !== false,
      }).pipe(
        Effect.mapError((error) =>
          new OrchestratorOperationError({
            operation: "completeTaskSuccessfully.completeWorktree",
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
        ),
      )

      this.db.updateTask(task.id, {
        status: "done",
        completedAt: nowUnix(),
        worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
        executionPhase: task.planmode ? "implementation_done" : undefined,
      })
      this.broadcastTask(task.id)
      yield* Effect.logInfo(
        `[orchestrator] Task ${task.name}(${task.id}) completed successfully after timeout recovery`,
      )
    }).pipe(
      Effect.catchAll((error) => {
        const message = error instanceof Error ? error.message : String(error)
        return Effect.gen(this, function* () {
          yield* Effect.logError(
            `[orchestrator] Task ${task.name}(${task.id}) completion failed after timeout: ${message}`,
          )
          this.db.updateTask(task.id, {
            status: "failed",
            errorMessage: `Worktree completion failed after timeout recovery: ${message}`,
            worktreeDir: worktreeInfo.directory,
          })
          this.broadcastTask(task.id)
          return yield* error
        })
      }),
    )
  }

  /**
   * Complete a task successfully after work is done.
   * Used when a task timed out but was essentially complete.
   * Skips re-running review/commit as they already happened.
   */
  appendApprovalNote(taskId: string, note: string): Task | null {
    const task = this.db.getTask(taskId)
    if (!task) return null
    return this.db.updateTask(taskId, {
      agentOutput: `${task.agentOutput}${tagOutput("user-approval-note", note)}`,
    })
  }

  appendRevisionRequest(taskId: string, feedback: string): Task | null {
    const task = this.db.getTask(taskId)
    if (!task) return null
    return this.db.updateTask(taskId, {
      agentOutput: `${task.agentOutput}${tagOutput("user-revision-request", feedback)}`,
      planRevisionCount: (task.planRevisionCount ?? 0) + 1,
    })
  }

  private getImageValidationContext(): import("./orchestrator/container-images.ts").ImageValidationContext {
    return {
      containerManager: this.containerManager,
      settingsWorkflowContainer: this.settings?.workflow?.container,
      getTask: (taskId: string) => this.db.getTask(taskId),
    }
  }

  /**
   * Validate that all container images for the given tasks exist.
   * Returns an object with valid flag and list of invalid tasks.
   * Skips validation when container mode is disabled.
   */
  private validateWorkflowImagesEffect(taskIds: string[]): Effect.Effect<{
    valid: boolean
    invalid: { taskId: string; taskName: string; image: string }[]
  }, OrchestratorOperationError> {
    return validateWorkflowImagesEffect(taskIds, this.getImageValidationContext())
  }

  /**
   * Check if a container image exists.
   * Uses the container manager if available, otherwise falls back to podman check.
   */
  private checkImageExistsEffect(imageName: string): Effect.Effect<boolean, OrchestratorOperationError> {
    return checkImageExistsEffect(imageName, this.getImageValidationContext())
  }

  /**
   * Check if a container image is a "custom" image that was built for a specific workflow.
   * Custom images follow naming patterns like:
   *   - pi-agent:custom-{timestamp}
   *   - pi-agent:{profileId}-{timestamp}
   *
   * The default base image is NOT considered custom and should never be deleted.
   */
  private isCustomImage(imageName: string): boolean {
    return isCustomImage(imageName)
  }

  /**
   * Log a task event to the session event system.
   * Used for logging when tasks are blocked due to missing images or other issues.
   */
  private logTaskEventEffect(
    taskId: string,
    eventType: string,
    data: Record<string, unknown>
  ): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.sync(() => {
      const sessionId = this.db.getTask(taskId)?.sessionId
      if (sessionId) {
        this.db.createSessionMessage({
          sessionId,
          taskId,
          role: "system",
          messageType: "error",
          contentJson: {
            eventType,
            timestamp: Date.now(),
            ...data
          },
        })
      }
    }).pipe(
      Effect.mapError((cause) => this.toOperationError("logTaskEvent", cause)),
    )
  }
}
