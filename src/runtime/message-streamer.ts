import { randomUUID } from "crypto"
import type { PiKanbanDB } from "../db.ts"
import type { CreateSessionMessageInput, SessionMessage } from "../types.ts"

interface StreamingMessageState {
  messageId: string
  seq: number
  timestamp: number
  textBuffer: string
  thinkingBuffer: string
  hasThinking: boolean
  hasText: boolean
  isComplete: boolean
  persistLock: boolean
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Utility to manage streaming message events (text_delta, thinking_delta)
 * and prevent duplicate persistence in the database. It buffers deltas 
 * and only persists fully formed messages.
 */
export class MessageStreamer {
  private streamingState: StreamingMessageState | null = null
  private recentMessageIds: string[] = []
  private messageSeq = 0
  private initialized = false

  constructor(
    private readonly db: PiKanbanDB,
    private readonly sessionId: string,
    private readonly taskId?: string | null,
    private readonly taskRunId?: string | null,
    private readonly onSessionMessage?: (message: SessionMessage) => void
  ) {}

  private initSeqIfNeeded() {
    if (this.initialized) return
    const allMessages = this.db.getSessionMessages(this.sessionId, { limit: 10000 })
    this.messageSeq = allMessages.reduce((max, msg) => Math.max(max, Number(msg.seq) || 0), 0)
    this.initialized = true
  }

  private checkAndAddRecentMessageId(messageId: string): boolean {
    if (this.recentMessageIds.includes(messageId)) return false
    this.recentMessageIds.unshift(messageId)
    if (this.recentMessageIds.length > 5) this.recentMessageIds.pop()
    return true
  }

  /**
   * Handles an event. Returns true if the event was processed as a streaming event 
   * (meaning it should NOT be passed to default persistence logic).
   */
  handleEvent(event: Record<string, unknown>): boolean {
    this.initSeqIfNeeded()
    
    const eventType = event.type as string

    if (eventType === "message_update") {
      const msgEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
      const msgEventType = msgEvent?.type as string
      
      if (!msgEventType) return true // Handled (prevent raw persistence)

      if (!this.streamingState) {
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
          
          if (this.onSessionMessage) {
            this.onSessionMessage({
              id: state.seq,
              seq: state.seq,
              messageId: state.messageId,
              sessionId: this.sessionId,
              taskId: this.taskId ?? null,
              taskRunId: this.taskRunId ?? null,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_thinking",
              messageType: "thinking",
              contentJson: { 
                thinking: state.thinkingBuffer, 
                streaming: true,
                isThinking: true 
              },
            } as SessionMessage)
          }
        }
        return true
      }

      if (msgEventType === "text_delta") {
        const delta = typeof msgEvent.delta === "string" ? msgEvent.delta : ""
        if (delta) {
          state.hasText = true
          state.textBuffer += delta
          
          if (this.onSessionMessage) {
            const textId = state.hasThinking ? state.seq + 1 : state.seq
            this.onSessionMessage({
              id: textId,
              seq: textId,
              messageId: state.messageId + "-text",
              sessionId: this.sessionId,
              taskId: this.taskId ?? null,
              taskRunId: this.taskRunId ?? null,
              timestamp: state.timestamp,
              role: "assistant",
              eventName: "assistant_response",
              messageType: "assistant_response",
              contentJson: { 
                text: state.textBuffer, 
                streaming: true,
                isThinking: false 
              },
            } as SessionMessage)
          }
        }
        return true
      }

      if (msgEventType === "text_complete") {
        this.persistCurrentState()
        return true
      }

      return true // Catch-all for other message_update events
    }

    if (eventType === "agent_end") {
      this.persistCurrentState()
      return false // Caller still needs to process agent_end
    }

    return false
  }

  private persistCurrentState(): void {
    if (!this.streamingState) return
    const state = this.streamingState
    if (state.persistLock) return
    state.persistLock = true

    if (state.hasThinking && state.thinkingBuffer && this.checkAndAddRecentMessageId(state.messageId)) {
      this.messageSeq++
      const thinkingMessageInput: CreateSessionMessageInput = {
        sessionId: this.sessionId,
        taskId: this.taskId ?? null,
        taskRunId: this.taskRunId ?? null,
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
      if (persistedThinking && this.onSessionMessage) {
        this.onSessionMessage(persistedThinking)
      }
    }

    const textMessageId = state.messageId + "-text"
    if (state.hasText && state.textBuffer && this.checkAndAddRecentMessageId(textMessageId)) {
      this.messageSeq++
      const textMessageInput: CreateSessionMessageInput = {
        sessionId: this.sessionId,
        taskId: this.taskId ?? null,
        taskRunId: this.taskRunId ?? null,
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
      if (persistedText && this.onSessionMessage) {
        this.onSessionMessage(persistedText)
      }
    }

    this.streamingState = null
  }
}
