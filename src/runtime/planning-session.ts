import { randomUUID } from "crypto"
import { join } from "path"
import { Duration, Effect, Exit, Schema, Scope } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { CreateSessionMessageInput, SessionMessage } from "../types.ts"
import { PiProcessError, PiRpcProcess } from "./pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { createPiProcessEffect, type PiRuntimeMode } from "./pi-process-factory.ts"
import { parseModelSelection } from "./model-utils.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Generate a session file path for pi CLI conversation persistence.
 * Stores sessions in .tauroboros/pi-sessions/ directory.
 */
function getSessionFilePath(sessionId: string, cwd: string): string {
  return join(cwd, ".tauroboros", "pi-sessions", `${sessionId}.jsonl`)
}

class PlanningSessionError extends Schema.TaggedError<PlanningSessionError>()("PlanningSessionError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface PlanningSessionInput {
  session: PiWorkflowSession
  systemPrompt: string
  model?: string
  thinkingLevel?: "default" | "low" | "medium" | "high"
  onMessage?: (message: SessionMessage) => void
  onStatusChange?: (session: PiWorkflowSession) => void
  forceRuntime?: PiRuntimeMode
}

export interface SendMessageInput {
  content: string
  contextAttachments?: ContextAttachment[]
}

export interface ContextAttachment {
  type: "file" | "screenshot" | "task"
  name: string
  content?: string
  filePath?: string
  taskId?: string
}

/**
 * Message being built from streaming events
 */
interface StreamingMessageState {
  messageId: string
  seq: number
  timestamp: number
  textBuffer: string
  thinkingBuffer: string
  hasThinking: boolean
  hasText: boolean
  isComplete: boolean
  persistLock: boolean  // Lock to prevent duplicate persistence
}

/**
 * PlanningSession - Manages an ongoing chat session with Pi for planning
 *
 * Unlike PiSessionManager which handles single-prompt execution sessions,
 * PlanningSession maintains a persistent conversation with message history.
 */
export class PlanningSession {
  private process: PiRpcProcess | null = null
  private sessionScope: Scope.CloseableScope | null = null
  private session: PiWorkflowSession
  private db: PiKanbanDB
  private settings?: InfrastructureSettings
  private containerManager?: PiContainerManager
  private recentMessageIds: string[] = []  // Small LRU buffer to prevent duplicate persistence (last 3 messages)
  private onMessage?: (message: SessionMessage) => void
  private onStatusChange?: (session: PiWorkflowSession) => void
  private messageSeq = 0
  private isReady = false
  private streamingState: StreamingMessageState | null = null

  constructor(args: {
    session: PiWorkflowSession
    db: PiKanbanDB
    settings?: InfrastructureSettings
    containerManager?: PiContainerManager
    onMessage?: (message: SessionMessage) => void
    onStatusChange?: (session: PiWorkflowSession) => void
  }) {
    this.session = args.session
    this.db = args.db
    this.settings = args.settings
    this.containerManager = args.containerManager
    this.onMessage = args.onMessage
    this.onStatusChange = args.onStatusChange
  }

  private closeSessionScope(exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const scope = this.sessionScope
      this.sessionScope = null
      this.process = null
      this.isReady = false
      this.streamingState = null

      if (scope) {
        yield* Scope.close(scope, exit)
      }
    })
  }

  private installStreamingSubscription(process: PiRpcProcess): Effect.Effect<void, never, Scope.Scope> {
    return process.subscribeEvents((event) => {
      const eventType = event.type as string

      if (eventType === "message_update") {
        const msgEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
        const msgEventType = msgEvent?.type as string

        if (!msgEventType) return
        if (!msgEvent) return
        if (!this.streamingState) {
          this.messageSeq++
          this.streamingState = {
            messageId: randomUUID(),
            seq: this.messageSeq,
            timestamp: nowUnix(),
            textBuffer: "",
            thinkingBuffer: "",
            hasThinking: false,
            hasText: false,
            isComplete: false,
            persistLock: false,
          }
        }

        const state = this.streamingState

        if (msgEventType === "thinking_delta") {
          const delta = typeof msgEvent.delta === "string" ? msgEvent.delta : ""
          if (delta) {
            state.hasThinking = true
            state.thinkingBuffer += delta

            const thinkingMessage = {
              id: state.seq,
              seq: state.seq,
              messageId: state.messageId,
              sessionId: this.session.id,
              taskId: null,
              taskRunId: null,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_thinking",
              messageType: "thinking",
              contentJson: {
                thinking: state.thinkingBuffer,
                streaming: true,
                isThinking: true,
              },
            } as unknown as SessionMessage
            this.onMessage?.(thinkingMessage)
          }
        }

        if (msgEventType === "text_delta") {
          const delta = typeof msgEvent.delta === "string" ? msgEvent.delta : ""
          if (delta) {
            state.hasText = true
            state.textBuffer += delta

            const textMessage = {
              id: state.seq + 1,
              seq: state.seq + 1,
              messageId: state.messageId + "-text",
              sessionId: this.session.id,
              taskId: null,
              taskRunId: null,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_response",
              messageType: "assistant_response",
              contentJson: {
                text: state.textBuffer,
                streaming: true,
                isThinking: false,
              },
            } as unknown as SessionMessage
            this.onMessage?.(textMessage)
          }
        }

        if (msgEventType === "text_complete") {
          if (state.persistLock) {
            return
          }
          if (!state.hasText || !state.textBuffer) {
            return
          }
          state.persistLock = true

          if (state.hasThinking && state.thinkingBuffer && this.checkAndAddRecentMessageId(state.messageId)) {
            this.messageSeq++
            const thinkingMessageInput: CreateSessionMessageInput = {
              sessionId: this.session.id,
              taskId: null,
              taskRunId: null,
              seq: this.messageSeq,
              messageId: state.messageId,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_thinking",
              messageType: "thinking",
              contentJson: {
                thinking: state.thinkingBuffer,
                streaming: false,
                isThinking: true,
              },
            }
            const persistedThinking = this.db.createSessionMessage(thinkingMessageInput)
            this.onMessage?.(persistedThinking)
          }

          const textMessageId = state.messageId + "-text"
          if (this.checkAndAddRecentMessageId(textMessageId)) {
            this.messageSeq++
            const textMessageInput: CreateSessionMessageInput = {
              sessionId: this.session.id,
              taskId: null,
              taskRunId: null,
              seq: this.messageSeq,
              messageId: textMessageId,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_response",
              messageType: "assistant_response",
              contentJson: {
                text: state.textBuffer,
                streaming: false,
                isThinking: false,
              },
            }
            const persistedText = this.db.createSessionMessage(textMessageInput)
            this.onMessage?.(persistedText)
          }

          this.streamingState = null
        }
      }

      if (eventType === "agent_end" && this.streamingState) {
        const state = this.streamingState

        if (!state.persistLock) {
          state.persistLock = true

          if (state.hasThinking && state.thinkingBuffer && this.checkAndAddRecentMessageId(state.messageId)) {
            this.messageSeq++
            const thinkingMessageInput: CreateSessionMessageInput = {
              sessionId: this.session.id,
              taskId: null,
              taskRunId: null,
              seq: this.messageSeq,
              messageId: state.messageId,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_thinking",
              messageType: "thinking",
              contentJson: {
                thinking: state.thinkingBuffer,
                streaming: false,
                isThinking: true,
              },
            }
            const persistedThinking = this.db.createSessionMessage(thinkingMessageInput)
            this.onMessage?.(persistedThinking)
          }

          const textMessageId = state.messageId + "-text"
          if (state.hasText && state.textBuffer && this.checkAndAddRecentMessageId(textMessageId)) {
            this.messageSeq++
            const textMessageInput: CreateSessionMessageInput = {
              sessionId: this.session.id,
              taskId: null,
              taskRunId: null,
              seq: this.messageSeq,
              messageId: textMessageId,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_response",
              messageType: "assistant_response",
              contentJson: {
                text: state.textBuffer,
                streaming: false,
                isThinking: false,
              },
            }
            const persistedText = this.db.createSessionMessage(textMessageInput)
            this.onMessage?.(persistedText)
          }
        }

        this.streamingState = null
      }
    })
  }

  /**
   * Check if a message ID was recently persisted (LRU deduplication)
   * Returns true if the ID is new and was added to the buffer
   * Returns false if the ID was already in the buffer (duplicate)
   */
  private checkAndAddRecentMessageId(messageId: string): boolean {
    if (this.recentMessageIds.includes(messageId)) {
      return false
    }

    this.recentMessageIds.unshift(messageId)

    if (this.recentMessageIds.length > 3) {
      this.recentMessageIds.pop()
    }

    return true
  }

  /**
   * Start the planning session.
   * Returns an Effect that must be run at the runtime boundary.
   */
  start(
    systemPrompt: string,
    model?: string,
    thinkingLevel?: "default" | "low" | "medium" | "high",
    forceRuntime?: PiRuntimeMode,
  ): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      if (self.process) {
        return yield* new PlanningSessionError({
          operation: "start",
          message: "Session already started",
        })
      }

      const piSessionFile = self.session.piSessionFile ?? getSessionFilePath(self.session.id, self.session.cwd)

      if (!self.session.piSessionFile) {
        self.session = yield* Effect.try({
          try: () =>
            self.db.updateWorkflowSession(self.session.id, {
              piSessionFile,
            }) ?? self.session,
          catch: (cause) => new PlanningSessionError({
            operation: "start",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        })
      }

      const process = (yield* createPiProcessEffect({
        db: self.db,
        session: self.session,
        containerManager: self.containerManager,
        onSessionMessage: (msg) => {
          self.onMessage?.(msg)
        },
        forceRuntime,
        settings: self.settings,
        systemPrompt,
        disableAutoSessionMessages: true,
        piSessionFile,
      }).pipe(
        Effect.mapError((cause) => new PlanningSessionError({
          operation: "start",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        })),
      )) as PiRpcProcess

      const scope = yield* Scope.make()
      yield* Effect.acquireRelease(
        Effect.succeed(process),
        (proc) => proc.close().pipe(Effect.orDie),
      ).pipe(Scope.extend(scope))
      yield* self.installStreamingSubscription(process).pipe(Scope.extend(scope))
      self.process = process
      self.sessionScope = scope

      yield* Effect.gen(function* () {
        yield* process.start().pipe(
          Effect.mapError((cause) => new PlanningSessionError({
            operation: "start",
            message: cause.message,
            cause,
          })),
        )

        yield* self.waitForProcessReadyEffect(10_000)

        if (model && model !== "default") {
          const modelSelection = parseModelSelection(model)
          if (modelSelection) {
            yield* process.send(
              {
                type: "set_model",
                provider: modelSelection.provider,
                modelId: modelSelection.modelId,
              },
              30_000,
            ).pipe(
              Effect.mapError((cause) => new PlanningSessionError({
                operation: "start",
                message: `Failed to set model ${model}: ${cause.message}`,
                cause,
              })),
            )
          } else {
            return yield* new PlanningSessionError({
              operation: "start",
              message: `Invalid model format: ${model}. Expected format: provider/modelId`,
            })
          }
        }

        if (thinkingLevel && thinkingLevel !== "default") {
          yield* process.send(
            {
              type: "set_thinking_level",
              level: thinkingLevel,
            },
            30_000,
          ).pipe(
            Effect.mapError((cause) => new PlanningSessionError({
              operation: "start",
              message: `Failed to set thinking level ${thinkingLevel}: ${cause.message}`,
              cause,
            })),
          )
        }

        self.session = yield* Effect.try({
          try: () =>
            self.db.updateWorkflowSession(self.session.id, {
              status: "active",
            }) ?? self.session,
          catch: (cause) => new PlanningSessionError({
            operation: "start",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        })

        self.isReady = true
        self.onStatusChange?.(self.session)
      }).pipe(
        Effect.tapError((error) =>
          self.closeSessionScope(Exit.fail(error)).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                self.session =
                  self.db.updateWorkflowSession(self.session.id, {
                    status: "failed",
                    errorMessage: error.message,
                    finishedAt: nowUnix(),
                  }) ?? self.session
                self.onStatusChange?.(self.session)
              }),
            ),
          ),
        ),
      )
    })
  }

  /**
   * Wait for the Pi process to be ready to accept commands.
   * Uses exponential backoff via Effect.retry with a total timeout.
   */
  private waitForProcessReadyEffect(timeoutMs: number): Effect.Effect<void, PlanningSessionError> {
    const self = this
    const deadline = Date.now() + timeoutMs

    const poll = (): Effect.Effect<void, PlanningSessionError> =>
      Effect.gen(function* () {
        if (!self.process) {
          return yield* new PlanningSessionError({
            operation: "waitForProcessReady",
            message: "Process was closed during startup",
          })
        }
        if (self.process.hasExited()) {
          return yield* new PlanningSessionError({
            operation: "waitForProcessReady",
            message: "Pi process exited during startup",
          })
        }

        const isReady = yield* self.process.send({ type: "get_messages" }, 1_000).pipe(
          Effect.as(true),
          Effect.catchTag("PiProcessError", () => Effect.succeed(false)),
        )

        if (isReady) {
          return yield* Effect.void
        }

        if (Date.now() >= deadline) {
          return yield* new PlanningSessionError({
            operation: "waitForProcessReady",
            message: `Process failed to become ready within ${timeoutMs}ms`,
          })
        }

        yield* Effect.sleep(Duration.millis(100))
        return yield* poll()
      })

    return poll()
  }

  /**
   * Change the model for this session mid-conversation.
   * Returns an Effect that must be run at the runtime boundary.
   */
  setModel(model: string): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process || !self.isReady) {
        return yield* new PlanningSessionError({
          operation: "setModel",
          message: "Session not ready",
        })
      }
      if (!model || model === "default") {
        return yield* new PlanningSessionError({
          operation: "setModel",
          message: "Invalid model selection",
        })
      }
      const modelSelection = parseModelSelection(model)
      if (!modelSelection) {
        return yield* new PlanningSessionError({
          operation: "setModel",
          message: `Invalid model format: ${model}. Expected format: provider/modelId`,
        })
      }

      yield* self.process.send(
        {
          type: "set_model",
          provider: modelSelection.provider,
          modelId: modelSelection.modelId,
        },
        30_000,
      ).pipe(
        Effect.mapError((cause) => new PlanningSessionError({
          operation: "setModel",
          message: `Failed to set model: ${cause.message}`,
          cause,
        })),
      )

      self.session = yield* Effect.try({
        try: () =>
          self.db.updateWorkflowSession(self.session.id, {
            model,
          }) ?? self.session,
        catch: (cause) => new PlanningSessionError({
          operation: "setModel",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })
      self.onStatusChange?.(self.session)
    })
  }

  /**
   * Set the thinking level for this session.
   * Returns an Effect that must be run at the runtime boundary.
   */
  setThinkingLevel(thinkingLevel: "default" | "low" | "medium" | "high"): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process || !self.isReady) {
        return yield* new PlanningSessionError({
          operation: "setThinkingLevel",
          message: "Session not ready",
        })
      }

      if (!thinkingLevel || thinkingLevel === "default") {
        return yield* Effect.void
      }

      yield* self.process.send(
        {
          type: "set_thinking_level",
          level: thinkingLevel,
        },
        30_000,
      ).pipe(
        Effect.mapError((cause) => new PlanningSessionError({
          operation: "setThinkingLevel",
          message: `Failed to set thinking level: ${cause.message}`,
          cause,
        })),
      )

      self.session = yield* Effect.try({
        try: () =>
          self.db.updateWorkflowSession(self.session.id, {
            thinkingLevel,
          }) ?? self.session,
        catch: (cause) => new PlanningSessionError({
          operation: "setThinkingLevel",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      self.onStatusChange?.(self.session)
    })
  }

  /**
   * Send a message to the planning session.
   * Returns an Effect that must be run at the runtime boundary.
   */
  sendMessage(input: SendMessageInput): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process || !self.isReady) {
        return yield* new PlanningSessionError({
          operation: "sendMessage",
          message: "Session not ready",
        })
      }

      let fullContent = input.content

      if (input.contextAttachments && input.contextAttachments.length > 0) {
        fullContent += "\n\n---\n\n**Context Attachments:**\n"
        for (const attachment of input.contextAttachments) {
          fullContent += `\n[${attachment.type.toUpperCase()}: ${attachment.name}]\n`
          if (attachment.content) {
            fullContent += "```\n" + attachment.content + "\n```\n"
          }
          if (attachment.filePath) {
            fullContent += `File: ${attachment.filePath}\n`
          }
          if (attachment.taskId) {
            fullContent += `Task ID: ${attachment.taskId}\n`
          }
        }
      }

      self.messageSeq++
      const userMessageInput: CreateSessionMessageInput = {
        sessionId: self.session.id,
        taskId: null,
        taskRunId: null,
        seq: self.messageSeq,
        messageId: randomUUID(),
        timestamp: nowUnix(),
        role: "user",
        eventName: "user_message",
        messageType: "user_prompt",
        contentJson: { text: input.content, attachments: input.contextAttachments },
      }

      const userMessage = self.db.createSessionMessage(userMessageInput)
      self.onMessage?.(userMessage)

      yield* self.process.prompt(fullContent).pipe(
        Effect.mapError((cause) => new PlanningSessionError({
          operation: "sendMessage",
          message: cause.message,
          cause,
        })),
      )
    })
  }

  /**
   * Close the planning session.
   * Returns an Effect that must be run at the runtime boundary.
   */
  close(): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process) {
        return yield* Effect.void
      }

      yield* self.closeSessionScope(Exit.void)

      self.session = yield* Effect.try({
        try: () =>
          self.db.updateWorkflowSession(self.session.id, {
            status: "completed",
            finishedAt: nowUnix(),
          }) ?? self.session,
        catch: (cause) => new PlanningSessionError({
          operation: "close",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      self.onStatusChange?.(self.session)
    })
  }

  /**
   * Get the next sequence number for this session based on existing messages.
   */
  private getNextSeqFromDb(): number {
    const messages = this.db.getSessionMessages(this.session.id, { limit: 1 })
    if (messages.length === 0) {
      return 1
    }
    // Get the max seq from the database
    const allMessages = this.db.getSessionMessages(this.session.id, { limit: 10000 })
    const maxSeq = allMessages.reduce((max, msg) => Math.max(max, Number(msg.seq) || 0), 0)
    return maxSeq + 1
  }

  /**
   * Reconnect to an existing session that is not currently active.
   * This creates a new Pi process and restores the session state.
   * Returns an Effect that must be run at the runtime boundary.
   */
  reconnect(
    systemPrompt: string,
    model?: string,
    thinkingLevel?: "default" | "low" | "medium" | "high",
    forceRuntime?: PiRuntimeMode,
  ): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      if (self.process) {
        return yield* new PlanningSessionError({
          operation: "reconnect",
          message: "Session already has an active process",
        })
      }

      self.messageSeq = self.getNextSeqFromDb()
      const piSessionFile = self.session.piSessionFile ?? getSessionFilePath(self.session.id, self.session.cwd)

      const process = (yield* createPiProcessEffect({
        db: self.db,
        session: self.session,
        containerManager: self.containerManager,
        onSessionMessage: (msg) => {
          self.onMessage?.(msg)
        },
        forceRuntime,
        settings: self.settings,
        systemPrompt,
        disableAutoSessionMessages: true,
        piSessionFile,
      }).pipe(
        Effect.mapError((cause) => new PlanningSessionError({
          operation: "reconnect",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        })),
      )) as PiRpcProcess

      const scope = yield* Scope.make()
      yield* Effect.acquireRelease(
        Effect.succeed(process),
        (proc) => proc.close().pipe(Effect.orDie),
      ).pipe(Scope.extend(scope))
      yield* self.installStreamingSubscription(process).pipe(Scope.extend(scope))
      self.process = process
      self.sessionScope = scope

      yield* Effect.gen(function* () {
        yield* process.start().pipe(
          Effect.mapError((cause) => new PlanningSessionError({
            operation: "reconnect",
            message: cause.message,
            cause,
          })),
        )

        yield* self.waitForProcessReadyEffect(10_000)

        if (model && model !== "default") {
          const modelSelection = parseModelSelection(model)
          if (modelSelection) {
            yield* process.send(
              {
                type: "set_model",
                provider: modelSelection.provider,
                modelId: modelSelection.modelId,
              },
              30_000,
            ).pipe(
              Effect.mapError((cause) => new PlanningSessionError({
                operation: "reconnect",
                message: `Failed to set model ${model} during reconnect: ${cause.message}`,
                cause,
              })),
            )
          } else {
            return yield* new PlanningSessionError({
              operation: "reconnect",
              message: `Invalid model format: ${model}. Expected format: provider/modelId`,
            })
          }
        }

        if (thinkingLevel && thinkingLevel !== "default") {
          yield* process.send(
            {
              type: "set_thinking_level",
              level: thinkingLevel,
            },
            30_000,
          ).pipe(
            Effect.mapError((cause) => new PlanningSessionError({
              operation: "reconnect",
              message: `Failed to set thinking level ${thinkingLevel} during reconnect: ${cause.message}`,
              cause,
            })),
          )
        }

        self.session = yield* Effect.try({
          try: () =>
            self.db.updateWorkflowSession(self.session.id, {
              status: "active",
            }) ?? self.session,
          catch: (cause) => new PlanningSessionError({
            operation: "reconnect",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        })

        self.isReady = true
        self.onStatusChange?.(self.session)
      }).pipe(
        Effect.tapError((error) =>
          self.closeSessionScope(Exit.fail(error)).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                self.session =
                  self.db.updateWorkflowSession(self.session.id, {
                    status: "failed",
                    errorMessage: error.message,
                  }) ?? self.session
                self.onStatusChange?.(self.session)
              }),
            ),
          ),
        ),
      )
    })
  }

  getSession(): PiWorkflowSession {
    return this.session
  }

  isActive(): boolean {
    return this.isReady && this.process !== null
  }
}

/**
 * PlanningSessionManager - Manages multiple planning chat sessions
 */
export class PlanningSessionManager {
  private sessions = new Map<string, PlanningSession>()

  static make(
    db: PiKanbanDB,
    containerManager?: PiContainerManager,
    settings?: InfrastructureSettings,
  ): Effect.Effect<PlanningSessionManager> {
    return Effect.sync(() => new PlanningSessionManager(db, containerManager, settings))
  }

  static makeScoped(
    db: PiKanbanDB,
    containerManager?: PiContainerManager,
    settings?: InfrastructureSettings,
  ): Effect.Effect<PlanningSessionManager, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new PlanningSessionManager(db, containerManager, settings)),
      (manager) => manager.closeAllSessions().pipe(Effect.orDie),
    )
  }

  constructor(
    private readonly db: PiKanbanDB,
    private readonly containerManager?: PiContainerManager,
    private readonly settings?: InfrastructureSettings,
  ) {}

  /**
   * Create a new planning session.
   * Returns an Effect that must be run at the runtime boundary.
   */
  createSession(input: {
    cwd: string
    systemPrompt: string
    model?: string
    thinkingLevel?: "default" | "low" | "medium" | "high"
    onMessage?: (message: SessionMessage) => void
    onStatusChange?: (session: PiWorkflowSession) => void
    sessionKind?: "planning" | "container_config"
  }): Effect.Effect<{ session: PiWorkflowSession; planningSession: PlanningSession }, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      const sessionId = randomUUID().slice(0, 8)
      const sessionKind = input.sessionKind ?? "planning"

      const session = self.db.createWorkflowSession({
        id: sessionId,
        sessionKind,
        status: "starting",
        cwd: input.cwd,
        model: input.model ?? "default",
        thinkingLevel: input.thinkingLevel ?? "default",
        startedAt: nowUnix(),
      })

      const planningSession = new PlanningSession({
        session,
        db: self.db,
        settings: self.settings,
        containerManager: self.containerManager,
        onMessage: input.onMessage,
        onStatusChange: input.onStatusChange,
      })

      // Store in active sessions
      self.sessions.set(sessionId, planningSession)

      // Start the planning session
      yield* planningSession.start(input.systemPrompt, input.model, input.thinkingLevel, "native")

      const updatedSession = self.db.getWorkflowSession(sessionId) ?? session

      return { session: updatedSession, planningSession }
    })
  }

  getSession(sessionId: string): PlanningSession | undefined {
    return this.sessions.get(sessionId)
  }

  getAllActiveSessions(): PlanningSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.isActive())
  }

  /**
   * Close a specific planning session.
   * Returns an Effect that must be run at the runtime boundary.
   */
  closeSession(sessionId: string): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      const session = self.sessions.get(sessionId)
      if (session) {
        yield* session.close()
        self.sessions.delete(sessionId)
      }
    })
  }

  /**
   * Close all active planning sessions.
   * Returns an Effect that must be run at the runtime boundary.
   */
  closeAllSessions(): Effect.Effect<void, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      const sessions = Array.from(self.sessions.values())
      for (const session of sessions) {
        yield* session.close()
      }
      self.sessions.clear()
    })
  }

  /**
   * Reconnect to an existing planning session that is not currently active.
   * Creates a new PlanningSession instance and connects it to the existing DB session.
   * Returns an Effect that must be run at the runtime boundary.
   */
  reconnectSession(
    sessionId: string,
    input: {
      systemPrompt: string
      model?: string
      thinkingLevel?: "default" | "low" | "medium" | "high"
      onMessage?: (message: SessionMessage) => void
      onStatusChange?: (session: PiWorkflowSession) => void
    },
  ): Effect.Effect<{ session: PiWorkflowSession; planningSession: PlanningSession }, PlanningSessionError> {
    const self = this
    return Effect.gen(function* () {
      // Check if session already has an active planning session
      const existingSession = self.sessions.get(sessionId)
      if (existingSession && existingSession.isActive()) {
        return yield* new PlanningSessionError({
          operation: "reconnectSession",
          message: "Session is already active",
        })
      }

      // Get the existing session from DB
      const dbSession = self.db.getWorkflowSession(sessionId)
      if (!dbSession) {
        return yield* new PlanningSessionError({
          operation: "reconnectSession",
          message: `Session ${sessionId} not found`,
        })
      }
      if (dbSession.sessionKind !== "planning" && dbSession.sessionKind !== "container_config") {
        return yield* new PlanningSessionError({
          operation: "reconnectSession",
          message: "Not a planning or container_config session",
        })
      }

      // Create a new PlanningSession wrapper for the existing DB session
      const planningSession = new PlanningSession({
        session: dbSession,
        db: self.db,
        settings: self.settings,
        containerManager: self.containerManager,
        onMessage: input.onMessage,
        onStatusChange: input.onStatusChange,
      })

      // Store in active sessions (or replace old one)
      self.sessions.set(sessionId, planningSession)

      // Reconnect to the Pi process (planning sessions always use native mode)
      yield* planningSession.reconnect(input.systemPrompt, input.model, input.thinkingLevel, "native")

      const updatedSession = self.db.getWorkflowSession(sessionId) ?? dbSession

      return { session: updatedSession, planningSession }
    })
  }
}
