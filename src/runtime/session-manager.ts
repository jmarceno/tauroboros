import { randomUUID } from "crypto"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiSessionKind, PiWorkflowSession } from "../db/types.ts"
import type { ThinkingLevel } from "../types.ts"
import { PiRpcProcess } from "./pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { ContainerPiProcess } from "./container-pi-process.ts"
import { createPiProcess, type PiRuntimeMode } from "./pi-process-factory.ts"
import { parseModelSelection } from "./model-utils.ts"
import { loadPausedRunState } from "./session-pause-state.ts"

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
   * Called when the process is created. Used to track processes for pause/stop operations.
   */
  onSessionCreated?: (process: PiRpcProcess | ContainerPiProcess, session: PiWorkflowSession) => void
  /**
   * Force specific runtime mode for this session.
   * If not specified, uses workflow.runtime.mode from settings.
   */
  forceRuntime?: PiRuntimeMode
  /**
   * Resume fields - used when resuming a paused session
   */
  isResume?: boolean
  resumedSessionId?: string
  continuationPrompt?: string
  /**
   * Container image to use when resuming a paused session.
   * If not specified, uses the default container image.
   */
  containerImage?: string | null
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
    // If resuming, use the same session ID
    const sessionId = input.resumedSessionId ?? randomUUID().slice(0, 8)
    
    // Check if this is a resume of a container session
    let existingContainerId: string | null = null
    if (input.isResume && input.resumedSessionId && input.worktreeDir) {
      const pauseState = loadPausedRunState()
      if (pauseState) {
        const pausedSession = pauseState.sessions.find(s => s.sessionId === input.resumedSessionId)
        if (pausedSession?.containerId && this.containerManager) {
          // Check if container still exists using containerId (not sessionId)
          const containerInfo = await this.containerManager.checkContainerById(pausedSession.containerId)
          if (!containerInfo?.running) {
            console.log(`[session-manager] Container ${pausedSession.containerId} no longer exists, will create new one`)
          } else {
            existingContainerId = pausedSession.containerId
          }
        }
      }
    }

    // Create or update session
    let session: PiWorkflowSession
    if (input.isResume && input.resumedSessionId) {
      // Update existing session instead of creating new
      const existingSession = this.db.getWorkflowSession(input.resumedSessionId)
      if (existingSession) {
        session = this.db.updateWorkflowSession(input.resumedSessionId, {
          status: "starting",
          // Don't reset startedAt, keep original
        }) ?? existingSession
      } else {
        // Session not found, create new one with same ID
        session = this.db.createWorkflowSession({
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
      }
    } else {
      session = this.db.createWorkflowSession({
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
    }

    const process = createPiProcess({
      db: this.db,
      session,
      containerManager: this.containerManager,
      onOutput: input.onOutput,
      onSessionMessage: input.onSessionMessage,
      forceRuntime: input.forceRuntime,
      settings: this.settings,
      existingContainerId,
      containerImage: input.containerImage,
    })

    // Notify caller about the created process for pause/stop tracking
    if (input.onSessionCreated) {
      input.onSessionCreated(process, session)
    }

    let responseText = ""
    try {
      if (input.onSessionStart) {
        input.onSessionStart(session)
      }

if (process instanceof ContainerPiProcess) {
        await process.start()
      } else {
        process.start()
      }

      // For container processes, the session manager sends an initial set_model
      // command (even for default model) which serves as a readiness check.
      // The command will be queued in stdin if the agent is still initializing
      // and processed once the agent is ready. The 60-second timeout provides
      // ample time for container startup and initialization.
      if (process instanceof ContainerPiProcess) {
        console.log("[session-manager] Container process started, sending initial command as readiness check...")
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      // Always send a set_model command to the pi agent. This serves as a
      // readiness check for container processes (the command will be buffered
      // until the agent is ready) and ensures the model is properly configured.
      // The 60-second timeout gives container processes enough time to fully
      // initialize before the command must be acknowledged.
      if (input.model && input.model !== "default") {
        const modelSelection = parseModelSelection(input.model)
        if (modelSelection) {
          await process.send({
            type: "set_model",
            provider: modelSelection.provider,
            modelId: modelSelection.modelId,
          }, 60_000)
        }
      } else {
        // Even for the default model, send a set_model command as a readiness
        // check. The response (success or error) confirms the agent is alive
        // and processing commands.
        try {
          await process.send({ type: "set_model", provider: "default", modelId: "default" }, 60_000)
          console.log("[session-manager] set_model readiness check succeeded")
        } catch (err) {
          // Non-fatal: default model configuration may not be supported,
          // but the agent responded, which means it's ready for commands.
          const errMsg = err instanceof Error ? err.message : String(err)
          if (errMsg.includes("timeout") || errMsg.includes("time out") || errMsg.includes("timed out")) {
            // If we timed out, the agent is not ready. This is a fatal error.
            throw new Error(`Container pi agent failed to respond within 60 seconds: ${errMsg}`)
          }
          console.log(`[session-manager] set_model with default failed (non-fatal: ${errMsg})`)
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

      // If resuming, send continuation prompt
      if (input.isResume && input.continuationPrompt) {
        await process.send({
          type: "prompt",
          message: input.continuationPrompt,
        }, 30_000)
      }

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
