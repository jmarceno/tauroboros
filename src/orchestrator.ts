import { randomUUID } from "crypto"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { Effect, Schema } from "effect"
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
  type WSMessage,
  type WorkflowRun,
} from "./types.ts"
import { resolveExecutionTasks, getExecutionGraphTasks, isTaskExecutable, resolveBatches } from "./execution-plan.ts"
import { PiSessionManager } from "./runtime/session-manager.ts"
import { PiReviewSessionRunner } from "./runtime/review-session.ts"
import { CodeStyleSessionRunner } from "./runtime/codestyle-session.ts"
import { BestOfNRunner } from "./runtime/best-of-n.ts"
import { GlobalScheduler } from "./runtime/global-scheduler.ts"
import { WorktreeLifecycle, resolveTargetBranch, listWorktrees, type WorktreeInfo, WorktreeError } from "./runtime/worktree.ts"
import type { PiContainerManager } from "./runtime/container-manager.ts"
import { PiRpcProcess, CollectEventsTimeoutError } from "./runtime/pi-process.ts"
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

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function stripAndNormalize(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n")
}

function tagOutput(tag: string, text: string): string {
  return text.trim() ? `\n[${tag}]\n${text.trim()}\n` : ""
}

/**
 * Determine if a task that timed out was "essentially complete" based on collected events.
 * This heuristic checks if meaningful work was done before the timeout occurred.
 */
/**
 * Check if an error is a merge conflict failure.
 */
function isMergeConflictError(error: unknown): boolean {
  if (error instanceof WorktreeError) {
    return error.code === "MERGE_FAILED" || 
           (error.gitOutput?.includes("CONFLICT") ?? false) ||
           (error.gitOutput?.includes("conflict") ?? false)
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return msg.includes("merge failed") || 
           msg.includes("conflict") || 
           msg.includes("automatic merge failed")
  }
  return false
}

function checkEssentialCompletion(collectedEvents: Record<string, unknown>[]): {
  isEssentiallyComplete: boolean
  reason: string
} {
  if (collectedEvents.length === 0) {
    return { isEssentiallyComplete: false, reason: "No events collected" }
  }

  // Event types that indicate substantial work was done
  const workIndicators = new Set([
    "tool_start",      // Tool execution started
    "tool_complete",   // Tool execution completed
    "text",            // Text output
    "message_update",  // Assistant message
    "file_write",      // File was written
    "bash_command",    // Bash command executed
    "git_commit",      // Git commit was made
  ])

  // Count meaningful events
  let workEventCount = 0
  let hasFileWrite = false
  let hasGitCommit = false
  let hasToolComplete = false
  let hasMessageUpdate = false

  for (const event of collectedEvents) {
    const eventType = event.type as string
    if (workIndicators.has(eventType)) {
      workEventCount++
    }
    if (eventType === "file_write") hasFileWrite = true
    if (eventType === "git_commit") hasGitCommit = true
    if (eventType === "tool_complete") hasToolComplete = true
    if (eventType === "message_update") hasMessageUpdate = true
  }

  // Heuristic: If we have at least 5 work events AND
  // either a file write, git commit, tool completion, or substantial messages,
  // consider the task essentially complete
  if (workEventCount >= 5 && (hasFileWrite || hasGitCommit || hasToolComplete || hasMessageUpdate)) {
    return {
      isEssentiallyComplete: true,
      reason: `Task made substantial progress (${workEventCount} work events, fileWrite=${hasFileWrite}, gitCommit=${hasGitCommit}, toolComplete=${hasToolComplete})`,
    }
  }

  // Lower threshold for git commit specifically (if commit happened, task is essentially done)
  if (hasGitCommit) {
    return { isEssentiallyComplete: true, reason: "Git commit was made before timeout" }
  }

  return {
    isEssentiallyComplete: false,
    reason: `Insufficient progress indicators (${workEventCount} work events, need at least 5 with file/tool/message activity)`,
  }
}

async function runShellCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export class OrchestratorUnavailableError extends Schema.TaggedError<OrchestratorUnavailableError>()(
  "OrchestratorUnavailableError",
  {
    operation: Schema.String,
  },
) {}

export class OrchestratorOperationError extends Schema.TaggedError<OrchestratorOperationError>()(
  "OrchestratorOperationError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export const runOrchestratorOperationPromiseEffect = Effect.fn("runOrchestratorOperationPromiseEffect")(
  function* <A>(
    orchestrator: PiOrchestrator | null,
    operation: string,
    run: (instance: PiOrchestrator) => Promise<A>,
  ) {
    if (!orchestrator) {
      return yield* new OrchestratorUnavailableError({ operation })
    }

    return yield* Effect.tryPromise({
      try: async () => await run(orchestrator),
      catch: (cause) => new OrchestratorOperationError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    })
  },
)

export const runOrchestratorOperationSyncEffect = Effect.fn("runOrchestratorOperationSyncEffect")(
  function* <A>(
    orchestrator: PiOrchestrator | null,
    operation: string,
    run: (instance: PiOrchestrator) => A,
  ) {
    if (!orchestrator) {
      return yield* new OrchestratorUnavailableError({ operation })
    }

    return yield* Effect.try({
      try: () => run(orchestrator),
      catch: (cause) =>
        new OrchestratorOperationError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    })
  },
)

export async function runOrchestratorOperationPromise<A>(
  orchestrator: PiOrchestrator | null,
  operation: string,
  run: (instance: PiOrchestrator) => Promise<A>,
): Promise<A> {
  return await Effect.runPromise(runOrchestratorOperationPromiseEffect(orchestrator, operation, run))
}

export function runOrchestratorOperationSync<A>(
  orchestrator: PiOrchestrator | null,
  operation: string,
  run: (instance: PiOrchestrator) => A,
): A {
  return Effect.runSync(runOrchestratorOperationSyncEffect(orchestrator, operation, run))
}

export class PiOrchestrator {
  private running = false
  private shouldStop = false
  private shouldPause = false
  private isPaused = false
  private currentRunId: string | null = null
  private readonly activeRuns = new Map<string, RunContext>()
  private readonly runControls = new Map<string, { shouldStop: boolean; shouldPause: boolean; isPaused: boolean }>()
  private readonly taskRunLookup = new Map<string, string>()
  private readonly activeTaskIds = new Set<string>()
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
    onPause?: () => Promise<void>
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
    this.scheduler = new GlobalScheduler(Math.max(1, this.db.getOptions().parallelTasks ?? 1))
    this.selfHealingService = new SelfHealingService(this.db, this.projectRoot, this.settings)
  }

  /**
   * Use container backend for process isolation.
   * Must be called before starting any runs.
   */
  useContainerBackend(manager: PiContainerManager): void {
    this.containerManager = manager
    this.sessionManager = new PiSessionManager(this.db, manager, this.settings)
    this.reviewRunner = new PiReviewSessionRunner(this.db, this.settings, manager, this.sessionManager)
  }

  private updateSchedulerCapacity(): void {
    this.scheduler.setMaxSlots(Math.max(1, this.db.getOptions().parallelTasks ?? 1))
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
    return kind !== "single_task"
  }

  private getAutoDeployTemplates(condition: AutoDeployCondition): Task[] {
    return this.db.getTasks().filter((task) => task.status === "template" && task.autoDeploy === true && task.autoDeployCondition === condition)
  }

  private deployTemplateTask(template: Task): Task {
    const deployed = this.db.createTask({
      name: template.name,
      prompt: template.prompt,
      status: "backlog",
      branch: template.branch,
      planModel: template.planModel,
      executionModel: template.executionModel,
      planmode: template.planmode,
      autoApprovePlan: template.autoApprovePlan,
      review: template.review,
      autoCommit: template.autoCommit,
      autoDeploy: false,
      autoDeployCondition: null,
      deleteWorktree: template.deleteWorktree,
      requirements: [...template.requirements],
      thinkingLevel: template.thinkingLevel,
      planThinkingLevel: template.planThinkingLevel,
      executionThinkingLevel: template.executionThinkingLevel,
      executionPhase: "not_started",
      awaitingPlanApproval: false,
      planRevisionCount: 0,
      executionStrategy: template.executionStrategy,
      bestOfNConfig: template.bestOfNConfig,
      bestOfNSubstage: "idle",
      skipPermissionAsking: template.skipPermissionAsking,
      maxReviewRunsOverride: template.maxReviewRunsOverride,
      smartRepairHints: template.smartRepairHints,
      reviewActivity: "idle",
      containerImage: template.containerImage,
      codeStyleReview: template.codeStyleReview,
    })

    this.broadcast({ type: "task_created", payload: deployed })
    return deployed
  }

  private deployTemplatesForCondition(condition: AutoDeployCondition): Task[] {
    const templates = this.getAutoDeployTemplates(condition)
    if (templates.length === 0) {
      return []
    }

    const deployedTasks: Task[] = []
    for (const template of templates) {
      deployedTasks.push(this.deployTemplateTask(template))
    }

    return deployedTasks
  }

  private async launchAutoDeployPostRunTasks(runKind: WorkflowRun["kind"], hasFailures: boolean): Promise<void> {
    if (!this.shouldCheckAutoDeploy(runKind)) {
      return
    }

    const condition: AutoDeployCondition = hasFailures ? "workflow_failed" : "workflow_done"
    const deployedTasks = [
      ...this.deployTemplatesForCondition(condition),
      ...this.deployTemplatesForCondition("after_workflow_end"),
    ]

    if (deployedTasks.length === 0) {
      return
    }

    for (const deployedTask of deployedTasks) {
      await this.startSingle(deployedTask.id)
    }
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
    for (const taskId of run.taskOrder) {
      this.taskRunLookup.set(taskId, run.id)
    }
  }

  private unregisterRun(runId: string): void {
    this.activeRuns.delete(runId)
    this.runControls.delete(runId)

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

  private enrichWorkflowRun(run: WorkflowRun | null): WorkflowRun | null {
    if (!run) return null
    const queueStatus = this.scheduler.getRunQueueStatus(
      run.id,
      run.status,
      run.taskOrder,
      (taskId) => this.db.getTask(taskId)?.status ?? null,
    )

    return {
      ...run,
      queuedTaskCount: queueStatus.queuedTasks,
      executingTaskCount: queueStatus.executingTasks,
    }
  }

  private broadcastRun(runId: string): void {
    const run = this.enrichWorkflowRun(this.db.getWorkflowRun(runId))
    if (!run) return
    this.broadcast({ type: "run_updated", payload: run })
  }

  private async queueRunTasks(taskIds: string[]): Promise<void> {
    for (const taskId of taskIds) {
      const task = this.db.getTask(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }
      if (task.status === "done") {
        throw new Error(`Cannot queue completed task ${task.name} (${taskId})`)
      }

      this.db.updateTask(taskId, {
        status: "queued",
        errorMessage: null,
      })
      this.broadcastTask(taskId)
    }
  }

  private isDependencySatisfiedByAnotherRun(taskId: string): boolean {
    const runId = this.taskRunLookup.get(taskId)
    if (!runId) return false
    const run = this.db.getWorkflowRun(runId)
    return Boolean(run && this.isRunActiveStatus(run.status))
  }

  private resolveExecutionTasksWithActiveDependencies(allTasks: Task[], taskId: string): Task[] {
    const taskMap = new Map(allTasks.map((task) => [task.id, task]))
    const ordered: Task[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const visit = (candidateId: string, isTarget = false) => {
      if (visiting.has(candidateId)) {
        throw new Error(`Circular dependency detected while resolving ${candidateId}`)
      }
      if (visited.has(candidateId)) return

      const candidate = taskMap.get(candidateId)
      if (!candidate) {
        throw new Error(`Task not found: ${candidateId}`)
      }

      visiting.add(candidateId)
      for (const depId of candidate.requirements) {
        const dependency = taskMap.get(depId)
        if (!dependency) continue
        if (dependency.status === "done" || this.isDependencySatisfiedByAnotherRun(depId)) {
          continue
        }
        if (dependency.status === "failed" || dependency.status === "stuck") {
          throw new Error(`Dependency \"${dependency.name}\" is not done (status: ${dependency.status})`)
        }
        if (!isTaskExecutable(dependency)) {
          throw new Error(
            isTarget
              ? `Task \"${candidate.name}\" is blocked by dependency \"${dependency.name}\" in status \"${dependency.status}\"`
              : `Dependency \"${dependency.name}\" is not done and cannot run from status \"${dependency.status}\" (phase: ${dependency.executionPhase})`,
          )
        }
        visit(depId)
      }
      visiting.delete(candidateId)
      visited.add(candidateId)

      if (candidate.status === "done") return
      if (!isTaskExecutable(candidate)) {
        throw new Error(
          isTarget
            ? `Task \"${candidate.name}\" is not runnable from status \"${candidate.status}\" (phase: ${candidate.executionPhase})`
            : `Dependency \"${candidate.name}\" is not done and cannot run from status \"${candidate.status}\" (phase: ${candidate.executionPhase})`,
        )
      }
      ordered.push(candidate)
    }

    visit(taskId, true)
    return ordered
  }

  private getExecutionGraphTasksWithActiveDependencies(tasks: Task[]): Task[] {
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
          return dependency.status === "done" || selectedIds.has(depId) || this.isDependencySatisfiedByAnotherRun(depId)
        })

        if (!canQueue) continue

        selectedIds.add(task.id)
        madeProgress = true
      }
    }

    return [...selectedIds].map((taskId) => {
      const task = taskMap.get(taskId)
      if (!task) {
        throw new Error(`Task not found while building execution graph: ${taskId}`)
      }
      return task
    })
  }

  private async startRun(input: {
    kind: WorkflowRun["kind"]
    displayName: string
    taskOrder: string[]
    targetTaskId?: string | null
    groupId?: string
  }): Promise<WorkflowRun> {
    let resolvedTaskOrder = [...input.taskOrder]
    if (this.shouldCheckAutoDeploy(input.kind)) {
      const beforeStartTasks = this.deployTemplatesForCondition("before_workflow_start")
      resolvedTaskOrder = [...beforeStartTasks.map((task) => task.id), ...resolvedTaskOrder]
    }

    await this.cleanupStaleRuns()

    for (const taskId of resolvedTaskOrder) {
      const existingRunId = this.taskRunLookup.get(taskId)
      if (!existingRunId) continue
      const existingRun = this.db.getWorkflowRun(existingRunId)
      if (existingRun && this.isRunActiveStatus(existingRun.status)) {
        throw new Error(`Task ${taskId} is already part of active run ${existingRunId}`)
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
    await this.queueRunTasks(resolvedTaskOrder)
    this.scheduler.enqueueRun(run.id, resolvedTaskOrder)

    const enrichedRun = this.enrichWorkflowRun(this.db.getWorkflowRun(run.id))
    if (!enrichedRun) {
      throw new Error(`Failed to reload run ${run.id} after creation`)
    }

    this.broadcast({ type: "run_created", payload: enrichedRun })
    this.broadcast({ type: "execution_queued", payload: { runId: run.id } })
    if (run.kind === "group_tasks" && run.groupId) {
      this.broadcast({ type: "group_execution_started", payload: { groupId: run.groupId, runId: run.id } })
    }

    await this.triggerScheduling()
    return enrichedRun
  }

  private async refreshRunProgress(runId: string): Promise<void> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) return

    const completedCount = run.taskOrder.reduce((count, taskId) => {
      const task = this.db.getTask(taskId)
      return task && this.isTaskRunTerminal(task) ? count + 1 : count
    }, 0)

    const currentTaskId = this.scheduler.getExecutingStates(runId)[0]?.taskId
      ?? this.scheduler.getQueuedTasks(runId)[0]
      ?? null

    const updated = this.db.updateWorkflowRun(runId, {
      currentTaskIndex: completedCount,
      currentTaskId,
    })

    if (updated) {
      this.broadcastRun(runId)
    }
  }

  private isTaskReadyForScheduling(taskId: string, runId: string): boolean {
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
      throw new Error(`Task not found: ${taskId}`)
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
  }

  private async failTasksBlockedByDependency(runId: string): Promise<void> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) return

    let changed = true
    while (changed) {
      changed = false

      for (const taskId of run.taskOrder) {
        if (!this.scheduler.isTaskQueued(taskId)) continue
        const task = this.db.getTask(taskId)
        if (!task) continue

        const failedDependency = task.requirements
          .map((depId) => this.db.getTask(depId))
          .find((dep) => dep && (dep.status === "failed" || dep.status === "stuck"))

        if (!failedDependency) continue

        this.scheduler.removeQueuedTask(taskId)
        this.db.updateTask(taskId, {
          status: "failed",
          errorMessage: `Dependency \"${failedDependency.name}\" did not complete successfully`,
        })
        this.broadcastTask(taskId)
        changed = true
      }
    }
  }

  private async finalizeRunIfComplete(runId: string): Promise<void> {
    await this.failTasksBlockedByDependency(runId)

    const run = this.db.getWorkflowRun(runId)
    if (!run) return

    const tasks = run.taskOrder.map((taskId) => this.db.getTask(taskId)).filter((task): task is Task => Boolean(task))
    if (tasks.length !== run.taskOrder.length) {
      throw new Error(`Run ${runId} references missing tasks`)
    }

    if (tasks.some((task) => !this.isTaskRunTerminal(task))) {
      await this.refreshRunProgress(runId)
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

    this.scheduler.removeRun(runId)
    this.unregisterRun(runId)

    if (updated) {
      const enrichedRun = this.enrichWorkflowRun(updated)
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
    await this.launchAutoDeployPostRunTasks(run.kind, hasFailures)
  }

  private startScheduledTask(taskId: string, runId: string): void {
    const task = this.db.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    this.activeTaskIds.add(taskId)
    const run = this.db.getWorkflowRun(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }

    if (run.status === "queued") {
      const updated = this.db.updateWorkflowRun(runId, { status: "running" })
      if (updated) {
        const context = this.activeRuns.get(runId)
        if (context) context.status = "running"
        this.broadcast({ type: "execution_started", payload: { runId } })
      }
    }

    void (async () => {
      try {
        await this.refreshRunProgress(runId)
        await this.executeTask(task, this.db.getOptions(), runId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[orchestrator] Task ${taskId} in run ${runId} failed: ${message}`)
      } finally {
        this.activeTaskIds.delete(taskId)

        let latestTask: Task | null
        try {
          latestTask = this.db.getTask(taskId)
        } catch {
          // DB was closed (e.g. during test teardown) before the background task completed; abort gracefully.
          return
        }
        if (!latestTask) {
          await this.triggerScheduling()
          return
        }

        if (latestTask.status === "queued") {
          await this.refreshRunProgress(runId)
          await this.triggerScheduling()
          return
        }

        if (latestTask.status === "failed" || latestTask.status === "stuck") {
          const recovered = await this.maybeSelfHealTask(runId, latestTask)
          if (recovered) {
            await this.refreshRunProgress(runId)
            await this.triggerScheduling()
            return
          }
        }

        const finalStatus = latestTask.status === "done"
          ? "done"
          : latestTask.status === "stuck"
            ? "stuck"
            : "failed"
        this.scheduler.completeTask(taskId, finalStatus, latestTask.sessionId)

        await this.finalizeRunIfComplete(runId)
        await this.triggerScheduling()
      }
    })()
  }

  private async triggerScheduling(): Promise<void> {
    if (this.scheduling) return

    this.scheduling = true
    try {
      this.updateSchedulerCapacity()

      while (true) {
        for (const runId of this.activeRuns.keys()) {
          await this.failTasksBlockedByDependency(runId)
        }

        const started = this.scheduler.schedule((taskId, runId) => this.isTaskReadyForScheduling(taskId, runId))
        if (started.length === 0) break

        for (const state of started) {
          this.startScheduledTask(state.taskId, state.runId)
        }
      }

      for (const runId of [...this.activeRuns.keys()]) {
        await this.refreshRunProgress(runId)
        await this.finalizeRunIfComplete(runId)
      }
    } finally {
      this.scheduling = false
    }
  }

  getSlotUtilization(): SlotUtilization {
    this.updateSchedulerCapacity()
    return this.scheduler.getSlotUtilization((taskId) => this.db.getTask(taskId)?.name ?? taskId)
  }

  getRunQueueStatus(runId: string): RunQueueStatus {
    const run = this.db.getWorkflowRun(runId)
    if (!run) {
      throw new Error(`Run ${runId} not found`)
    }

    return this.scheduler.getRunQueueStatus(
      run.id,
      run.status,
      run.taskOrder,
      (taskId) => this.db.getTask(taskId)?.status ?? null,
    )
  }

  /**
   * Detect and clean up stale workflow runs that are in active status but have no executing tasks.
   * This is a defensive check to prevent ghost runs from blocking new executions.
   */
  private async cleanupStaleRuns(): Promise<void> {
    const activeRuns = this.db.getWorkflowRuns().filter((run) => this.isRunActiveStatus(run.status))

    for (const run of activeRuns) {
      if (this.activeRuns.has(run.id) || run.status === "paused") {
        continue
      }

      const hasTrackedSchedulerState = this.scheduler.getQueuedTasks(run.id).length > 0 || this.scheduler.getExecutingStates(run.id).length > 0
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
          const enriched = this.enrichWorkflowRun(updated)
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
        const enriched = this.enrichWorkflowRun(updated)
        if (enriched) {
          this.broadcast({ type: "run_updated", payload: enriched })
        }
      }
    }
  }

  async startAll(): Promise<WorkflowRun> {
    // Get all tasks and validate dependencies
    const allTasks = this.db.getTasks()
    const validTaskIds = new Set(allTasks.map(t => t.id))

    // Check for and log tasks with invalid dependencies
    for (const task of allTasks) {
      const invalidDeps = task.requirements.filter(depId => !validTaskIds.has(depId))
      if (invalidDeps.length > 0) {
        console.warn(`[orchestrator] Task "${task.name}" has invalid dependencies: ${invalidDeps.join(', ')} - will be ignored during execution`)
      }
    }

    // Use getExecutionGraphTasks to get ALL tasks that will run,
    // including those whose dependencies will be satisfied during this run

    const tasks = this.getExecutionGraphTasksWithActiveDependencies(allTasks)

    if (tasks.length === 0 && this.getAutoDeployTemplates("before_workflow_start").length === 0) {
      throw new Error("No tasks in backlog")
    }

    console.log(`[orchestrator] startAll: ${tasks.length} tasks to execute: ${tasks.map(t => `${t.name}(${t.id})`).join(', ')}`)

    // Validate container images for all tasks before starting
    const imageValidation = await this.validateWorkflowImages(tasks.map(t => t.id))
    if (!imageValidation.valid) {
      // Log event for each invalid task before throwing
      for (const invalid of imageValidation.invalid) {
        await this.logTaskEvent(invalid.taskId, "execution_blocked", {
          reason: "missing_container_image",
          image: invalid.image,
          message: `Task execution blocked: Container image '${invalid.image}' not found`,
          recommendation: "Build the image in Image Builder or select a valid image in task settings"
        })
      }
      const details = imageValidation.invalid
        .map(i => `"${i.taskName}" (${i.taskId}): ${i.image}`)
        .join("; ")
      throw new Error(`Cannot start workflow: The following tasks have invalid container images: ${details}. Build the images first.`)
    }

    return await this.startRun({
      kind: "all_tasks",
      displayName: "Workflow run",
      taskOrder: tasks.map((task) => task.id),
    })
  }

  async startSingle(taskId: string): Promise<WorkflowRun> {
    // Get all tasks and validate dependencies
    const allTasks = this.db.getTasks()
    const validTaskIds = new Set(allTasks.map(t => t.id))

    // Check for and log tasks with invalid dependencies
    for (const task of allTasks) {
      const invalidDeps = task.requirements.filter(depId => !validTaskIds.has(depId))
      if (invalidDeps.length > 0) {
        console.warn(`[orchestrator] Task "${task.name}" has invalid dependencies: ${invalidDeps.join(', ')} - will be ignored during execution`)
      }
    }

    const chain = this.resolveExecutionTasksWithActiveDependencies(allTasks, taskId)
    if (chain.length === 0) throw new Error("No tasks in backlog")
    const target = this.db.getTask(taskId)
    if (!target) throw new Error("Task not found")

    // Validate container images for all tasks in the chain before starting
    const imageValidation = await this.validateWorkflowImages(chain.map(t => t.id))
    if (!imageValidation.valid) {
      // Log event for each invalid task before throwing
      for (const invalid of imageValidation.invalid) {
        await this.logTaskEvent(invalid.taskId, "execution_blocked", {
          reason: "missing_container_image",
          image: invalid.image,
          message: `Task execution blocked: Container image '${invalid.image}' not found`,
          recommendation: "Build the image in Image Builder or select a valid image in task settings"
        })
      }
      const details = imageValidation.invalid
        .map(i => `"${i.taskName}" (${i.taskId}): ${i.image}`)
        .join("; ")
      throw new Error(`Cannot start workflow: The following tasks have invalid container images: ${details}. Build the images first.`)
    }

    return await this.startRun({
      kind: "single_task",
      displayName: `Single task: ${target.name}`,
      targetTaskId: target.id,
      taskOrder: chain.map((task) => task.id),
    })
  }

  /**
   * Validate that all tasks in the given array exist in the database.
   * Returns the loaded Task objects.
   * Throws an error if any task is not found.
   */
  private validateGroupTasksExist(taskIds: string[]): Task[] {
    const tasks: Task[] = []
    const missingIds: string[] = []

    for (const taskId of taskIds) {
      const task = this.db.getTask(taskId)
      if (!task) {
        missingIds.push(taskId)
      } else {
        tasks.push(task)
      }
    }

    if (missingIds.length > 0) {
      throw new Error(`One or more tasks in group were not found in database: ${missingIds.join(', ')}`)
    }

    return tasks
  }

  /**
   * Find dependencies that are outside the group.
   * Returns array of objects with task and its external dependency.
   */
  private findExternalDependencies(
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

  /**
   * Start execution of a task group.
   * Loads group members, validates dependencies, checks container images,
   * and executes tasks in dependency order.
   */
  async startGroup(groupId: string): Promise<WorkflowRun> {
    // Load group - throws if not found
    const group = this.db.getTaskGroup(groupId)
    if (!group) {
      throw new Error(`Task group with ID "${groupId}" not found`)
    }

    if (group.taskIds.length === 0) {
      throw new Error(`Cannot start group "${group.name}": group has no tasks`)
    }

    // Validate all tasks exist
    const groupTasks = this.validateGroupTasksExist(group.taskIds)

    // Check for external dependencies
    const allTasks = this.db.getTasks()
    const externalDeps = this.findExternalDependencies(groupTasks, allTasks)

    if (externalDeps.length > 0) {
      // Get unique task names that have external dependencies
      const taskNamesWithExternalDeps = [...new Set(externalDeps.map((d) => d.task.name))]
      throw new Error(
        `Group execution blocked: ${externalDeps.length} tasks have external dependencies that must be completed first: ${taskNamesWithExternalDeps.join(', ')}`
      )
    }

    // Validate container images for all group tasks
    const imageValidation = await this.validateWorkflowImages(group.taskIds)
    if (!imageValidation.valid) {
      // Log event for each invalid task before throwing
      for (const invalid of imageValidation.invalid) {
        await this.logTaskEvent(invalid.taskId, "execution_blocked", {
          reason: "missing_container_image",
          image: invalid.image,
          message: `Task execution blocked: Container image '${invalid.image}' not found`,
          recommendation: "Build the image in Image Builder or select a valid image in task settings",
        })
      }
      const details = imageValidation.invalid
        .map((i) => `"${i.taskName}" (${i.taskId}): ${i.image}`)
        .join("; ")
      throw new Error(`Cannot start group: The following tasks have invalid container images: ${details}`)
    }

    return await this.startRun({
      kind: "group_tasks",
      displayName: `Group: ${group.name}`,
      groupId: group.id,
      taskOrder: group.taskIds,
    })
  }

  /**
   * Stop (kill - SIGKILL) of a specific workflow run by ID.
   * Sets flags that will be checked in the execution loop and kills active sessions.
   */
  async stopRun(runId: string): Promise<void> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) {
      console.error(`[orchestrator] Cannot stop: run ${runId} not found`)
      return
    }

    if (run.status !== "queued" && run.status !== "running" && run.status !== "paused" && run.status !== "stopping") {
      console.error(`[orchestrator] Cannot stop: run ${runId} is not running, paused, or stopping (status: ${run.status})`)
      return
    }

    console.log(`[orchestrator] Graceful stop requested for run ${runId}`)
    const control = this.getRunControl(runId)
    control.shouldStop = true

    for (const [sessionId, activeProcess] of [...this.activeSessionProcesses]) {
      const taskId = activeProcess.session.taskId
      if (!taskId || !run.taskOrder.includes(taskId)) continue
      if ("forceKill" in activeProcess.process) {
        await activeProcess.process.forceKill("SIGKILL")
      }
      this.activeSessionProcesses.delete(sessionId)
    }

    for (const taskId of run.taskOrder ?? []) {
      const task = this.db.getTask(taskId)
      if (this.scheduler.isTaskExecuting(taskId)) {
        this.scheduler.completeTask(taskId, "failed", task?.sessionId ?? null)
      } else if (this.scheduler.isTaskQueued(taskId)) {
        this.scheduler.removeQueuedTask(taskId)
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
      const enriched = this.enrichWorkflowRun(updated)
      if (enriched) {
        this.broadcast({ type: "run_updated", payload: enriched })
      }
      this.broadcast({ type: "execution_stopped", payload: { runId } })
      console.log(`[orchestrator] Run ${runId} stopped immediately`)
    }

    this.scheduler.removeRun(runId)
    this.unregisterRun(runId)
    await this.triggerScheduling()
  }

  /**
   * Request destructive stop of current workflow run.
   * This is the main STOP action - it kills everything and loses data.
   */
  async stop(): Promise<void> {
    const activeRunId = this.currentRunId ?? this.db.getWorkflowRuns().find((run) => this.isRunActiveStatus(run.status))?.id ?? null
    if (!activeRunId) return
    // STOP is destructive by design - kills containers, loses data
    await this.destructiveStop(activeRunId)
  }

  /**
   * Emergency stop - kill all containers immediately.
   */
  async emergencyStop(): Promise<number> {
    if (!this.containerManager) return 0
    return this.containerManager.emergencyStop()
  }

  /**
   * Destructive stop - immediately kill all processes and clean up for a specific run.
   * This is destructive and requires user confirmation.
   * Kills all sessions, containers, worktrees for the run's tasks and marks them as failed.
   */
  async destructiveStop(runId: string): Promise<{ killed: number; cleaned: number }> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) {
      throw new Error(`Run ${runId} not found`)
    }

    console.log(`[orchestrator] Destructive stop for run ${runId}`)
    const result = { killed: 0, cleaned: 0 }
    const control = this.getRunControl(runId)
    control.shouldStop = true

    // 1. Stop all active sessions for tasks in this run
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.sessionId) {
        await this.killSessionImmediately(task.sessionId)
        result.killed++
      }
    }

    // 2. Kill all containers for this run's tasks
    if (this.containerManager) {
      for (const taskId of run.taskOrder) {
        const task = this.db.getTask(taskId)
        if (task?.sessionId) {
          try {
            await this.containerManager.forceKillContainer(task.sessionId)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.warn(`[orchestrator] Failed to kill container for session ${task.sessionId}: ${msg}`)
          }
        }
      }
      // Also do emergency stop as a fallback
      result.killed += await this.containerManager.emergencyStop()
    }

    // 3. Delete all worktrees for this run's tasks
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.worktreeDir && existsSync(task.worktreeDir)) {
        try {
          console.log(`[orchestrator] Removing worktree: ${task.worktreeDir}`)
          await this.worktree.complete(task.worktreeDir, {
            branch: "",
            targetBranch: "",
            shouldMerge: false,
            shouldRemove: true,
          })
          this.db.updateTask(taskId, { worktreeDir: null })
          result.cleaned++
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.warn(`[orchestrator] Failed to remove worktree ${task.worktreeDir}: ${msg}`)
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
            try {
              console.log(`[orchestrator] Deleting custom container image: ${task.containerImage}`)
              await this.containerManager.deleteImage(task.containerImage)
              this.db.updateTask(taskId, { containerImage: undefined })
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              console.warn(`[orchestrator] Failed to delete custom image ${task.containerImage}: ${msg}`)
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
      if (this.scheduler.isTaskExecuting(taskId)) {
        this.scheduler.completeTask(taskId, "failed", task?.sessionId ?? null)
      } else if (this.scheduler.isTaskQueued(taskId)) {
        this.scheduler.removeQueuedTask(taskId)
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
      const enriched = this.enrichWorkflowRun(updated)
      if (enriched) {
        this.broadcast({ type: "run_updated", payload: enriched })
      }
    }

    this.scheduler.removeRun(runId)
    this.unregisterRun(runId)

    // Clear any persisted pause state
    clearGlobalPausedRunState()
    clearAllPausedSessionStates(this.db)

    this.broadcast({ type: "execution_stopped", payload: { runId, destructive: true } })

    await this.triggerScheduling()

    return result
  }

  /**
   * Force stop - immediately kill all processes and clean up (backward compatibility).
   * Uses destructiveStop on the current run.
   */
  async forceStop(): Promise<{ killed: number; cleaned: number }> {
    const activeRunId = this.currentRunId ?? this.db.getWorkflowRuns().find((run) => this.isRunActiveStatus(run.status))?.id ?? null
    if (!activeRunId) {
      return { killed: 0, cleaned: 0 }
    }
    return this.destructiveStop(activeRunId)
  }

  /**
   * Pause a specific workflow run by ID.
   * Kills the active processes but preserves state for resume.
   * Saves session state to disk for resume after server restart.
   * Iterates through all tasks in the run to pause their sessions.
   */
  async pauseRun(runId: string): Promise<boolean> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) {
      console.error(`[orchestrator] Cannot pause: run ${runId} not found`)
      return false
    }

    if (run.status !== "queued" && run.status !== "running" && run.status !== "stopping") {
      console.error(`[orchestrator] Cannot pause: run ${runId} is not running (status: ${run.status})`)
      return false
    }

    console.log(`[orchestrator] Pausing run ${runId}`)
    const control = this.getRunControl(runId)
    control.shouldPause = true

    const pausedSessions: PausedSessionState[] = []

    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (!task) continue

      if (this.scheduler.isTaskExecuting(taskId) && task.sessionId) {
        const activeProcess = this.activeSessionProcesses.get(task.sessionId)
        if (activeProcess) {
          const pausedState = await this.pauseSession(task.sessionId, activeProcess)
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

      if (this.scheduler.isTaskExecuting(taskId)) {
        this.scheduler.requeueExecutingTask(taskId)
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
      currentTaskId: this.scheduler.getQueuedTasks(runId)[0] ?? null,
    })
    if (updated) {
      const enriched = this.enrichWorkflowRun(updated)
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
  }

  /**
   * Pause the current workflow run (backward compatibility).
   * Delegates to pauseRun with the current run ID.
   */
  async pause(): Promise<boolean> {
    const pausedRunId = this.currentRunId ?? this.db.getWorkflowRuns().find((run) => run.status === "queued" || run.status === "running")?.id ?? null
    if (!pausedRunId) {
      return false
    }
    return this.pauseRun(pausedRunId)
  }

  /**
   * Resume a specific workflow run by ID.
   * Restores state from database and continues execution.
   * Can resume after server restart.
   * Iterates through all tasks in the run to resume their sessions.
   */
  async resumeRun(runId: string): Promise<WorkflowRun | null> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) {
      console.error(`[orchestrator] Cannot resume: run ${runId} not found`)
      return null
    }

    if (run.status !== "paused") {
      throw new Error(`Run ${runId} is not paused (status: ${run.status})`)
    }

    console.log(`[orchestrator] Resuming run ${runId}`)
    clearGlobalPausedRunState(runId, this.db)

    const control = this.getRunControl(runId)
    control.shouldPause = false
    control.shouldStop = false
    control.isPaused = false
    if (this.currentRunId === runId) {
      this.isPaused = false
    }

    // Update run status
    const updated = this.db.updateWorkflowRun(runId, {
      status: "queued",
      pauseRequested: false,
      currentTaskId: this.scheduler.getQueuedTasks(runId)[0] ?? run.currentTaskId,
    })
    if (updated) {
      const enriched = this.enrichWorkflowRun(updated)
      if (enriched) {
        this.broadcast({ type: "run_updated", payload: enriched })
      }
    }

    this.currentRunId = runId

    this.broadcast({ type: "execution_resumed", payload: { runId } })

    await this.triggerScheduling()

    return this.enrichWorkflowRun(this.db.getWorkflowRun(runId))
  }

  /**
   * Resume a paused workflow run (backward compatibility).
   * If no runId provided, checks for persisted pause state in database or uses current run.
   */
  async resume(runId?: string): Promise<WorkflowRun | null> {
    const targetRunId = runId || this.currentRunId

    if (!targetRunId) {
      const pausedRuns = listPausedRunStates(this.db)
      if (pausedRuns.length > 0) {
        const mostRecent = pausedRuns[0]
        if (mostRecent) {
          return this.resumeFromPauseState(mostRecent)
        }
      }
      if (hasPausedRunState()) {
        const pauseState = loadPausedRunState()
        if (pauseState) {
          return this.resumeFromPauseState(pauseState)
        }
      }
      return null
    }

    return this.resumeRun(targetRunId)
  }

  /**
   * Resume from a loaded pause state.
   */
  private async resumeFromPauseState(pauseState: PausedRunState): Promise<WorkflowRun | null> {
    const updated = this.db.updateWorkflowRun(pauseState.runId, {
      status: "queued",
      pauseRequested: false,
    })
    if (updated) {
      const enriched = this.enrichWorkflowRun(updated)
      if (enriched) {
        this.broadcast({ type: "run_updated", payload: enriched })
      }
    }

    clearGlobalPausedRunState()

    this.currentRunId = pauseState.runId
    this.isPaused = false
    const control = this.getRunControl(pauseState.runId)
    control.shouldStop = false
    control.shouldPause = false
    control.isPaused = false

    this.broadcast({ type: "execution_resumed", payload: { runId: pauseState.runId } })

    await this.triggerScheduling()

    return this.enrichWorkflowRun(this.db.getWorkflowRun(pauseState.runId))
  }

  /**
   * Check if there's a paused run that can be resumed.
   */
  hasPausedRun(): boolean {
    return listPausedRunStates(this.db).length > 0 || hasPausedRunState()
  }

  /**
   * Get the paused run state if available.
   */
  getPausedRunState(): PausedRunState | null {
    const pausedRuns = listPausedRunStates(this.db)
    if (pausedRuns.length > 0) {
      return pausedRuns[0] ?? null
    }
    return loadPausedRunState()
  }

  /**
   * Pause an individual session.
   * Saves state for resume and kills the process.
   */
  private async pauseSession(
    sessionId: string,
    activeProcess: { process: PiRpcProcess | ContainerPiProcess; session: PiWorkflowSession; onPause?: () => Promise<void> },
  ): Promise<PausedSessionState | null> {
    const session = this.db.getWorkflowSession(sessionId)
    if (!session) return null

    // Call custom onPause handler if provided
    if (activeProcess.onPause) {
      await activeProcess.onPause()
    }

    // Get container ID if using container
    let containerId: string | null = null
    if ("getContainerId" in activeProcess.process && typeof activeProcess.process.getContainerId === "function") {
      containerId = await activeProcess.process.getContainerId()
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

    try {
      if ("forceKill" in activeProcess.process) {
        await activeProcess.process.forceKill("SIGTERM")
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[orchestrator] Failed to pause session ${sessionId}: ${msg}`)
    }

    this.db.updateWorkflowSession(sessionId, { status: "paused" })

    this.broadcast({ type: "session_status_changed", payload: {
      sessionId,
      status: "paused",
      taskId: session.taskId,
    }})

    return pausedState
  }

  /**
   * Resume an individual session.
   * Restarts containers if needed and sends "continue" prompt.
   */
  private async resumeSession(sessionId: string): Promise<void> {
    // Load paused state for this session
    const pauseState = loadPausedRunState()
    if (!pauseState) {
      throw new Error(`No paused state found for session ${sessionId}`)
    }

    const pausedSession = pauseState.sessions.find(s => s.sessionId === sessionId)
    if (!pausedSession) {
      throw new Error(`Session ${sessionId} not found in paused state`)
    }

    const session = this.db.getWorkflowSession(sessionId)
    if (!session) throw new Error("Session not found")

    // Check if container needs to be restarted
    if (pausedSession.containerId && this.containerManager) {
      const containerInfo = await this.containerManager.checkContainerById(pausedSession.containerId)
      if (!containerInfo?.running) {
        console.log(`[orchestrator] Container ${pausedSession.containerId} not running for session ${sessionId}`)
      }
    }

    if (pausedSession.taskId) {
      const task = this.db.getTask(pausedSession.taskId)
      if (task) {
        await this.resumeTaskExecution(task, pausedSession)
      }
    }
  }

  private async resumeTaskExecution(task: Task, pausedState: PausedSessionState): Promise<void> {
    const agentOutputSnapshot = pausedState.context?.agentOutputSnapshot ?? task.agentOutput ?? ""
    const continuePrompt = renderPromptTemplate(
      joinPrompt(PROMPT_CATALOG.resumeTaskContinuationPromptLines),
      {
        agent_output_snapshot: agentOutputSnapshot.slice(-2000) || "Task execution paused",
      },
    )

    const execution = await this.sessionManager.executePrompt({
      taskId: task.id,
      sessionKind: pausedState.sessionKind,
      cwd: pausedState.cwd ?? pausedState.worktreeDir ?? "",
      worktreeDir: pausedState.worktreeDir,
      branch: pausedState.branch,
      model: pausedState.model,
      thinkingLevel: pausedState.thinkingLevel as import("./types.ts").ThinkingLevel | undefined,
      promptText: continuePrompt,
      isResume: true,
      resumedSessionId: pausedState.sessionId,
      continuationPrompt: continuePrompt,
      // Pass container image for container recreation on resume
      containerImage: pausedState.containerImage,
      onSessionCreated: (process, startedSession) => {
        this.activeSessionProcesses.set(startedSession.id, {
          process,
          session: startedSession,
          onPause: async () => {},
        })
      },
      onSessionStart: (startedSession) => {
        this.db.updateTask(task.id, {
          sessionId: startedSession.id,
          sessionUrl: this.sessionUrlFor(startedSession.id),
        })
      },
    })

    this.activeSessionProcesses.delete(execution.session.id)
  }

  private async killSessionImmediately(sessionId: string): Promise<void> {
    const activeProcess = this.activeSessionProcesses.get(sessionId)
    if (activeProcess) {
      if ("forceKill" in activeProcess.process) {
        await activeProcess.process.forceKill()
      }
      this.activeSessionProcesses.delete(sessionId)
    }

    this.db.updateWorkflowSession(sessionId, {
      status: "aborted",
      finishedAt: nowUnix(),
      errorMessage: "Session killed by workflow stop",
    })
  }

  private async runInBackground(runId: string, taskIds: string[]): Promise<void> {
    const executedTaskIds = new Set<string>()
    const options = this.db.getOptions()
    const parallelLimit = options.parallelTasks ?? 1
    const run = this.db.getWorkflowRun(runId)

    // Get task objects for all task IDs
    const tasks: Task[] = []
    for (const taskId of taskIds) {
      const task = this.db.getTask(taskId)
      if (task) tasks.push(task)
    }

    // Resolve tasks into parallel batches based on dependencies
    const batches = resolveBatches(tasks, parallelLimit)
    console.log(`[orchestrator] runInBackground: ${tasks.length} tasks resolved into ${batches.length} batches with parallelLimit=${parallelLimit}`)

    try {
      let taskIndex = 0
      for (const batch of batches) {
        if (this.shouldStop) break
        // TODO: Implement proper pause coordination for multiple active tasks
        // Currently pause only works between batches, not within a batch.
        // For full parallel pause support:
        // 1. Track all active tasks in a Set (not just activeTask)
        // 2. Send pause signal to all active sessions in parallel
        // 3. Wait for all to reach paused state
        // 4. Save state for all tasks
        if (this.shouldPause) return

        // Validate dependencies for all tasks in the batch
        for (const task of batch) {
          for (const depId of task.requirements) {
            const dep = this.db.getTask(depId)
            if (dep && dep.status !== "done" && !executedTaskIds.has(depId)) {
              const msg = `Dependency "${dep.name}" is not done (status: ${dep.status})`
              this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
              this.broadcastTask(task.id)
              throw new Error(msg)
            }
          }
        }

        // Update run progress (first task of the batch)
        if (batch.length > 0) {
          const updatedRun = this.db.updateWorkflowRun(runId, {
            currentTaskId: batch[0].id,
            currentTaskIndex: taskIndex,
          })
          if (updatedRun) this.broadcast({ type: "run_updated", payload: updatedRun })
        }

        // Execute all tasks in this batch in parallel
        console.log(`[orchestrator] Executing batch with ${batch.length} tasks in parallel: ${batch.map(t => t.name).join(', ')}`)

        const batchResults = await Promise.allSettled(
          batch.map(task => this.executeTask(task, options, runId))
        )

        // Process results
        let hasFailure = false
        for (let i = 0; i < batch.length; i++) {
          const task = batch[i]
          const result = batchResults[i]

          if (result.status === 'fulfilled') {
            executedTaskIds.add(task.id)
            console.log(`[orchestrator] executeTask COMPLETE: ${task.name}(${task.id})`)
          } else {
            hasFailure = true
            console.error(`[orchestrator] executeTask FAILED: ${task.name}(${task.id}) - ${result.reason}`)
            // Task failure is already handled within executeTask
          }

          taskIndex++
        }

        const progressedRun = this.db.updateWorkflowRun(runId, {
          currentTaskIndex: taskIndex,
          currentTaskId: taskIds[taskIndex] ?? null,
        })
        if (progressedRun) this.broadcast({ type: "run_updated", payload: progressedRun })

        // If any task failed, stop the workflow (fail-fast behavior)
        if (hasFailure) {
          throw new Error(`One or more tasks in the batch failed`)
        }

        console.log(`[orchestrator] Batch complete. Total executed: ${executedTaskIds.size}/${tasks.length}`)
      }

      // Only mark as completed if we weren't paused
      if (!this.shouldPause) {
        const finalRun = this.db.updateWorkflowRun(runId, {
          status: this.shouldStop ? "completed" : "completed",
          stopRequested: this.shouldStop,
          currentTaskId: null,
          currentTaskIndex: tasks.length,
          finishedAt: nowUnix(),
        })
        if (finalRun) this.broadcast({ type: "run_updated", payload: finalRun })
        
        // If this was a group execution, mark the group as completed
        if (run && run.kind === "group_tasks" && run.groupId) {
          const completedGroup = this.db.updateTaskGroup(run.groupId, {
            status: "completed",
            completedAt: nowUnix(),
          })
          if (completedGroup) {
            this.broadcast({ type: "task_group_updated", payload: completedGroup })
            this.broadcast({ type: "group_execution_complete", payload: { groupId: run.groupId } })
          }
        }
        
        this.broadcast({ type: "execution_complete", payload: {} })
      }
    } catch (error) {
      // Don't mark as failed if we were paused or stopped
      if (this.shouldPause || this.shouldStop) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const failed = this.db.updateWorkflowRun(runId, {
        status: "failed",
        errorMessage: message,
        finishedAt: nowUnix(),
      })
      if (failed) this.broadcast({ type: "run_updated", payload: failed })
      this.broadcast({ type: "error", payload: { message } })
    } finally {
      // Always reset running flag to allow new executions to start
      // This is critical for pause functionality - when paused, we need running=false
      // so users can start new runs, but we preserve currentRunId for resume
      this.running = false

      if (!this.shouldPause) {
        // Only reset full orchestrator state if this run is still the current run.
        // If cleanupStaleRuns() or destructiveStop() has already started a new run,
        // we must not corrupt that new run's state.
        // Note: When paused (shouldPause=true), we preserve currentRunId and other
        // state so the run can be resumed later. The pauseRun() method handles that.
        if (this.currentRunId === runId) {
          this.currentRunId = null
          this.activeBestOfNRunner = null
          this.activeWorktreeInfo = null
          this.activeTask = null
          sessionPauseStateManager.clear()
          this.broadcast({ type: "execution_stopped", payload: {} })
        } else {
          // This run was already cleaned up by another operation (e.g., destructiveStop
          // or cleanupStaleRuns started a new run). Just broadcast that this run stopped.
          this.broadcast({ type: "execution_stopped", payload: { runId, replaced: true } })
        }
      }
    }
  }

  private async executeTask(task: Task, options: Options, runId: string): Promise<void> {
    const eligibility = getPlanExecutionEligibility(task)
    if (!eligibility.ok) throw new Error(`Task state is invalid: ${eligibility.reason}`)
    const runControl = this.getRunControl(runId)

    console.log(`[orchestrator] executeTask START: ${task.name}(${task.id}), requirements: ${task.requirements.length > 0 ? task.requirements.join(', ') : 'none'}`)

    for (const depId of task.requirements) {
      const dep = this.db.getTask(depId)
      if (dep && dep.status !== "done") {
        console.log(`[orchestrator] executeTask BLOCKED: ${task.name}(${task.id}) - dependency "${dep.name}"(${depId}) status is ${dep.status}`)
        throw new Error(`Dependency "${dep.name}" is not done (status: ${dep.status})`)
      }
    }

    // Track active task for pause/stop operations
    // TODO: For parallel execution, this should add to a Set of active tasks
    // rather than replacing the single activeTask reference
    this.activeTask = task

    if (task.executionStrategy === "best_of_n") {
      const command = options.command.trim()
      if (command) {
        const commandResult = await runShellCommand(command, this.projectRoot)
        if (commandResult.stdout.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stdout]\n${commandResult.stdout.trim()}\n`)
        }
        if (commandResult.stderr.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stderr]\n${commandResult.stderr.trim()}\n`)
        }
        this.broadcastTask(task.id)
        if (commandResult.exitCode !== 0) {
          throw new Error(`Pre-execution command failed with exit code ${commandResult.exitCode}`)
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
      await bestOfNRunner.run(task, options)
      this.activeBestOfNRunner = null
      return
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
    try {
      if (task.worktreeDir && existsSync(task.worktreeDir)) {
        try {
          const worktrees = await listWorktrees(this.projectRoot)
          const existingWorktree = worktrees.find(w => w.directory === task.worktreeDir)
          if (existingWorktree) {
            worktreeInfo = existingWorktree
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.warn(`[orchestrator] Failed to verify worktree ${task.worktreeDir}: ${msg}`)
        }
      }

      if (!worktreeInfo) {
        // Resolve the target branch to use as base for the worktree
        const targetBranch = await resolveTargetBranch({
          baseDirectory: this.projectRoot,
          taskBranch: task.branch,
          optionBranch: options.branch,
        })
        worktreeInfo = await this.worktree.createForTask(task.id, undefined, targetBranch)
        this.db.updateTask(task.id, { worktreeDir: worktreeInfo.directory })
      }
      this.activeWorktreeInfo = worktreeInfo
      this.broadcastTask(task.id)

      const command = options.command.trim()
      if (command) {
        const commandResult = await runShellCommand(command, worktreeInfo.directory)
        if (commandResult.stdout.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stdout]\n${commandResult.stdout.trim()}\n`)
        }
        if (commandResult.stderr.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stderr]\n${commandResult.stderr.trim()}\n`)
        }
        this.broadcastTask(task.id)
        if (commandResult.exitCode !== 0) {
          throw new Error(`Pre-execution command failed with exit code ${commandResult.exitCode}`)
        }
      }

      const pausedSession = task.sessionId ? loadPausedSessionState(this.db, task.sessionId) : null
      if (pausedSession) {
        await this.resumeTaskExecution(task, pausedSession)
        clearPausedSessionState(this.db, pausedSession.sessionId)
      } else if (task.planmode) {
        const planContinue = await this.runPlanMode(task.id, task, options, worktreeInfo)
        if (!planContinue) return
      } else {
        await this.runStandardPrompt(task.id, task, options, worktreeInfo)
      }

      if (task.review) {
        const reviewPassed = await this.runReviewLoop(task.id, options, worktreeInfo)
        if (!reviewPassed) return
      }

      if (task.review && task.codeStyleReview) {
        const success = await this.runCodeStyleCheck(task.id, options, worktreeInfo)
        if (!success) {
          this.db.updateTask(task.id, { status: "stuck", errorMessage: "Code style enforcement failed" })
          this.broadcastTask(task.id)
          return
        }
      }

      if (task.autoCommit) {
        await this.runCommitPrompt(task.id, task, options, worktreeInfo)
      }

      const targetBranch = await resolveTargetBranch({
        baseDirectory: this.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      })
      await this.worktree.complete(worktreeInfo.directory, {
        branch: worktreeInfo.branch,
        targetBranch,
        shouldMerge: true,
        shouldRemove: task.deleteWorktree !== false,
      })

      this.db.updateTask(task.id, {
        status: "done",
        completedAt: nowUnix(),
        worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
        executionPhase: task.planmode ? "implementation_done" : undefined,
      })
      this.broadcastTask(task.id)
    } catch (error) {
      // Don't mark as failed if we were stopped
      if (runControl.shouldStop || runControl.shouldPause || runControl.isPaused) {
        throw error
      }

      // Special handling for CollectEventsTimeoutError
      // The task may have timed out but completed substantial work
      if (error instanceof CollectEventsTimeoutError) {
        const completionCheck = checkEssentialCompletion(error.collectedEvents)
        if (completionCheck.isEssentiallyComplete) {
          console.log(`[orchestrator] Task ${task.name}(${task.id}) timed out but was essentially complete: ${completionCheck.reason}`)
          // The work was done, just the agent_end event didn't arrive in time
          // Complete the task normally without running review/commit (they already ran)
          await this.completeTaskSuccessfully(task, worktreeInfo!, options)
          return
        } else {
          console.log(`[orchestrator] Task ${task.name}(${task.id}) timed out with insufficient progress: ${completionCheck.reason}`)
          const message = `${error.message} - ${completionCheck.reason}`
          this.db.updateTask(task.id, {
            status: "failed",
            errorMessage: message,
            worktreeDir: worktreeInfo?.directory ?? task.worktreeDir,
          })
          this.broadcastTask(task.id)
          throw error
        }
      }

      // Special handling for merge conflicts
      // Send repair agent to fix the merge instead of failing the task
      if (isMergeConflictError(error)) {
        console.log(`[orchestrator] Merge conflict detected for task ${task.name}(${task.id}), attempting repair`)
        const targetBranch = await resolveTargetBranch({
          baseDirectory: this.projectRoot,
          taskBranch: task.branch,
          optionBranch: options.branch,
        })

        const repairSuccess = await this.runMergeRepairPrompt(
          task.id,
          task,
          options,
          worktreeInfo!,
          targetBranch,
          error instanceof WorktreeError ? error : new Error(String(error)),
        )

        if (repairSuccess) {
          console.log(`[orchestrator] Merge repair succeeded for task ${task.name}(${task.id}), completing task`)
          try {
            // Try to complete the worktree again (merge should now succeed)
            await this.worktree.complete(worktreeInfo!.directory, {
              branch: worktreeInfo!.branch,
              targetBranch,
              shouldMerge: true,
              shouldRemove: task.deleteWorktree !== false,
            })

            this.db.updateTask(task.id, {
              status: "done",
              completedAt: nowUnix(),
              worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo!.directory,
              executionPhase: task.planmode ? "implementation_done" : undefined,
            })
            this.broadcastTask(task.id)
            return
          } catch (completionError) {
            // If completion still fails after repair, mark as failed
            const message = completionError instanceof Error ? completionError.message : String(completionError)
            console.error(`[orchestrator] Worktree completion failed after merge repair: ${message}`)
            this.db.updateTask(task.id, {
              status: "failed",
              errorMessage: `Merge repair succeeded but worktree completion failed: ${message}`,
              worktreeDir: worktreeInfo?.directory ?? task.worktreeDir,
            })
            this.broadcastTask(task.id)
            throw completionError
          }
        } else {
          // Repair failed - mark as stuck since the task work is done but merge failed
          console.error(`[orchestrator] Merge repair failed for task ${task.name}(${task.id})`)
          this.db.updateTask(task.id, {
            status: "stuck",
            errorMessage: `Merge conflict could not be resolved automatically. Manual intervention required to merge '${worktreeInfo!.branch}' into '${targetBranch}'`,
            worktreeDir: worktreeInfo?.directory ?? task.worktreeDir,
          })
          this.broadcastTask(task.id)
          throw error
        }
      }

      const message = error instanceof Error ? error.message : String(error)
      this.db.updateTask(task.id, {
        status: "failed",
        errorMessage: message,
        worktreeDir: worktreeInfo?.directory ?? task.worktreeDir,
      })
      this.broadcastTask(task.id)
      throw error
    } finally {
      // Clear active tracking
      this.activeWorktreeInfo = null
      // TODO: For parallel execution, this should remove from Set of active tasks
      // rather than just clearing the single reference
      this.activeTask = null
    }
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

  private async runReviewLoop(taskId: string, options: Options, worktreeInfo: WorktreeInfo): Promise<boolean> {
    const originalTask = this.db.getTask(taskId)
    if (!originalTask) return false

    let reviewCount = originalTask.reviewCount
    let jsonParseRetryCount = originalTask.jsonParseRetryCount
    const maxRuns = originalTask.maxReviewRunsOverride ?? options.maxReviews
    const maxJsonParseRetries = options.maxJsonParseRetries || 5
    const reviewFilePath = this.buildReviewFile(originalTask, worktreeInfo.directory)

    try {
      while (reviewCount < maxRuns) {
        const task = this.db.getTask(taskId)
        if (!task) return false

        this.db.updateTask(taskId, {
          status: "review",
          reviewCount,
          reviewActivity: "running",
        })
        this.broadcastTask(taskId)

        const reviewRun = await this.reviewRunner.run({
          task,
          cwd: worktreeInfo.directory,
          worktreeDir: worktreeInfo.directory,
          branch: worktreeInfo.branch,
          reviewFilePath,
          model: options.reviewModel,
          thinkingLevel: options.reviewThinkingLevel,
          maxJsonParseRetries,
          currentJsonParseRetryCount: jsonParseRetryCount,
          onSessionCreated: (process, startedSession) => {
            this.activeSessionProcesses.set(startedSession.id, {
              process,
              session: startedSession,
            })
          },
        })

        this.db.updateTask(taskId, {
          sessionId: reviewRun.sessionId,
          sessionUrl: this.sessionUrlFor(reviewRun.sessionId),
          reviewActivity: "idle",
          jsonParseRetryCount: reviewRun.jsonParseRetryCount,
        })
        this.broadcastTask(taskId)

        reviewCount += 1
        jsonParseRetryCount = reviewRun.jsonParseRetryCount
        this.db.updateTask(taskId, { reviewCount, reviewActivity: "idle", jsonParseRetryCount })
        this.broadcastTask(taskId)

        if (reviewRun.reviewResult.status === "pass") {
          this.db.updateTask(taskId, { status: "executing", reviewActivity: "idle", jsonParseRetryCount: 0 })
          this.broadcastTask(taskId)
          return true
        }

        if (reviewRun.reviewResult.status === "json_parse_max_retries") {
          this.db.updateTask(taskId, {
            status: "stuck",
            reviewCount,
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
            reviewCount,
            reviewActivity: "idle",
            errorMessage: `Review blocked: ${reviewRun.reviewResult.summary}`,
          })
          this.broadcastTask(taskId)
          return false
        }

        if (reviewCount >= maxRuns) {
          this.db.updateTask(taskId, {
            status: "stuck",
            reviewCount,
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

        const fixSession = await this.sessionManager.executePrompt({
          taskId,
          sessionKind: "task",
          cwd: worktreeInfo.directory,
          worktreeDir: worktreeInfo.directory,
          branch: worktreeInfo.branch,
          model: currentTask.executionModel !== "default" ? currentTask.executionModel : options.executionModel,
          thinkingLevel: currentTask.executionThinkingLevel,
          promptText: fixPrompt,
          containerImage: fixImageToUse,
          onSessionCreated: (process, startedSession) => {
            // Track review fix sessions for pause/stop operations
            this.activeSessionProcesses.set(startedSession.id, {
              process,
              session: startedSession,
            })
          },
        })

        this.db.updateTask(taskId, {
          status: "executing",
          sessionId: fixSession.session.id,
          sessionUrl: this.sessionUrlFor(fixSession.session.id),
        })
        if (fixSession.responseText.trim()) {
          this.db.appendAgentOutput(taskId, tagOutput(`review-fix-${reviewCount}`, fixSession.responseText))
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
        const msg = error instanceof Error ? error.message : String(error)
        console.debug(`[orchestrator] Failed to remove review file ${reviewFilePath}: ${msg}`)
      }
    }
  }

  private async runStandardPrompt(taskId: string, task: Task, options: Options, worktreeInfo: WorktreeInfo): Promise<void> {
    // Container mode is the default - only disabled when explicitly set to false
    const isContainerMode = this.settings?.workflow?.container?.enabled !== false
    const prompt = this.db.renderPrompt("execution", buildExecutionVariables(task, options, worktreeInfo.directory, { isPlanMode: false }, isContainerMode))
    const execution = await this.runSessionPrompt({
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
  }

  private async runPlanMode(taskId: string, originalTask: Task, options: Options, worktreeInfo: WorktreeInfo): Promise<boolean> {
    let task = this.db.getTask(taskId) ?? originalTask
    const isImplementationResume = task.executionPhase === "implementation_pending"
    const isRevisionResume = task.executionPhase === "plan_revision_pending"

    const planModel = task.planModel !== "default" ? task.planModel : options.planModel

    if (!isImplementationResume && !isRevisionResume) {
      const planningPrompt = this.db.renderPrompt("planning", buildPlanningVariables(task, options))
      const planning = await this.runSessionPrompt({
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
        throw new Error("Plan revision is missing captured [plan] or [user-revision-request] data")
      }

      const revisionPrompt = this.db.renderPrompt("plan_revision", buildPlanRevisionVariables(task, currentPlan, revisionFeedback, options))
      const revised = await this.runSessionPrompt({
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
      throw new Error("Execution prompt failed: no approved [plan] block found")
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

    const execution = await this.runSessionPrompt({
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
  }

  private async runCodeStyleCheck(taskId: string, options: Options, worktreeInfo: WorktreeInfo): Promise<boolean> {
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

    try {
      const result = await codeStyleRunner.run({
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
      })

      if (result.sessionId) {
        this.activeSessionProcesses.delete(result.sessionId)
      }

      if (result.responseText.trim()) {
        this.db.appendAgentOutput(taskId, tagOutput("code-style", result.responseText))
        this.broadcastTask(taskId)
      }

      return result.success
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.appendAgentOutput(taskId, `\n[code-style-error]\n${message}\n`)
      this.broadcastTask(taskId)
      return false
    }
  }

  private async runCommitPrompt(taskId: string, task: Task, options: Options, worktreeInfo: WorktreeInfo): Promise<void> {
    const targetBranch = await resolveTargetBranch({
      baseDirectory: this.projectRoot,
      taskBranch: task.branch,
      optionBranch: options.branch,
    })
    const commitPrompt = this.db.renderPrompt("commit", buildCommitVariables(targetBranch, task.deleteWorktree !== false))

    const commit = await this.runSessionPrompt({
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
  }

  /**
   * Repair a merge conflict by sending a prompt to the agent.
   * The agent will resolve the conflicts and complete the merge.
   */
  private async runMergeRepairPrompt(
    taskId: string,
    task: Task,
    options: Options,
    worktreeInfo: WorktreeInfo,
    targetBranch: string,
    mergeError: WorktreeError | Error,
  ): Promise<boolean> {
    console.log(`[orchestrator] Running merge repair for task ${task.name}(${taskId})`)

    const mergeOutput = mergeError instanceof WorktreeError ? mergeError.gitOutput : ""
    const repairPrompt = renderPromptTemplate(
      joinPrompt(PROMPT_CATALOG.mergeConflictRepairPromptLines),
      {
        worktree_branch: worktreeInfo.branch,
        target_branch: targetBranch,
        merge_output: mergeOutput || mergeError.message,
      },
    )

    try {
      const repair = await this.runSessionPrompt({
        task,
        sessionKind: "repair",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: options.repairModel !== "default" ? options.repairModel : options.executionModel,
        thinkingLevel: options.repairThinkingLevel,
        promptText: repairPrompt,
      })

      if (repair.responseText.trim()) {
        this.db.appendAgentOutput(taskId, tagOutput("merge-repair", repair.responseText))
        this.broadcastTask(taskId)
      }

      // Verify the merge was resolved by checking git status
      const status = await this.worktree.inspect(worktreeInfo.directory)
      if (status.stagedFiles.length > 0 || status.modifiedFiles.length > 0) {
        // There are still uncommitted changes - try to commit them
        console.log(`[orchestrator] Merge repair has uncommitted changes, attempting commit`)
        const commitResult = await runShellCommand(`git commit -m "Resolve merge conflicts"`, worktreeInfo.directory)
        if (commitResult.exitCode !== 0) {
          console.warn(`[orchestrator] Automatic commit after merge repair failed: ${commitResult.stderr}`)
        }
      }

      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[orchestrator] Merge repair failed: ${message}`)
      this.db.appendAgentOutput(taskId, `\n[merge-repair-error]\n${message}\n`)
      this.broadcastTask(taskId)
      return false
    }
  }

  private async runSessionPrompt(input: {
    task: Task
    sessionKind: PiSessionKind
    cwd: string
    worktreeDir?: string | null
    branch?: string | null
    model?: string
    thinkingLevel?: string
    promptText: string
  }): Promise<{ session: PiWorkflowSession; responseText: string }> {
    let createdSession: PiWorkflowSession | null = null
    let createdProcess: PiRpcProcess | ContainerPiProcess | null = null

    const imageToUse = resolveContainerImage(input.task, this.settings?.workflow?.container?.image)

    const session = await this.sessionManager.executePrompt({
      taskId: input.task.id,
      sessionKind: input.sessionKind,
      cwd: input.cwd,
      worktreeDir: input.worktreeDir,
      branch: input.branch,
      model: input.model,
      thinkingLevel: (input.thinkingLevel ?? input.task.thinkingLevel) as import("./types.ts").ThinkingLevel,
      promptText: input.promptText,
      containerImage: imageToUse,
      onSessionCreated: (process, startedSession) => {
        createdProcess = process
        createdSession = startedSession
        // Track the process for pause/stop operations
        this.activeSessionProcesses.set(startedSession.id, {
          process,
          session: startedSession,
          onPause: async () => {
            // Custom pause handler - can be used for graceful shutdown
          },
        })
      },
      onSessionStart: (startedSession) => {
        const updated = this.db.updateTask(input.task.id, {
          sessionId: startedSession.id,
          sessionUrl: this.sessionUrlFor(startedSession.id),
        })
        if (updated) this.broadcast({ type: "task_updated", payload: updated })
      },
      onOutput: (chunk) => {
        if (!chunk.trim()) return
        this.db.appendAgentOutput(input.task.id, `${stripAndNormalize(chunk)}\n`)
      },
      onSessionMessage: (message) => {
        this.broadcast({
          type: "session_message_created",
          payload: message,
        })
      },
    })

    // Clean up tracking after session completes
    if (createdSession) {
      this.activeSessionProcesses.delete((createdSession as import("./db/types.ts").PiWorkflowSession).id)
    }

    return { session: session.session, responseText: session.responseText }
  }

  /**
   * Apply a manual self-heal recovery action from the UI.
   * This is called when the user explicitly selects a recovery action from a self-heal report.
   */
  async manualSelfHealRecover(
    taskId: string,
    reportId: string,
    action: "restart_task" | "keep_failed",
  ): Promise<{ ok: boolean; message: string }> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    const report = this.db.getSelfHealReport(reportId)
    if (!report) throw new Error(`Self-heal report not found: ${reportId}`)
    if (report.taskId !== taskId) throw new Error(`Report ${reportId} does not belong to task ${taskId}`)

    const runId = report.runId

    if (action === "restart_task") {
      const requeued = this.scheduler.requeueExecutingTask(taskId)
      if (!requeued) {
        this.scheduler.enqueueTask(runId, taskId)
      }

      this.db.updateTask(taskId, {
        status: "queued",
        errorMessage: null,
        selfHealStatus: "idle",
        selfHealMessage: "Manually recovered: task requeued",
        sessionId: null,
        sessionUrl: null,
      })
      this.broadcastTask(taskId)
      this.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId,
          status: "recovered",
          message: "Task manually requeued from self-heal report",
          reportId,
        },
      })
      await this.refreshRunProgress(runId)
      await this.triggerScheduling()
      return { ok: true, message: "Task requeued successfully" }
    }

    // keep_failed: clear self-heal status so the card returns to normal failed state
    this.db.updateTask(taskId, {
      selfHealStatus: "idle",
      selfHealMessage: null,
    })
    this.broadcastTask(taskId)
    this.broadcast({
      type: "self_heal_status",
      payload: {
        runId,
        taskId,
        status: "manual_required",
        message: "Manual recovery dismissed — task remains failed",
        reportId,
      },
    })
    return { ok: true, message: "Task kept as failed" }
  }

  private broadcastTask(taskId: string): void {
    const updated = this.db.getTask(taskId)
    if (!updated) return
    console.log(`[orchestrator] broadcastTask: ${updated.name}(${taskId}) status=${updated.status}`)
    this.broadcast({ type: "task_updated", payload: updated })
  }

  private async maybeSelfHealTask(runId: string, task: Task): Promise<boolean> {
    const reportCount = this.db.countSelfHealReportsForTaskInRun(runId, task.id)
    if (reportCount >= 2) {
      this.db.updateTask(task.id, {
        selfHealStatus: "idle",
        selfHealMessage: "Self-healing retry limit reached for this task in this run",
      })
      this.broadcastTask(task.id)
      this.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId: task.id,
          status: "skipped",
          message: "Self-healing retry limit reached",
        },
      })
      return false
    }

    const run = this.db.getWorkflowRun(runId)
    if (!run) {
      throw new Error(`Run not found for self-heal flow: ${runId}`)
    }

    const hasOtherActiveTasks =
      this.scheduler.getExecutingStates(runId).some((state) => state.taskId !== task.id)
      || this.scheduler.getQueuedTasks(runId).some((queuedTaskId) => queuedTaskId !== task.id)

    this.db.updateTask(task.id, {
      selfHealStatus: "investigating",
      selfHealMessage: "Investigating failure and drafting permanent fix...",
    })
    this.broadcastTask(task.id)
    this.broadcast({
      type: "self_heal_status",
      payload: {
        runId,
        taskId: task.id,
        status: "investigating",
        message: "Self-healing investigation started",
      },
    })

    try {
      const result = await this.selfHealingService.investigateFailure({
        run,
        task,
        errorMessage: task.errorMessage ?? "Task failed without explicit error message",
        hasOtherActiveTasks,
      })

      this.db.updateTask(task.id, {
        selfHealStatus: "recovering",
        selfHealMessage: result.diagnosticsSummary,
        selfHealReportId: result.reportId,
      })
      this.broadcastTask(task.id)
      this.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId: task.id,
          status: "recovering",
          message: "Self-healing generated diagnostics and recovery decision",
          reportId: result.reportId,
        },
      })

      if (result.recoverable && result.recommendedAction === "restart_task") {
        const requeued = this.scheduler.requeueExecutingTask(task.id)
        if (!requeued) {
          this.scheduler.enqueueTask(runId, task.id)
        }

        this.db.updateTask(task.id, {
          status: "queued",
          errorMessage: null,
          selfHealStatus: "idle",
          selfHealMessage: "Auto-recovered: task requeued",
          sessionId: null,
          sessionUrl: null,
        })
        this.broadcastTask(task.id)
        this.broadcast({
          type: "self_heal_status",
          payload: {
            runId,
            taskId: task.id,
            status: "recovered",
            message: "Task requeued after self-healing",
            reportId: result.reportId,
          },
        })
        return true
      }

      this.db.updateTask(task.id, {
        selfHealStatus: "idle",
        selfHealMessage: `Manual recovery required: ${result.actionRationale}`,
      })
      this.broadcastTask(task.id)
      this.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId: task.id,
          status: "manual_required",
          message: result.actionRationale,
          reportId: result.reportId,
        },
      })
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.updateTask(task.id, {
        selfHealStatus: "idle",
        selfHealMessage: `Self-healing failed: ${message}`,
      })
      this.broadcastTask(task.id)
      this.broadcast({
        type: "self_heal_status",
        payload: {
          runId,
          taskId: task.id,
          status: "error",
          message,
        },
      })
      return false
    }
  }

  /**
   * Complete a task successfully after work is done.
   * Used when a task timed out but was essentially complete.
   * Skips re-running review/commit as they already happened.
   */
  private async completeTaskSuccessfully(
    task: Task,
    worktreeInfo: WorktreeInfo,
    options: Options,
  ): Promise<void> {
    try {
      const targetBranch = await resolveTargetBranch({
        baseDirectory: this.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      })
      await this.worktree.complete(worktreeInfo.directory, {
        branch: worktreeInfo.branch,
        targetBranch,
        shouldMerge: true,
        shouldRemove: task.deleteWorktree !== false,
      })

      this.db.updateTask(task.id, {
        status: "done",
        completedAt: nowUnix(),
        worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
        executionPhase: task.planmode ? "implementation_done" : undefined,
      })
      this.broadcastTask(task.id)
      console.log(`[orchestrator] Task ${task.name}(${task.id}) completed successfully after timeout recovery`)
    } catch (completionError) {
      // If completion itself fails, mark as failed but preserve the worktree for debugging
      const message = completionError instanceof Error ? completionError.message : String(completionError)
      console.error(`[orchestrator] Task ${task.name}(${task.id}) completion failed after timeout: ${message}`)
      this.db.updateTask(task.id, {
        status: "failed",
        errorMessage: `Worktree completion failed after timeout recovery: ${message}`,
        worktreeDir: worktreeInfo.directory,
      })
      this.broadcastTask(task.id)
      throw completionError
    }
  }

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

  async resetTaskToBacklog(taskId: string): Promise<Task | null> {
    const task = this.db.getTask(taskId)
    if (!task) return null

    if (task.worktreeDir) {
      try {
        await this.worktree.complete(task.worktreeDir, {
          branch: "",
          targetBranch: "",
          shouldMerge: false,
          shouldRemove: true,
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.warn(`[orchestrator] Failed to remove worktree ${task.worktreeDir}: ${msg}`)
      }
    }

    return this.db.updateTask(taskId, {
      status: "backlog",
      reviewCount: 0,
      jsonParseRetryCount: 0,
      errorMessage: null,
      completedAt: null,
      sessionId: null,
      sessionUrl: null,
      worktreeDir: null,
      executionPhase: "not_started",
      awaitingPlanApproval: false,
      planRevisionCount: 0,
    })
  }

  /**
   * Validate that all container images for the given tasks exist.
   * Returns an object with valid flag and list of invalid tasks.
   * Skips validation when container mode is disabled.
   */
  async validateWorkflowImages(taskIds: string[]): Promise<{
    valid: boolean
    invalid: { taskId: string; taskName: string; image: string }[]
  }> {
    // Skip image validation when container mode is disabled
    const containerEnabled = this.settings?.workflow?.container?.enabled !== false
    if (!containerEnabled) {
      return { valid: true, invalid: [] }
    }

    const invalid: { taskId: string; taskName: string; image: string }[] = []

    for (const taskId of taskIds) {
      const task = this.db.getTask(taskId)
      if (!task) continue

      const imageToCheck = resolveContainerImage(task, this.settings?.workflow?.container?.image)

      if (imageToCheck) {
        const exists = await this.checkImageExists(imageToCheck)
        if (!exists) {
          invalid.push({
            taskId,
            taskName: task.name,
            image: imageToCheck,
          })
        }
      }
    }

    return { valid: invalid.length === 0, invalid }
  }

  /**
   * Check if a container image exists.
   * Uses the container manager if available, otherwise falls back to podman check.
   */
  private async checkImageExists(imageName: string): Promise<boolean> {
    if (this.containerManager) {
      return this.containerManager.checkImageExists(imageName)
    }

    // Fallback: check using podman directly
    try {
      const proc = Bun.spawn(["podman", "image", "exists", imageName], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      return exitCode === 0
    } catch {
      return false
    }
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
    if (!imageName) return false
    // Never delete the default base image
    if (imageName === BASE_IMAGES.piAgent) return false
    // Custom images have a timestamp suffix after the colon
    // Match patterns like: pi-agent:custom-1234567890 or pi-agent:profile-1234567890
    const customPattern = /^pi-agent:[a-zA-Z]+-\d+$/
    return customPattern.test(imageName)
  }

  /**
   * Log a task event to the session event system.
   * Used for logging when tasks are blocked due to missing images or other issues.
   */
  private async logTaskEvent(
    taskId: string,
    eventType: string,
    data: Record<string, unknown>
  ): Promise<void> {
    // Create a system session message for the task
    const sessionId = this.db.getTask(taskId)?.sessionId
    if (sessionId) {
      await this.db.createSessionMessage({
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
  }
}
