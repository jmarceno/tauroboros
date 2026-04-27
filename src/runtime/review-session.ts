import { Effect, Schema } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import { resolveContainerImage, type Task, type ThinkingLevel, type ReviewResult } from "../types.ts"
import { buildReviewVariables } from "../prompts/index.ts"
import { PiSessionManager, SessionManagerExecuteError } from "./session-manager.ts"
import { parseStrictJsonObject } from "./strict-json.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { PiProcessError } from "./pi-process.ts"
import { StructuredOutputExtractor, StructuredOutputNotFoundError } from "./structured-output-extractor.ts"

export class ReviewSessionError extends Schema.TaggedError<ReviewSessionError>()("ReviewSessionError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

function asReviewResultEffect(parsed: Record<string, unknown>): Effect.Effect<ReviewResult, ReviewSessionError> {
  return Effect.try({
    try: () => {
      const status = parsed.status
      if (status !== "pass" && status !== "gaps_found" && status !== "blocked") {
        throw new ReviewSessionError({
          operation: "asReviewResult",
          message: `Review response JSON must include status: pass|gaps_found|blocked, got: ${String(status)}`,
        })
      }

      const summary = typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "No summary provided"

      const gaps = Array.isArray(parsed.gaps)
        ? parsed.gaps.map((item) => String(item).trim()).filter(Boolean)
        : []

      const recommendedPrompt = typeof parsed.recommendedPrompt === "string"
        ? parsed.recommendedPrompt.trim()
        : ""

      return {
        status,
        summary,
        gaps,
        recommendedPrompt,
      }
    },
    catch: (cause) => new ReviewSessionError({
      operation: "asReviewResult",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  })
}

export interface RunReviewScratchInput {
  task: Task
  cwd: string
  worktreeDir: string
  branch: string
  reviewFilePath: string
  model: string
  thinkingLevel: ThinkingLevel
  maxJsonParseRetries: number
  currentJsonParseRetryCount: number
  onOutput?: (chunk: string) => void
  onSessionCreated?: (process: import("./container-pi-process.ts").ContainerPiProcess | import("./pi-process.ts").PiRpcProcess, session: import("../db/types.ts").PiWorkflowSession) => void
}

export interface RunReviewScratchResult {
  reviewResult: ReviewResult
  responseText: string
  sessionId: string
  jsonParseRetryCount: number
}

/**
 * Try to extract review result from tool_execution_end events.
 * Returns null if no tool event is found (fall back to JSON parsing).
 */
function tryExtractReviewFromToolEvents(
  events: Record<string, unknown>[],
): ReviewResult | null {
  const extractor = new StructuredOutputExtractor()
  const details = extractor.extractFromEvents<{
    status: string
    summary: string
    gaps: string[]
    recommendedPrompt: string
  }>(events, "emit_review_result")

  if (!details) return null

  const status = details.status
  if (status !== "pass" && status !== "gaps_found" && status !== "blocked") return null

  return {
    status,
    summary: details.summary || "No summary provided",
    gaps: Array.isArray(details.gaps) ? details.gaps.map((g) => String(g).trim()).filter(Boolean) : [],
    recommendedPrompt: typeof details.recommendedPrompt === "string" ? details.recommendedPrompt.trim() : "",
  }
}

export class PiReviewSessionRunner {
  private readonly sessions: PiSessionManager

  constructor(
    private readonly db: PiKanbanDB,
    private readonly settings?: InfrastructureSettings,
    containerManager?: PiContainerManager,
    externalSessionManager?: PiSessionManager,
  ) {
    this.sessions = externalSessionManager ?? new PiSessionManager(db, containerManager, settings)
  }

  run(input: RunReviewScratchInput): Effect.Effect<RunReviewScratchResult, ReviewSessionError> {
    const self = this
    return Effect.gen(function* () {
      const rendered = self.db.renderPrompt("review", buildReviewVariables(input.task, input.reviewFilePath))

      const imageToUse = resolveContainerImage(input.task, self.settings?.workflow?.container?.image)

      const response = yield* self.sessions.executePrompt({
        taskId: input.task.id,
        sessionKind: "review_scratch",
        cwd: input.cwd,
        worktreeDir: input.worktreeDir,
        branch: input.branch,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        promptText: rendered.renderedText,
        containerImage: imageToUse,
      }, {
        onOutput: input.onOutput,
        onSessionCreated: input.onSessionCreated,
      }).pipe(
        Effect.mapError((cause) =>
          new ReviewSessionError({
            operation: cause instanceof SessionManagerExecuteError ? cause.operation : cause instanceof PiProcessError ? cause.operation : "run",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        ),
      )

      // Phase A: Try structured output from tool events first
      const toolResult = tryExtractReviewFromToolEvents(response.events)
      if (toolResult) {
        return {
          reviewResult: toolResult,
          responseText: response.responseText,
          sessionId: response.session.id,
          jsonParseRetryCount: 0,
        }
      }

      // Fallback: Parse JSON from response text (backward compatibility)
      const parsedResult = yield* Effect.either(
        Effect.try({
          try: () => parseStrictJsonObject(response.responseText, "Review response"),
          catch: (error) =>
            new ReviewSessionError({
              operation: "parseReviewResponse",
              message: error instanceof Error ? error.message : String(error),
              cause: error,
            }),
        }),
      )

      let parsed: Record<string, unknown>
      let jsonParseFailed = false
      if (parsedResult._tag === "Left") {
        const error = parsedResult.left
        const msg = error instanceof Error ? error.message : String(error)
        yield* Effect.logDebug(`[review-session] JSON parse failed: ${msg}`)
        self.db.incrementJsonOutFail(response.session.id, input.model)
        jsonParseFailed = true

        const newRetryCount = input.currentJsonParseRetryCount + 1
        if (newRetryCount >= input.maxJsonParseRetries) {
          return {
            reviewResult: {
              status: "json_parse_max_retries" as const,
              summary: `Max JSON parse retries (${input.maxJsonParseRetries}) reached. The review model is not returning valid JSON.`,
              gaps: ["Model consistently returns invalid JSON - task marked as stuck"],
              recommendedPrompt: "",
            },
            responseText: response.responseText,
            sessionId: response.session.id,
            jsonParseRetryCount: newRetryCount,
          }
        }

        parsed = {
          status: "gaps_found",
          summary: `Review model did not return valid JSON (retry ${newRetryCount}/${input.maxJsonParseRetries}). Raw response: ${response.responseText.slice(0, 500)}`,
          gaps: ["Model response was not valid JSON - retrying with fix"],
          recommendedPrompt: "",
        }
      } else {
        parsed = parsedResult.right
      }
      const reviewResult = yield* asReviewResultEffect(parsed)
      return {
        reviewResult,
        responseText: response.responseText,
        sessionId: response.session.id,
        jsonParseRetryCount: jsonParseFailed ? input.currentJsonParseRetryCount + 1 : 0,
      }
    })
  }
}