import { mkdirSync } from "fs"
import { dirname } from "path"
import { Effect, Fiber, Schema, Scope } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { SessionMessage } from "../types.ts"
import { projectPiEventToSessionMessage } from "./message-projection.ts"
import { MessageStreamer } from "./message-streamer.ts"

export type PiEventListener = (event: Record<string, unknown>) => void

/**
 * Tagged error for Pi process operations
 */
export class PiProcessError extends Schema.TaggedError<PiProcessError>()("PiProcessError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error thrown when collectEvents times out but has partial events collected.
 * The orchestrator can use these events to determine if the task was "essentially complete".
 */
export class CollectEventsTimeoutError extends Schema.TaggedError<CollectEventsTimeoutError>()("CollectEventsTimeoutError", {
  message: Schema.String,
  collectedEvents: Schema.Array(Schema.Unknown),
  originalTimeoutMs: Schema.Number,
}) {}
export type ExtensionUIRequestHandler = (request: {
  id: string
  method: string
  [key: string]: unknown
}) => Effect.Effect<{ type: "extension_ui_response"; id: string } & Record<string, unknown>, PiProcessError>

type Pending = {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
}

function parseArgs(value: string): string[] {
  return value
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean)
}

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
 * PiRpcProcess - Event-driven RPC client for pi CLI
 *
 * Architecture:
 * - Commands sent with unique string IDs
 * - Responses match commands by ID
 * - Events stream asynchronously (messages, tool calls, UI requests)
 * - Completion detected via agent_end event (not polling)
 * - Interactive UI via extension_ui_request/response
 */
export class PiRpcProcess {
  private readonly db: PiKanbanDB
  private readonly session: PiWorkflowSession
  private readonly onOutput?: (chunk: string) => void
  private readonly onSessionMessage?: (message: SessionMessage) => void
  private readonly settings?: InfrastructureSettings
  private readonly systemPrompt?: string
  private readonly disableAutoSessionMessages: boolean
  private readonly piSessionFile?: string
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
  private requestId = 0
  private readonly pending = new Map<string, Pending>()
  private readonly eventListeners = new Set<PiEventListener>()
  private extensionUIHandler: ExtensionUIRequestHandler | null = null
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private isIdle = true
  private abortController: AbortController | null = null
  private messageStreamer: MessageStreamer | null = null

  constructor(args: {
    db: PiKanbanDB
    session: PiWorkflowSession
    onOutput?: (chunk: string) => void
    onSessionMessage?: (message: SessionMessage) => void
    settings?: InfrastructureSettings
    systemPrompt?: string
    disableAutoSessionMessages?: boolean
    piSessionFile?: string
  }) {
    this.db = args.db
    this.disableAutoSessionMessages = args.disableAutoSessionMessages ?? false
    this.session = args.session
    this.onOutput = args.onOutput
    this.onSessionMessage = args.onSessionMessage
    this.settings = args.settings
    this.systemPrompt = args.systemPrompt
    this.piSessionFile = args.piSessionFile ?? args.session.piSessionFile ?? undefined

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

  start(): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      if (this.proc) return yield* Effect.void

      const piBin = this.settings?.workflow?.container?.piBin?.trim() || "pi"
      const configuredArgs = this.settings?.workflow?.container?.piArgs
        ? parseArgs(this.settings.workflow.container.piArgs)
        : ["--mode", "rpc"]

      const args = [...configuredArgs]
      if (this.systemPrompt) {
        args.push("--system-prompt", this.systemPrompt)
      }

      if (this.piSessionFile) {
        const sessionFile = this.piSessionFile
        yield* Effect.try({
          try: () => mkdirSync(dirname(sessionFile), { recursive: true }),
          catch: (cause) => new PiProcessError({
            operation: "start",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        })
        args.push("--session", sessionFile)
      }

      this.proc = Bun.spawn({
        cmd: [piBin, ...args],
        cwd: this.session.cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        env: { ...process.env, PI_CODING_AGENT: "true" },
      })

      yield* Effect.try({
        try: () => this.db.updateWorkflowSession(this.session.id, {
          status: "active",
          processPid: this.proc!.pid,
        }),
        catch: (cause) => new PiProcessError({
          operation: "start",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      this.abortController = new AbortController()

      this.captureStdout()
      this.captureStderr()
    })
  }

  /**
   * Subscribe to agent events
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
   * Returns true if the underlying process has already exited (or was never started).
   */
  hasExited(): boolean {
    if (!this.proc) return true
    return this.proc.exitCode !== null
  }

  /**
   * Set handler for extension UI requests (interactive prompts)
   */
  setExtensionUIHandler(handler: ExtensionUIRequestHandler): void {
    this.extensionUIHandler = handler
  }

  /**
   * Send a command and wait for response
   */
  send(command: { type: string } & Record<string, unknown>, timeoutMs = 30_000): Effect.Effect<Record<string, unknown>, PiProcessError> {
    return Effect.gen(this, function* () {
      if (!this.proc) {
        return yield* new PiProcessError({
          operation: "send",
          message: "Pi process not started",
        })
      }

      const id = `req_${++this.requestId}`
      const payload = { ...command, id }
      const line = `${JSON.stringify(payload)}\n`

      // Write to stdin with a timeout
      const writeTimeoutMs = Math.min(5_000, timeoutMs)
      yield* Effect.tryPromise({
        try: async () => {
          await this.proc!.stdin.write(line)
        },
        catch: (cause) => new PiProcessError({
          operation: "send",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      }).pipe(
        Effect.timeoutFail({
          duration: writeTimeoutMs,
          onTimeout: () => new PiProcessError({
            operation: "send",
            message: `Stdin write timeout for command ${command.type}`,
          }),
        }),
      )

      if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
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
   * Send a prompt (returns immediately, use onEvent/waitForIdle for results)
   */
  prompt(message: string): Effect.Effect<void, PiProcessError> {
    return this.send({ type: "prompt", message }, 60_000)
  }

  /**
   * Wait for agent to become idle (no streaming)
   * Resolves when agent_end event is received
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
                message: `Process was killed (${signal || "SIGKILL"}) while waiting for idle`,
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
   * Collect all events until agent becomes idle
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
                message: `Process was killed (${signal || "SIGKILL"}) while collecting events`,
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
   * Send prompt and wait for completion
   */
  promptAndWait(message: string, timeoutMs = 600_000): Effect.Effect<Record<string, unknown>[], PiProcessError | CollectEventsTimeoutError> {
    return Effect.gen(this, function* () {
      const eventsFiber = yield* this.collectEvents(timeoutMs).pipe(Effect.fork)
      return yield* this.prompt(message).pipe(
        Effect.zipRight(Fiber.join(eventsFiber)),
        Effect.tapError(() => Fiber.interrupt(eventsFiber)),
      )
    })
  }

  close(): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      if (!this.proc) return yield* Effect.void

      const proc = this.proc
      this.proc = null

      // Signal stream readers to stop
      if (this.abortController) {
        this.abortController.abort()
        this.abortController = null
      }

      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error(`Pi process closed before RPC response (${id})`))
        this.pending.delete(id)
      }

      try {
        proc.kill()
      } catch (err) {
        console.error(`[pi-process] Error killing process during close:`, err)
      }

      const exitCode = yield* Effect.tryPromise({
        try: () => proc.exited,
        catch: (cause) => new PiProcessError({
          operation: "close",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      this.db.updateWorkflowSession(this.session.id, {
        status: exitCode === 0 ? "completed" : "failed",
        finishedAt: Math.floor(Date.now() / 1000),
        exitCode,
      })
    })
  }

  /**
   * Force kill the process immediately without waiting for graceful shutdown.
   * Used for emergency stop and destructive operations.
   */
  forceKill(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): Effect.Effect<void, PiProcessError> {
    return Effect.gen(this, function* () {
      if (!this.proc) return yield* Effect.void

      const proc = this.proc
      this.proc = null

      // Signal stream readers to stop
      if (this.abortController) {
        this.abortController.abort()
        this.abortController = null
      }

      // Reject all pending requests immediately
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error(`Pi process force killed (${id})`))
        this.pending.delete(id)
      }

      // Notify all event listeners that the process is being killed
      const killEvent = { type: "process_killed", signal, timestamp: Date.now() }
      for (const listener of this.eventListeners) {
        try {
          listener(killEvent)
        } catch (err) {
          console.error(`[pi-process] Error in event listener during force kill:`, err)
        }
      }
      this.eventListeners.clear()

      // Force kill the process
      try {
        if (signal === "SIGKILL") {
          proc.kill(9) // SIGKILL
        } else {
          proc.kill(15) // SIGTERM
        }
      } catch (err) {
        console.error(`[pi-process] Error during force kill:`, err)
      }

      // Don't wait for exit - force kill is immediate
      this.db.updateWorkflowSession(this.session.id, {
        status: "aborted",
        finishedAt: Math.floor(Date.now() / 1000),
        exitCode: -1,
        exitSignal: signal,
      })
    })
  }

  /**
   * Get underlying process for direct manipulation.
   * Used for pause/stop operations.
   */
  getProcess(): Bun.Subprocess<"pipe", "pipe", "pipe"> | null {
    return this.proc
  }

  private captureStdout(): void {
    if (!this.proc || !this.abortController) return

    const reader = this.proc.stdout.getReader()
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

  private handleStdoutLine(line: string): void {
    void Effect.runPromise(
      this.handleStdoutLineEffect(line).pipe(
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError(`[pi-process] Failed to handle stdout line`)
            yield* Effect.logError(cause)
          })
        )
      )
    )
  }

  private handleStdoutLineEffect(line: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not JSON, treat as text event
      parsed = { type: "text", text: line }
    }

    const id = typeof parsed.id === "string" ? parsed.id : null
    const isResponse = parsed.type === "response" && id !== null
    const isExtensionUIRequest = parsed.type === "extension_ui_request" && id !== null

    if (isResponse && id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)

      if (parsed.success === false) {
        const errorMsg = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error)
        pending.reject(new Error(errorMsg))
      } else {
        pending.resolve(asRecord(parsed.data))
      }
      return
    }

    if (isExtensionUIRequest && this.extensionUIHandler) {
      yield* Effect.catchAll(
        this.extensionUIHandler(parsed as { id: string; method: string; [key: string]: unknown }).pipe(
          Effect.flatMap((response) => this.send(response, 10_000))
        ),
        (error) => Effect.gen(this, function* () {
          yield* Effect.logError(`[pi-process] Extension UI handler failed`)
          yield* Effect.logError(error)
          yield* this.send({
            type: "extension_ui_response",
            id: parsed.id,
            cancelled: true,
          }, 10_000).pipe(
            Effect.catchAll((sendErr) => Effect.gen(function* () {
              yield* Effect.logError(`[pi-process] Failed to send cancelled response`)
              yield* Effect.logError(sendErr)
            }))
          )
        })
      )
      return
    }

    // Broadcast to event listeners
    for (const listener of this.eventListeners) {
      try {
        listener(parsed)
      } catch (err) {
        console.error(`[pi-process] Error in event listener:`, err)
      }
    }

    // Project to session messages (unless disabled for planning sessions)
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

    // Always call onOutput for response text
    const text = pullResponseText(parsed)
    if (text && this.onOutput) {
      this.onOutput(text)
    }
    })
  }

  private captureStderr(): void {
    if (!this.proc || !this.abortController) return

    const reader = this.proc.stderr.getReader()
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
          this.persistStderr(this.stderrBuffer.trim())
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

  private persistStderr(content: string): void {
    if (this.onOutput) {
      this.onOutput(`[stderr] ${content}`)
    }
  }
}
