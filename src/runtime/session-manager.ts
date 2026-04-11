import { randomUUID } from "crypto"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiSessionKind, PiWorkflowSession } from "../db/types.ts"
import type { ThinkingLevel } from "../types.ts"
import { PiRpcProcess } from "./pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { createPiProcess, type PiRuntimeMode } from "./pi-process-factory.ts"
import { parseModelSelection } from "./model-utils.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Extract text content from a pi message.
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

  if (typeof content === "string") {
    return content
  }

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
  /**
   * Force specific runtime mode for this session.
   * If not specified, uses workflow.runtime.mode from settings.
   */
  forceRuntime?: PiRuntimeMode
}

export interface ExecuteSessionPromptResult {
  session: PiWorkflowSession
  responseText: string
}

/**
 * PiSessionManager - Manages pi RPC sessions
 *
 * Supports both native and containerized execution modes.
 * - Native mode: Spawns pi directly on the host
 * - Container mode: Runs pi inside a gVisor container for isolation
 */
export class PiSessionManager {
  constructor(
    private readonly db: PiKanbanDB,
    private readonly containerManager?: PiContainerManager,
    private readonly settings?: InfrastructureSettings,
  ) {}

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

    const process = createPiProcess({
      db: this.db,
      session,
      containerManager: this.containerManager,
      onOutput: input.onOutput,
      onSessionMessage: input.onSessionMessage,
      forceRuntime: input.forceRuntime,
      settings: this.settings,
    })

    let responseText = ""
    try {
      if (input.onSessionStart) {
        input.onSessionStart(session)
      }

      if ("start" in process && typeof process.start === "function") {
        await process.start()
      } else {
        // Native PiRpcProcess uses synchronous start()
        ;(process as PiRpcProcess).start()
      }

      await new Promise((resolve) => setTimeout(resolve, 500))

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
