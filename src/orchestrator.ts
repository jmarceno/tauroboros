import { randomUUID } from "crypto"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import type { InfrastructureSettings } from "./config/settings.ts"
import { buildExecutionVariables, buildPlanningVariables, buildPlanRevisionVariables, buildCommitVariables, buildReviewFixVariables } from "./prompts/index.ts"
import { getLatestTaggedOutput, getPlanExecutionEligibility } from "./task-state.ts"
import type { PiKanbanDB } from "./db.ts"
import type { PiSessionKind, PiWorkflowSession } from "./db/types.ts"
import type { Options, Task, WSMessage, WorkflowRun } from "./types.ts"
import { resolveExecutionTasks, getExecutionGraphTasks } from "./execution-plan.ts"
import { PiSessionManager } from "./runtime/session-manager.ts"
import { PiReviewSessionRunner } from "./runtime/review-session.ts"
import { BestOfNRunner } from "./runtime/best-of-n.ts"
import { WorktreeLifecycle, resolveTargetBranch, listWorktrees, type WorktreeInfo } from "./runtime/worktree.ts"
import type { PiContainerManager } from "./runtime/container-manager.ts"
import { PiRpcProcess } from "./runtime/pi-process.ts"
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
    // Update review runner to use the new session manager
    this.reviewRunner = new PiReviewSessionRunner(this.db, this.settings, manager, this.sessionManager)
  }

  /**
   * Detect and clean up stale workflow runs that are in active status but have no executing tasks.
   * This is a defensive check to prevent ghost runs from blocking new executions.
   */
  private async cleanupStaleRuns(): Promise<void> {
    const activeRuns = this.db.getWorkflowRuns().filter((r) => r.status === "running" || r.status === "stopping" || r.status === "paused")

    for (const run of activeRuns) {
      // Runs in "stopping" status should be force-completed - the user requested a stop
      if (run.status === "stopping") {
        console.log(`[orchestrator] Force-completing stopping run ${run.id}`)
        
        // Kill ALL active tracked sessions to unblock runInBackground immediately
        // Don't rely on task.sessionId which may not be set yet (race condition)
        console.log(`[orchestrator] Killing ${this.activeSessionProcesses.size} active sessions during force-complete`)
        for (const [sessionId, activeProcess] of this.activeSessionProcesses) {
          console.log(`[orchestrator] Killing session ${sessionId} during force-complete`)
          if ("forceKill" in activeProcess.process) {
            await activeProcess.process.forceKill()
          }
        }
        // Clear all tracked sessions
        this.activeSessionProcesses.clear()

        // Reset any executing/review tasks in this run back to backlog
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

      // Check if any tasks in the taskOrder are actually executing
      const hasExecutingTask = run.taskOrder?.some((taskId) => {
        const task = this.db.getTask(taskId)
        return task?.status === "executing"
      })

      if (!hasExecutingTask) {
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

    if (this.running) throw new Error("Already executing")

    // Use getExecutionGraphTasks to get ALL tasks that will run,
    // including those whose dependencies will be satisfied during this run
    const tasks = getExecutionGraphTasks(this.db.getTasks())

    if (tasks.length === 0) throw new Error("No tasks in backlog")

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

    if (this.running) throw new Error("Already executing")
    const chain = resolveExecutionTasks(this.db.getTasks(), taskId)
    if (chain.length === 0) throw new Error("No tasks in backlog")
    const target = this.db.getTask(taskId)
    if (!target) throw new Error("Task not found")

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
          } catch {
            // Ignore errors during container kill
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
        } catch {
          // Ignore cleanup errors during force stop
        }
      }
    }

    // 4. Clear any paused states for all sessions in this run
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.sessionId) {
        clearPausedSessionState(this.db, task.sessionId)
      }
    }

    // 5. Mark all incomplete tasks as failed
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

    // 6. Update run status
    const updated = this.db.updateWorkflowRun(runId, {
      status: "failed",
      stopRequested: true,
      errorMessage: "Workflow stopped by user - all work discarded",
      finishedAt: nowUnix(),
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
    }

    // 7. Reset orchestrator state if this was the current run
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

    // Build pause state
    const pauseState: PausedRunState = {
      runId: run.id,
      kind: run.kind,
      taskOrder: run.taskOrder,
      currentTaskIndex: run.currentTaskIndex,
      currentTaskId: run.currentTaskId,
      targetTaskId: run.targetTaskId,
      pausedAt: nowUnix(),
      sessions: pausedSessions,
      executionPhase: this.activeTask?.status === "review" ? "reviewing" : "executing",
    }

    // Save to database (replaces file-based storage)
    savePausedRunState(pauseState, this.db)

    // Update run status
    const updated = this.db.updateWorkflowRun(runId, {
      status: "paused",
      pauseRequested: true,
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
    }

    // Update current task status if it belongs to this run
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

    // Resume execution from where we left off
    this.currentRunId = runId
    this.running = true
    this.shouldStop = false

    // Get remaining tasks
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
    // If no runId provided, check for persisted pause state in database
    const targetRunId = runId || this.currentRunId

    if (!targetRunId) {
      // Check if there's a persisted pause state in database
      const pausedRuns = listPausedRunStates(this.db)
      if (pausedRuns.length > 0) {
        // Resume the most recently paused run
        const mostRecent = pausedRuns[0]
        if (mostRecent) {
          return this.resumeFromPauseState(mostRecent)
        }
      }
      // Fallback: check for legacy file-based pause state
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
    // Update run status
    const updated = this.db.updateWorkflowRun(pauseState.runId, {
      status: "running",
      pauseRequested: false,
    })
    if (updated) {
      this.broadcast({ type: "run_updated", payload: updated })
    }

    // Clear pause state
    clearGlobalPausedRunState()

    // Set state
    this.currentRunId = pauseState.runId
    this.running = true
    this.shouldStop = false
    this.shouldPause = false
    this.isPaused = false

    // Resume execution from where we left off
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

    // Get task for additional context
    const task = session.taskId ? this.db.getTask(session.taskId) : null

    // Build paused state with full context
    // Get container image from settings if using containers
    const containerImage = this.settings?.workflow?.container?.image || null
    // Get execution phase from task for richer context
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
      lastPrompt: null, // We don't capture the exact prompt, will send "continue"
      lastPromptTimestamp: nowUnix(),
      containerId,
      containerName: `pi-easy-workflow-${sessionId}`,
      containerImage, // Populate from settings for container recreation on resume
      piSessionId: session.piSessionId,
      piSessionFile: session.piSessionFile,
      executionPhase, // Track where we are in task execution
      pauseReason: "user_pause", // Default pause reason
      context: task ? {
        agentOutputSnapshot: task.agentOutput || null,
        pendingToolCalls: null, // Not currently tracked
        reviewCount: task.reviewCount || 0,
      } : null,
    }

    // Stop the process but DON'T mark session as completed
    try {
      if ("forceKill" in activeProcess.process) {
        await activeProcess.process.forceKill("SIGTERM") // Use SIGTERM for pause (gentler than SIGKILL)
      }
    } catch {
      // Ignore errors during pause
    }

    // Update session status to paused (not completed)
    this.db.updateWorkflowSession(sessionId, {
      status: "paused",
      // Don't set finishedAt - we're not done
    })

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
        // Container will be recreated when executePrompt is called
      }
    }

    // Get the task to resume execution
    if (pausedSession.taskId) {
      const task = this.db.getTask(pausedSession.taskId)
      if (task) {
        await this.resumeTaskExecution(task, pausedSession)
      }
    }
  }

  /**
   * Resume task execution from pause point.
   * Re-executes the prompt with a "continue" message.
   */
  private async resumeTaskExecution(task: Task, pausedState: PausedSessionState): Promise<void> {
    // Create a "continue" prompt that preserves context
    // Prefer the snapshot from paused state context, fall back to current task output
    const agentOutputSnapshot = pausedState.context?.agentOutputSnapshot ?? task.agentOutput ?? ""
    const continuePrompt = `Continue from where you left off. You were in the middle of implementing a task. Review what you've done so far and continue with the remaining work.

Previous context: ${agentOutputSnapshot.slice(-2000) || "Task execution paused"}`

    // Re-execute the prompt with container image from paused state
    const execution = await this.sessionManager.executePrompt({
      taskId: task.id,
      sessionKind: pausedState.sessionKind,
      cwd: pausedState.cwd ?? pausedState.worktreeDir ?? "",
      worktreeDir: pausedState.worktreeDir,
      branch: pausedState.branch,
      model: pausedState.model,
      thinkingLevel: pausedState.thinkingLevel as import("./types.ts").ThinkingLevel,
      promptText: continuePrompt,
      // Indicate this is a resume, not a fresh start
      isResume: true,
      resumedSessionId: pausedState.sessionId,
      continuationPrompt: continuePrompt,
      // Pass container image for container recreation on resume
      containerImage: pausedState.containerImage,
      onSessionCreated: (process, startedSession) => {
        // Track the process for pause/stop operations
        this.activeSessionProcesses.set(startedSession.id, {
          process,
          session: startedSession,
          onPause: async () => {
            // Custom pause handler for resumed sessions
          },
        })
      },
      onSessionStart: (startedSession) => {
        this.db.updateTask(task.id, {
          sessionId: startedSession.id,
          sessionUrl: this.sessionUrlFor(startedSession.id),
        })
      },
    })

    // Clean up tracking after session completes
    this.activeSessionProcesses.delete(execution.session.id)
  }

  /**
   * Kill a session immediately without graceful shutdown.
   * Used for destructive stop operations.
   */
  private async killSessionImmediately(sessionId: string): Promise<void> {
    const activeProcess = this.activeSessionProcesses.get(sessionId)
    if (activeProcess) {
      // Force kill without graceful close
      if ("forceKill" in activeProcess.process) {
        await activeProcess.process.forceKill()
      }
      this.activeSessionProcesses.delete(sessionId)
    }

    // Mark session as aborted
    this.db.updateWorkflowSession(sessionId, {
      status: "aborted",
      finishedAt: nowUnix(),
      errorMessage: "Session killed by workflow stop",
    })
  }

  private async runInBackground(runId: string, taskIds: string[]): Promise<void> {
    const executedTaskIds = new Set<string>()

    try {
      for (let index = 0; index < taskIds.length; index++) {
        if (this.shouldStop) break
        if (this.shouldPause) {
          // Pause requested - exit loop and let pause() handle state
          return
        }

        const taskId = taskIds[index]
        const task = this.db.getTask(taskId)
        if (!task) continue

        for (const depId of task.requirements) {
          const dep = this.db.getTask(depId)
          if (dep && dep.status !== "done" && !executedTaskIds.has(depId)) {
            const msg = `Dependency "${dep.name}" is not done (status: ${dep.status})`
            this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
            this.broadcastTask(task.id)
            throw new Error(msg)
          }
        }

        const updatedRun = this.db.updateWorkflowRun(runId, {
          currentTaskId: task.id,
          currentTaskIndex: index,
        })
        if (updatedRun) this.broadcast({ type: "run_updated", payload: updatedRun })

        await this.executeTask(task, this.db.getOptions())
        executedTaskIds.add(taskId)
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
      if (!this.shouldPause) {
        // Only reset orchestrator state if this run is still the current run.
        // If cleanupStaleRuns() or destructiveStop() has already started a new run,
        // we must not corrupt that new run's state.
        if (this.currentRunId === runId) {
          this.running = false
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

    for (const depId of task.requirements) {
      const dep = this.db.getTask(depId)
      if (dep && dep.status !== "done") {
        throw new Error(`Dependency "${dep.name}" is not done (status: ${dep.status})`)
      }
    }

    // Track active task for pause/stop operations
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
          // Track BestOfN sessions for pause/stop operations
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
        } catch {
          // If verification fails, fall through to create new worktree
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
      this.activeTask = null
    }
  }

  private buildReviewFile(task: Task, worktreeDir: string): string {
    const reviewDir = join(worktreeDir, ".pi", "easy-workflow")
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
    const maxRuns = originalTask.maxReviewRunsOverride ?? options.maxReviews
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
          onSessionCreated: (process, startedSession) => {
            // Track review sessions for pause/stop operations
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
        })
        this.broadcastTask(taskId)

        // Increment reviewCount after every review attempt (pass or fail)
        reviewCount += 1
        this.db.updateTask(taskId, { reviewCount, reviewActivity: "idle" })
        this.broadcastTask(taskId)

        if (reviewRun.reviewResult.status === "pass") {
          this.db.updateTask(taskId, { status: "executing", reviewActivity: "idle" })
          this.broadcastTask(taskId)
          return true
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

        const fixSession = await this.sessionManager.executePrompt({
          taskId,
          sessionKind: "task",
          cwd: worktreeInfo.directory,
          worktreeDir: worktreeInfo.directory,
          branch: worktreeInfo.branch,
          model: currentTask.executionModel !== "default" ? currentTask.executionModel : options.executionModel,
          thinkingLevel: currentTask.executionThinkingLevel,
          promptText: fixPrompt,
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
          this.broadcast({
            type: "agent_output",
            payload: {
              taskId,
              output: tagOutput(`review-fix-${reviewCount}`, fixSession.responseText),
            },
          })
        }
        this.broadcastTask(taskId)
      }

      return true
    } finally {
      this.db.updateTask(taskId, { reviewActivity: "idle" })
      this.broadcastTask(taskId)
      try {
        unlinkSync(reviewFilePath)
      } catch {
        // best-effort cleanup
      }
    }
  }

  private async runStandardPrompt(taskId: string, task: Task, options: Options, worktreeInfo: WorktreeInfo): Promise<void> {
    const isContainerMode = this.settings?.workflow?.runtime?.mode === "container"
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

    const isContainerMode = this.settings?.workflow?.runtime?.mode === "container"
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

    const session = await this.sessionManager.executePrompt({
      taskId: input.task.id,
      sessionKind: input.sessionKind,
      cwd: input.cwd,
      worktreeDir: input.worktreeDir,
      branch: input.branch,
      model: input.model,
      thinkingLevel: (input.thinkingLevel ?? input.task.thinkingLevel) as import("./types.ts").ThinkingLevel,
      promptText: input.promptText,
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
        this.broadcast({
          type: "agent_output",
          payload: {
            taskId: input.task.id,
            output: `${stripAndNormalize(chunk)}\n`,
          },
        })
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
    this.broadcast({ type: "task_updated", payload: updated })
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
      } catch {
        // best effort
      }
    }

    return this.db.updateTask(taskId, {
      status: "backlog",
      reviewCount: 0,
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
}
