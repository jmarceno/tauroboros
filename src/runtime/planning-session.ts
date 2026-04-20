import { randomUUID } from "crypto"
import { join } from "path"
import { Effect } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { CreateSessionMessageInput, SessionMessage } from "../types.ts"
import { PiRpcProcess } from "./pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { createPiProcess, type PiRuntimeMode } from "./pi-process-factory.ts"
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

  async start(systemPrompt: string, model?: string, thinkingLevel?: "default" | "low" | "medium" | "high", forceRuntime?: PiRuntimeMode): Promise<void> {
    return await Effect.runPromise(this.startEffect(systemPrompt, model, thinkingLevel, forceRuntime))
  }

  private startEffect(
    systemPrompt: string,
    model?: string,
    thinkingLevel?: "default" | "low" | "medium" | "high",
    forceRuntime?: PiRuntimeMode,
  ): Effect.Effect<void, Error> {
    const self = this
    return Effect.gen(function* () {
      if (self.process) {
        return yield* Effect.fail(new Error("Session already started"))
      }

      const piSessionFile = self.session.piSessionFile ?? getSessionFilePath(self.session.id, self.session.cwd)

      if (!self.session.piSessionFile) {
        self.session =
          self.db.updateWorkflowSession(self.session.id, {
            piSessionFile,
          }) ?? self.session
      }

      try {
        self.process = yield* Effect.try({
          try: () =>
            createPiProcess({
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
            }) as PiRpcProcess,
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })

        yield* Effect.tryPromise({
          try: () => Promise.resolve(self.process!.start()),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })

        yield* self.waitForProcessReadyEffect(10_000)

        if (model && model !== "default") {
          const modelSelection = parseModelSelection(model)
          if (modelSelection) {
            yield* Effect.tryPromise({
              try: () =>
                self.process!.send(
                  {
                    type: "set_model",
                    provider: modelSelection.provider,
                    modelId: modelSelection.modelId,
                  },
                  30_000,
                ),
              catch: (modelError) => {
                console.warn(`[PlanningSession] Failed to set model ${model}:`, modelError)
                return null
              },
            })
          }
        }

        if (thinkingLevel && thinkingLevel !== "default") {
          yield* Effect.tryPromise({
            try: () =>
              self.process!.send(
                {
                  type: "set_thinking_level",
                  level: thinkingLevel,
                },
                30_000,
              ),
            catch: (thinkingError) => {
              console.warn(`[PlanningSession] Failed to set thinking level ${thinkingLevel}:`, thinkingError)
              return null
            },
          })
        }

        self.session =
          self.db.updateWorkflowSession(self.session.id, {
            status: "active",
          }) ?? self.session

        self.isReady = true
        self.onStatusChange?.(self.session)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (self.process) {
          yield* Effect.tryPromise({
            try: () => self.process!.close(),
            catch: () => null,
          })
          self.process = null
        }
        self.session =
          self.db.updateWorkflowSession(self.session.id, {
            status: "failed",
            errorMessage: message,
            finishedAt: nowUnix(),
          }) ?? self.session
        self.onStatusChange?.(self.session)
        return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Wait for the Pi process to be ready to accept commands.
   * Uses exponential backoff polling with a timeout.
   */
  private waitForProcessReadyEffect(timeoutMs: number): Effect.Effect<void, Error> {
    const self = this
    return Effect.gen(function* () {
      const startTime = Date.now()
      const checkInterval = 100
      let elapsed = 0

      while (elapsed < timeoutMs) {
        if (!self.process) {
          return yield* Effect.fail(new Error("Process was closed during startup"))
        }

        const ready = yield* Effect.tryPromise({
          try: async () => {
            await self.process!.send({ type: "get_messages" }, 5_000)
            return true
          },
          catch: () => false,
        })

        if (ready) {
          return
        }

        const waitTime = Math.min(checkInterval * Math.pow(1.5, Math.floor(elapsed / 1000)), 1000)
        yield* Effect.sleep(waitTime)
        elapsed = Date.now() - startTime
      }

      return yield* Effect.fail(new Error(`Process failed to become ready within ${timeoutMs}ms`))
    })
  }

  /**
   * Change the model for this session mid-conversation
   */
  async setModel(model: string): Promise<void> {
    return await Effect.runPromise(this.setModelEffect(model))
  }

  private setModelEffect(model: string): Effect.Effect<void, Error> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process || !self.isReady) {
        return yield* Effect.fail(new Error("Session not ready"))
      }
      if (!model || model === "default") {
        return yield* Effect.fail(new Error("Invalid model selection"))
      }
      const modelSelection = parseModelSelection(model)
      if (!modelSelection) {
        return yield* Effect.fail(new Error(`Invalid model format: ${model}. Expected format: provider/modelId`))
      }

      yield* Effect.tryPromise({
        try: () =>
          self.process!.send(
            {
              type: "set_model",
              provider: modelSelection.provider,
              modelId: modelSelection.modelId,
            },
            30_000,
          ),
        catch: (error) => new Error(`Failed to set model: ${error instanceof Error ? error.message : String(error)}`),
      })

      self.session =
        self.db.updateWorkflowSession(self.session.id, {
          model,
        }) ?? self.session
      self.onStatusChange?.(self.session)
    })
  }

  async setThinkingLevel(thinkingLevel: "default" | "low" | "medium" | "high"): Promise<void> {
    return await Effect.runPromise(this.setThinkingLevelEffect(thinkingLevel))
  }

  private setThinkingLevelEffect(thinkingLevel: "default" | "low" | "medium" | "high"): Effect.Effect<void, Error> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process || !self.isReady) {
        return yield* Effect.fail(new Error("Session not ready"))
      }

      if (!thinkingLevel || thinkingLevel === "default") {
        return
      }

      yield* Effect.tryPromise({
        try: () =>
          self.process!.send(
            {
              type: "set_thinking_level",
              level: thinkingLevel,
            },
            30_000,
          ),
        catch: (error) => new Error(`Failed to set thinking level: ${error instanceof Error ? error.message : String(error)}`),
      })

      self.session =
        self.db.updateWorkflowSession(self.session.id, {
          thinkingLevel,
        }) ?? self.session

      self.onStatusChange?.(self.session)
    })
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    return await Effect.runPromise(this.sendMessageEffect(input))
  }

  private sendMessageEffect(input: SendMessageInput): Effect.Effect<void, Error> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process || !self.isReady) {
        return yield* Effect.fail(new Error("Session not ready"))
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

      yield* Effect.tryPromise({
        try: () => self.process!.prompt(fullContent),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })

      self.collectStreamingEvents()
    })
  }

  private collectStreamingEvents(): void {
    if (!this.process) return

    const unsubscribe = this.process.onEvent((event) => {
      const eventType = event.type as string

      if (eventType === "message_update") {
        const msgEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
        const msgEventType = msgEvent?.type as string

        if (!msgEventType) return
        if (!msgEvent) return // Guards TS narrowing; msgEvent is defined when msgEventType is
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
                isThinking: true
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
              id: state.seq + 1, // Different ID for text vs thinking
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
                isThinking: false
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
                isThinking: true
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
                isThinking: false
              },
            }
            const persistedText = this.db.createSessionMessage(textMessageInput)
            this.onMessage?.(persistedText)
          }

          this.streamingState = null
        }
      }

      if (eventType === "agent_end") {
        if (this.streamingState) {
          const state = this.streamingState

          // Only persist if lock was not acquired (meaning text_complete didn't handle it)
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
                  isThinking: true
                },
              }
              const persistedThinking = this.db.createSessionMessage(thinkingMessageInput)
              this.onMessage?.(persistedThinking)
            }

            // Then persist any remaining text (if not already persisted and we have content)
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
                  isThinking: false
                },
              }
              const persistedText = this.db.createSessionMessage(textMessageInput)
              this.onMessage?.(persistedText)
            }
          }

          this.streamingState = null
        }
        unsubscribe()
      }
    })
  }

  async close(): Promise<void> {
    return await Effect.runPromise(this.closeEffect())
  }

  private closeEffect(): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      if (!self.process) {
        return
      }

      yield* Effect.tryPromise({
        try: () => self.process!.close(),
        catch: () => null,
      })

      self.process = null
      self.isReady = false

      self.session =
        self.db.updateWorkflowSession(self.session.id, {
          status: "completed",
          finishedAt: nowUnix(),
        }) ?? self.session

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
   */
  async reconnect(systemPrompt: string, model?: string, thinkingLevel?: "default" | "low" | "medium" | "high", forceRuntime?: PiRuntimeMode): Promise<void> {
    return await Effect.runPromise(this.reconnectEffect(systemPrompt, model, thinkingLevel, forceRuntime))
  }

  private reconnectEffect(
    systemPrompt: string,
    model?: string,
    thinkingLevel?: "default" | "low" | "medium" | "high",
    forceRuntime?: PiRuntimeMode,
  ): Effect.Effect<void, Error> {
    const self = this
    return Effect.gen(function* () {
      if (self.process) {
        return yield* Effect.fail(new Error("Session already has an active process"))
      }

      self.messageSeq = self.getNextSeqFromDb()
      const piSessionFile = self.session.piSessionFile ?? getSessionFilePath(self.session.id, self.session.cwd)

      try {
        self.process = yield* Effect.try({
          try: () =>
            createPiProcess({
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
            }) as PiRpcProcess,
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })

        yield* Effect.tryPromise({
          try: () => Promise.resolve(self.process!.start()),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })

        yield* self.waitForProcessReadyEffect(10_000)

        if (model && model !== "default") {
          const modelSelection = parseModelSelection(model)
          if (modelSelection) {
            yield* Effect.tryPromise({
              try: () =>
                self.process!.send(
                  {
                    type: "set_model",
                    provider: modelSelection.provider,
                    modelId: modelSelection.modelId,
                  },
                  30_000,
                ),
              catch: (modelError) => {
                console.warn(`[PlanningSession] Failed to set model ${model} during reconnect:`, modelError)
                return null
              },
            })
          }
        }

        if (thinkingLevel && thinkingLevel !== "default") {
          yield* Effect.tryPromise({
            try: () =>
              self.process!.send(
                {
                  type: "set_thinking_level",
                  level: thinkingLevel,
                },
                30_000,
              ),
            catch: (thinkingError) => {
              console.warn(`[PlanningSession] Failed to set thinking level ${thinkingLevel} during reconnect:`, thinkingError)
              return null
            },
          })
        }

        self.session =
          self.db.updateWorkflowSession(self.session.id, {
            status: "active",
          }) ?? self.session

        self.isReady = true
        self.onStatusChange?.(self.session)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (self.process) {
          yield* Effect.tryPromise({
            try: () => self.process!.close(),
            catch: () => null,
          })
          self.process = null
        }
        self.session =
          self.db.updateWorkflowSession(self.session.id, {
            status: "failed",
            errorMessage: message,
          }) ?? self.session
        self.onStatusChange?.(self.session)
        return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
      }
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

  constructor(
    private readonly db: PiKanbanDB,
    private readonly containerManager?: PiContainerManager,
    private readonly settings?: InfrastructureSettings,
  ) {}

  async createSession(input: {
    cwd: string
    systemPrompt: string
    model?: string
    thinkingLevel?: "default" | "low" | "medium" | "high"
    onMessage?: (message: SessionMessage) => void
    onStatusChange?: (session: PiWorkflowSession) => void
    sessionKind?: "planning" | "container_config"
  }): Promise<{ session: PiWorkflowSession; planningSession: PlanningSession }> {
    const sessionId = randomUUID().slice(0, 8)
    const sessionKind = input.sessionKind ?? "planning"

    const session = this.db.createWorkflowSession({
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
      db: this.db,
      settings: this.settings,
      containerManager: this.containerManager,
      onMessage: input.onMessage,
      onStatusChange: input.onStatusChange,
    })

    // Store in active sessions
    this.sessions.set(sessionId, planningSession)

    await planningSession.start(input.systemPrompt, input.model, input.thinkingLevel, "native")

    const updatedSession = this.db.getWorkflowSession(sessionId) ?? session

    return { session: updatedSession, planningSession }
  }

  getSession(sessionId: string): PlanningSession | undefined {
    return this.sessions.get(sessionId)
  }

  getAllActiveSessions(): PlanningSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.isActive())
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      await session.close()
      this.sessions.delete(sessionId)
    }
  }

  async closeAllSessions(): Promise<void> {
    const promises = Array.from(this.sessions.values()).map((s) => s.close())
    await Promise.all(promises)
    this.sessions.clear()
  }

  /**
   * Reconnect to an existing planning session that is not currently active.
   * Creates a new PlanningSession instance and connects it to the existing DB session.
   */
  async reconnectSession(
    sessionId: string,
    input: {
      systemPrompt: string
      model?: string
      thinkingLevel?: "default" | "low" | "medium" | "high"
      onMessage?: (message: SessionMessage) => void
      onStatusChange?: (session: PiWorkflowSession) => void
    },
  ): Promise<{ session: PiWorkflowSession; planningSession: PlanningSession } | null> {
    // Check if session already has an active planning session
    const existingSession = this.sessions.get(sessionId)
    if (existingSession && existingSession.isActive()) {
      throw new Error("Session is already active")
    }

    // Get the existing session from DB
    const dbSession = this.db.getWorkflowSession(sessionId)
    if (!dbSession) {
      return null
    }
    if (dbSession.sessionKind !== "planning" && dbSession.sessionKind !== "container_config") {
      throw new Error("Not a planning or container_config session")
    }

    // Create a new PlanningSession wrapper for the existing DB session
    const planningSession = new PlanningSession({
      session: dbSession,
      db: this.db,
      settings: this.settings,
      containerManager: this.containerManager,
      onMessage: input.onMessage,
      onStatusChange: input.onStatusChange,
    })

    // Store in active sessions (or replace old one)
    this.sessions.set(sessionId, planningSession)

    // Reconnect to the Pi process (planning sessions always use native mode)
    await planningSession.reconnect(input.systemPrompt, input.model, input.thinkingLevel, "native")

    const updatedSession = this.db.getWorkflowSession(sessionId) ?? dbSession

    return { session: updatedSession, planningSession }
  }
}
