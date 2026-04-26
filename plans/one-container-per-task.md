# Plan: One Container Per Task (Complete Migration)

## Core Principle

**One container per task. Always. No exceptions. No fallbacks. No flags.**

The system guarantees that every task creates exactly one container at task start and destroys it at task end. All sessions within the task lifecycle share this single container and its Pi process.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         TASK LIFECYCLE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                   TASK CONTAINER                         │    │
│  │  ┌────────────────────────────────────────────────────┐  │    │
│  │  │         Pi Process (Single, Long-running)          │  │    │
│  │  │  ┌──────────────────────────────────────────────┐  │  │    │
│  │  │  │  RPC via FIFO/socket                          │  │  │    │
│  │  │  │  • Maintains conversation history             │  │  │    │
│  │  │  │  • Accumulates context across all phases      │  │  │    │
│  │  │  │  • Resettable for phase isolation             │  │  │    │
│  │  │  └──────────────────────────────────────────────┘  │  │    │
│  │  └────────────────────────────────────────────────────┘  │    │
│  │                         ▲                                 │    │
│  └─────────────────────────┼─────────────────────────────────┘    │
│                           │                                       │
│    ┌──────────────────────┼──────────────────────┐               │
│    │                      │                      │               │
│    ▼                      ▼                      ▼               │
│ ┌───────┐           ┌─────────┐          ┌───────────┐          │
│ │ Plan  │──────────>│ Exec    │─────────>│ Review    │          │
│ │Session│  same      │Session  │  same    │Session    │          │
│ └───────┘  process    └─────────┘  process └───────────┘          │
│    │                      │                      │               │
│    └──────────────────────┼──────────────────────┘               │
│                           │                                       │
│                    ┌────────────┐                                │
│                    │   Commit   │                                │
│                    │  Session   │                                │
│                    └────────────┘                                │
│                           │                                       │
│                           ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              DESTROY TASK CONTAINER                       │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Model Changes

### Task Schema Updates

```typescript
// src/types.ts - Task interface
interface Task {
  // ... existing fields ...
  containerId: string | null           // ID of the task container
  containerName: string | null         // Named reference for management
}

// src/db/types.ts - UpdateTaskInput
interface UpdateTaskInput {
  // ... existing fields ...
  containerId?: string | null
  containerName?: string | null
}
```

### Task Container State

```typescript
// src/runtime/task-container.ts

export type TaskContainerStatus = 
  | "creating" 
  | "running" 
  | "paused" 
  | "stopping" 
  | "destroyed" 
  | "error"

export interface TaskContainer {
  taskId: string
  containerId: string
  containerName: string
  worktreeDir: string
  
  // Communication channels
  inputFifoPath: string
  outputFifoPath: string  
  controlFifoPath: string
  
  // State
  status: TaskContainerStatus
  piProcessPid: number | null
  
  // Timing
  createdAt: number
  lastActivityAt: number
  destroyedAt: number | null
  
  // Error tracking
  errorMessage: string | null
  lastErrorAt: number | null
}

export interface CreateTaskContainerInput {
  taskId: string
  worktreeDir: string
  imageName: string
  env?: Record<string, string>
}
```

## Container Entrypoint

The container runs a single Pi daemon that handles all prompts for the task.

```typescript
// docker/pi-agent/task-daemon.ts
// This runs inside the container and manages the Pi process

import { spawn } from "child_process"
import { createServer } from "net"
import { mkdirSync, existsSync } from "fs"
import { join } from "path"

interface PromptRequest {
  type: "prompt"
  sessionId: string
  message: string
  model?: string
  thinkingLevel?: string
  resetContext?: boolean  // If true, reset before this prompt
}

interface ControlCommand {
  type: "control"
  action: "pause" | "resume" | "reset_context" | "exit"
}

class TaskPiDaemon {
  private piProcess: ReturnType<typeof spawn> | null = null
  private socketServer: ReturnType<typeof createServer> | null = null
  private pendingResponses = new Map<string, (response: any) => void>()
  private eventBuffer: any[] = []
  private isPaused = false
  private socketPath = "/tmp/pi-rpc.sock"
  
  constructor(private taskId: string) {}
  
  start(): void {
    // Ensure socket directory exists
    const socketDir = "/tmp/pi-sockets"
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true })
    }
    
    this.socketPath = join(socketDir, `${this.taskId}.sock`)
    
    // Remove old socket if exists
    try {
      if (existsSync(this.socketPath)) {
        require("fs").unlinkSync(this.socketPath)
      }
    } catch {}
    
    // Start Pi in RPC mode
    this.piProcess = spawn("pi", ["rpc"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_TASK_ID: this.taskId,
        PI_PERSISTENT: "1",
      }
    })
    
    this.setupEventHandlers()
    this.setupSocketServer()
    
    console.log(`[task-daemon] Started for task ${this.taskId}`)
    console.log(`[task-daemon] Socket: ${this.socketPath}`)
  }
  
  private setupEventHandlers(): void {
    let buffer = ""
    
    this.piProcess!.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""
      
      for (const line of lines) {
        if (!line.trim()) continue
        
        try {
          const event = JSON.parse(line)
          this.eventBuffer.push(event)
          
          // Route to waiting request
          if (event.id && this.pendingResponses.has(event.id)) {
            const callback = this.pendingResponses.get(event.id)!
            callback(event)
            this.pendingResponses.delete(event.id)
          }
          
          // Handle agent_end
          if (event.type === "agent_end") {
            // Find any pending request for this session and complete it
            for (const [id, callback] of this.pendingResponses) {
              if (id.startsWith(event.sessionId || "")) {
                callback({ type: "complete", events: this.eventBuffer })
                this.pendingResponses.delete(id)
                break
              }
            }
          }
        } catch (err) {
          console.error("[task-daemon] Failed to parse event:", line)
        }
      }
    })
    
    this.piProcess!.stderr!.on("data", (data: Buffer) => {
      console.error("[pi-stderr]", data.toString())
    })
    
    this.piProcess!.on("exit", (code) => {
      console.log(`[task-daemon] Pi process exited with code ${code}`)
      // If not intentional shutdown, the container will be killed anyway
    })
  }
  
  private setupSocketServer(): void {
    this.socketServer = createServer((socket) => {
      let buffer = ""
      
      socket.on("data", (data) => {
        buffer += data.toString()
        
        // Process complete JSON messages
        while (true) {
          const newlineIdx = buffer.indexOf("\n")
          if (newlineIdx === -1) break
          
          const line = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 1)
          
          if (!line.trim()) continue
          
          try {
            const message = JSON.parse(line)
            this.handleMessage(message, socket)
          } catch (err) {
            socket.write(JSON.stringify({ error: "Invalid JSON" }) + "\n")
          }
        }
      })
      
      socket.on("error", (err) => {
        console.error("[task-daemon] Socket error:", err)
      })
    })
    
    this.socketServer.listen(this.socketPath, () => {
      console.log(`[task-daemon] Socket server listening`)
    })
  }
  
  private handleMessage(message: any, socket: any): void {
    if (message.type === "prompt") {
      this.handlePrompt(message, socket)
    } else if (message.type === "control") {
      this.handleControl(message, socket)
    } else {
      socket.write(JSON.stringify({ error: "Unknown message type" }) + "\n")
    }
  }
  
  private handlePrompt(request: PromptRequest, socket: any): void {
    if (this.isPaused) {
      socket.write(JSON.stringify({ error: "Container is paused" }) + "\n")
      return
    }
    
    // Reset context if requested
    if (request.resetContext) {
      this.piProcess!.stdin!.write(JSON.stringify({ type: "new_session" }) + "\n")
    }
    
    // Store callback for response
    const requestId = `${request.sessionId}_${Date.now()}`
    this.pendingResponses.set(requestId, (response) => {
      socket.write(JSON.stringify(response) + "\n")
    })
    
    // Send to Pi
    const promptMessage = {
      type: "prompt",
      message: request.message,
      id: requestId,
      ...(request.model && { model: request.model }),
      ...(request.thinkingLevel && { thinkingLevel: request.thinkingLevel }),
    }
    
    this.piProcess!.stdin!.write(JSON.stringify(promptMessage) + "\n")
  }
  
  private handleControl(command: ControlCommand, socket: any): void {
    switch (command.action) {
      case "pause":
        this.isPaused = true
        // Optionally send SIGSTOP to Pi process
        if (this.piProcess?.pid) {
          process.kill(this.piProcess.pid, "SIGSTOP")
        }
        socket.write(JSON.stringify({ status: "paused" }) + "\n")
        break
        
      case "resume":
        this.isPaused = false
        if (this.piProcess?.pid) {
          process.kill(this.piProcess.pid, "SIGCONT")
        }
        socket.write(JSON.stringify({ status: "resumed" }) + "\n")
        break
        
      case "reset_context":
        this.piProcess!.stdin!.write(JSON.stringify({ type: "new_session" }) + "\n")
        socket.write(JSON.stringify({ status: "context_reset" }) + "\n")
        break
        
      case "exit":
        socket.write(JSON.stringify({ status: "exiting" }) + "\n")
        this.stop()
        break
    }
  }
  
  stop(): void {
    console.log("[task-daemon] Stopping...")
    
    // Send exit to Pi if possible
    if (this.piProcess) {
      this.piProcess.stdin?.write(JSON.stringify({ type: "exit" }) + "\n")
      
      // Give it a moment then force kill
      setTimeout(() => {
        this.piProcess?.kill("SIGTERM")
      }, 1000)
    }
    
    this.socketServer?.close()
    
    // Cleanup socket
    try {
      if (existsSync(this.socketPath)) {
        require("fs").unlinkSync(this.socketPath)
      }
    } catch {}
  }
}

// Start daemon
const taskId = process.env.TASK_ID
if (!taskId) {
  console.error("TASK_ID environment variable required")
  process.exit(1)
}

const daemon = new TaskPiDaemon(taskId)
daemon.start()

// Handle signals
process.on("SIGTERM", () => daemon.stop())
process.on("SIGINT", () => daemon.stop())
```

## Task Container Manager

Centralized manager for all task containers. Guarantees exactly one container per task.

```typescript
// src/runtime/task-container-manager.ts

import { Effect, Schema } from "effect"
import { spawn } from "child_process"
import { createConnection } from "net"
import { join } from "path"
import { mkdirSync, existsSync, rmSync } from "fs"

export class TaskContainerManagerError extends Schema.TaggedError<TaskContainerManagerError>()(
  "TaskContainerManagerError",
  {
    operation: Schema.String,
    message: Schema.String,
    taskId: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

export class TaskContainerManager {
  private taskContainers = new Map<string, TaskContainer>()
  private socketBasePath: string
  
  constructor(
    private containerManager: PiContainerManager,
    private imageName: string,
    basePath: string = ".tauroboros/task-sockets"
  ) {
    this.socketBasePath = join(process.cwd(), basePath)
    this.ensureSocketDir()
  }
  
  private ensureSocketDir(): void {
    if (!existsSync(this.socketBasePath)) {
      mkdirSync(this.socketBasePath, { recursive: true })
    }
  }
  
  /**
   * Create task container.
   * This is the ONLY way to create a container for task execution.
   * Must be called before any session starts.
   */
  createTaskContainer(
    input: CreateTaskContainerInput
  ): Effect.Effect<TaskContainer, TaskContainerManagerError> {
    return Effect.gen(this, function* () {
      // Check if task already has a container
      const existing = this.taskContainers.get(input.taskId)
      if (existing) {
        return yield* new TaskContainerManagerError({
          operation: "createTaskContainer",
          message: `Task ${input.taskId} already has a container`,
          taskId: input.taskId,
        })
      }
      
      const containerName = `tauroboros-task-${input.taskId}`
      const socketDir = join(this.socketBasePath, input.taskId)
      
      // Ensure socket directory exists
      if (!existsSync(socketDir)) {
        mkdirSync(socketDir, { recursive: true })
      }
      
      const hostSocketPath = join(socketDir, "pi.sock")
      const containerSocketPath = "/tmp/pi-sockets/pi.sock"
      
      // Create container configuration
      const containerConfig = {
        sessionId: `task-${input.taskId}`,
        worktreeDir: input.worktreeDir,
        repoRoot: input.worktreeDir.replace(/\/\.worktrees\/[^/]+$/, ""),
        imageName: this.imageName,
        env: {
          TASK_ID: input.taskId,
          PI_PERSISTENT: "1",
          PI_SOCKET_PATH: containerSocketPath,
          ...(input.env || {}),
        },
        volumeMounts: [
          // Standard mounts
          { source: input.worktreeDir, target: input.worktreeDir, type: "bind", readOnly: false },
          // Socket mount for communication
          { source: socketDir, target: "/tmp/pi-sockets", type: "bind", readOnly: false },
        ],
        // Use custom entrypoint that starts the daemon
        entrypoint: ["bun", "run", "/pi-daemon.ts"],
      }
      
      // Create container
      const containerProcess = yield* this.containerManager.createContainer(
        containerConfig as any
      ).pipe(
        Effect.mapError((cause) => new TaskContainerManagerError({
          operation: "createContainer",
          message: cause.message,
          taskId: input.taskId,
          cause,
        }))
      )
      
      // Wait for socket to be created (daemon is ready)
      yield* this.waitForSocket(hostSocketPath, 30000).pipe(
        Effect.mapError((cause) => new TaskContainerManagerError({
          operation: "waitForSocket",
          message: `Pi daemon failed to start: ${cause}`,
          taskId: input.taskId,
          cause,
        }))
      )
      
      const taskContainer: TaskContainer = {
        taskId: input.taskId,
        containerId: containerProcess.containerId,
        containerName,
        worktreeDir: input.worktreeDir,
        inputFifoPath: "", // Not used in socket mode
        outputFifoPath: "", // Not used in socket mode
        controlFifoPath: hostSocketPath,
        status: "running",
        piProcessPid: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        destroyedAt: null,
        errorMessage: null,
        lastErrorAt: null,
      }
      
      this.taskContainers.set(input.taskId, taskContainer)
      
      yield* Effect.logInfo(`[task-container] Created container for task ${input.taskId}`)
      
      return taskContainer
    })
  }
  
  /**
   * Send prompt to task's Pi process via socket.
   */
  sendPrompt(
    taskId: string,
    sessionId: string,
    promptText: string,
    options?: { resetContext?: boolean; model?: string; thinkingLevel?: string }
  ): Effect.Effect<void, TaskContainerManagerError> {
    return Effect.gen(this, function* () {
      const container = this.getTaskContainerOrFail(taskId)
      
      const request = {
        type: "prompt",
        sessionId,
        message: promptText,
        ...(options?.resetContext && { resetContext: true }),
        ...(options?.model && { model: options.model }),
        ...(options?.thinkingLevel && { thinkingLevel: options.thinkingLevel }),
      }
      
      yield* this.sendSocketMessage(container.controlFifoPath, request).pipe(
        Effect.mapError((cause) => new TaskContainerManagerError({
          operation: "sendPrompt",
          message: `Failed to send prompt: ${cause}`,
          taskId,
          cause,
        }))
      )
      
      container.lastActivityAt = Date.now()
    })
  }
  
  /**
   * Collect events from Pi until agent_end or timeout.
   */
  collectEvents(
    taskId: string,
    sessionId: string,
    timeoutMs: number
  ): Effect.Effect<Record<string, unknown>[], TaskContainerManagerError> {
    return Effect.gen(this, function* () {
      const container = this.getTaskContainerOrFail(taskId)
      
      const events: Record<string, unknown>[] = []
      const startTime = Date.now()
      
      return yield* Effect.async<Record<string, unknown>[], TaskContainerManagerError>((resume) => {
        const socket = createConnection(container.controlFifoPath)
        
        let buffer = ""
        let isComplete = false
        
        const timeoutId = setTimeout(() => {
          if (!isComplete) {
            isComplete = true
            socket.end()
            resume(Effect.fail(new TaskContainerManagerError({
              operation: "collectEvents",
              message: `Timeout after ${timeoutMs}ms`,
              taskId,
            })))
          }
        }, timeoutMs)
        
        socket.on("data", (data) => {
          buffer += data.toString()
          
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""
          
          for (const line of lines) {
            if (!line.trim()) continue
            
            try {
              const event = JSON.parse(line)
              events.push(event)
              
              if (event.type === "agent_end" || event.type === "complete") {
                isComplete = true
                clearTimeout(timeoutId)
                socket.end()
                resume(Effect.succeed(events))
                return
              }
            } catch {}
          }
        })
        
        socket.on("error", (err) => {
          if (!isComplete) {
            isComplete = true
            clearTimeout(timeoutId)
            resume(Effect.fail(new TaskContainerManagerError({
              operation: "collectEvents",
              message: err.message,
              taskId,
              cause: err,
            })))
          }
        })
        
        socket.on("close", () => {
          if (!isComplete) {
            isComplete = true
            clearTimeout(timeoutId)
            resume(Effect.succeed(events))
          }
        })
      })
    })
  }
  
  /**
   * Pause task container.
   */
  pauseTaskContainer(taskId: string): Effect.Effect<void, TaskContainerManagerError> {
    return Effect.gen(this, function* () {
      const container = this.getTaskContainerOrFail(taskId)
      
      yield* this.sendControlCommand(taskId, "pause")
      
      container.status = "paused"
      
      yield* Effect.logInfo(`[task-container] Paused container for task ${taskId}`)
    })
  }
  
  /**
   * Resume task container.
   */
  resumeTaskContainer(taskId: string): Effect.Effect<void, TaskContainerManagerError> {
    return Effect.gen(this, function* () {
      const container = this.getTaskContainersOrFail(taskId)
      
      yield* this.sendControlCommand(taskId, "resume")
      
      container.status = "running"
      container.lastActivityAt = Date.now()
      
      yield* Effect.logInfo(`[task-container] Resumed container for task ${taskId}`)
    })
  }
  
  /**
   * Reset Pi context.
   */
  resetContext(taskId: string): Effect.Effect<void, TaskContainerManagerError> {
    return Effect.gen(this, function* () {
      yield* this.sendControlCommand(taskId, "reset_context")
      
      yield* Effect.logInfo(`[task-container] Reset context for task ${taskId}`)
    })
  }
  
  /**
   * Destroy task container.
   * Called at end of task execution.
   */
  destroyTaskContainer(taskId: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const container = this.taskContainers.get(taskId)
      if (!container) {
        return yield* Effect.void
      }
      
      // Signal daemon to exit
      yield* this.sendControlCommand(taskId, "exit").pipe(
        Effect.timeout(5000),
        Effect.catchAll(() => Effect.void)
      )
      
      // Wait briefly for graceful shutdown
      yield* Effect.sleep(1000)
      
      // Force kill container
      yield* this.containerManager.forceKillContainer(`task-${taskId}`).pipe(
        Effect.catchAll(() => Effect.void)
      )
      
      // Update state
      container.status = "destroyed"
      container.destroyedAt = Date.now()
      
      // Cleanup
      this.taskContainers.delete(taskId)
      
      // Remove socket directory
      const socketDir = join(this.socketBasePath, taskId)
      try {
        if (existsSync(socketDir)) {
          rmSync(socketDir, { recursive: true, force: true })
        }
      } catch {}
      
      yield* Effect.logInfo(`[task-container] Destroyed container for task ${taskId}`)
    })
  }
  
  /**
   * Get task container.
   */
  getTaskContainer(taskId: string): TaskContainer | undefined {
    return this.taskContainers.get(taskId)
  }
  
  /**
   * Check if task has active container.
   */
  hasTaskContainer(taskId: string): boolean {
    const container = this.taskContainers.get(taskId)
    return container !== undefined && container.status !== "destroyed"
  }
  
  // Private helpers
  
  private getTaskContainerOrFail(taskId: string): TaskContainer {
    const container = this.taskContainers.get(taskId)
    if (!container) {
      throw new TaskContainerManagerError({
        operation: "getTaskContainer",
        message: `No container found for task ${taskId}`,
        taskId,
      })
    }
    return container
  }
  
  private sendSocketMessage(
    socketPath: string,
    message: any
  ): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath)
        
        socket.on("connect", () => {
          socket.write(JSON.stringify(message) + "\n")
          socket.end()
          resolve()
        })
        
        socket.on("error", reject)
      }),
      catch: (err) => err as Error,
    })
  }
  
  private sendControlCommand(
    taskId: string,
    action: string
  ): Effect.Effect<void, TaskContainerManagerError> {
    return Effect.gen(this, function* () {
      const container = this.getTaskContainerOrFail(taskId)
      
      yield* this.sendSocketMessage(container.controlFifoPath, {
        type: "control",
        action,
      }).pipe(
        Effect.mapError((cause) => new TaskContainerManagerError({
          operation: "sendControlCommand",
          message: cause.message,
          taskId,
          cause,
        }))
      )
    })
  }
  
  private waitForSocket(
    socketPath: string,
    timeoutMs: number
  ): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const startTime = Date.now()
      
      while (Date.now() - startTime < timeoutMs) {
        if (existsSync(socketPath)) {
          return yield* Effect.void
        }
        yield* Effect.sleep(100)
      }
      
      return yield* Effect.fail(new Error(`Socket not created within ${timeoutMs}ms`))
    })
  }
}
```

## Orchestrator Integration

```typescript
// src/orchestrator.ts

export class PiOrchestrator {
  private taskContainerManager: TaskContainerManager
  
  constructor(/* ... */) {
    // ... existing setup ...
    
    // Initialize task container manager
    this.taskContainerManager = new TaskContainerManager(
      this.containerManager!,
      this.settings?.workflow?.container?.image || BASE_IMAGES.piAgent
    )
  }
  
  private executeTaskEffect(
    task: Task,
    options: Options,
    runId: string,
  ): Effect.Effect<void, OrchestratorOperationError | SessionManagerExecuteError | PiProcessError | CollectEventsTimeoutError, never> {
    return Effect.gen(this, function* () {
      // ... existing validation ...
      
      let taskContainer: TaskContainer | null = null
      
      // CREATE TASK CONTAINER
      // This is now MANDATORY - no fallback, no flag
      const imageToUse = resolveContainerImage(task, this.settings?.workflow?.container?.image)
      
      taskContainer = yield* this.taskContainerManager.createTaskContainer({
        taskId: task.id,
        worktreeDir: worktreeInfo!.directory,
        imageName: imageToUse,
      }).pipe(
        Effect.mapError((cause) => new OrchestratorOperationError({
          operation: "createTaskContainer",
          message: cause.message,
          cause,
        }))
      )
      
      // Store on task
      this.db.updateTask(task.id, {
        containerId: taskContainer.containerId,
        containerName: taskContainer.containerName,
      })
      
      // Execute main task logic
      const executeMain = Effect.gen(this, function* () {
        // ... worktree setup ...
        
        const pausedSession = task.sessionId
          ? yield* loadPausedSessionState(this.db, task.sessionId).pipe(...)
          : null
          
        if (pausedSession) {
          // Resume using existing task container
          yield* this.resumeTaskExecution(task, pausedSession, taskContainer)
          clearPausedSessionState(this.db, pausedSession.sessionId)
        } else if (task.planmode) {
          yield* this.runPlanMode(task.id, task, options, worktreeInfo!, taskContainer)
        } else {
          yield* this.runStandardExecution(task.id, task, options, worktreeInfo!, taskContainer)
        }
        
        if (task.review) {
          const reviewPassed = yield* this.runReviewLoop(task.id, options, worktreeInfo!, taskContainer)
          if (!reviewPassed) return
        }
        
        if (task.review && task.codeStyleReview) {
          const success = yield* this.runCodeStyleCheck(task.id, options, worktreeInfo!, taskContainer)
          if (!success) {
            this.db.updateTask(task.id, { 
              status: "stuck", 
              errorMessage: "Code style enforcement failed" 
            })
            this.broadcastTask(task.id)
            return
          }
        }
        
        if (task.autoCommit) {
          yield* this.runCommitPrompt(task.id, task, options, worktreeInfo!, taskContainer)
        }
        
        // Complete worktree
        yield* this.worktree.complete(worktreeInfo!.directory, {
          branch: worktreeInfo!.branch,
          targetBranch,
          shouldMerge: true,
          shouldRemove: task.deleteWorktree !== false,
        }).pipe(...)
        
        this.db.updateTask(task.id, {
          status: "done",
          completedAt: nowUnix(),
          worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo!.directory,
          executionPhase: task.planmode ? "implementation_done" : undefined,
          containerId: null,
          containerName: null,
        })
        this.broadcastTask(task.id)
      })
      
      // Execute with guaranteed cleanup
      const executeWithHandling = executeMain.pipe(
        Effect.catchAll((error) => {
          // ... error handling ...
        }),
        Effect.ensuring(
          // DESTROY TASK CONTAINER - always runs
          Effect.gen(this, function* () {
            yield* this.taskContainerManager.destroyTaskContainer(task.id)
            this.activeWorktreeInfo = null
            this.activeTask = null
          })
        )
      )
      
      return yield* executeWithHandling
    })
  }
  
  // All session methods updated to use task container
  
  private runStandardExecution(
    taskId: string,
    task: Task,
    options: Options,
    worktreeInfo: WorktreeInfo,
    taskContainer: TaskContainer
  ): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const session = this.db.createWorkflowSession({
        id: randomUUID().slice(0, 8),
        taskId: task.id,
        sessionKind: "task",
        status: "active",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: task.executionModel !== "default" ? task.executionModel : options.executionModel,
        startedAt: nowUnix(),
      })
      
      const prompt = this.db.renderPrompt("execution", 
        buildExecutionVariables(task, options, worktreeInfo.directory))
      
      // Send via task container
      yield* this.taskContainerManager.sendPrompt(
        task.id,
        session.id,
        prompt.renderedText
      ).pipe(...)
      
      // Collect response
      const events = yield* this.taskContainerManager.collectEvents(
        task.id,
        session.id,
        600_000
      ).pipe(...)
      
      // Process events...
      
      this.db.updateWorkflowSession(session.id, {
        status: "completed",
        finishedAt: nowUnix(),
      })
    })
  }
  
  private runReviewLoop(
    taskId: string,
    options: Options,
    worktreeInfo: WorktreeInfo,
    taskContainer: TaskContainer
  ): Effect.Effect<boolean, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      // ... setup ...
      
      while (state.reviewCount < maxRuns) {
        // Review phase - uses full context from execution
        const reviewSession = this.db.createWorkflowSession({
          sessionKind: "task_run_reviewer",
          // ...
        })
        
        yield* this.taskContainerManager.sendPrompt(
          taskId,
          reviewSession.id,
          reviewPrompt
        )
        
        const reviewEvents = yield* this.taskContainerManager.collectEvents(
          taskId, 
          reviewSession.id, 
          600_000
        )
        
        // ... process review result ...
        
        if (reviewResult.status === "pass") {
          return true
        }
        
        // Reset context before fix for cleaner implementation
        yield* this.taskContainerManager.resetContext(taskId)
        
        // Fix phase
        const fixSession = this.db.createWorkflowSession({
          sessionKind: "task",
          // ...
        })
        
        yield* this.taskContainerManager.sendPrompt(
          taskId,
          fixSession.id,
          fixPrompt
        )
        
        const fixEvents = yield* this.taskContainerManager.collectEvents(
          taskId,
          fixSession.id,
          600_000
        )
        
        // Review and fix are now in same context (Pi accumulates both)
      }
    })
  }
  
  // ... similar updates for runPlanMode, runCodeStyleCheck, runCommitPrompt ...
  
  private pauseSession(
    sessionId: string,
    activeProcess: { 
      taskId: string
      session: PiWorkflowSession
    }
  ): Effect.Effect<PausedSessionState | null, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      const session = this.db.getWorkflowSession(sessionId)
      if (!session) return null
      
      const task = session.taskId ? this.db.getTask(session.taskId) : null
      if (!task?.containerId) return null
      
      // PAUSE the task container (don't kill)
      yield* this.taskContainerManager.pauseTaskContainer(task.id).pipe(
        Effect.mapError((cause) => this.toOperationError("pauseTaskContainer", cause))
      )
      
      // Create paused state with container info
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
        containerId: task.containerId,
        containerName: task.containerName,
        containerImage: this.settings?.workflow?.container?.image || null,
        piSessionId: session.piSessionId,
        piSessionFile: session.piSessionFile,
        executionPhase: task?.executionPhase || null,
        pauseReason: "user_pause",
        context: {
          agentOutputSnapshot: task.agentOutput || null,
          pendingToolCalls: null,
          reviewCount: task.reviewCount || 0,
        },
      }
      
      this.db.updateWorkflowSession(sessionId, { status: "paused" })
      
      this.broadcast({ 
        type: "session_status_changed", 
        payload: { sessionId, status: "paused", taskId: session.taskId }
      })
      
      return pausedState
    })
  }
  
  private resumeTaskExecution(
    task: Task,
    pausedState: PausedSessionState,
    taskContainer: TaskContainer
  ): Effect.Effect<void, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      // Resume the task container
      yield* this.taskContainerManager.resumeTaskContainer(task.id).pipe(
        Effect.mapError((cause) => this.toOperationError("resumeTaskContainer", cause))
      )
      
      // Build continuation prompt
      const agentOutputSnapshot = pausedState.context?.agentOutputSnapshot ?? task.agentOutput ?? ""
      const continuePrompt = renderPromptTemplate(
        joinPrompt(PROMPT_CATALOG.resumeTaskContinuationPromptLines),
        { agent_output_snapshot: agentOutputSnapshot.slice(-2000) }
      )
      
      // Create new session for resume
      const session = this.db.createWorkflowSession({
        id: randomUUID().slice(0, 8),
        taskId: task.id,
        sessionKind: pausedState.sessionKind,
        status: "active",
        cwd: pausedState.cwd ?? pausedState.worktreeDir ?? "",
        worktreeDir: pausedState.worktreeDir,
        branch: pausedState.branch,
        model: pausedState.model,
        thinkingLevel: pausedState.thinkingLevel ?? undefined,
        startedAt: nowUnix(),
        resumedFromSessionId: pausedState.sessionId,
      })
      
      // Send continuation via task container
      yield* this.taskContainerManager.sendPrompt(
        task.id,
        session.id,
        continuePrompt
      ).pipe(...)
      
      // Collect response
      const events = yield* this.taskContainerManager.collectEvents(
        task.id,
        session.id,
        600_000
      ).pipe(...)
      
      // Process events...
      
      this.activeSessionProcesses.delete(session.id)
    })
  }
  
  // Emergency stop - kill all task containers
  emergencyStop(): Effect.Effect<number, OrchestratorOperationError> {
    return Effect.gen(this, function* () {
      // Get all active runs
      const activeRuns = this.db.getWorkflowRuns().filter(
        run => run.status === "running" || run.status === "queued" || run.status === "paused"
      )
      
      let killed = 0
      
      for (const run of activeRuns) {
        for (const taskId of run.taskOrder) {
          const task = this.db.getTask(taskId)
          if (task?.containerId) {
            yield* this.taskContainerManager.destroyTaskContainer(taskId).pipe(
              Effect.catchAll(() => Effect.void)
            )
            killed++
          }
        }
      }
      
      yield* Effect.logInfo(`[orchestrator] Emergency stop killed ${killed} task containers`)
      
      return killed
    })
  }
}
```

## Best-of-N with Task Containers

```typescript
// src/runtime/best-of-n.ts

export class BestOfNRunner {
  run(task: Task, options: Options): Effect.Effect<void, BestOfNError> {
    return Effect.gen(this, function* () {
      // Each worker gets its own task container
      // (parallel execution requires isolated containers)
      
      const workerContainers = new Map<string, TaskContainer>()
      
      // Create containers for each worker
      for (const workerConfig of task.bestOfNConfig!.workers) {
        for (let i = 0; i < workerConfig.count; i++) {
          const workerId = `${task.id}-worker-${workerConfig.model}-${i}`
          
          const container = yield* this.taskContainerManager.createTaskContainer({
            taskId: workerId,
            worktreeDir: worktreeInfo.directory, // Same worktree for all
            imageName: resolveContainerImage(task, this.settings?.workflow?.container?.image),
          })
          
          workerContainers.set(workerId, container)
        }
      }
      
      // Run workers in parallel
      const workerResults = yield* Effect.all(
        Array.from(workerContainers.entries()).map(([workerId, container]) =>
          this.runWorker(workerId, task, container, options)
        ),
        { mode: "either" }
      )
      
      // Reviewers can share containers with their respective workers
      // (reviewer runs after worker in same container)
      
      // Final applier uses winning worker's container
      const winningWorker = this.selectWinningWorker(workerResults)
      const winningContainer = workerContainers.get(winningWorker.id)!
      
      yield* this.runFinalApplier(task, winningContainer, options)
      
      // Cleanup all worker containers
      for (const [workerId, container] of workerContainers) {
        yield* this.taskContainerManager.destroyTaskContainer(workerId).pipe(
          Effect.catchAll(() => Effect.void)
        )
      }
    })
  }
  
  private runWorker(
    workerId: string,
    task: Task,
    container: TaskContainer,
    options: Options
  ): Effect.Effect<WorkerResult, BestOfNError> {
    return Effect.gen(this, function* () {
      // Send worker prompt via container
      yield* this.taskContainerManager.sendPrompt(
        workerId,
        `${workerId}-session`,
        workerPrompt
      )
      
      // Collect result
      const events = yield* this.taskContainerManager.collectEvents(
        workerId,
        `${workerId}-session`,
        600_000
      )
      
      // Run reviewer in same container (shares context with worker)
      yield* this.taskContainerManager.sendPrompt(
        workerId,
        `${workerId}-review`,
        reviewerPrompt
      )
      
      const reviewEvents = yield* this.taskContainerManager.collectEvents(
        workerId,
        `${workerId}-review`,
        300_000
      )
      
      return { workerId, events, reviewEvents, container }
    })
  }
}
```

## Cleanup on System Shutdown

```typescript
// src/index.ts or server shutdown handler

process.on("SIGTERM", () => {
  // Cleanup all task containers
  orchestrator.emergencyStop().pipe(
    Effect.runPromise
  ).then(() => {
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  orchestrator.emergencyStop().pipe(
    Effect.runPromise
  ).then(() => {
    process.exit(0)
  })
})
```

## Migration Notes

### Code to Remove

The following session-per-container code paths are **deleted**:

1. **`ContainerPiProcess`** - Replaced by TaskContainerManager
2. **`PiSessionManager.executePrompt`** - Replaced by TaskContainerManager.sendPrompt/collectEvents
3. **`sessionManager` references in orchestrator** - Use `taskContainerManager` instead
4. **`existingContainerId` in ExecuteSessionPromptInput** - No longer needed
5. **Container-per-session logic in `executeTaskEffect`** - Replaced with mandatory task container creation

### Code to Keep (Modified)

1. **`PiWorkflowSession`** - Still used for tracking/logging, but no longer owns the container
2. **Session messages database** - Still records all Pi events
3. **Pause/resume state** - Still persists, but stores containerId instead of creating new on resume
4. **Worktree lifecycle** - Unchanged

### Guarantees

The system now guarantees:

1. **Exactly one container per task** - Created at task start, destroyed at task end
2. **Shared Pi process** - All sessions use the same Pi process via socket communication
3. **Full context accumulation** - Pi maintains conversation history across all phases
4. **Pause preserves container** - Container stays alive during pause, resumed on continue
5. **Emergency cleanup** - All task containers killed on emergency stop
6. **No fallbacks** - No code paths exist for session-per-container mode

## Testing Requirements

1. Verify exactly one container created per task
2. Verify container destroyed after task completes (success or failure)
3. Verify pause/resume keeps same container
4. Verify Pi process maintains state between sessions
5. Verify emergency stop kills all task containers
6. Verify Best-of-N creates N containers (one per parallel worker)
7. Verify review loop shares Pi process with execution
8. Verify context reset works between review phases

---

**Summary**: One container per task. Always. No flags. No fallbacks. The system guarantees this through the TaskContainerManager which is the sole interface for container operations in the orchestrator.
