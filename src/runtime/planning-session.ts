import { randomUUID } from "crypto"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { CreateSessionMessageInput, SessionMessage } from "../types.ts"
import { PiRpcProcess } from "./pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { createPiProcess, type PiRuntimeMode } from "./pi-process-factory.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function parseModelSelection(model: string): { provider: string; modelId: string } | null {
  const parts = model.split("/")
  if (parts.length === 2) {
    return { provider: parts[0], modelId: parts[1] }
  }
  return null
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
    if (this.process) {
      throw new Error("Session already started")
    }

    try {
      this.process = createPiProcess({
        db: this.db,
        session: this.session,
        containerManager: this.containerManager,
        onSessionMessage: (msg) => {
          this.onMessage?.(msg)
        },
        forceRuntime,
        settings: this.settings,
        systemPrompt: systemPrompt,
        disableAutoSessionMessages: true,
      }) as PiRpcProcess

      // Start the process
      if ("start" in this.process && typeof this.process.start === "function") {
        await this.process.start()
      } else {
        this.process.start()
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))

      if (model && model !== "default") {
        const modelSelection = parseModelSelection(model)
        if (modelSelection) {
          await this.process.send({
            type: "set_model",
            provider: modelSelection.provider,
            modelId: modelSelection.modelId,
          }, 30_000)
        }
      }

      if (thinkingLevel && thinkingLevel !== "default") {
        await this.process.send({
          type: "set_thinking_level",
          level: thinkingLevel,
        }, 30_000)
      }

      this.session = this.db.updateWorkflowSession(this.session.id, {
        status: "active",
      }) ?? this.session

      this.isReady = true
      this.onStatusChange?.(this.session)

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.session = this.db.updateWorkflowSession(this.session.id, {
        status: "failed",
        errorMessage: message,
        finishedAt: nowUnix(),
      }) ?? this.session
      this.onStatusChange?.(this.session)
      throw error
    }
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    if (!this.process || !this.isReady) {
      throw new Error("Session not ready")
    }

    // Build the message content with attachments
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

    // Record user message in database
    this.messageSeq++
    const userMessageInput: CreateSessionMessageInput = {
      sessionId: this.session.id,
      taskId: null,
      taskRunId: null,
      seq: this.messageSeq,
      messageId: randomUUID(),
      timestamp: nowUnix(),
      role: "user",
      eventName: "user_message",
      messageType: "user_prompt",
      contentJson: { text: input.content, attachments: input.contextAttachments },
    }
    
    const userMessage = this.db.createSessionMessage(userMessageInput)
    
    // Broadcast user message to UI immediately
    this.onMessage?.(userMessage)

    // Send to Pi
    await this.process.prompt(fullContent)

    // Start collecting streaming events for this message
    this.collectStreamingEvents()
  }

  private collectStreamingEvents(): void {
    if (!this.process) return

    const unsubscribe = this.process.onEvent((event) => {
      const eventType = event.type as string

      if (eventType === "message_update") {
        const msgEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
        const msgEventType = msgEvent?.type as string
        
        if (!msgEventType) return

        // Initialize streaming state if needed
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
            
            const thinkingMessage: SessionMessage = {
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
            }
            this.onMessage?.(thinkingMessage)
          }
        }

        if (msgEventType === "text_delta") {
          const delta = typeof msgEvent.delta === "string" ? msgEvent.delta : ""
          if (delta) {
            state.hasText = true
            state.textBuffer += delta
            
            const textMessage: SessionMessage = {
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
            }
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
    if (!this.process) return

    try {
      await this.process.close()
    } catch {
      // ignore
    }

    this.process = null
    this.isReady = false
    
    this.session = this.db.updateWorkflowSession(this.session.id, {
      status: "completed",
      finishedAt: nowUnix(),
    }) ?? this.session
    
    this.onStatusChange?.(this.session)
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
  }): Promise<{ session: PiWorkflowSession; planningSession: PlanningSession }> {
    const sessionId = randomUUID().slice(0, 8)

    const session = this.db.createWorkflowSession({
      id: sessionId,
      sessionKind: "planning",
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

    await planningSession.start(input.systemPrompt, input.model, input.thinkingLevel)

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
}
