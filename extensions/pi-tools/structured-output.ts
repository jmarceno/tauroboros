import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"

// ============================================================================
// emit_review_result
// ============================================================================

const ReviewResultParams = Type.Object({
  status: Type.Union(
    [Type.Literal("pass"), Type.Literal("gaps_found"), Type.Literal("blocked")],
    { description: "Review verdict" },
  ),
  summary: Type.String({ description: "Brief summary of review findings" }),
  gaps: Type.Array(Type.String(), { description: "Specific gaps or issues found. Empty array if none." }),
  recommendedPrompt: Type.String({
    description: "Specific prompt to address gaps, or empty string if no gaps",
  }),
})

export interface ReviewResultDetails {
  status: "pass" | "gaps_found" | "blocked"
  summary: string
  gaps: string[]
  recommendedPrompt: string
}

const reviewResultTool = defineTool({
  name: "emit_review_result",
  label: "Emit Review Result",
  description:
    "Call this as your FINAL action to emit a structured review result. Do not output any text after calling this tool.",
  promptSnippet:
    "Call emit_review_result as your final action to submit the review verdict.",
  promptGuidelines: [
    "When asked to review code, ALWAYS call emit_review_result as your final action.",
    "Do not output any text or JSON after calling emit_review_result.",
    "Set status to 'pass' only when ALL goals are complete and no defects remain.",
    "Set status to 'gaps_found' when there are issues that need fixing.",
    "Set status to 'blocked' when the review cannot proceed.",
  ],
  parameters: ReviewResultParams,

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Review result: ${params.status}` }],
      details: {
        status: params.status,
        summary: params.summary,
        gaps: params.gaps,
        recommendedPrompt: params.recommendedPrompt,
      } satisfies ReviewResultDetails,
      terminate: true,
    }
  },
})

// ============================================================================
// emit_repair_decision
// ============================================================================

const RepairDecisionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("queue_implementation"),
      Type.Literal("restore_plan_approval"),
      Type.Literal("reset_backlog"),
      Type.Literal("mark_done"),
      Type.Literal("fail_task"),
      Type.Literal("continue_with_more_reviews"),
      Type.Literal("skip_code_style"),
      Type.Literal("return_to_review"),
    ],
    { description: "The repair action to take" },
  ),
  reason: Type.String({ description: "Why this action was chosen" }),
  errorMessage: Type.Optional(
    Type.String({ description: "Error message for fail_task action" }),
  ),
})

export interface RepairDecisionDetails {
  action:
    | "queue_implementation"
    | "restore_plan_approval"
    | "reset_backlog"
    | "mark_done"
    | "fail_task"
    | "continue_with_more_reviews"
    | "skip_code_style"
    | "return_to_review"
  reason: string
  errorMessage?: string
}

const repairDecisionTool = defineTool({
  name: "emit_repair_decision",
  label: "Emit Repair Decision",
  description:
    "Call this as your FINAL action to emit a structured repair decision. Do not output any text after calling this tool.",
  promptSnippet:
    "Call emit_repair_decision as your final action to submit the repair decision.",
  promptGuidelines: [
    "When asked to decide a repair action, ALWAYS call emit_repair_decision as your final action.",
    "Do not output any text or JSON after calling emit_repair_decision.",
    "Only include errorMessage when action is 'fail_task'.",
  ],
  parameters: RepairDecisionParams,

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Repair decision: ${params.action}` }],
      details: {
        action: params.action,
        reason: params.reason,
        ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
      } satisfies RepairDecisionDetails,
      terminate: true,
    }
  },
})

// ============================================================================
// emit_best_of_n_vote
// ============================================================================

const BestOfNVoteParams = Type.Object({
  status: Type.Union(
    [Type.Literal("pass"), Type.Literal("needs_manual_review")],
    { description: "Review verdict for best-of-n candidates" },
  ),
  summary: Type.String({ description: "Short evaluation summary" }),
  bestCandidateIds: Type.Array(Type.String(), {
    description: "IDs of the best candidate implementations",
  }),
  gaps: Type.Array(Type.String(), {
    description: "Issues found across candidates. Empty array if none.",
  }),
  recommendedFinalStrategy: Type.Union(
    [
      Type.Literal("pick_best"),
      Type.Literal("synthesize"),
      Type.Literal("pick_or_synthesize"),
    ],
    { description: "Strategy for combining candidates" },
  ),
  recommendedPrompt: Type.Optional(
    Type.String({ description: "Optional instructions for the final applier" }),
  ),
})

export interface BestOfNVoteDetails {
  status: "pass" | "needs_manual_review"
  summary: string
  bestCandidateIds: string[]
  gaps: string[]
  recommendedFinalStrategy: "pick_best" | "synthesize" | "pick_or_synthesize"
  recommendedPrompt?: string
}

const bestOfNVoteTool = defineTool({
  name: "emit_best_of_n_vote",
  label: "Emit Best-of-N Vote",
  description:
    "Call this as your FINAL action to emit a structured best-of-n evaluation. Do not output any text after calling this tool.",
  promptSnippet:
    "Call emit_best_of_n_vote as your final action to submit the candidate evaluation.",
  promptGuidelines: [
    "When asked to evaluate best-of-n candidates, ALWAYS call emit_best_of_n_vote as your final action.",
    "Do not output any text or JSON after calling emit_best_of_n_vote.",
  ],
  parameters: BestOfNVoteParams,

  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Best-of-N vote: ${params.status}` }],
      details: {
        status: params.status,
        summary: params.summary,
        bestCandidateIds: params.bestCandidateIds,
        gaps: params.gaps,
        recommendedFinalStrategy: params.recommendedFinalStrategy,
        ...(params.recommendedPrompt
          ? { recommendedPrompt: params.recommendedPrompt }
          : {}),
      } satisfies BestOfNVoteDetails,
      terminate: true,
    }
  },
})

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool(reviewResultTool)
  pi.registerTool(repairDecisionTool)
  pi.registerTool(bestOfNVoteTool)
}