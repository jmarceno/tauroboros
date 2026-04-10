import { randomUUID } from "crypto"
import type { PiKanbanDB } from "../db.ts"
import type { PiSessionKind, PiWorkflowSession } from "../db/types.ts"
import type { ThinkingLevel } from "../types.ts"
import { PiRpcProcess } from "./pi-process.ts"

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

/**
 * Extract text content from a pi message.
 * Pi messages use structured content arrays per packages/ai/src/types.ts:
 * - UserMessage: content: string | (TextContent | ImageContent)[]
 * - AssistantMessage: content: (TextContent | ThinkingContent | ToolCall)[]
 * - TextContent: { type: "text", text: string }
 * We extract and join all text blocks from the content array.
 */
interface PiContentBlock {
  type: string
  text?: string
}

interface PiMessage {
  role?: string
  content?: string | PiContentBlock[]
}

function extractTextFromPiMessage(message: PiMessage): string {
  const content = message.content
  if (!content) return ""

  // Handle string content (UserMessage simple form)
  if (typeof content === "string") {
    return content
  }

  // Handle content blocks array (AssistantMessage, UserMessage with attachments)
  if (Array.isArray(content)) {
    return content
      .filter((block): block is PiContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string"
      )
      .map((block) => block.text)
      .join(" ")
  }

  return ""
}

export interface ExecuteSessionPromptInput {
  taskId: string
  taskRunId?: string | null
  sessionKind: PiSessionKind
  cwd: string
  worktreeDir?: string | null
  branch?: string | null
  model?: string
  thinkingLevel?: ThinkingLevel
  promptText: string
  onOutput?: (chunk: string) => void
  onSessionMessage?: (message: import("../types.ts").SessionMessage) => void
  onSessionStart?: (session: PiWorkflowSession) => void
}

export interface ExecuteSessionPromptResult {
  session: PiWorkflowSession
  responseText: string
}

/**
 * PiSessionManager - Manages pi RPC sessions
 * 
 * Uses event-driven architecture:
 * - Sends prompt (returns immediately)
 * - Collects events until agent_end
 * - Extracts final response from assistant messages
 */
export class PiSessionManager {
  constructor(private readonly db: PiKanbanDB) {}

  async executePrompt(input: ExecuteSessionPromptInput): Promise<ExecuteSessionPromptResult> {
    const sessionId = randomUUID().slice(0, 8)
    let session = this.db.createWorkflowSession({
      id: sessionId,
      taskId: input.taskId,
      taskRunId: input.taskRunId ?? null,
      sessionKind: input.sessionKind,
      status: "starting",
      cwd: input.cwd,
      worktreeDir: input.worktreeDir ?? null,
      branch: input.branch ?? null,
      model: input.model ?? "default",
      thinkingLevel: input.thinkingLevel ?? "default",
      startedAt: nowUnix(),
    })

    const process = new PiRpcProcess({
      db: this.db,
      session,
      onOutput: input.onOutput,
      onSessionMessage: input.onSessionMessage,
    })

    let responseText = ""
    try {
      // Notify that session has started immediately
      if (input.onSessionStart) {
        input.onSessionStart(session)
      }

      process.start()

      // Wait for process to be ready
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Set model if specified
      if (input.model && input.model !== "default") {
        const modelSelection = parseModelSelection(input.model)
        if (modelSelection) {
          await process.send({
            type: "set_model",
            provider: modelSelection.provider,
            modelId: modelSelection.modelId,
          }, 30_000)
        }
      }

      // Set thinking level if specified
      if (input.thinkingLevel && input.thinkingLevel !== "default") {
        await process.send({
          type: "set_thinking_level",
          level: input.thinkingLevel,
        }, 30_000)
      }

      session = this.db.updateWorkflowSession(session.id, {
        status: "active",
      }) ?? session

      this.db.appendSessionIO({
        sessionId: session.id,
        stream: "server",
        recordType: "prompt_rendered",
        payloadJson: {
          sessionKind: input.sessionKind,
          promptLength: input.promptText.length,
        },
        payloadText: input.promptText,
      })

      // Send prompt and collect all events until completion
      // This uses the event-driven architecture - no polling
      const events = await process.promptAndWait(input.promptText, 600_000) // 10 min timeout

      // Extract response text from the last assistant message
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
          if (msgEvent?.type === "text_complete" || msgEvent?.type === "text") {
            const text = typeof msgEvent.text === "string" ? msgEvent.text : 
                        typeof msgEvent.delta === "string" ? msgEvent.delta : ""
            if (text) {
              responseText = text
              break
            }
          }
        }
      }

      // If no response text from events, try to get from messages
      if (!responseText) {
        const messagesResult = await process.send({ type: "get_messages" }, 30_000).catch(() => null)
        if (messagesResult && Array.isArray(messagesResult.messages)) {
          // Pi messages use structured content blocks, not direct text/content fields
          // See: packages/ai/src/types.ts in pi source
          type ContentBlock = { type: string; text?: string }
          type PiMessage = {
            role?: string
            content?: string | ContentBlock[]
          }
          const messages = messagesResult.messages as PiMessage[]
          const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant")
          if (lastAssistantMsg) {
            responseText = extractTextFromPiMessage(lastAssistantMsg)
          }
        }
      }

      // Final snapshot
      const finalSnapshot = await process.send({ type: "get_messages" }, 30_000).catch(() => null)
      if (finalSnapshot) {
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "snapshot",
          payloadJson: finalSnapshot,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.updateWorkflowSession(session.id, {
        status: "failed",
        errorMessage: message,
        finishedAt: nowUnix(),
      })
      throw error
    } finally {
      await process.close()
    }

    return {
      session: this.db.getWorkflowSession(session.id) ?? session,
      responseText,
    }
  }
}
