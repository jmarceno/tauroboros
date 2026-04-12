# Comprehensive Plan: Workflow Stop and Pause Implementation

## Executive Summary

Based on thorough audit of the codebase, here's the current state and required changes:

**Current State:**
- **Stop** exists but is incomplete - it kills processes but doesn't delete containers/worktrees
- **Pause** exists only as a database flag - it doesn't actually pause agent sessions  
- **Resume** exists only as a database flag update - no session reconnection or "continue" signal
- **CRITICAL GAP**: `attachToContainer()` is only a placeholder - resuming loses all container state
  - Currently recreates containers on resume, losing all unsaved work
  - Must implement proper container reattachment to preserve:
    - Modified files in the working directory
    - Installed packages and dependencies
    - Environment state and variables
    - Any running background processes
- No UI for pause/resume, only stop/start toggle
- No confirmation dialog for destructive stop

**Target State:**
- **Stop (Destructive)**: Kills everything immediately, deletes containers and worktrees, requires user confirmation
- **Pause (Non-Destructive)**: Stops agent sessions while preserving all state, can resume even after server restart
- **Resume**: Restarts containers if needed, reconnects to same sessions, sends "continue" to agents

---

## Phase 1: Core Backend Implementation

### 1.1 Session State Persistence for Pause/Resume

**New File: `src/runtime/session-pause-state.ts`**

This module manages the paused session state, allowing sessions to be resumed after server restart:

```typescript
// Tracks paused sessions with their context for resumption
export interface PausedSessionState {
  sessionId: string
  taskId: string | null
  taskRunId: string | null
  sessionKind: PiSessionKind
  worktreeDir: string | null
  branch: string | null
  model: string
  thinkingLevel: string
  piSessionId: string | null  // The Pi CLI's internal session ID
  piSessionFile: string | null // Path to session file
  containerId: string | null  // Container ID if running in container
  containerImage: string | null
  pausedAt: number
  lastPrompt: string | null    // Last prompt sent (for context)
  executionPhase: string | null // Where we are in the task
  // Additional context for resumption
  context: {
    agentOutputSnapshot: string | null  // Last known agent output
    pendingToolCalls: unknown[] | null   // Any pending tool calls
    reviewCount: number                // Current review iteration
  }
}

// Save paused state to database
// Save paused state to database
export function savePausedSessionState(db: PiKanbanDB, state: PausedSessionState): void

// Load paused state from database
export function loadPausedSessionState(db: PiKanbanDB, sessionId: string): PausedSessionState | null

// Clear paused state from database (after successful resume or stop)
export function clearPausedSessionState(db: PiKanbanDB, sessionId: string): void

// List all paused sessions from database
export function listPausedSessions(db: PiKanbanDB): PausedSessionState[]
```

**Database Changes (`src/db.ts`):**

Add a new table `paused_session_states` with the following columns:
- `session_id` TEXT PRIMARY KEY - References workflow_sessions.id
- `task_id` TEXT - Associated task ID
- `task_run_id` TEXT - Associated workflow run ID
- `session_kind` TEXT NOT NULL - "plan", "review", or "execute"
- `worktree_dir` TEXT - Path to the git worktree
- `branch` TEXT - Git branch name
- `model` TEXT NOT NULL - AI model used
- `thinking_level` TEXT NOT NULL - Thinking level setting
- `pi_session_id` TEXT - Pi CLI's internal session ID
- `pi_session_file` TEXT - Path to Pi session file
- `container_id` TEXT - Container ID if running in container
- `container_image` TEXT - Container image name
- `paused_at` INTEGER NOT NULL - Unix timestamp when paused
- `last_prompt` TEXT - Last prompt sent to agent
- `execution_phase` TEXT - Current execution phase
- `context_json` TEXT NOT NULL - JSON blob containing: agentOutputSnapshot, pendingToolCalls, reviewCount
- `pause_reason` TEXT - "user_pause", "server_shutdown", etc.

Add index on `task_id` for faster lookups.

### 1.2 Enhanced Orchestrator with True Pause/Resume

**Modify `src/orchestrator.ts`:**

```typescript
export class PiOrchestrator {
  // ... existing properties
  
  // Track active session processes for pause/resume
  private activeSessionProcesses = new Map<string, {
    process: PiRpcProcess | ContainerPiProcess
    session: PiWorkflowSession
    onPause: () => Promise<void>
  }>()

  // NEW: Pause a specific run
  async pauseRun(runId: string): Promise<void> {
    // 1. Update run status
    const updated = this.db.updateWorkflowRun(runId, {
      status: "paused",
      pauseRequested: true,
    })
    if (updated) this.broadcast({ type: "run_updated", payload: updated })

    // 2. Find all active sessions for this run's tasks
    const run = this.db.getWorkflowRun(runId)
    if (!run) throw new Error("Run not found")

    // 3. For each executing task in the run, pause its session
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.status === "executing" && task.sessionId) {
        await this.pauseSession(task.sessionId, taskId)
      }
    }

    // 4. Broadcast pause event
    this.broadcast({ type: "execution_paused", payload: { runId } })
  }

  // NEW: Resume a paused run
  async resumeRun(runId: string): Promise<void> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) throw new Error("Run not found")
    if (run.status !== "paused") throw new Error("Run is not paused")

    // 1. Update run status
    const updated = this.db.updateWorkflowRun(runId, {
      status: "running",
      pauseRequested: false,
    })
    if (updated) this.broadcast({ type: "run_updated", payload: updated })

    // 2. Resume each paused session
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.status === "executing" && task.sessionId) {
        await this.resumeSession(task.sessionId)
      }
    }

    // 3. If we were in the middle of runInBackground, continue execution
    this.shouldStop = false  // Clear stop flag
    // The runInBackground loop will naturally continue since shouldStop is false
    
    this.broadcast({ type: "execution_resumed", payload: { runId } })
  }

  // NEW: Pause individual session
  private async pauseSession(sessionId: string, taskId: string): Promise<void> {
    const session = this.db.getWorkflowSession(sessionId)
    if (!session) return

    // Get the active process
    const activeProcess = this.activeSessionProcesses.get(sessionId)
    if (!activeProcess) {
      // Session might be in a different phase (e.g., waiting for approval)
      // Just update status
      this.db.updateWorkflowSession(sessionId, { status: "paused" })
      return
    }

    // Save state for resume
    const pausedState: PausedSessionState = {
      sessionId,
      taskId,
      taskRunId: session.taskRunId,
      sessionKind: session.sessionKind,
      worktreeDir: session.worktreeDir,
      branch: session.branch,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      piSessionId: session.piSessionId,
      piSessionFile: session.piSessionFile,
      containerId: activeProcess.process instanceof ContainerPiProcess 
        ? await activeProcess.process.getContainerId() 
        : null,
      containerImage: this.settings?.workflow?.container?.image || null,
      pausedAt: nowUnix(),
      lastPrompt: null, // Would need to track this in session-manager
      executionPhase: this.db.getTask(taskId)?.executionPhase || null,
      context: {
        agentOutputSnapshot: this.db.getTask(taskId)?.agentOutput || null,
        pendingToolCalls: null, // Would need to track from Pi events
        reviewCount: this.db.getTask(taskId)?.reviewCount || 0,
      }
    }
    savePausedSessionState(this.db, pausedState)

    // Stop the process but DON'T mark session as completed
    await activeProcess.process.close()
    this.activeSessionProcesses.delete(sessionId)

    // Update session status to paused (not completed)
    this.db.updateWorkflowSession(sessionId, { 
      status: "paused",
      // Don't set finishedAt - we're not done
    })

    this.broadcast({ type: "session_status_changed", payload: { 
      sessionId, 
      status: "paused",
      taskId,
    }})
  }

  // NEW: Resume individual session
  private async resumeSession(sessionId: string): Promise<void> {
    const pausedState = loadPausedSessionState(this.db, sessionId)
    if (!pausedState) {
      throw new Error(`No paused state found for session ${sessionId}`)
    }

    const session = this.db.getWorkflowSession(sessionId)
    if (!session) throw new Error("Session not found")

    // Check if container needs to be recreated
    let containerManager = this.containerManager
    if (pausedState.containerId && this.containerManager) {
      // Check if container still exists
      const containerExists = await this.containerManager.checkContainerExists(pausedState.containerId)
      if (!containerExists) {
        // Container was removed (e.g., server restart), need to recreate
        console.log(`[orchestrator] Recreating container for session ${sessionId}`)
        // The session-manager will create a new container when executePrompt is called
      }
    }

    // Resume the session by sending "continue" or re-executing with context
    // This depends on Pi CLI capabilities - two approaches:

    // APPROACH A: If Pi CLI supports "continue" command
    // await this.sendContinueToSession(sessionId)

    // APPROACH B: Re-execute with "continue" prompt
    const task = this.db.getTask(pausedState.taskId!)
    if (task) {
      await this.resumeTaskExecution(task, pausedState)
    }

    // Clear paused state from database
    clearPausedSessionState(this.db, sessionId)

    this.broadcast({ type: "session_status_changed", payload: { 
      sessionId, 
      status: "active",
      taskId: pausedState.taskId,
    }})
  }

  // NEW: Resume task execution from pause point
  private async resumeTaskExecution(task: Task, pausedState: PausedSessionState): Promise<void> {
    // Create a "continue" prompt that preserves context
    const continuePrompt = `Continue from where you left off. You were in the middle of implementing a task. Review what you've done so far and continue with the remaining work.

Previous context: ${pausedState.context.agentOutputSnapshot?.slice(-2000) || 'Task execution paused'}`

    // Re-execute the prompt
    const execution = await this.sessionManager.executePrompt({
      taskId: task.id,
      sessionKind: pausedState.sessionKind as PiSessionKind,
      cwd: pausedState.worktreeDir!,
      worktreeDir: pausedState.worktreeDir,
      branch: pausedState.branch,
      model: pausedState.model,
      thinkingLevel: pausedState.thinkingLevel as ThinkingLevel,
      promptText: continuePrompt,
      // Indicate this is a resume, not a fresh start
      isResume: true,  // New flag in session-manager
      resumedSessionId: pausedState.sessionId,  // Reuse same session ID
    })

    // Update task with new session info
    this.db.updateTask(task.id, {
      sessionId: execution.session.id,
      sessionUrl: this.sessionUrlFor(execution.session.id),
    })
  }

  // NEW: Destructive Stop with Cleanup
  async destructiveStop(runId: string): Promise<void> {
    const run = this.db.getWorkflowRun(runId)
    if (!run) throw new Error("Run not found")

    console.log(`[orchestrator] Destructive stop for run ${runId}`)

    // 1. Stop all active sessions immediately
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.sessionId) {
        await this.killSessionImmediately(task.sessionId)
      }
    }

    // 2. Kill all containers for this run
    if (this.containerManager) {
      for (const taskId of run.taskOrder) {
        const task = this.db.getTask(taskId)
        if (task?.sessionId) {
          await this.containerManager.killContainer(task.sessionId)
        }
      }
    }

    // 3. Delete all worktrees for this run's tasks
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.worktreeDir && existsSync(task.worktreeDir)) {
        console.log(`[orchestrator] Removing worktree: ${task.worktreeDir}`)
        await this.worktree.complete(task.worktreeDir, {
          branch: "",
          targetBranch: "",
          shouldMerge: false,
          shouldRemove: true,
        })
        this.db.updateTask(taskId, { worktreeDir: null })
      }
    }

    // 4. Clear any paused states from database
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task?.sessionId) {
        clearPausedSessionState(this.db, task.sessionId)
      }
    }

    // 5. Mark all incomplete tasks as failed
    for (const taskId of run.taskOrder) {
      const task = this.db.getTask(taskId)
      if (task && task.status === "executing") {
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
    if (updated) this.broadcast({ type: "run_updated", payload: updated })

    // 7. Reset orchestrator state
    this.running = false
    this.currentRunId = null
    this.shouldStop = true

    this.broadcast({ type: "execution_stopped", payload: { runId, destructive: true } })
  }

  // Helper: Kill session without cleanup
  private async killSessionImmediately(sessionId: string): Promise<void> {
    const activeProcess = this.activeSessionProcesses.get(sessionId)
    if (activeProcess) {
      // Force kill without graceful close
      if (activeProcess.process instanceof ContainerPiProcess) {
        await activeProcess.process.forceKill()
      } else {
        // Native process - kill the underlying Bun subprocess
        const proc = (activeProcess.process as PiRpcProcess).getProcess()
        proc?.kill(9) // SIGKILL
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

  // Modify existing executeTask to track processes
  private async runSessionPrompt(input: {...}): Promise<...> {
    const result = await this.sessionManager.executePrompt({
      ...input,
      onSessionCreated: (process) => {
        // Track the process for pause/stop
        this.activeSessionProcesses.set(result.session.id, {
          process,
          session: result.session,
          onPause: async () => {
            // Custom pause handler if needed
          }
        })
      }
    })
    return result
  }
}
```

### 1.3 Enhanced Session Manager with Resume Support

**Modify `src/runtime/session-manager.ts`:**

```typescript
export interface ExecuteSessionPromptInput {
  // ... existing fields
  
  // NEW: Resume fields
  isResume?: boolean
  resumedSessionId?: string
  continuationPrompt?: string  // "Continue from where you left off..."
}

export class PiSessionManager {
  async executePrompt(input: ExecuteSessionPromptInput): Promise<...> {
    // If resuming, use the same session ID
    const sessionId = input.resumedSessionId ?? randomUUID().slice(0, 8)
    
    // Check if this is a resume of a container session
    let containerId: string | null = null
    if (input.isResume && input.worktreeDir) {
      // Load paused state from database to check container
      const pausedState = loadPausedSessionState(this.db, input.resumedSessionId!)
      if (pausedState?.containerId) {
        // Check if container still exists
        const exists = await this.containerManager?.checkContainerExists(pausedState.containerId)
        if (!exists) {
          console.log(`[session-manager] Container ${pausedState.containerId} no longer exists, will create new one`)
        } else {
          containerId = pausedState.containerId
        }
      }
    }

    // Create or update session
    let session: PiWorkflowSession
    if (input.isResume && input.resumedSessionId) {
      // Update existing session instead of creating new
      session = this.db.updateWorkflowSession(input.resumedSessionId, {
        status: "starting",
        // Don't reset startedAt, keep original
      }) ?? this.db.createWorkflowSession({...})
    } else {
      session = this.db.createWorkflowSession({...})
    }

    const process = createPiProcess({
      db: this.db,
      session,
      containerManager: this.containerManager,
      // Pass containerId if resuming and container exists
      existingContainerId: containerId,
      // ...
    })

    // ... rest of implementation

    // If resuming, send "continue" prompt
    if (input.isResume && input.continuationPrompt) {
      await process.send({
        type: "prompt",
        message: input.continuationPrompt,
      })
    }

    // ...
  }
}
```

### 1.4 Enhanced Container Manager

**Add to `src/runtime/container-manager.ts`:**

```typescript
export class PiContainerManager {
  // ... existing methods

  /**
   * Check if a container exists and is running
   */
  async checkContainerExists(containerId: string): Promise<boolean> {
    try {
      const { stdout } = await this.execPodman([
        "ps", "-q", "-f", `id=${containerId}`,
      ])
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }

  /**
   * Attach to an existing container (for resume)
   * 
   * CRITICAL: This is the RECOMMENDED approach for container resume operations.
   * Reattaching to an existing container preserves:
   *   - All file system state (modified files, installed packages)
   *   - Environment variables set during execution
   *   - Running processes and their state
   *   - Network connections
   * 
   * Container recreation (the fallback) loses all unsaved work and requires
   * re-execution from scratch. Only use recreation when attach fails.
   * 
   * Implementation uses 'podman exec' to create a new session in the existing
   * container while preserving all container state.
   */
  async attachToContainer(containerId: string, sessionId: string): Promise<ContainerProcess | null> {
    // Verify container exists and is running
    const containerInfo = await this.checkContainerById(containerId)
    if (!containerInfo?.running) {
      console.log(`[container-manager] Container ${containerId} not running, cannot attach`)
      return null
    }

    try {
      console.log(`[container-manager] Attaching to existing container ${containerId} for session ${sessionId}`)
      
      // Create stdin/stdout/stderr streams for the exec session
      const stdin = new WritableStream({
        write(chunk: Uint8Array) {
          // Will be connected to podman exec stdin
        }
      })
      
      const stdout = new ReadableStream({
        start(controller) {
          // Will receive podman exec stdout
        }
      })
      
      const stderr = new ReadableStream({
        start(controller) {
          // Will receive podman exec stderr
        }
      })

      // Execute pi-cli in the existing container
      // This creates a new process inside the container while preserving all state
      const process = Bun.spawn([
        "podman", "exec", "-i", containerId,
        "pi", "rpc", "--session-id", sessionId
      ], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })

      // Create container process wrapper
      const containerProcess: ContainerProcess = {
        sessionId,
        containerId,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        kill: async () => {
          process.kill()
        },
        inspect: async () => ({
          State: { Status: "running", Running: true }
        }),
      }

      // Register in managed containers
      this.containers.set(sessionId, containerProcess)

      console.log(`[container-manager] Successfully attached to container ${containerId}`)
      return containerProcess
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[container-manager] Failed to attach to container ${containerId}: ${message}`)
      return null
    }
  }

  /**
   * Force kill a container (SIGKILL)
   */
  async forceKillContainer(sessionId: string): Promise<void> {
    const process = this.containers.get(sessionId)
    if (process) {
      // Send SIGKILL instead of graceful stop
      await this.execPodman(["kill", "-s", "SIGKILL", process.containerId])
      this.containers.delete(sessionId)
    }
  }
}
```

### 1.5 Enhanced Container Pi Process

**Add to `src/runtime/container-pi-process.ts`:**

```typescript
export class ContainerPiProcess {
  // ... existing methods

  /**
   * Force kill without graceful shutdown
   */
  async forceKill(): Promise<void> {
    if (!this.containerProcess) return
    
    const process = this.containerProcess
    this.containerProcess = null

    // Abort stream readers
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    // Reject all pending
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Session force killed"))
      this.pending.delete(id)
    }

    // SIGKILL the container
    try {
      await this.containerManager.forceKillContainer(this.session.id)
    } catch {
      // Ignore
    }

    // Mark as aborted
    this.db.updateWorkflowSession(this.session.id, {
      status: "aborted",
      finishedAt: Math.floor(Date.now() / 1000),
    })
  }

  /**
   * Get container ID
   */
  async getContainerId(): Promise<string | null> {
    return this.containerProcess?.containerId ?? null
  }
}
```

### 1.6 Enhanced Native Pi Process

**Add to `src/runtime/pi-process.ts`:**

```typescript
export class PiRpcProcess {
  // ... existing methods

  /**
   * Get underlying process for force kill
   */
  getProcess(): Bun.Subprocess<"pipe", "pipe", "pipe"> | null {
    return this.proc
  }

  /**
   * Force kill without graceful shutdown
   */
  forceKill(): void {
    if (!this.proc) return
    
    const proc = this.proc
    this.proc = null

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Session force killed"))
      this.pending.delete(id)
    }

    // SIGKILL
    proc.kill(9)

    this.db.updateWorkflowSession(this.session.id, {
      status: "aborted",
      finishedAt: Math.floor(Date.now() / 1000),
    })
  }
}
```

### 1.7 Server Route Updates

**Modify `src/server/server.ts`:**

```typescript
export class PiKanbanServer {
  constructor(...) {
    // ... existing setup
    
    // NEW: Set up pause/resume callbacks
    this.onPauseRun = async (runId: string) => {
      await this.orchestrator?.pauseRun(runId)
      return { ok: true, runId, status: "paused" }
    }
    
    this.onResumeRun = async (runId: string) => {
      await this.orchestrator?.resumeRun(runId)
      return { ok: true, runId, status: "running" }
    }
    
    this.onStopRun = async (runId: string, options?: { destructive?: boolean }) => {
      if (options?.destructive) {
        await this.orchestrator?.destructiveStop(runId)
      } else {
        await this.orchestrator?.stopRun(runId) // graceful stop
      }
      return { ok: true, runId, status: "stopped" }
    }
  }

  private registerRoutes(): void {
    // ... existing routes

    // UPDATE: Pause run with actual session pausing
    this.router.post("/api/runs/:id/pause", async ({ params, json, broadcast }) => {
      if (this.onPauseRun) {
        const response = await this.onPauseRun(params.id)
        broadcast({ type: "run_paused", payload: { runId: params.id } })
        return json(response)
      }
      // Fallback to old behavior
      const updated = this.db.updateWorkflowRun(params.id, { pauseRequested: true, status: "paused" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      return json(updated)
    })

    // UPDATE: Resume run with actual session resumption
    this.router.post("/api/runs/:id/resume", async ({ params, json, broadcast }) => {
      if (this.onResumeRun) {
        const response = await this.onResumeRun(params.id)
        broadcast({ type: "run_resumed", payload: { runId: params.id } })
        return json(response)
      }
      // Fallback to old behavior
      const updated = this.db.updateWorkflowRun(params.id, { pauseRequested: false, status: "running" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      return json(updated)
    })

    // UPDATE: Stop run with destructive option
    this.router.post("/api/runs/:id/stop", async ({ params, req, json, broadcast }) => {
      const body = await req.json().catch(() => ({}))
      const destructive = body?.destructive === true
      
      if (this.onStopRun) {
        const response = await this.onStopRun(params.id, { destructive })
        if (destructive) {
          broadcast({ type: "run_stopped", payload: { runId: params.id, destructive: true } })
        }
        return json(response)
      }
      // Fallback to old behavior
      const updated = this.db.updateWorkflowRun(params.id, { stopRequested: true, status: "stopping" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      return json(updated)
    })

    // NEW: Get paused session state (for debugging)
    this.router.get("/api/runs/:id/paused-state", async ({ params, json }) => {
      const run = this.db.getWorkflowRun(params.id)
      if (!run) return json({ error: "Run not found" }, 404)

      const pausedStates = []
      for (const taskId of run.taskOrder) {
        const task = this.db.getTask(taskId)
        if (task?.sessionId) {
          const state = loadPausedSessionState(this.db, task.sessionId)
          if (state) pausedStates.push(state)
        }
      }

      return json({ runId: params.id, pausedSessions: pausedStates })
    })
  }
}
```

### 1.8 New WebSocket Events

**Add to `src/types.ts`:**

```typescript
export type WSMessageType =
  | "task_created"
  | "task_updated"
  // ... existing types
  | "execution_paused"      // NEW
  | "execution_resumed"     // NEW
  | "run_paused"           // NEW
  | "run_resumed"          // NEW
  | "run_stopped"          // NEW (with destructive flag)
```

---

## Phase 2: Frontend UI Implementation

### 2.1 New Composable: `useWorkflowControl.ts`

**New File: `src/kanban-vue/src/composables/useWorkflowControl.ts`**

```typescript
import { ref, computed } from 'vue'
import type { WorkflowRun } from '@/types/api'
import { useApi } from './useApi'

export type WorkflowControlState = 'idle' | 'running' | 'paused' | 'stopping'

export function useWorkflowControl() {
  const api = useApi()
  const controlState = ref<WorkflowControlState>('idle')
  const isConfirmingStop = ref(false)
  const stopType = ref<'graceful' | 'destructive' | null>(null)

  const isRunning = computed(() => controlState.value === 'running')
  const isPaused = computed(() => controlState.value === 'paused')
  const isStopping = computed(() => controlState.value === 'stopping')

  const updateStateFromRuns = (runs: WorkflowRun[]) => {
    const active = runs.find(r => r.status === 'running' || r.status === 'stopping' || r.status === 'paused')
    if (!active) {
      controlState.value = 'idle'
      return
    }
    
    if (active.status === 'paused') {
      controlState.value = 'paused'
    } else if (active.status === 'stopping') {
      controlState.value = 'stopping'
    } else {
      controlState.value = 'running'
    }
  }

  const pauseWorkflow = async (runId: string) => {
    controlState.value = 'paused'
    return await api.pauseRun(runId)
  }

  const resumeWorkflow = async (runId: string) => {
    controlState.value = 'running'
    return await api.resumeRun(runId)
  }

  const requestStop = (type: 'graceful' | 'destructive') => {
    stopType.value = type
    isConfirmingStop.value = true
  }

  const confirmStop = async (runId: string) => {
    isConfirmingStop.value = false
    if (stopType.value === 'destructive') {
      controlState.value = 'stopping'
      return await api.stopRun(runId, { destructive: true })
    } else {
      controlState.value = 'stopping'
      return await api.stopRun(runId, { destructive: false })
    }
  }

  const cancelStop = () => {
    isConfirmingStop.value = false
    stopType.value = null
  }

  return {
    controlState,
    isRunning,
    isPaused,
    isStopping,
    isConfirmingStop,
    stopType,
    updateStateFromRuns,
    pauseWorkflow,
    resumeWorkflow,
    requestStop,
    confirmStop,
    cancelStop,
  }
}
```

### 2.2 Update `useApi.ts`

**Modify `src/kanban-vue/src/composables/useApi.ts`:**

```typescript
export function useApi() {
  // ... existing methods

  return {
    // ... existing methods

    // UPDATE: Stop with destructive option
    stopRun: (id: string, options?: { destructive?: boolean }) => 
      request<WorkflowRun>(`/api/runs/${id}/stop`, { 
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      }),
  }
}
```

### 2.3 New Modal: `StopConfirmModal.vue`

**New File: `src/kanban-vue/src/components/modals/StopConfirmModal.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  isOpen: boolean
  runName: string
}>()

const emit = defineEmits<{
  close: []
  confirmGraceful: []
  confirmDestructive: []
}>()

const isVisible = computed(() => props.isOpen)
</script>

<template>
  <div v-if="isVisible" class="modal-overlay" @click.self="emit('close')">
    <div class="modal-container">
      <div class="modal-header">
        <h3 class="modal-title">Stop Workflow</h3>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>
      
      <div class="modal-body">
        <div class="warning-section">
          <div class="warning-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <p class="warning-text">
            Are you sure you want to stop <strong>{{ runName }}</strong>?
          </p>
        </div>

        <div class="options-grid">
          <!-- Graceful Stop -->
          <button class="option-btn graceful" @click="emit('confirmGraceful')">
            <div class="option-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            </div>
            <div class="option-content">
              <div class="option-title">Pause & Stop Gracefully</div>
              <div class="option-desc">
                Stop after current task completes. Work is preserved.
              </div>
            </div>
          </button>

          <!-- Destructive Stop -->
          <button class="option-btn destructive" @click="emit('confirmDestructive')">
            <div class="option-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                <line x1="10" y1="11" x2="10" y2="17"/>
                <line x1="14" y1="11" x2="14" y2="17"/>
              </svg>
            </div>
            <div class="option-content">
              <div class="option-title">Stop & Delete Everything</div>
              <div class="option-desc">
                <strong>Danger:</strong> Kills all agents, deletes containers & worktrees immediately. All work is lost.
              </div>
            </div>
          </button>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-container {
  background: #1a1a2e;
  border: 1px solid #2a2a3e;
  border-radius: 12px;
  width: 90%;
  max-width: 500px;
  max-height: 90vh;
  overflow: hidden;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #2a2a3e;
}

.modal-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: #e2e2e5;
}

.modal-close {
  background: none;
  border: none;
  color: #8a8a9a;
  font-size: 1.5rem;
  cursor: pointer;
}

.modal-body {
  padding: 1.25rem;
}

.warning-section {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
  padding: 0.75rem;
  background: rgba(255, 193, 7, 0.1);
  border: 1px solid rgba(255, 193, 7, 0.3);
  border-radius: 8px;
}

.warning-icon {
  width: 24px;
  height: 24px;
  color: #ffc107;
  flex-shrink: 0;
}

.warning-text {
  color: #e2e2e5;
  font-size: 0.875rem;
}

.options-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.option-btn {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem;
  background: #0f0f1a;
  border: 2px solid #2a2a3e;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}

.option-btn:hover {
  border-color: #4a4a5e;
}

.option-btn.graceful:hover {
  border-color: #00ff88;
}

.option-btn.destructive {
  border-color: #ff6b6b;
}

.option-btn.destructive:hover {
  background: rgba(255, 107, 107, 0.1);
}

.option-icon {
  width: 20px;
  height: 20px;
  color: #8a8a9a;
  flex-shrink: 0;
}

.option-btn.graceful .option-icon {
  color: #00ff88;
}

.option-btn.destructive .option-icon {
  color: #ff6b6b;
}

.option-title {
  font-weight: 600;
  color: #e2e2e5;
  margin-bottom: 0.25rem;
}

.option-desc {
  font-size: 0.75rem;
  color: #8a8a9a;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  padding: 1rem 1.25rem;
  border-top: 1px solid #2a2a3e;
}

.btn-secondary {
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid #4a4a5e;
  border-radius: 6px;
  color: #8a8a9a;
  cursor: pointer;
}

.btn-secondary:hover {
  border-color: #8a8a9a;
  color: #e2e2e5;
}
</style>
```

### 2.4 Enhanced Sidebar with Pause/Resume

**Modify `src/kanban-vue/src/components/board/Sidebar.vue`:**

Add new props and emits:
```vue
<script setup lang="ts">
const props = defineProps<{
  runs: WorkflowRun[]
  staleRuns: WorkflowRun[]
  consumedSlots: number
  parallelTasks: number
  isConnected: boolean
  isPaused: boolean  // NEW
  activeRunId: string | null  // NEW
}>()

const emit = defineEmits<{
  toggleExecution: []
  pauseExecution: [runId: string]  // NEW
  resumeExecution: [runId: string]  // NEW
  stopExecution: [type: 'graceful' | 'destructive']  // NEW - with confirmation
  // ... existing emits
}>()

// NEW: Get pause/resume button state
const pauseResumeButton = computed(() => {
  if (isPaused.value) {
    return {
      label: 'Resume Workflow',
      icon: 'play',
      action: () => emit('resumeExecution', props.activeRunId!)
    }
  } else if (isRunning.value) {
    return {
      label: 'Pause Workflow',
      icon: 'pause',
      action: () => emit('pauseExecution', props.activeRunId!)
    }
  }
  return null
})
</script>
```

Add new buttons in template:
```vue
<template>
  <!-- ... -->
  <div class="sidebar-section">
    <div class="sidebar-section-title">Actions</div>
    
    <!-- Main Start/Pause/Resume/Stop Button -->
    <div class="action-group">
      <button
        v-if="!isRunning && !isPaused"
        class="sidebar-btn primary"
        @click="emit('toggleExecution')"
      >
        <!-- Start icon -->
        <span class="sidebar-label">Start Workflow</span>
      </button>

      <template v-else>
        <!-- Pause/Resume Button -->
        <button
          v-if="pauseResumeButton"
          :class="['sidebar-btn', isPaused ? 'primary' : 'warning']"
          @click="pauseResumeButton.action"
        >
          <!-- Pause/Play icon -->
          <span class="sidebar-label">{{ pauseResumeButton.label }}</span>
        </button>

        <!-- Stop Button (opens confirmation) -->
        <button
          class="sidebar-btn danger"
          @click="emit('stopExecution', 'graceful')"
        >
          <!-- Stop icon -->
          <span class="sidebar-label">Stop</span>
        </button>
      </template>
    </div>
    <!-- ... other buttons ... -->
  </div>
  <!-- ... -->
</template>

<style scoped>
/* NEW: Action group for related buttons */
.action-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

/* NEW: Warning button style */
.sidebar-btn.warning {
  border-color: #ffc107;
  color: #ffc107;
}

.sidebar-btn.warning:hover {
  background: rgba(255, 193, 7, 0.1);
}

/* NEW: Danger button style */
.sidebar-btn.danger {
  border-color: #ff6b6b;
  color: #ff6b6b;
}

.sidebar-btn.danger:hover {
  background: rgba(255, 107, 107, 0.1);
}
</style>
```

### 2.5 Update App.vue to Integrate

**Modify `src/kanban-vue/src/App.vue`:**

```vue
<script setup lang="ts">
import { useWorkflowControl } from './composables/useWorkflowControl' // NEW
import StopConfirmModal from './components/modals/StopConfirmModal.vue' // NEW

// NEW: Workflow control
const workflowControl = useWorkflowControl()
const showStopConfirm = ref(false)
const activeRunForStop = ref<string | null>(null)

const handleStopRequest = (type: 'graceful' | 'destructive') => {
  const activeRun = runs.activeRuns.value[0]
  if (activeRun) {
    activeRunForStop.value = activeRun.id
    showStopConfirm.value = true
  }
}

const confirmStop = async (type: 'graceful' | 'destructive') => {
  if (activeRunForStop.value) {
    await workflowControl.confirmStop(activeRunForStop.value)
    showStopConfirm.value = false
    activeRunForStop.value = null
  }
}

// Update workflow control state when runs change
const activeRun = computed(() => runs.activeRuns.value[0] ?? null)
workflowControl.updateStateFromRuns(runs.runs.value)

// WebSocket handlers for new events
ws.onMessage('execution_paused', () => {
  workflowControl.updateStateFromRuns(runs.runs.value)
})

ws.onMessage('execution_resumed', () => {
  workflowControl.updateStateFromRuns(runs.runs.value)
})

ws.onMessage('run_paused', (payload) => {
  runs.updateRunFromWebSocket({ ...runs.runs.value.find(r => r.id === payload.runId)!, status: 'paused' })
  workflowControl.updateStateFromRuns(runs.runs.value)
})

ws.onMessage('run_resumed', (payload) => {
  runs.updateRunFromWebSocket({ ...runs.runs.value.find(r => r.id === payload.runId)!, status: 'running' })
  workflowControl.updateStateFromRuns(runs.runs.value)
})
</script>

<template>
  <!-- ... -->
  <Sidebar
    :runs="runs.runs"
    :stale-runs="runs.staleRuns"
    :consumed-slots="runs.consumedRunSlots"
    :parallel-tasks="options.data.value?.parallelTasks ?? 1"
    :is-connected="ws.isConnected.value"
    :is-paused="workflowControl.isPaused.value"
    :active-run-id="activeRun?.id ?? null"
    @toggle-execution="toggleExecution"
    @pause-execution="workflowControl.pauseWorkflow"
    @resume-execution="workflowControl.resumeWorkflow"
    @stop-execution="handleStopRequest"
    <!-- ... other handlers ... -->
  />
  <!-- ... -->

  <!-- NEW: Stop Confirmation Modal -->
  <StopConfirmModal
    :is-open="showStopConfirm"
    :run-name="activeRun?.displayName ?? 'Current Run'"
    @close="showStopConfirm = false"
    @confirm-graceful="() => confirmStop('graceful')"
    @confirm-destructive="() => confirmStop('destructive')"
  />
  <!-- ... -->
</template>
```

---

## Phase 3: Database and State Persistence

### 3.1 Database Migration

**Add to `src/db/migrations.ts`:**

```typescript
// Migration: Add paused session state table
export function migrateAddPausedSessionState(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS paused_session_states (
      session_id TEXT PRIMARY KEY,
      task_id TEXT,
      task_run_id TEXT,
      session_kind TEXT NOT NULL,
      worktree_dir TEXT,
      branch TEXT,
      model TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      pi_session_id TEXT,
      pi_session_file TEXT,
      container_id TEXT,
      container_image TEXT,
      paused_at INTEGER NOT NULL,
      last_prompt TEXT,
      execution_phase TEXT,
      context_json TEXT,
      FOREIGN KEY (session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE
    )
  `)
  
  // Add index for faster lookup
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_paused_sessions_task 
    ON paused_session_states(task_id)
  `)
}
```

### 3.2 Paused State Storage Implementation

**New File: `src/runtime/session-pause-state.ts`:**

```typescript
import type { PiKanbanDB } from "../db.ts"
import type { PiSessionKind, ThinkingLevel } from "../db/types.ts"

export interface PausedSessionState {
  sessionId: string
  taskId: string | null
  taskRunId: string | null
  sessionKind: PiSessionKind
  worktreeDir: string | null
  branch: string | null
  model: string
  thinkingLevel: ThinkingLevel
  piSessionId: string | null
  piSessionFile: string | null
  containerId: string | null
  containerImage: string | null
  pausedAt: number
  lastPrompt: string | null
  executionPhase: string | null
  pauseReason: string | null
  context: {
    agentOutputSnapshot: string | null
    pendingToolCalls: unknown[] | null
    reviewCount: number
  }
}

export function savePausedSessionState(db: PiKanbanDB, state: PausedSessionState): void {
  const contextJson = JSON.stringify(state.context)

  db.run(
    `INSERT INTO paused_session_states (
      session_id, task_id, task_run_id, session_kind, worktree_dir, branch,
      model, thinking_level, pi_session_id, pi_session_file, container_id,
      container_image, paused_at, last_prompt, execution_phase, pause_reason, context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      task_id = excluded.task_id,
      task_run_id = excluded.task_run_id,
      session_kind = excluded.session_kind,
      worktree_dir = excluded.worktree_dir,
      branch = excluded.branch,
      model = excluded.model,
      thinking_level = excluded.thinking_level,
      pi_session_id = excluded.pi_session_id,
      pi_session_file = excluded.pi_session_file,
      container_id = excluded.container_id,
      container_image = excluded.container_image,
      paused_at = excluded.paused_at,
      last_prompt = excluded.last_prompt,
      execution_phase = excluded.execution_phase,
      pause_reason = excluded.pause_reason,
      context_json = excluded.context_json`,
    [
      state.sessionId,
      state.taskId,
      state.taskRunId,
      state.sessionKind,
      state.worktreeDir,
      state.branch,
      state.model,
      state.thinkingLevel,
      state.piSessionId,
      state.piSessionFile,
      state.containerId,
      state.containerImage,
      state.pausedAt,
      state.lastPrompt,
      state.executionPhase,
      state.pauseReason,
      contextJson,
    ]
  )
}

export function loadPausedSessionState(db: PiKanbanDB, sessionId: string): PausedSessionState | null {
  const row = db.query(
    `SELECT * FROM paused_session_states WHERE session_id = ?`,
    [sessionId]
  )[0]

  if (!row) return null

  const context = JSON.parse(row.context_json)

  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    sessionKind: row.session_kind,
    worktreeDir: row.worktree_dir,
    branch: row.branch,
    model: row.model,
    thinkingLevel: row.thinking_level,
    piSessionId: row.pi_session_id,
    piSessionFile: row.pi_session_file,
    containerId: row.container_id,
    containerImage: row.container_image,
    pausedAt: row.paused_at,
    lastPrompt: row.last_prompt,
    executionPhase: row.execution_phase,
    pauseReason: row.pause_reason,
    context: {
      agentOutputSnapshot: context.agentOutputSnapshot,
      pendingToolCalls: context.pendingToolCalls,
      reviewCount: context.reviewCount,
    },
  }
}

export function clearPausedSessionState(db: PiKanbanDB, sessionId: string): void {
  db.run(`DELETE FROM paused_session_states WHERE session_id = ?`, [sessionId])
}

export function listPausedSessions(db: PiKanbanDB): PausedSessionState[] {
  const rows = db.query(`SELECT * FROM paused_session_states`)

  return rows.map((row) => {
    const context = JSON.parse(row.context_json)
    return {
      sessionId: row.session_id,
      taskId: row.task_id,
      taskRunId: row.task_run_id,
      sessionKind: row.session_kind,
      worktreeDir: row.worktree_dir,
      branch: row.branch,
      model: row.model,
      thinkingLevel: row.thinking_level,
      piSessionId: row.pi_session_id,
      piSessionFile: row.pi_session_file,
      containerId: row.container_id,
      containerImage: row.container_image,
      pausedAt: row.paused_at,
      lastPrompt: row.last_prompt,
      executionPhase: row.execution_phase,
      pauseReason: row.pause_reason,
      context: {
        agentOutputSnapshot: context.agentOutputSnapshot,
        pendingToolCalls: context.pendingToolCalls,
        reviewCount: context.reviewCount,
      },
    }
  })
}
```

---

## Phase 4: Integration and Testing

### 4.1 Update Server.ts to Pass Orchestrator

**Modify `src/server.ts`:**

```typescript
export function createPiServer(args: {
  port?: number
  dbPath: string
  settings?: InfrastructureSettings
}): { db: PiKanbanDB; server: PiKanbanServer; orchestrator: PiOrchestrator } {
  // ... existing setup ...

  const orchestrator = new PiOrchestrator(
    db,
    (msg) => server.broadcast(msg),
    (sessionId) => `/#session/${sessionId}`,
    projectRoot,
    args.settings,
    containerManager,
  )

  const server = new PiKanbanServer(db, {
    port: args.port,
    settings: args.settings,
    onStart: () => orchestrator.startAll(),
    onStartSingle: (taskId) => orchestrator.startSingle(taskId),
    onStop: () => orchestrator.stop(),
    onPauseRun: (runId) => orchestrator.pauseRun(runId),
    onResumeRun: (runId) => orchestrator.resumeRun(runId),
    onStopRun: (runId, options) => orchestrator.destructiveStop(runId, options),
  })

  return { db, server, orchestrator }
}
```

### 4.2 Startup Recovery for Paused Sessions

**Modify `src/recovery/startup-recovery.ts`:**

```typescript
export async function runStartupRecovery(args: {
  db: PiKanbanDB
  broadcast: (message: WSMessage) => void
  orchestrator?: PiOrchestrator  // NEW
}): Promise<void> {
  // ... existing recovery code ...

  // NEW: Recover paused sessions
  // Check for sessions that were paused when server shut down
  const pausedSessions = db.getWorkflowSessions().filter(s => s.status === "paused")
  for (const session of pausedSessions) {
    // Load paused state from database
    const pausedState = loadPausedSessionState(db, session.id)
    if (pausedState) {
      // Check if container still exists
      if (pausedState.containerId) {
        const containerExists = await checkContainerExists(pausedState.containerId)
        if (!containerExists) {
          console.log(`[startup-recovery] Paused session ${session.id} container no longer exists`)
          // Container is gone - we'll need to recreate it when resumed
        }
      }

      // Keep the paused state in database - user can resume from UI
      console.log(`[startup-recovery] Found paused session ${session.id}, can be resumed`)
    }
  }
}
```

---

## Summary of Changes

### New Files:
1. `src/runtime/session-pause-state.ts` - Paused session persistence
2. `src/kanban-vue/src/composables/useWorkflowControl.ts` - Frontend workflow control
3. `src/kanban-vue/src/components/modals/StopConfirmModal.vue` - Stop confirmation UI

### Modified Files:
1. `src/orchestrator.ts` - Core pause/resume/destructive stop logic
2. `src/runtime/session-manager.ts` - Resume support
3. `src/runtime/container-manager.ts` - Container existence check
4. `src/runtime/container-pi-process.ts` - Force kill
5. `src/runtime/pi-process.ts` - Force kill
6. `src/server/server.ts` - Updated routes
7. `src/server.ts` - Orchestrator integration
8. `src/kanban-vue/src/components/board/Sidebar.vue` - Pause/Resume/Stop UI
9. `src/kanban-vue/src/App.vue` - Integration
10. `src/types.ts` - New WebSocket events
11. `src/db/migrations.ts` - Paused session table
12. `src/recovery/startup-recovery.ts` - Paused session recovery

### Database Changes:
- New table: `paused_session_states` with full paused session state
- Indexes on `session_id` (primary key) and `task_id` for efficient lookups
- All paused state persisted in database, no external files used

### API Changes:
- `POST /api/runs/:id/pause` - Now actually pauses sessions
- `POST /api/runs/:id/resume` - Now actually resumes with **container reattachment** (preserves state)
- `POST /api/runs/:id/stop` - Added `destructive` option
- `GET /api/runs/:id/paused-state` - Debug paused state

### Critical Implementation Requirement:
**Container Reattachment is REQUIRED for proper resume functionality.**
The `attachToContainer()` method must be fully implemented to:
1. Preserve all container filesystem state (modified files)
2. Maintain installed packages and dependencies
3. Keep environment variables and process state
4. Only fall back to container recreation when reattachment fails

### WebSocket Events:
- `execution_paused`
- `execution_resumed`
- `run_paused`
- `run_resumed`
- `run_stopped` (with destructive flag)

---

## Implementation Notes

### Key Design Decisions:

1. **Paused State Storage**: Use database only. All paused session state is stored in the `paused_session_states` table with:
   - One row per paused session (referenced by session_id)
   - All context fields stored as individual columns for queryability
   - Complex context object serialized to JSON in the `context_json` column
   - Proper foreign key relationship to workflow_sessions
   - Indexes on frequently queried columns (task_id)
   - No JSON files used - everything is in SQLite for consistency and reliability

2. **Resume Strategy**: When resuming, we re-execute with a "continue" prompt rather than trying to reconnect to existing Pi CLI session. This is more reliable and works across server restarts.

3. **Container Resume Strategy (CRITICAL)**:
   
   **Recommended: Container Reattachment** (implemented via `attachToContainer()`)
   - Uses `podman exec` to create a new process inside the existing container
   - Preserves ALL container state: modified files, installed packages, env vars
   - Maintains network connections and background processes
   - This is the PRIMARY and RECOMMENDED approach for resume operations
   
   **Fallback: Container Recreation** (only when attach fails)
   - Creates a brand new container, losing all unsaved work
   - Used only when the original container no longer exists
   - Agent must restart from scratch with a "continue" prompt
   
   **Priority**: Always attempt reattachment first. Only fall back to recreation if the container is truly gone.

4. **Destructive Stop**: Immediate termination with SIGKILL, cleanup of all containers and worktrees, and marking tasks as failed with explanatory message.

5. **Graceful Stop**: Completes current task, preserves all work, allows resumption from same state.

### Testing Checklist:

- [ ] Pause active run, verify sessions stopped and state saved
- [ ] Resume paused run, verify containers recreated and execution continues
- [ ] Pause, restart server, resume - verify state preserved
- [ ] Destructive stop - verify containers and worktrees deleted
- [ ] Graceful stop - verify current task completes before stopping
- [ ] UI: Pause/Resume buttons appear correctly
- [ ] UI: Stop confirmation modal shows both options
- [ ] UI: WebSocket events update UI correctly
