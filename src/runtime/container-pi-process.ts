import { Effect, Fiber, Scope } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import {
  PiContainerManager,
  type ContainerConfig,
  type ContainerProcess,
} from "./container-manager.ts"
import { BASE_IMAGES } from "../config/base-images.ts"
import { projectPiEventToSessionMessage } from "./message-projection.ts"
import { MessageStreamer } from "./message-streamer.ts"
import type { PiEventListener, ExtensionUIRequestHandler } from "./pi-process.ts"
import { PiProcessError, CollectEventsTimeoutError } from "./pi-process.ts"
import type { PiRpcRequest, PiRpcResponse } from "./pi-rpc.ts"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pullResponseText(result: Record<string, unknown>): string {
  if (typeof result.text === "string") return result.text
  if (typeof result.output === "string") return result.output
  const message = result.message
  if (typeof message === "string") return message
  if (message && typeof message === "object") {
    const messageText = (message as Record<string, unknown>).text
    if (typeof messageText === "string") return messageText
  }
  return ""
}

/**
 * ContainerPiProcess - Docker/gVisor backed Pi process implementation.
 *
 * This backend runs the pi agent inside a gVisor container for isolation:
 * - Filesystem isolation: Can only access worktree and repo (read-only)
 * - Port isolation: Runs in separate network namespace
 * - Security: Drops all capabilities, no new privileges
 */
export class ContainerPiProcess {
  private readonly db: PiKanbanDB
  private readonly session: PiWorkflowSession
  private readonly containerManager: PiContainerManager
  private readonly onOutput?: (chunk: string) => void
  private readonly onSessionMessage?: (
    message: import("../types.ts").SessionMessage,
  ) => void
  private readonly settings?: InfrastructureSettings
  private readonly disableAutoSessionMessages: boolean
  private readonly systemPrompt?: string

  private containerProcess: ContainerProcess | null = null
  private requestId = 0
  private readonly pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
    }
  >()
  private readonly eventListeners = new Set<PiEventListener>()
  private extensionUIHandler: ExtensionUIRequestHandler | null = null
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private isIdle = true
  private abortController: AbortController | null = null
  private existingContainerId: string | null = null
  private containerImage: string | null = null
  private messageStreamer: MessageStreamer | null = null

  constructor(args: {
    db: PiKanbanDB
    session: PiWorkflowSession
    containerManager: PiContainerManager
    onOutput?: (chunk: string) => void
    onSessionMessage?: (message: import("../types.ts").SessionMessage) => void
    settings?: InfrastructureSettings
    systemPrompt?: string
    disableAutoSessionMessages?: boolean
    existingContainerId?: string | null
    containerImage?: string | null
  }) {
    this.db = args.db
    this.disableAutoSessionMessages = args.disableAutoSessionMessages ?? false
    this.session = args.session
    this.containerManager = args.containerManager
    this.onOutput = args.onOutput
    this.onSessionMessage = args.onSessionMessage
    this.settings = args.settings
    this.systemPrompt = args.systemPrompt
    this.existingContainerId = args.existingContainerId ?? null
    this.containerImage = args.containerImage ?? null

    if (!this.disableAutoSessionMessages) {
      this.messageStreamer = new MessageStreamer(
        this.db,
        this.session.id,
        this.session.taskId,
        this.session.taskRunId,
        this.onSessionMessage
      )
    }
  }

  /**
   * Start the containerized pi process.
   */
  start(): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      if (this.containerProcess) return yield* Effect.void

      // Determine container configuration from settings or resume parameters
      const containerSettings = this.settings?.workflow?.container
      // Use containerImage from resume if provided, otherwise fall back to settings
      const imageName = this.containerImage || containerSettings?.image || BASE_IMAGES.piAgent
      const memoryMb = containerSettings?.memoryMb || 512
      const cpuCount = containerSettings?.cpuCount || 1

      const worktreeDir = this.session.worktreeDir
      if (!worktreeDir) {
        return yield* new PiProcessError({
          operation: "start",
          message: "ContainerPiProcess requires a worktree directory",
        })
      }

      const repoRoot = worktreeDir.replace(/\/\.worktrees\/[^/]+$/, "")

      // Check if we have an existing container to reuse (for resume operations)
      if (this.existingContainerId) {
        const containerInfo = yield* Effect.tryPromise({
          try: () => this.containerManager.checkContainerById(this.existingContainerId!),
          catch: (cause) => new PiProcessError({
            operation: "start",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        })

        if (containerInfo?.running) {
          console.log(`[container-pi-process] Attaching to existing container ${this.existingContainerId}`)
          // Try to attach to the existing container to preserve all state
          const attachedProcess = yield* Effect.tryPromise({
            try: () => this.containerManager.attachToContainer(
              this.existingContainerId!,
              this.session.id
            ),
            catch: (cause) => new PiProcessError({
              operation: "start",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
          })

          if (attachedProcess) {
            this.containerProcess = attachedProcess
            console.log(`[container-pi-process] Successfully attached to container ${this.existingContainerId}`)

            this.db.updateWorkflowSession(this.session.id, {
              status: "active",
            })

            this.abortController = new AbortController()
            this.captureStdout()
            this.captureStderr()

            yield* Effect.sleep("1 second")
            return yield* Effect.void
          } else {
            console.log(`[container-pi-process] Failed to attach to container ${this.existingContainerId}, will create new one`)
          }
        } else {
          console.log(`[container-pi-process] Existing container ${this.existingContainerId} not running, creating new one`)
        }
      }

      const containerConfig: ContainerConfig = {
        sessionId: this.session.id,
        worktreeDir,
        repoRoot,
        imageName,
        memoryMb,
        cpuCount,
        env: {},
        useMockLLM: process.env.USE_MOCK_LLM === 'true',
        mountPodmanSocket: containerSettings?.mountPodmanSocket ?? false,
      }

      this.containerProcess = yield* Effect.tryPromise({
        try: () => this.containerManager.createContainer(containerConfig),
        catch: (cause) => new PiProcessError({
          operation: "start",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      this.db.updateWorkflowSession(this.session.id, {
        status: "active",
      })

      this.abortController = new AbortController()

      this.captureStdout()
      this.captureStderr()
    })
  }

  /**
   * Subscribe to agent events.
   */
  subscribeEvents(listener: PiEventListener): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        this.eventListeners.add(listener)
      }),
      () =>
        Effect.sync(() => {
          this.eventListeners.delete(listener)
        }),
    )
  }

  /**
   * Set handler for extension UI requests.
   */
  setExtensionUIHandler(handler: ExtensionUIRequestHandler): void {
    this.extensionUIHandler = handler
  }

  /**
   * Send a command and wait for response.
   */
  send(
    command: { type: string } & Record<string, unknown>,
    timeoutMs = 30_000,
  ): Effect.Effect<Record<string, unknown>, PiProcessError> {
    return Effect.gen(this, function* () {
      if (!this.containerProcess) {
        return yield* new PiProcessError({
          operation: "send",
          message: "Container process not started",
        })
      }

      const id = `req_${++this.requestId}`
      const payload: PiRpcRequest = { ...command, id }
      const line = `${JSON.stringify(payload)}\n`

      // Write to container stdin
      const writer = this.containerProcess.stdin.getWriter()
      yield* Effect.try({
        try: () => writer.write(new TextEncoder().encode(line)),
        catch: (cause) => new PiProcessError({
          operation: "send",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })
      writer.releaseLock()

      if (
        command.type === "prompt" ||
        command.type === "steer" ||
        command.type === "follow_up"
      ) {
        this.isIdle = false
      }

      return yield* Effect.async<Record<string, unknown>, PiProcessError>((resume) => {
        this.pending.set(id, {
          resolve: (value) => resume(Effect.succeed(value)),
          reject: (error) => resume(Effect.fail(new PiProcessError({
            operation: "send",
            message: error.message,
            cause: error,
          }))),
        })
        return Effect.sync(() => {
          this.pending.delete(id)
        })
      }).pipe(
        Effect.timeoutFail({
          duration: timeoutMs,
          onTimeout: () => new PiProcessError({
            operation: "send",
            message: `Pi RPC timeout for command ${command.type}`,
          }),
        }),
      )
    })
  }

  /**
   * Send a prompt (returns immediately, use onEvent/waitForIdle for results).
   */
  prompt(message: string): Effect.Effect<void, PiProcessError> {
    return this.send({ type: "prompt", message }, 60_000)
  }

  /**
   * Wait for agent to become idle.
   */
  waitForIdle(timeoutMs = 600_000): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      if (this.isIdle) {
        return yield* Effect.void
      }

      return yield* Effect.scoped(
        Effect.async<void, PiProcessError>((resume) => {
          const listener: PiEventListener = (event) => {
            if (event.type === "agent_end") {
              this.isIdle = true
              resume(Effect.void)
            } else if (event.type === "process_killed") {
              const signal = (event as Record<string, unknown>).signal
              resume(Effect.fail(new PiProcessError({
                operation: "waitForIdle",
                message: `Container process was killed (${signal || "SIGKILL"}) while waiting for idle`,
              })))
            }
          }

          this.eventListeners.add(listener)
          return Effect.sync(() => {
            this.eventListeners.delete(listener)
          })
        }).pipe(
          Effect.timeoutFail({
            duration: timeoutMs,
            onTimeout: () => new PiProcessError({
              operation: "waitForIdle",
              message: "Timeout waiting for agent to become idle",
            }),
          }),
        ),
      )
    })
  }

  /**
   * Collect all events until agent becomes idle.
   */
  collectEvents(timeoutMs = 600_000): Effect.Effect<Record<string, unknown>[], PiProcessError | CollectEventsTimeoutError> {
    return Effect.gen(this, function* () {
      const events: Record<string, unknown>[] = []

      return yield* Effect.scoped(
        Effect.async<Record<string, unknown>[], PiProcessError | CollectEventsTimeoutError>((resume) => {
          const listener: PiEventListener = (event) => {
            events.push(event)
            if (event.type === "agent_end") {
              this.isIdle = true
              resume(Effect.succeed(events))
            } else if (event.type === "process_killed") {
              const signal = (event as Record<string, unknown>).signal
              resume(Effect.fail(new PiProcessError({
                operation: "collectEvents",
                message: `Container process was killed (${signal || "SIGKILL"}) while collecting events`,
              })))
            }
          }

          this.eventListeners.add(listener)
          return Effect.sync(() => {
            this.eventListeners.delete(listener)
          })
        }).pipe(
          Effect.timeoutFail({
            duration: timeoutMs,
            onTimeout: () => new CollectEventsTimeoutError({
              message: `Timeout collecting events after ${timeoutMs}ms (collected ${events.length} events)`,
              collectedEvents: events,
              originalTimeoutMs: timeoutMs,
            }),
          }),
        ),
      )
    })
  }

  /**
   * Send prompt and wait for completion.
   */
  promptAndWait(
    message: string,
    timeoutMs = 600_000,
  ): Effect.Effect<Record<string, unknown>[], PiProcessError | CollectEventsTimeoutError> {
    return Effect.gen(this, function* () {
      const eventsFiber = yield* this.collectEvents(timeoutMs).pipe(Effect.fork)
      return yield* this.prompt(message).pipe(
        Effect.zipRight(Fiber.join(eventsFiber)),
        Effect.tapError(() => Fiber.interrupt(eventsFiber)),
      )
    })
  }

  /**
   * Close the container process.
   */
  close(): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      if (!this.containerProcess) return yield* Effect.void

      const process = this.containerProcess
      this.containerProcess = null

      // Signal stream readers to stop
      if (this.abortController) {
        this.abortController.abort()
        this.abortController = null
      }

      // Reject all pending requests
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(
          new Error(`Container process closed before RPC response (${id})`),
        )
        this.pending.delete(id)
      }

      // Kill container
      yield* Effect.tryPromise({
        try: () => process.kill(),
        catch: (cause) => new PiProcessError({
          operation: "close",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      yield* Effect.try({
        try: () => this.db.updateWorkflowSession(this.session.id, {
          status: "completed",
          finishedAt: Math.floor(Date.now() / 1000),
        }),
        catch: (cause) => new PiProcessError({
          operation: "close",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })
    })
  }

  /**
   * Force kill the container immediately without waiting for graceful shutdown.
   * Used for emergency stop and destructive operations.
   */
  forceKill(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      if (!this.containerProcess) return yield* Effect.void

      const process = this.containerProcess
      this.containerProcess = null

      // Signal stream readers to stop
      if (this.abortController) {
        this.abortController.abort()
        this.abortController = null
      }

      // Reject all pending requests immediately
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error(`Container process force killed (${id})`))
        this.pending.delete(id)
      }

      // Notify all event listeners that the process is being killed
      const killEvent = { type: "process_killed", signal, timestamp: Date.now() }
      for (const listener of this.eventListeners) {
        try {
          listener(killEvent)
        } catch (err) {
          console.error(`[container-pi-process] Error in event listener during force kill:`, err)
        }
      }
      this.eventListeners.clear()

      // Force kill the container
      yield* Effect.tryPromise({
        try: () => process.kill(),
        catch: (cause) => new PiProcessError({
          operation: "forceKill",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      // Don't wait for exit - force kill is immediate
      yield* Effect.try({
        try: () => this.db.updateWorkflowSession(this.session.id, {
          status: "aborted",
          finishedAt: Math.floor(Date.now() / 1000),
          exitCode: -1,
          exitSignal: signal,
        }),
        catch: (cause) => new PiProcessError({
          operation: "forceKill",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })
    })
  }

  /**
   * Get the container ID for this process.
   * Used for pause/resume operations.
   */
  getContainerId(): Effect.Effect<string | null, PiProcessError> {
    return Effect.sync(() => this.containerProcess?.containerId ?? null)
  }

  private captureStdout(): void {
    if (!this.containerProcess || !this.abortController) return

    const reader = this.containerProcess.stdout.getReader()
    const decoder = new TextDecoder()
    const signal = this.abortController.signal

    const loop = async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done || signal.aborted) break
          this.stdoutBuffer += decoder.decode(value, { stream: true })
          this.consumeStdoutLines()
        }
        if (this.stdoutBuffer.trim() && !signal.aborted) {
          this.handleStdoutLine(this.stdoutBuffer.trim())
          this.stdoutBuffer = ""
        }
      } finally {
        reader.releaseLock()
      }
    }

    void loop()
  }

  private consumeStdoutLines(): void {
    while (true) {
      const newlineIdx = this.stdoutBuffer.indexOf("\n")
      if (newlineIdx < 0) break
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1)
      if (!line) continue
      this.handleStdoutLine(line)
    }
  }

  private async handleStdoutLine(line: string): Promise<void> {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not JSON, treat as text event
      parsed = { type: "text", text: line }
    }

    const id = typeof parsed.id === "string" ? parsed.id : null
    const isResponse = parsed.type === "response" && id !== null
    const isExtensionUIRequest =
      parsed.type === "extension_ui_request" && id !== null

    if (isResponse && id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)

      const response = parsed as unknown as PiRpcResponse
      if (response.success === false) {
        const errorMsg =
          typeof response.error === "string"
            ? response.error
            : JSON.stringify(response.error)
        pending.reject(new Error(errorMsg))
      } else {
        pending.resolve(asRecord(response.data))
      }
      return
    }

    if (isExtensionUIRequest && this.extensionUIHandler) {
      try {
        const response = await Effect.runPromise(this.extensionUIHandler(
          parsed as { id: string; method: string; [key: string]: unknown },
        ))
        await Effect.runPromise(this.send(response, 10_000))
      } catch (err) {
        console.error(`[container-pi-process] Extension UI handler failed:`, err)
        // Send cancelled response if handler fails
        try {
          await Effect.runPromise(this.send(
            {
              type: "extension_ui_response",
              id: parsed.id,
              cancelled: true,
            },
            10_000,
          ))
        } catch (sendErr) {
          console.error(`[container-pi-process] Failed to send cancelled response:`, sendErr)
        }
      }
      return
    }

    // Broadcast to event listeners
    for (const listener of this.eventListeners) {
      try {
        listener(parsed)
      } catch (err) {
        console.error(`[container-pi-process] Error in event listener:`, err)
      }
    }

    // Project to session messages (unless disabled)
    if (!this.disableAutoSessionMessages) {
      const isStreamEvent = this.messageStreamer?.handleEvent(parsed) ?? false

      if (!isStreamEvent) {
        const message = projectPiEventToSessionMessage({
          event: parsed,
          sessionId: this.session.id,
          taskId: this.session.taskId,
          taskRunId: this.session.taskRunId,
        })
        if (message.contentJson && Object.keys(message.contentJson).length > 0) {
          // Use MessageStreamer's seq counter to ensure consistent sequencing
          // and avoid UNIQUE constraint violations with streaming messages
          const seq = this.messageStreamer?.getNextSeq()
          const createdMessage = this.db.createSessionMessage({
            ...message,
            seq,
          })
          if (createdMessage && this.onSessionMessage) {
            this.onSessionMessage(createdMessage)
          }
        }
      }
    }

    // Output handling
    const text = pullResponseText(parsed)
    if (text && this.onOutput) {
      this.onOutput(text)
    }
  }

  private captureStderr(): void {
    if (!this.containerProcess || !this.abortController) return

    const reader = this.containerProcess.stderr.getReader()
    const decoder = new TextDecoder()
    const signal = this.abortController.signal

    const loop = async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done || signal.aborted) break
          this.stderrBuffer += decoder.decode(value, { stream: true })
          this.consumeStderrLines()
        }
        if (this.stderrBuffer.trim() && !signal.aborted) {
          this.stderrBuffer = ""
        }
      } finally {
        reader.releaseLock()
      }
    }

    void loop()
  }

  private consumeStderrLines(): void {
    while (true) {
      const newlineIdx = this.stderrBuffer.indexOf("\n")
      if (newlineIdx < 0) break
      const line = this.stderrBuffer.slice(0, newlineIdx).trim()
      this.stderrBuffer = this.stderrBuffer.slice(newlineIdx + 1)
      if (!line) continue
    }
  }
}
