import { randomUUID } from "crypto"
import { Effect, Schema } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiSessionKind, PiWorkflowSession } from "../db/types.ts"
import type { ThinkingLevel, SessionMessage } from "../types.ts"
import { CollectEventsTimeoutError, PiProcessError, PiRpcProcess } from "./pi-process.ts"
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
  /**
   * Force specific runtime mode for this session.
   * If not specified, uses workflow.container.enabled from settings.
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

/**
 * Effect-based session execution result with event stream
 */
export interface ExecuteSessionPromptResult {
  session: PiWorkflowSession
  responseText: string
  events: Record<string, unknown>[]
}

export class SessionManagerExecuteError extends Schema.TaggedError<SessionManagerExecuteError>()(
  "SessionManagerExecuteError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

function toSessionManagerError(operation: string, cause: unknown): SessionManagerExecuteError {
  return new SessionManagerExecuteError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

/**
 * PiSessionManager - Manages pi RPC sessions
 *
 * Supports both native and containerized execution modes.
 * - Native mode: Spawns pi directly on the host
 * - Container mode: Runs pi inside a gVisor container for isolation
 * 
 * NOTE: All methods return Effects. Callers must run Effects at the boundary.
 */
export class PiSessionManager {
  constructor(
    private readonly db: PiKanbanDB,
    private readonly containerManager?: PiContainerManager,
    private readonly settings?: InfrastructureSettings,
  ) {}

  /**
   * Execute a prompt and return the complete result.
   * Returns an Effect that must be run at the runtime boundary.
   */
  executePrompt(
    input: ExecuteSessionPromptInput,
    callbacks?: {
      onOutput?: (chunk: string) => void
      onSessionMessage?: (message: SessionMessage) => void
      onSessionStart?: (session: PiWorkflowSession) => void
      onSessionCreated?: (process: PiRpcProcess | ContainerPiProcess, session: PiWorkflowSession) => void
    }
  ): Effect.Effect<ExecuteSessionPromptResult, SessionManagerExecuteError | PiProcessError> {
    const self = this
    return Effect.gen(function* () {
      const sessionId = input.resumedSessionId ?? randomUUID().slice(0, 8)
      const existingContainerId = yield* self.resolveExistingContainerIdEffect(input)

      const resolvedModel = yield* self.resolveModel(input.model, input.sessionKind)

      let session: PiWorkflowSession
      if (input.isResume && input.resumedSessionId) {
        const existingSession = self.db.getWorkflowSession(input.resumedSessionId)
        if (existingSession) {
          session =
            self.db.updateWorkflowSession(input.resumedSessionId, {
              status: "starting",
              model: resolvedModel,
            }) ?? existingSession
        } else {
          session = self.db.createWorkflowSession({
            id: sessionId,
            taskId: input.taskId,
            taskRunId: input.taskRunId ?? null,
            sessionKind: input.sessionKind,
            status: "starting",
            cwd: input.cwd,
            worktreeDir: input.worktreeDir ?? null,
            branch: input.branch ?? null,
            model: resolvedModel,
            thinkingLevel: input.thinkingLevel ?? "default",
            startedAt: nowUnix(),
          })
        }
      } else {
        session = self.db.createWorkflowSession({
          id: sessionId,
          taskId: input.taskId,
          taskRunId: input.taskRunId ?? null,
          sessionKind: input.sessionKind,
          status: "starting",
          cwd: input.cwd,
          worktreeDir: input.worktreeDir ?? null,
          branch: input.branch ?? null,
          model: resolvedModel,
          thinkingLevel: input.thinkingLevel ?? "default",
          startedAt: nowUnix(),
        })
      }

      const process = yield* Effect.try({
        try: () =>
          createPiProcess({
            db: self.db,
            session,
            containerManager: self.containerManager,
            onOutput: callbacks?.onOutput,
            onSessionMessage: callbacks?.onSessionMessage,
            forceRuntime: input.forceRuntime,
            settings: self.settings,
            existingContainerId,
            containerImage: input.containerImage,
          }),
        catch: (cause) => toSessionManagerError("createProcess", cause),
      })

      if (callbacks?.onSessionCreated) {
        callbacks.onSessionCreated(process, session)
      }

      // Use acquireRelease to guarantee process cleanup
      const result = yield* Effect.acquireRelease(
        Effect.succeed(process),
        (proc) => proc.close().pipe(Effect.orDie),
      ).pipe(
        Effect.flatMap((proc) =>
          Effect.gen(function* () {
            if (callbacks?.onSessionStart) {
              callbacks.onSessionStart(session)
            }

            if (proc instanceof ContainerPiProcess) {
              yield* proc.start().pipe(
                Effect.mapError((cause) => new SessionManagerExecuteError({
                  operation: "startContainer",
                  message: cause.message,
                  cause,
                })),
              )
            } else {
              yield* proc.start()
            }

            if (!(proc instanceof ContainerPiProcess)) {
              yield* Effect.sleep(500)
            }

            const modelSelection = parseModelSelection(resolvedModel)
            if (!modelSelection) {
              return yield* new SessionManagerExecuteError({
                operation: "parseModel",
                message: `Invalid model format: ${resolvedModel}. Expected 'provider/modelId' (e.g., 'openai/gpt-4')`,
              })
            }

            yield* proc.send(
              {
                type: "set_model",
                provider: modelSelection.provider,
                modelId: modelSelection.modelId,
              },
              60_000,
            ).pipe(
              Effect.mapError((cause) => {
                const errMsg = cause.message
                const msg = errMsg.includes("timeout") || errMsg.includes("time out") || errMsg.includes("timed out")
                  ? `Container pi agent failed to respond within 60 seconds: ${errMsg}`
                  : `Failed to set model ${resolvedModel}: ${errMsg}`
                return new SessionManagerExecuteError({ operation: "setModel", message: msg, cause })
              }),
            )

            if (input.thinkingLevel && input.thinkingLevel !== "default") {
              yield* proc.send(
                {
                  type: "set_thinking_level",
                  level: input.thinkingLevel,
                },
                30_000,
              ).pipe(
                Effect.mapError((cause) => new SessionManagerExecuteError({
                  operation: "setThinkingLevel",
                  message: cause.message,
                  cause,
                })),
              )
            }

            session =
              self.db.updateWorkflowSession(session.id, {
                status: "active",
              }) ?? session

            if (input.isResume && input.continuationPrompt) {
              yield* proc.send(
                {
                  type: "prompt",
                  message: input.continuationPrompt,
                },
                30_000,
              ).pipe(
                Effect.mapError((cause) => new SessionManagerExecuteError({
                  operation: "sendContinuationPrompt",
                  message: cause.message,
                  cause,
                })),
              )
            }

            const events = yield* proc.promptAndWait(input.promptText, 600_000).pipe(
              Effect.mapError((cause) => new SessionManagerExecuteError({
                operation: cause instanceof CollectEventsTimeoutError ? "promptAndWaitTimeout" : "promptAndWait",
                message: cause.message,
                cause,
              })),
            )

            let responseText = ""
            for (let i = events.length - 1; i >= 0; i--) {
              const event = events[i]
              if (event.type === "message_update") {
                const msgEvent = event.assistantMessageEvent as Record<string, unknown> | undefined
                if (msgEvent?.type === "text_complete" || msgEvent?.type === "text") {
                  const text =
                    typeof msgEvent.text === "string"
                      ? msgEvent.text
                      : typeof msgEvent.delta === "string"
                        ? msgEvent.delta
                        : ""
                  if (text) {
                    responseText = text
                    break
                  }
                }
              }
            }

            if (!responseText) {
              const messagesResult = yield* proc.send({ type: "get_messages" }, 30_000).pipe(
                Effect.catchTag("PiProcessError", () => Effect.succeed(null)),
              )
              if (messagesResult && Array.isArray(messagesResult.messages)) {
                const messages = messagesResult.messages as PiMessage[]
                const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant")
                if (lastAssistantMsg) {
                  responseText = extractTextFromPiMessage(lastAssistantMsg)
                }
              }
            }

            return {
              session: self.db.getWorkflowSession(session.id) ?? session,
              responseText,
              events,
            }
          }).pipe(
            // On any failure, mark session as failed before propagating error
            Effect.tapError((error) =>
              Effect.sync(() => {
                self.db.updateWorkflowSession(session.id, {
                  status: "failed",
                  errorMessage: error.message,
                  finishedAt: nowUnix(),
                })
              }),
            ),
          ),
        ),
        Effect.scoped,
      )

      return result
    })
  }

  private resolveExistingContainerIdEffect(input: ExecuteSessionPromptInput): Effect.Effect<string | null> {
    if (!input.isResume || !input.resumedSessionId || !input.worktreeDir) {
      return Effect.succeed(null)
    }

    const pauseState = loadPausedRunState()
    if (!pauseState || !this.containerManager) {
      return Effect.succeed(null)
    }

    const pausedSession = pauseState.sessions.find((session) => session.sessionId === input.resumedSessionId)
    if (!pausedSession?.containerId) {
      return Effect.succeed(null)
    }
    const pausedContainerId = pausedSession.containerId

    return Effect.tryPromise({
      try: async () => {
        const containerInfo = await this.containerManager!.checkContainerById(pausedContainerId)
        if (!containerInfo?.running) {
          return null
        }
        return pausedContainerId
      },
      catch: () => null as null,
    }).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
  }

  /**
   * Resolve the model to use for a session based on kind and database options.
   * If 'default' is specified, looks up the corresponding model in options.
   * Fails if no model can be resolved.
   */
  private resolveModel(model: string | undefined, sessionKind: PiSessionKind): Effect.Effect<string, SessionManagerExecuteError> {
    const options = this.db.getOptions()
    let resolved = model || "default"

    if (resolved === "default") {
      switch (sessionKind) {
        case "plan":
        case "plan_revision":
        case "planning":
          resolved = options.planModel
          break
        case "task_run_reviewer":
        case "review_scratch":
          resolved = options.reviewModel
          break
        case "repair":
          resolved = options.repairModel
          break
        case "task":
        case "task_run_worker":
        case "task_run_final_applier":
        default:
          resolved = options.executionModel
          break
      }
    }

    if (!resolved || resolved === "default" || resolved.trim() === "") {
      return Effect.fail(new SessionManagerExecuteError({
        operation: "resolveModel",
        message: `Failed to resolve model for ${sessionKind}: No model is set for this task and no default model is configured in options. Please set a model in task settings or global options.`,
      }))
    }

    return Effect.succeed(resolved)
  }
}

