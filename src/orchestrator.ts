import { randomUUID } from "crypto"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import type { InfrastructureSettings } from "./config/settings.ts"
import { BASE_IMAGES } from "./config/base-images.ts"
import { buildExecutionVariables, buildPlanningVariables, buildPlanRevisionVariables, buildCommitVariables, buildReviewFixVariables } from "./prompts/index.ts"
import { getLatestTaggedOutput, getPlanExecutionEligibility } from "./task-state.ts"
import type { PiKanbanDB } from "./db.ts"
import type { PiSessionKind, PiWorkflowSession } from "./db/types.ts"
import { resolveContainerImage, type Options, type Task, type WSMessage, type WorkflowRun } from "./types.ts"
import { resolveExecutionTasks, getExecutionGraphTasks, resolveBatches } from "./execution-plan.ts"
import { PiSessionManager } from "./runtime/session-manager.ts"
import { PiReviewSessionRunner } from "./runtime/review-session.ts"
import { CodeStyleSessionRunner } from "./runtime/codestyle-session.ts"
import { BestOfNRunner } from "./runtime/best-of-n.ts"
import { WorktreeLifecycle, resolveTargetBranch, listWorktrees, type WorktreeInfo } from "./runtime/worktree.ts"
import type { PiContainerManager } from "./runtime/container-manager.ts"
import { PiRpcProcess, CollectEventsTimeoutError } from "./runtime/pi-process.ts"
import { ContainerPiProcess } from "./runtime/container-pi-process.ts"
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

export class PiOrchestrator {
  private running = false
  private shouldStop = false
  private shouldPause = false
  private isPaused = false
  private currentRunId: string | null = null
  private sessionManager: PiSessionManager
  private readonly reviewRunner: PiReviewSessionRunner
  private readonly worktree: WorktreeLifecycle
  private containerManager?: PiContainerManager

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

  /**
   * Detect and clean up stale workflow runs that are in active status but have no executing tasks.
   * This is a defensive check to prevent ghost runs from blocking new executions.
   */
  private async cleanupStaleRuns(): Promise<void> {
    const activeRuns = this.db.getWorkflowRuns().filter((r) => r.status === "running" || r.status === "stopping")

    // Defensive check: Validate this.running consistency with database state
    if (this.running) {
      const currentRunInActiveList = this.currentRunId && activeRuns.some(r => r.id === this.currentRunId)
      if (!currentRunInActiveList) {
        // this.running is true but the current run is not in active state in DB
        // This can happen if pause/stop raced with runInBackground exit
        const currentRunFromDb = this.currentRunId ? this.db.getWorkflowRun(this.currentRunId) : null
        if (!currentRunFromDb || (currentRunFromDb.status !== "running" && currentRunFromDb.status !== "stopping" && currentRunFromDb.status !== "paused")) {
          console.log(`[orchestrator] cleanupStaleRuns: Resetting stale running flag (run ${this.currentRunId} is not active in DB)`)
          this.running = false
          // Don't reset currentRunId here - it might be needed for resume or other operations
          // Just reset the running flag to unblock new executions
        }
      }
    }

    for (const run of activeRuns) {
      if (run.id === this.currentRunId && this.running) continue

      if (run.status === "stopping") {
        console.log(`[orchestrator] Force-completing stopping run ${run.id}`)
        console.log(`[orchestrator] Killing ${this.activeSessionProcesses.size} active sessions during force-complete`)
        for (const [sessionId, activeProcess] of this.activeSessionProcesses) {
          console.log(`[orchestrator] Killing session ${sessionId} during force-complete`)
          if ("forceKill" in activeProcess.process) {
            await activeProcess.process.forceKill()
          }
        }
        this.activeSessionProcesses.clear()

        for (const taskId of run.taskOrder ?? []) {
          const task = this.db.getTask(taskId)
          if (task && (task.status === "executing" || task.status === "review")) {
            this.db.updateTask(taskId, {
              status: "backlog",
              errorMessage: "Auto-recovered: workflow was stopping",
              sessionId: null,
              sessionUrl: null,
            })
            this.broadcastTask(taskId)
          }
        }

        // Mark the run as completed
        const updated = this.db.updateWorkflowRun(run.id, {
          status: "completed",
          stopRequested: true,
          finishedAt: nowUnix(),
        })
        if (updated) {
          this.broadcast({ type: "run_updated", payload: updated })
          this.broadcast({ type: "execution_stopped", payload: {} })
          console.log(`[orchestrator] Force-completed stopping run ${run.id}`)
        }

        // Reset orchestrator state if this was the current run
        if (this.currentRunId === run.id) {
          this.running = false
          this.shouldStop = false
          this.shouldPause = false
          this.isPaused = false
          this.currentRunId = null
          this.activeBestOfNRunner = null
          this.activeWorktreeInfo = null
          this.activeTask = null
          sessionPauseStateManager.clear()
        }
        continue
      }

      // Check if any tasks in the taskOrder are actually executing or in review
      const hasActiveTask = run.taskOrder?.some((taskId) => {
        const task = this.db.getTask(taskId)
        return task?.status === "executing" || task?.status === "review"
      })

      if (!hasActiveTask) {
        // This is a stale run - mark it as failed
        const updated = this.db.updateWorkflowRun(run.id, {
          status: "failed",
          errorMessage: "Auto-recovered: no executing tasks found",
          finishedAt: nowUnix(),
        })
        if (updated) {
          this.broadcast({ type: "run_updated", payload: updated })
          console.log(`[orchestrator] Cleaned up stale run ${run.id} (was ${run.status})`)
        }

        // Reset orphaned task statuses back to backlog
        for (const taskId of run.taskOrder ?? []) {
          const task = this.db.getTask(taskId)
          if (task && (task.status === "executing" || task.status === "review")) {
            this.db.updateTask(taskId, {
              status: "backlog",
              errorMessage: "Auto-recovered: workflow run was stale",
              sessionId: null,
              sessionUrl: null,
            })
            this.broadcastTask(taskId)
          }
        }

        // Reset orchestrator internal state if this was the current run
        if (this.currentRunId === run.id) {
          console.log(`[orchestrator] Resetting orchestrator state for cleaned-up run ${run.id}`)
          this.running = false
          this.shouldStop = false
          this.shouldPause = false
          this.isPaused = false
          this.currentRunId = null
          this.activeBestOfNRunner = null
          this.activeWorktreeInfo = null
          this.activeTask = null
          sessionPauseStateManager.clear()
          this.broadcast({ type: "execution_stopped", payload: {} })
        }
      }
    }

    // Safety net: if running is true but no active runs exist in the DB, reset state
    if (this.running && activeRuns.length === 0) {
      console.log(`[orchestrator] Running flag set but no active runs found - resetting state`)
      this.running = false
      this.shouldStop = false
      this.shouldPause = false
      this.isPaused = false
      this.currentRunId = null
      this.activeBestOfNRunner = null
      this.activeWorktreeInfo = null
      this.activeTask = null
      sessionPauseStateManager.clear()
    }
  }

  async startAll(): Promise<WorkflowRun> {
    // Phase 2: Clean up any stale runs before checking if already executing
    await this.cleanupStaleRuns()

    // Defensive check: If still running but current run is not actually active in DB, force reset
    if (this.running && this.currentRunId) {
      const activeRun = this.db.getWorkflowRun(this.currentRunId)
      if (!activeRun || (activeRun.status !== "running" && activeRun.status !== "stopping")) {
        console.log(`[orchestrator] startAll: Force resetting stale running flag (run ${this.currentRunId} status: ${activeRun?.status ?? "not found"})`)
        this.running = false
      }
    }

    if (this.running) throw new Error("Already executing")

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

    const tasks = getExecutionGraphTasks(allTasks)

    if (tasks.length === 0) throw new Error("No tasks in backlog")

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

    const run = this.db.createWorkflowRun({
      id: randomUUID().slice(0, 8),
      kind: "all_tasks",
      status: "running",
      displayName: "Workflow run",
      taskOrder: tasks.map((task) => task.id),
      currentTaskId: tasks[0]?.id ?? null,
      currentTaskIndex: 0,
      color: this.db.getNextRunColor(),
    })

    this.currentRunId = run.id
    this.running = true
    this.shouldStop = false
    this.broadcast({ type: "run_created", payload: run })
    this.broadcast({ type: "execution_started", payload: {} })

    void this.runInBackground(run.id, tasks.map((task) => task.id))
    return run
  }

  async startSingle(taskId: string): Promise<WorkflowRun> {
    // Phase 2: Clean up any stale runs before checking if already executing
    await this.cleanupStaleRuns()

    // Defensive check: If still running but current run is not actually active in DB, force reset
    if (this.running && this.currentRunId) {
      const activeRun = this.db.getWorkflowRun(this.currentRunId)
      if (!activeRun || (activeRun.status !== "running" && activeRun.status !== "stopping")) {
        console.log(`[orchestrator] startSingle: Force resetting stale running flag (run ${this.currentRunId} status: ${activeRun?.status ?? "not found"})`)
        this.running = false
      }
    }

    if (this.running) throw new Error("Already executing")

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

    const chain = resolveExecutionTasks(allTasks, taskId)
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

    const run = this.db.createWorkflowRun({
      id: randomUUID().slice(0, 8),
      kind: "single_task",
      status: "running",
      displayName: `Single task: ${target.name}`,
      targetTaskId: target.id,
      taskOrder: chain.map((task) => task.id),
      currentTaskId: chain[0]?.id ?? null,
      currentTaskIndex: 0,
      color: this.db.getNextRunColor(),
    })

    this.currentRunId = run.id
    this.running = true
    this.shouldStop = false
    this.broadcast({ type: "run_created", payload: run })
    this.broadcast({ type: "execution_started", payload: {} })

    void this.runInBackground(run.id, chain.map((task) => task.id))
    return run
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
    // Phase 1: Clean up any stale runs before checking if already executing
    await this.cleanupStaleRuns()

    // Defensive check: If still running but current run is not actually active in DB, force reset
    if (this.running && this.currentRunId) {
      const activeRun = this.db.getWorkflowRun(this.currentRunId)
      if (!activeRun || (activeRun.status !== "running" && activeRun.status !== "stopping")) {
        console.log(`[orchestrator] startGroup: Force resetting stale running flag (run ${this.currentRunId} status: ${activeRun?.status ?? "not found"})`)
        this.running = false
      }
    }

    if (this.running) throw new Error("Already executing")

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

    // Create workflow run with kind=group_tasks
    const run = this.db.createWorkflowRun({
      id: randomUUID().slice(0, 8),
      kind: "group_tasks",
      status: "running",
      displayName: `Group: ${group.name}`,
      groupId: group.id,
      taskOrder: group.taskIds,
      currentTaskId: group.taskIds[0] ?? null,
      currentTaskIndex: 0,
      color: this.db.getNextRunColor(),
    })

    // Set orchestrator state
    this.currentRunId = run.id
    this.running = true
    this.shouldStop = false

    // Broadcast events
    this.broadcast({ type: "run_created", payload: run })
    this.broadcast({ type: "execution_started", payload: {} })

    // Execute in background
    void this.runInBackground(run.id, group.taskIds)
    return run
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

    if (run.status !== "running" && run.status !== "paused" && run.status !== "stopping") {
      console.error(`[orchestrator] Cannot stop: run ${runId} is not running, paused, or stopping (status: ${run.status})`)
      return
    }

    console.log(`[orchestrator] Graceful stop requested for run ${runId}`)
    this.shouldStop = true

    // Kill ALL active tracked sessions immediately with SIGKILL
    // This kills both sessions with task.sessionId set AND those that are tracked
    // but haven't had their sessionId saved to the task yet (race condition)
    console.log(`[orchestrator] Killing ${this.activeSessionProcesses.size} active sessions for stop`)
    for (const [sessionId, activeProcess] of this.activeSessionProcesses) {
      console.log(`[orchestrator] Killing session ${sessionId} with SIGKILL`)
      if ("forceKill" in activeProcess.process) {
        await activeProcess.process.forceKill("SIGKILL")
      }
    }
    // Clear all tracked sessions
    this.activeSessionProcesses.clear()

    // Reset any executing/review tasks back to backlog immediately
    for (const taskId of run.taskOrder ?? []) {
      const task = this.db.getTask(taskId)
      if (task && (task.status === "executing" || task.status === "review")) {
        this.db.updateTask(taskId, {
          status: "backlog",
          errorMessage: "Workflow stopped by user",
          sessionId: null,
          sessionUrl: null,
        })
        this.broadcastTask(taskId)
      }
    }

    // Mark the run as completed immediately - do not wait
    const updated = this.db.updateWorkflowRun(runId, {
      status: "completed",
      stopRequested: true,
      finishedAt: nowUnix(),
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
      this.broadcast({ type: "execution_stopped", payload: { runId } })
      console.log(`[orchestrator] Run ${runId} stopped immediately`)
    }

    // Reset orchestrator state if this was the current run
    if (this.currentRunId === runId) {
      this.running = false
      this.shouldStop = false
      this.shouldPause = false
      this.isPaused = false
      this.currentRunId = null
      this.activeBestOfNRunner = null
      this.activeWorktreeInfo = null
      this.activeTask = null
      sessionPauseStateManager.clear()
    }
  }

  /**
   * Request destructive stop of current workflow run.
   * This is the main STOP action - it kills everything and loses data.
   */
  async stop(): Promise<void> {
    if (!this.currentRunId) return
    // STOP is destructive by design - kills containers, loses data
    await this.destructiveStop(this.currentRunId)
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
              this.db.updateTask(taskId, { containerImage: null })
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
      if (task && (task.status === "executing" || task.status === "review")) {
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
      finishedAt: nowUnix(),
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
    }

    // 8. Reset orchestrator state if this was the current run
    if (this.currentRunId === runId) {
      this.running = false
      this.shouldStop = false
      this.shouldPause = false
      this.isPaused = false
      this.currentRunId = null
      this.activeBestOfNRunner = null
      this.activeWorktreeInfo = null
      this.activeTask = null
      sessionPauseStateManager.clear()
    }

    // Clear any persisted pause state
    clearGlobalPausedRunState()
    clearAllPausedSessionStates(this.db)

    this.broadcast({ type: "execution_stopped", payload: { runId, destructive: true } })

    return result
  }

  /**
   * Force stop - immediately kill all processes and clean up (backward compatibility).
   * Uses destructiveStop on the current run.
   */
  async forceStop(): Promise<{ killed: number; cleaned: number }> {
    if (!this.currentRunId) {
      return { killed: 0, cleaned: 0 }
    }
    return this.destructiveStop(this.currentRunId)
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

    if (run.status !== "running" && run.status !== "stopping") {
      console.error(`[orchestrator] Cannot pause: run ${runId} is not running (status: ${run.status})`)
      return false
    }

    console.log(`[orchestrator] Pausing run ${runId}`)
    this.shouldPause = true

    // TODO: With parallel execution, multiple tasks may be active simultaneously
    // Currently we iterate and pause one by one, which works but may leave some
    // tasks running briefly while others are paused. For true atomic pause,
    // we'd need to signal all active sessions in parallel and wait for all to ack.
    // Pause all active sessions for tasks in this run
    const pausedSessions: PausedSessionState[] = []

    // Iterate through all tasks in the run's taskOrder
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (!task) continue

      // Only pause tasks that are currently executing and have a session
      if (task.status === "executing" && task.sessionId) {
        const activeProcess = this.activeSessionProcesses.get(task.sessionId)
        if (activeProcess) {
          const pausedState = await this.pauseSession(task.sessionId, activeProcess)
          if (pausedState) {
            pausedSessions.push(pausedState)
            // Save individual session state
            savePausedSessionState(this.db, pausedState)
          }
        } else {
          // Session exists in DB but not in active processes - mark as paused
          this.db.updateWorkflowSession(task.sessionId, { status: "paused" })
          this.broadcast({
            type: "session_status_changed",
            payload: { sessionId: task.sessionId, status: "paused", taskId },
          })
        }
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
      // TODO: With parallel execution, this only captures the phase of one active task
      // For complete parallel pause support, we'd need to track all active task phases
      executionPhase: this.activeTask?.status === "review" ? "reviewing" : "executing",
    }

    savePausedRunState(pauseState, this.db)

    const updated = this.db.updateWorkflowRun(runId, {
      status: "paused",
      pauseRequested: true,
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
    }

    // TODO: With parallel execution, multiple tasks may be active
    // Currently only resets the tracked activeTask, but other active tasks in the
    // batch won't be reset. The batch will complete first (due to shouldPause check)
    // then on resume they'll restart from backlog since they weren't done.
    if (this.activeTask && run.taskOrder.includes(this.activeTask.id)) {
      this.db.updateTask(this.activeTask.id, {
        status: "backlog", // Move back to backlog so it will be picked up on resume
        errorMessage: null,
      })
      this.broadcastTask(this.activeTask.id)
    }

    // If this is the current run, update orchestrator state
    if (this.currentRunId === runId) {
      this.isPaused = true
      this.running = false
    }

    this.broadcast({ type: "execution_paused", payload: { runId } })

    // SAFETY NET: Set a timeout to ensure the run doesn't get stuck in a transitional state
    // This handles edge cases where runInBackground hasn't exited yet
    const SAFETY_TIMEOUT_MS = 5000 // 5 seconds should be plenty for cleanup
    setTimeout(() => {
      const currentRun = this.db.getWorkflowRun(runId)
      if (currentRun?.status === "running" && this.shouldPause) {
        console.log(`[orchestrator] Safety timeout: force-pausing run ${runId} that was still running`)

        // Update run status to paused
        const pausedRun = this.db.updateWorkflowRun(runId, {
          status: "paused",
          pauseRequested: true,
        })
        if (pausedRun) {
          this.broadcast({ type: "run_updated", payload: pausedRun })
        }

        // Update orchestrator state
        if (this.currentRunId === runId) {
          this.isPaused = true
          this.running = false
        }
      }
    }, SAFETY_TIMEOUT_MS)

    return true
  }

  /**
   * Pause the current workflow run (backward compatibility).
   * Delegates to pauseRun with the current run ID.
   */
  async pause(): Promise<boolean> {
    if (!this.currentRunId) {
      return false
    }
    return this.pauseRun(this.currentRunId)
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

    // Load pause state from database
    const pauseState = loadPausedRunState(runId, this.db)
    if (pauseState && pauseState.runId === runId) {
      // Iterate through all tasks in the run to resume their sessions
      // This ensures we don't miss any sessions that might not be in pauseState.sessions
      for (const taskId of run.taskOrder) {
        const task = this.db.getTask(taskId)
        // Resume sessions for tasks that were executing and have a session
        if (task?.status === "executing" && task.sessionId) {
          try {
            await this.resumeSession(task.sessionId)
            // Clear individual session pause state
            clearPausedSessionState(this.db, task.sessionId)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[orchestrator] Failed to resume session ${task.sessionId}: ${message}`)
          }
        }
      }

      // Check and recreate containers if needed for all tasks in the run
      if (this.containerManager) {
        for (const taskId of run.taskOrder) {
          const task = this.db.getTask(taskId)
          if (task?.sessionId) {
            const individualState = loadPausedSessionState(this.db, task.sessionId)
            if (individualState?.containerId) {
              const containerInfo = await this.containerManager.checkContainerById(individualState.containerId)
              if (!containerInfo?.running) {
                console.log(`[orchestrator] Container ${individualState.containerId} for session ${task.sessionId} not running, recreating...`)
                // Remove the old container reference and let resumeTaskExecution create a new one
                await this.containerManager.removeContainer(task.sessionId, true)
              }
            }
          }
        }
      }

      // Clear global pause state from database after successful resume
      clearGlobalPausedRunState(runId, this.db)
    }

    // Clear orchestrator pause state
    this.shouldPause = false
    if (this.currentRunId === runId) {
      this.isPaused = false
    }

    // Update run status
    const updated = this.db.updateWorkflowRun(runId, {
      status: "running",
      pauseRequested: false,
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
    }

    this.currentRunId = runId
    this.running = true
    this.shouldStop = false

    const remainingTasks = run.taskOrder.slice(run.currentTaskIndex)
    if (remainingTasks.length > 0) {
      void this.runInBackground(runId, remainingTasks)
    }

    this.broadcast({ type: "execution_resumed", payload: { runId } })

    return updated
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
      status: "running",
      pauseRequested: false,
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
    }

    clearGlobalPausedRunState()

    this.currentRunId = pauseState.runId
    this.running = true
    this.shouldStop = false
    this.shouldPause = false
    this.isPaused = false

    const remainingTasks = pauseState.taskOrder.slice(pauseState.currentTaskIndex)
    if (remainingTasks.length > 0) {
      void this.runInBackground(pauseState.runId, remainingTasks)
    }

    this.broadcast({ type: "execution_resumed", payload: { runId: pauseState.runId } })

    return updated
  }

  /**
   * Check if there's a paused run that can be resumed.
   */
  hasPausedRun(): boolean {
    if (this.isPaused && this.currentRunId) {
      return true
    }
    // Check database first
    const pausedRuns = listPausedRunStates(this.db)
    if (pausedRuns.length > 0) {
      return true
    }
    // Fallback to file-based check
    return hasPausedRunState()
  }

  /**
   * Get the paused run state if available.
   */
  getPausedRunState(): PausedRunState | null {
    if (this.isPaused && this.currentRunId) {
      // Try to load from database first
      const dbState = loadPausedRunState(this.currentRunId, this.db)
      if (dbState) {
        return dbState
      }
      // Fallback: construct from run info
      const run = this.db.getWorkflowRun(this.currentRunId)
      if (run) {
        return {
          runId: run.id,
          kind: run.kind,
          taskOrder: run.taskOrder,
          currentTaskIndex: run.currentTaskIndex,
          currentTaskId: run.currentTaskId,
          targetTaskId: run.targetTaskId,
          pausedAt: nowUnix(),
          sessions: [],
          executionPhase: "executing",
        }
      }
    }
    // Check database for any paused runs
    const pausedRuns = listPausedRunStates(this.db)
    if (pausedRuns.length > 0) {
      return pausedRuns[0] ?? null
    }
    // Fallback to file-based storage
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
    const continuePrompt = `Continue from where you left off. You were in the middle of implementing a task. Review what you've done so far and continue with the remaining work.

Previous context: ${agentOutputSnapshot.slice(-2000) || "Task execution paused"}`

    const execution = await this.sessionManager.executePrompt({
      taskId: task.id,
      sessionKind: pausedState.sessionKind,
      cwd: pausedState.cwd ?? pausedState.worktreeDir ?? "",
      worktreeDir: pausedState.worktreeDir,
      branch: pausedState.branch,
      model: pausedState.model,
      thinkingLevel: pausedState.thinkingLevel,
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
          batch.map(task => this.executeTask(task, options))
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
          finishedAt: nowUnix(),
        })
        if (finalRun) this.broadcast({ type: "run_updated", payload: finalRun })
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

  private async executeTask(task: Task, options: Options): Promise<void> {
    const eligibility = getPlanExecutionEligibility(task)
    if (!eligibility.ok) throw new Error(`Task state is invalid: ${eligibility.reason}`)

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

      if (task.planmode) {
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
      if (this.shouldStop) {
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
          await this.completeTaskSuccessfully(task, worktreeInfo, options)
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
      this.activeSessionProcesses.delete(createdSession.id)
    }

    return { session: session.session, responseText: session.responseText }
  }

  private broadcastTask(taskId: string): void {
    const updated = this.db.getTask(taskId)
    if (!updated) return
    console.log(`[orchestrator] broadcastTask: ${updated.name}(${taskId}) status=${updated.status}`)
    this.broadcast({ type: "task_updated", payload: updated })
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
