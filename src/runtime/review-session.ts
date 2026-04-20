import { Effect, Schema } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import { resolveContainerImage, type Task, type ThinkingLevel, type ReviewResult } from "../types.ts"
import { buildReviewVariables } from "../prompts/index.ts"
import { PiSessionManager } from "./session-manager.ts"
import { parseStrictJsonObject } from "./strict-json.ts"
import type { PiContainerManager } from "./container-manager.ts"

export class ReviewSessionError extends Schema.TaggedError<ReviewSessionError>()("ReviewSessionError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

function asReviewResultEffect(parsed: Record<string, unknown>): Effect.Effect<ReviewResult, ReviewSessionError> {
  return Effect.try({
    try: () => {
      const status = parsed.status
      if (status !== "pass" && status !== "gaps_found" && status !== "blocked" && status !== "json_parse_max_retries") {
        throw new ReviewSessionError({
          operation: "asReviewResult",
          message: `Review response JSON must include status: pass|gaps_found|blocked|json_parse_max_retries, got: ${String(status)}`,
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
    return Effect.gen(function* () {
      const rendered = this.db.renderPrompt("review", buildReviewVariables(input.task, input.reviewFilePath))

      const imageToUse = resolveContainerImage(input.task, this.settings?.workflow?.container?.image)

      const response = yield* this.sessions.executePrompt({
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
      })

      let parsed: Record<string, unknown>
      let jsonParseFailed = false
      try {
        parsed = parseStrictJsonObject(response.responseText, "Review response")
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        Effect.logDebug(`[review-session] JSON parse failed: ${msg}`).pipe(Effect.runVoid)
        this.db.incrementJsonOutFail(response.session.id, input.model)
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
      }
      const reviewResult = yield* asReviewResultEffect(parsed)
      return {
        reviewResult,
        responseText: response.responseText,
        sessionId: response.session.id,
        jsonParseRetryCount: jsonParseFailed ? input.currentJsonParseRetryCount + 1 : 0,
      }
    }.bind(this))
  }
}
