import { randomUUID } from "crypto"
import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"
import {
  DEFAULT_COMMIT_PROMPT,
  DEFAULT_CODE_STYLE_PROMPT,
  type BestOfNConfig,
  type ColumnSortPreferences,
  type CreateSessionMessageInput,
  type ExecutionPhase,
  type ExecutionStrategy,
  type MessageType,
  type Options,
  type SessionMessage,
  type SessionUsageRollup,
  type Task,
  type TaskCandidate,
  type TaskRun,
  type TaskStatus,
  type TelegramNotificationLevel,
  type ThinkingLevel,
  type TimelineEntry,
  type WorkflowRun,
  type WorkflowRunKind,
  type WorkflowRunStatus,
} from "./types.ts"

export type TaskStatusChangeListener = (taskId: string, oldStatus: TaskStatus, newStatus: TaskStatus) => void
import { runMigrations, type Migration } from "./db/migrations.ts"
import type {
  CreateTaskCandidateInput,
  CreateTaskRunInput,
  CreatePiWorkflowSessionInput,
  CreateTaskInput,
  CreateWorkflowRunInput,
  PiSessionStatus,
  PiWorkflowSession,
  PlanningPrompt,
  PlanningPromptVersion,
  PromptRenderAndCaptureInput,
  PromptRenderResult,
  PromptTemplate,
  PromptTemplateKey,
  PromptTemplateVersion,
  SessionMessageQueryOptions,
  UpdateTaskCandidateInput,
  UpdateTaskRunInput,
  UpdatePiWorkflowSessionInput,
  UpdateTaskInput,
  UpdateWorkflowRunInput,
  UpsertPromptTemplateInput,
  UpsertPlanningPromptInput,
  UpdatePlanningPromptInput,
  ContainerPackage,
  ContainerBuild,
  CreateContainerPackageInput,
  CreateSelfHealReportInput,
  WorkflowRunIndicators,
  JsonOutFailEntry,
  CreateWorkflowRunIndicatorsInput,
  SelfHealReport,
  CreateTaskGroupDTO,
  UpdateTaskGroupDTO,
  TaskGroup,
  TaskGroupMember,
  StatsTimeRange,
  UsageStats,
  TaskStats,
  ModelUsageStats,
  HourlyUsage,
  DailyUsage,
} from "./db/types.ts"
import { renderTemplate } from "./prompts/renderer.ts"
import { parseModelSelection } from "./runtime/model-utils.ts"
import { projectPiEventToSessionMessage } from "./runtime/message-projection.ts"

// Color palette for workflow runs - distinct colors that work well with dark theme
const RUN_COLORS = [
  "#ff6b6b", // Red
  "#4ecdc4", // Teal
  "#45b7d1", // Blue
  "#96ceb4", // Green
  "#feca57", // Yellow
  "#ff9ff3", // Pink
  "#54a0ff", // Light Blue
  "#48dbfb", // Cyan
  "#1dd1a1", // Mint
  "#ffc048", // Orange
  "#5f27cd", // Purple
  "#00d2d3", // Turquoise
]

function pickRunColor(usedColors: string[]): string {
  const available = RUN_COLORS.filter(c => !usedColors.includes(c))
  if (available.length === 0) return RUN_COLORS[Math.floor(Math.random() * RUN_COLORS.length)]
  return available[0]
}

const DEFAULT_OPTIONS: Options = {
  commitPrompt: DEFAULT_COMMIT_PROMPT,
  extraPrompt: "",
  branch: "",
  planModel: "",
  executionModel: "",
  reviewModel: "",
  repairModel: "",
  command: "",
  parallelTasks: 1,
  autoDeleteNormalSessions: false,
  autoDeleteReviewSessions: false,
  showExecutionGraph: true,
  port: 3789,
  thinkingLevel: "default",
  planThinkingLevel: "default",
  executionThinkingLevel: "default",
  reviewThinkingLevel: "default",
  repairThinkingLevel: "default",
  codeStylePrompt: "",
  telegramBotToken: "",
  telegramChatId: "",
  telegramNotificationLevel: "all",
  maxReviews: 2,
  maxJsonParseRetries: 5,
  columnSorts: undefined,
}

type PromptSeed = {
  key: PromptTemplateKey
  name: string
  description: string
  templateText: string
  variablesJson: string[]
}

const DEFAULT_PROMPT_TEMPLATES: PromptSeed[] = [
  {
    key: "execution",
    name: "Task Execution",
    description: "Core implementation prompt for standard and approved-plan execution.",
    templateText: [
      "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.",
      "",
      "{{execution_intro}}",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "{{approved_plan_block}}",
      "{{user_guidance_block}}",
      "{{additional_context_block}}",
      "",
      "Implementation requirements:",
      "- Make concrete code changes in this worktree.",
      "- Keep changes scoped to the task goals.",
      "- Validate your result with focused checks before finishing.",
      "- Report concise progress and outcomes.",
    ].join("\n"),
    variablesJson: [
      "task",
      "execution_intro",
      "approved_plan_block",
      "user_guidance_block",
      "additional_context_block",
    ],
  },
  {
    key: "planning",
    name: "Plan Generation",
    description: "Planning-only prompt used before implementation begins.",
    templateText: [
      "PREPARE PLAN ONLY. Do not ask follow-up questions. Make reasonable assumptions from the codebase. Output only the plan — do not proceed to implementation.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Plan requirements:",
      "- Break work into clear, ordered implementation steps.",
      "- Include validation and verification approach.",
      "- Keep scope aligned to task goals and constraints.",
    ].join("\n"),
    variablesJson: ["task", "additional_context_block"],
  },
  {
    key: "plan_revision",
    name: "Plan Revision",
    description: "Revises a captured plan using user feedback while staying in planning mode.",
    templateText: [
      "PREPARE PLAN ONLY. Do not ask follow-up questions. Make reasonable assumptions from the codebase. Output only the plan — do not proceed to implementation.",
      "",
      "The user has reviewed your plan and requested changes. Revise the plan based on feedback.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "Previous plan:",
      "{{current_plan}}",
      "",
      "User feedback:",
      "{{revision_feedback}}",
      "",
      "{{additional_context_block}}",
      "",
      "Provide a revised plan that directly addresses the feedback.",
    ].join("\n"),
    variablesJson: ["task", "current_plan", "revision_feedback", "additional_context_block"],
  },
  {
    key: "review",
    name: "Review",
    description: "Strict repository review prompt with JSON output contract.",
    templateText: [
      "You are the workflow review agent. You are strict and thorough.",
      "",
      "Review the current repository state against the task review file named in the user prompt.",
      "Use that review file as the source of truth for goals and review instructions.",
      "Inspect the codebase and branch state directly.",
      "Do not rely on prior session history.",
      "Do not make code changes.",
      "",
      "Review the task review file at: {{review_file_path}}",
      "",
      "Review Criteria:",
      "1) Goal completeness: every goal must map to verified working code.",
      "2) Errors and bugs: logic issues, null handling, boundary failures, race conditions, exceptions.",
      "3) Security flaws: injection, missing validation, hardcoded secrets, unsafe file/path operations.",
      "4) Best practices: error handling, type safety, cleanup, edge cases, project conventions.",
      "5) Test coverage: critical paths and new behavior should be testable and covered.",
      "",
      "Strictness directive: default to finding gaps. Only return pass when all goals are complete and no unresolved defects remain.",
      "",
      "IMPORTANT: Your ENTIRE response must be a single JSON object. Do NOT include any text before or after the JSON. Do NOT wrap it in markdown code blocks. Output ONLY the JSON object:",
      "",
      "{\"status\": \"pass|gaps_found|blocked\", \"summary\": \"<brief summary of review findings>\", \"gaps\": [\"<first gap if any>\", \"<second gap if any>\"], \"recommendedPrompt\": \"<specific prompt to address gaps, or empty string if no gaps>\"}",
      "",
      "Context:",
      "Task ID: {{task.id}}",
      "Task Name: {{task.name}}",
    ].join("\n"),
    variablesJson: ["task", "review_file_path"],
  },
  {
    key: "review_fix",
    name: "Review Fix",
    description: "Follow-up prompt that fixes issues identified by review.",
    templateText: [
      "Address the issues found during review and update the implementation.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "Review summary:",
      "{{review_summary}}",
      "",
      "Gaps:",
      "{{review_gaps}}",
      "",
      "Requirements:",
      "- Fix all listed gaps completely.",
      "- Preserve existing correct behavior.",
      "- Keep the solution scoped and production-ready.",
    ].join("\n"),
    variablesJson: ["task", "review_summary", "review_gaps"],
  },
  {
    key: "repair",
    name: "Repair",
    description: "Deterministic workflow state repair analysis prompt.",
    templateText: [
      "You repair workflow task states.",
      "",
      "Analyze the task state, worktree git status, session history, and latest output. Choose what ACTUALLY happened and the right repair action.",
      "",
      "Choose exactly one action:",
      "- queue_implementation",
      "- restore_plan_approval",
      "- reset_backlog",
      "- mark_done",
      "- fail_task",
      "- continue_with_more_reviews",
      "",
      "Decision guidelines:",
      "- Prefer queue_implementation when a usable [plan] exists and worktree shows real code changes.",
      "- Prefer mark_done only when output and worktree both confirm completion.",
      "- Use restore_plan_approval when plan should return to human review.",
      "- Use reset_backlog when there are no meaningful changes and task should restart.",
      "- Use fail_task when state is invalid and should remain visible with actionable error.",
      "- Use continue_with_more_reviews when task is stuck only due to review limit and gaps seem fixable.",
      "",
      "Critical verification steps:",
      "1) Check worktree git status.",
      "2) Check session messages for where execution stopped.",
      "3) Check workflow session history patterns.",
      "4) Compare latest output claims with actual worktree changes.",
      "",
      "Context:",
      "{{repair_context}}",
      "",
      "Return strict JSON: {\"action\":\"...\",\"reason\":\"...\",\"errorMessage\":\"optional\"}",
    ].join("\n"),
    variablesJson: ["task", "repair_context"],
  },
  {
    key: "best_of_n_worker",
    name: "Best-of-N Worker",
    description: "Worker prompt for candidate implementation generation in best-of-n.",
    templateText: [
      "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.",
      "",
      "You are one candidate implementation worker in a best-of-n workflow.",
      "Produce the best complete solution you can in this worktree.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Worker metadata:",
      "- Slot index: {{slot_index}}",
      "- Model: {{model}}",
      "- Worker instructions: {{task_suffix}}",
      "",
      "Deliver complete implementation and a concise summary of what changed.",
    ].join("\n"),
    variablesJson: ["task", "slot_index", "model", "task_suffix", "additional_context_block"],
  },
  {
    key: "best_of_n_reviewer",
    name: "Best-of-N Reviewer",
    description: "Reviewer prompt for evaluating best-of-n candidates with strict JSON output.",
    templateText: [
      "You are a reviewer in a best-of-n workflow.",
      "Your job is to evaluate the candidate implementations and provide structured guidance.",
      "",
      "Original Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Candidates:",
      "{{candidate_summaries}}",
      "",
      "Your response must be valid JSON with fields:",
      '"status": "pass|needs_manual_review",',
      '"summary": "<short evaluation summary>",',
      '"bestCandidateIds": ["<candidate-id-1>", "<candidate-id-2>"],',
      '"gaps": ["<issue 1>", "<issue 2>"],',
      '"recommendedFinalStrategy": "pick_best|synthesize|pick_or_synthesize",',
      '"recommendedPrompt": "<optional instructions for the final applier, or null>"',
      "",
      "Additional reviewer instructions:",
      "{{task_suffix}}",
    ].join("\n"),
    variablesJson: ["task", "candidate_summaries", "task_suffix", "additional_context_block"],
  },
  {
    key: "best_of_n_final_applier",
    name: "Best-of-N Final Applier",
    description: "Final applier prompt to produce final implementation from best-of-n results.",
    templateText: [
      "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.",
      "",
      "You are the final applier in a best-of-n workflow.",
      "Produce the final implementation based on the original task and reviewer guidance.",
      "",
      "Original Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Selection mode:",
      "{{selection_mode}}",
      "",
      "Candidate guidance:",
      "{{candidate_guidance}}",
      "",
      "Recurring reviewer gaps:",
      "{{recurring_gaps}}",
      "",
      "Reviewer recommended prompts:",
      "{{reviewer_recommended_prompts}}",
      "",
      "Consensus reached: {{consensus_reached}}",
      "",
      "Additional final-applier instructions:",
      "{{task_suffix}}",
      "",
      "Produce the final implementation now.",
    ].join("\n"),
    variablesJson: [
      "task",
      "selection_mode",
      "candidate_guidance",
      "recurring_gaps",
      "reviewer_recommended_prompts",
      "consensus_reached",
      "task_suffix",
      "additional_context_block",
    ],
  },
  {
    key: "commit",
    name: "Commit",
    description: "Commit instructions executed after task completion.",
    templateText: `${DEFAULT_COMMIT_PROMPT}\n\n{{keep_worktree_note}}`,
    variablesJson: ["base_ref", "keep_worktree_note"],
  },
]

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function parseJSON<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.length === 0) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function asThinkingLevel(value: unknown): ThinkingLevel {
  if (value === "low" || value === "medium" || value === "high" || value === "default") {
    return value
  }
  throw new Error(`Invalid thinking level: ${JSON.stringify(value)}. Expected "low", "medium", "high", or "default".`)
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "true" || normalized === "1") return true
    if (normalized === "false" || normalized === "0") return false
  }
  throw new Error(`Invalid boolean value: ${JSON.stringify(value)}. Expected boolean, 0/1, or "true"/"false".`)
}

const TASK_STATUSES: TaskStatus[] = ["template", "backlog", "queued", "executing", "review", "code-style", "done", "failed", "stuck"]

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus)
}

function asTaskStatus(value: unknown): TaskStatus {
  if (isTaskStatus(value)) return value
  throw new Error(`Invalid task status: ${JSON.stringify(value)}. Expected one of: ${TASK_STATUSES.join(", ")}.`)
}

const EXECUTION_PHASES: ExecutionPhase[] = [
  "not_started",
  "plan_complete_waiting_approval",
  "plan_revision_pending",
  "implementation_pending",
  "implementation_done",
]

function isExecutionPhase(value: unknown): value is ExecutionPhase {
  return typeof value === "string" && EXECUTION_PHASES.includes(value as ExecutionPhase)
}

function asExecutionPhase(value: unknown): ExecutionPhase {
  if (isExecutionPhase(value)) return value
  throw new Error(`Invalid execution phase: ${JSON.stringify(value)}. Expected one of: ${EXECUTION_PHASES.join(", ")}.`)
}

const EXECUTION_STRATEGIES: ExecutionStrategy[] = ["best_of_n", "standard"]

function isExecutionStrategy(value: unknown): value is ExecutionStrategy {
  return typeof value === "string" && EXECUTION_STRATEGIES.includes(value as ExecutionStrategy)
}

function asExecutionStrategy(value: unknown): ExecutionStrategy {
  if (isExecutionStrategy(value)) return value
  throw new Error(`Invalid execution strategy: ${JSON.stringify(value)}. Expected "best_of_n" or "standard".`)
}

const BEST_OF_N_SUBSTAGES: Task["bestOfNSubstage"][] = [
  "workers_running",
  "reviewers_running",
  "final_apply_running",
  "blocked_for_manual_review",
  "completed",
  "idle",
]

function isBestOfNSubstage(value: unknown): value is Task["bestOfNSubstage"] {
  return typeof value === "string" && BEST_OF_N_SUBSTAGES.includes(value as Task["bestOfNSubstage"])
}

function asBestOfNSubstage(value: unknown): Task["bestOfNSubstage"] {
  if (isBestOfNSubstage(value)) return value
  throw new Error(`Invalid best-of-n substage: ${JSON.stringify(value)}. Expected one of: ${BEST_OF_N_SUBSTAGES.join(", ")}.`)
}

const WORKFLOW_RUN_KINDS: WorkflowRunKind[] = ["all_tasks", "single_task", "workflow_review", "group_tasks"]

function isWorkflowRunKind(value: unknown): value is WorkflowRunKind {
  return typeof value === "string" && WORKFLOW_RUN_KINDS.includes(value as WorkflowRunKind)
}

function asWorkflowRunKind(value: unknown): WorkflowRunKind {
  if (isWorkflowRunKind(value)) return value
  throw new Error(`Invalid workflow run kind: ${JSON.stringify(value)}. Expected one of: ${WORKFLOW_RUN_KINDS.join(", ")}.`)
}

const WORKFLOW_RUN_STATUSES: WorkflowRunStatus[] = ["queued", "running", "paused", "stopping", "completed", "failed"]

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === "string" && WORKFLOW_RUN_STATUSES.includes(value as WorkflowRunStatus)
}

function asWorkflowRunStatus(value: unknown): WorkflowRunStatus {
  if (isWorkflowRunStatus(value)) return value
  throw new Error(`Invalid workflow run status: ${JSON.stringify(value)}. Expected one of: ${WORKFLOW_RUN_STATUSES.join(", ")}.`)
}

const PI_SESSION_STATUSES: PiSessionStatus[] = ["starting", "active", "paused", "completed", "failed", "aborted"]

function isPiSessionStatus(value: unknown): value is PiSessionStatus {
  return typeof value === "string" && PI_SESSION_STATUSES.includes(value as PiSessionStatus)
}

function asPiSessionStatus(value: unknown): PiSessionStatus {
  if (isPiSessionStatus(value)) return value
  throw new Error(`Invalid Pi session status: ${JSON.stringify(value)}. Expected one of: ${PI_SESSION_STATUSES.join(", ")}.`)
}

const TASK_GROUP_STATUSES: TaskGroup["status"][] = ["active", "completed", "archived"]

export function isTaskGroupStatus(value: unknown): value is TaskGroup["status"] {
  return typeof value === "string" && TASK_GROUP_STATUSES.includes(value as TaskGroup["status"])
}

function asTaskGroupStatus(value: unknown): TaskGroup["status"] {
  if (isTaskGroupStatus(value)) return value
  throw new Error(`Invalid task group status: ${JSON.stringify(value)}. Expected one of: ${TASK_GROUP_STATUSES.join(", ")}.`)
}

export function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value)
}

export function validateTaskGroupName(name: unknown): { valid: boolean; error?: string } {
  if (typeof name !== "string") return { valid: false, error: "name must be a string" }
  if (name.trim().length === 0) return { valid: false, error: "name cannot be empty" }
  if (name.length > 100) return { valid: false, error: "name must be 100 characters or less" }
  return { valid: true }
}

export function validateTaskIds(taskIds: unknown, db: PiKanbanDB): { valid: boolean; error?: string; invalidIds?: string[] } {
  if (!Array.isArray(taskIds)) return { valid: false, error: "taskIds must be an array" }
  if (taskIds.length === 0) return { valid: true }

  const invalidIds: string[] = []
  for (const id of taskIds) {
    if (typeof id !== "string") {
      invalidIds.push(String(id))
      continue
    }
    if (!db.getTask(id)) invalidIds.push(id)
  }

  if (invalidIds.length > 0) {
    return { valid: false, error: `Invalid or non-existent task IDs: ${invalidIds.join(', ')}`, invalidIds }
  }
  return { valid: true }
}

const MESSAGE_TYPES: MessageType[] = [
  "text",
  "tool_call",
  "tool_result",
  "error",
  "step_start",
  "step_finish",
  "session_start",
  "session_end",
  "session_status",
  "thinking",
  "user_prompt",
  "assistant_response",
  "tool_request",
  "permission_asked",
  "permission_replied",
  "session_error",
  "message_part",
]

function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && MESSAGE_TYPES.includes(value as MessageType)
}

function asMessageType(value: unknown): MessageType {
  if (isMessageType(value)) return value
  throw new Error(`Invalid message type: ${JSON.stringify(value)}. Expected one of: ${MESSAGE_TYPES.join(", ")}.`)
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

const SECONDS_IN_DAY = 86400

// Query result row interfaces for type-safe database access
interface TokenCostRow {
  total_tokens: number | null
  total_cost: number | null
}

interface CountRow {
  cnt: number | null
}

interface AvgReviewsRow {
  avg_reviews: number | null
}

interface ModelUsageRow {
  session_kind: string
  model: string
  cnt: number | null
}

interface AvgDurationRow {
  avg_duration: number | null
}

interface HourlyUsageRow {
  hour_bucket: number
  tokens: number | null
  cost: number | null
}

interface DailyUsageRow {
  date_str: string
  tokens: number | null
  cost: number | null
}

const SESSION_MESSAGE_SELECT = `
  SELECT
    sm.*,
    ws.task_id AS task_id,
    ws.task_run_id AS task_run_id
  FROM session_messages sm
  LEFT JOIN workflow_sessions ws ON ws.id = sm.session_id
`

function rowToTask(row: Record<string, unknown>): Task {
  const bestOfNConfigRaw = parseJSON<BestOfNConfig>(row.best_of_n_config)

  return {
    id: String(row.id),
    name: String(row.name),
    idx: Number(row.idx ?? 0),
    prompt: String(row.prompt ?? ""),
    branch: String(row.branch ?? ""),
    planModel: String(row.plan_model ?? "default"),
    executionModel: String(row.execution_model ?? "default"),
    planmode: Number(row.planmode ?? 0) === 1,
    autoApprovePlan: Number(row.auto_approve_plan ?? 0) === 1,
    review: Number(row.review ?? 1) === 1,
    autoCommit: Number(row.auto_commit ?? 1) === 1,
    deleteWorktree: Number(row.delete_worktree ?? 1) === 1,
    status: asTaskStatus(row.status),
    requirements: parseJSON<string[]>(row.requirements) ?? [],
    agentOutput: String(row.agent_output ?? ""),
    reviewCount: Number(row.review_count ?? 0),
    jsonParseRetryCount: Number(row.json_parse_retry_count ?? 0),
    sessionId: row.session_id ? String(row.session_id) : null,
    sessionUrl: row.session_url ? String(row.session_url) : null,
    worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
    thinkingLevel: asThinkingLevel(row.thinking_level),
    planThinkingLevel: asThinkingLevel(row.plan_thinking_level),
    executionThinkingLevel: asThinkingLevel(row.execution_thinking_level),
    executionPhase: asExecutionPhase(row.execution_phase),
    awaitingPlanApproval: Number(row.awaiting_plan_approval ?? 0) === 1,
    planRevisionCount: Number(row.plan_revision_count ?? 0),
    executionStrategy: asExecutionStrategy(row.execution_strategy),
    bestOfNConfig: bestOfNConfigRaw ?? null,
    bestOfNSubstage: asBestOfNSubstage(row.best_of_n_substage),
    skipPermissionAsking: Number(row.skip_permission_asking ?? 1) === 1,
    maxReviewRunsOverride: row.max_review_runs_override === null || row.max_review_runs_override === undefined
      ? null
      : Number(row.max_review_runs_override),
    smartRepairHints: row.smart_repair_hints ? String(row.smart_repair_hints) : null,
    reviewActivity: row.review_activity === "running" ? "running" : "idle",
    isArchived: Number(row.is_archived ?? 0) === 1,
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
    containerImage: row.container_image ? String(row.container_image) : undefined,
    codeStyleReview: Number(row.code_style_review ?? 0) === 1,
    groupId: row.group_id ? String(row.group_id) : undefined,
    selfHealStatus:
      row.self_heal_status === "investigating"
        ? "investigating"
        : row.self_heal_status === "recovering"
          ? "recovering"
          : "idle",
    selfHealMessage: row.self_heal_message ? String(row.self_heal_message) : null,
    selfHealReportId: row.self_heal_report_id ? String(row.self_heal_report_id) : null,
  }
}

function rowToSelfHealReport(row: Record<string, unknown>): SelfHealReport {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    taskStatus: asTaskStatus(row.task_status),
    errorMessage: row.error_message ? String(row.error_message) : null,
    diagnosticsSummary: String(row.diagnostics_summary ?? ""),
    rootCauses: parseJSON<string[]>(row.root_causes_json) ?? [],
    proposedSolution: String(row.proposed_solution ?? ""),
    implementationPlan: parseJSON<string[]>(row.implementation_plan_json) ?? [],
    recoverable: Number(row.recoverable ?? 0) === 1,
    recommendedAction: row.recommended_action === "restart_task" ? "restart_task" : "keep_failed",
    actionRationale: String(row.action_rationale ?? ""),
    sourceMode:
      row.source_mode === "local"
        ? "local"
        : row.source_mode === "github_clone"
          ? "github_clone"
          : "github_metadata_only",
    sourcePath: row.source_path ? String(row.source_path) : null,
    githubUrl: String(row.github_url ?? ""),
    tauroborosVersion: String(row.tauroboros_version ?? ""),
    dbPath: String(row.db_path ?? ""),
    dbSchemaJson: parseJSON<Record<string, unknown>>(row.db_schema_json) ?? {},
    rawResponse: String(row.raw_response ?? ""),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

const TASK_RUN_PHASES: TaskRun["phase"][] = ["worker", "reviewer", "final_applier"]
const TASK_RUN_STATUSES: TaskRun["status"][] = ["pending", "running", "done", "failed", "skipped"]

function isTaskRunPhase(value: unknown): value is TaskRun["phase"] {
  return typeof value === "string" && TASK_RUN_PHASES.includes(value as TaskRun["phase"])
}

function isTaskRunStatus(value: unknown): value is TaskRun["status"] {
  return typeof value === "string" && TASK_RUN_STATUSES.includes(value as TaskRun["status"])
}

function rowToTaskRun(row: Record<string, unknown>): TaskRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    phase: isTaskRunPhase(row.phase) ? row.phase : "worker",
    slotIndex: Number(row.slot_index ?? 0),
    attemptIndex: Number(row.attempt_index ?? 0),
    model: String(row.model ?? "default"),
    taskSuffix: row.task_suffix ? String(row.task_suffix) : null,
    status: isTaskRunStatus(row.status) ? row.status : "pending",
    sessionId: row.session_id ? String(row.session_id) : null,
    sessionUrl: row.session_url ? String(row.session_url) : null,
    worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
    summary: row.summary ? String(row.summary) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    candidateId: row.candidate_id ? String(row.candidate_id) : null,
    metadataJson: parseJSON<Record<string, unknown>>(row.metadata_json) ?? {},
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
  }
}

const TASK_CANDIDATE_STATUSES: TaskCandidate["status"][] = ["available", "selected", "rejected"]

function isTaskCandidateStatus(value: unknown): value is TaskCandidate["status"] {
  return typeof value === "string" && TASK_CANDIDATE_STATUSES.includes(value as TaskCandidate["status"])
}

function rowToTaskCandidate(row: Record<string, unknown>): TaskCandidate {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    workerRunId: String(row.worker_run_id),
    status: isTaskCandidateStatus(row.status) ? row.status : "available",
    changedFilesJson: parseJSON<string[]>(row.changed_files_json) ?? [],
    diffStatsJson: parseJSON<Record<string, number>>(row.diff_stats_json) ?? {},
    verificationJson: parseJSON<Record<string, unknown>>(row.verification_json) ?? {},
    summary: row.summary ? String(row.summary) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

function rowToWorkflowRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: String(row.id),
    kind: asWorkflowRunKind(row.kind),
    status: asWorkflowRunStatus(row.status),
    displayName: String(row.display_name ?? ""),
    targetTaskId: row.target_task_id ? String(row.target_task_id) : null,
    taskOrder: parseJSON<string[]>(row.task_order_json) ?? [],
    currentTaskId: row.current_task_id ? String(row.current_task_id) : null,
    currentTaskIndex: Number(row.current_task_index ?? 0),
    pauseRequested: Number(row.pause_requested ?? 0) === 1,
    stopRequested: Number(row.stop_requested ?? 0) === 1,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: Number(row.created_at ?? 0),
    startedAt: Number(row.started_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    isArchived: Number(row.is_archived ?? 0) === 1,
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
    color: row.color ? String(row.color) : "#888888",
    groupId: row.group_id ? String(row.group_id) : undefined,
    queuedTaskCount: undefined,
    executingTaskCount: undefined,
  }
}

const PI_SESSION_KINDS: PiWorkflowSession["sessionKind"][] = [
  "task",
  "task_run_worker",
  "task_run_reviewer",
  "task_run_final_applier",
  "review_scratch",
  "repair",
  "plan",
  "plan_revision",
  "planning",
  "container_config",
]

function isPiSessionKind(value: unknown): value is PiWorkflowSession["sessionKind"] {
  return typeof value === "string" && PI_SESSION_KINDS.includes(value as PiWorkflowSession["sessionKind"])
}

function asPiSessionKind(value: unknown): PiWorkflowSession["sessionKind"] {
  if (isPiSessionKind(value)) return value
  throw new Error(`Invalid Pi session kind: ${JSON.stringify(value)}. Expected one of: ${PI_SESSION_KINDS.join(", ")}.`)
}

const SESSION_MESSAGE_ROLES: SessionMessage["role"][] = ["system", "user", "assistant", "tool"]

function isSessionMessageRole(value: unknown): value is SessionMessage["role"] {
  return typeof value === "string" && SESSION_MESSAGE_ROLES.includes(value as SessionMessage["role"])
}

function asSessionMessageRole(value: unknown): SessionMessage["role"] {
  if (isSessionMessageRole(value)) return value
  throw new Error(`Invalid session message role: ${JSON.stringify(value)}. Expected one of: ${SESSION_MESSAGE_ROLES.join(", ")}.`)
}

function rowToWorkflowSession(row: Record<string, unknown>): PiWorkflowSession {
  return {
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : null,
    taskRunId: row.task_run_id ? String(row.task_run_id) : null,
    sessionKind: asPiSessionKind(row.session_kind),
    status: asPiSessionStatus(row.status),
    cwd: String(row.cwd),
    worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
    branch: row.branch ? String(row.branch) : null,
    piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
    piSessionFile: row.pi_session_file ? String(row.pi_session_file) : null,
    processPid: row.process_pid === null || row.process_pid === undefined ? null : Number(row.process_pid),
    model: String(row.model ?? "default"),
    thinkingLevel: asThinkingLevel(row.thinking_level),
    startedAt: Number(row.started_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    exitSignal: row.exit_signal ? String(row.exit_signal) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  }
}

function rowToSessionMessage(row: Record<string, unknown>): SessionMessage {
  return {
    id: Number(row.id),
    seq: Number(row.seq ?? 0),
    messageId: row.message_id ? String(row.message_id) : null,
    sessionId: String(row.session_id),
    taskId: row.task_id ? String(row.task_id) : null,
    taskRunId: row.task_run_id ? String(row.task_run_id) : null,
    timestamp: Number(row.timestamp),
    role: asSessionMessageRole(row.role),
    eventName: row.event_name ? String(row.event_name) : null,
    messageType: asMessageType(row.message_type),
    contentJson: parseJSON<Record<string, unknown>>(row.content_json) ?? {},
    modelProvider: row.model_provider ? String(row.model_provider) : null,
    modelId: row.model_id ? String(row.model_id) : null,
    agentName: row.agent_name ? String(row.agent_name) : null,
    promptTokens: row.prompt_tokens === null || row.prompt_tokens === undefined ? null : Number(row.prompt_tokens),
    completionTokens: row.completion_tokens === null || row.completion_tokens === undefined ? null : Number(row.completion_tokens),
    cacheReadTokens: row.cache_read_tokens === null || row.cache_read_tokens === undefined ? null : Number(row.cache_read_tokens),
    cacheWriteTokens: row.cache_write_tokens === null || row.cache_write_tokens === undefined ? null : Number(row.cache_write_tokens),
    totalTokens: row.total_tokens === null || row.total_tokens === undefined ? null : Number(row.total_tokens),
    costJson: parseJSON<Record<string, unknown>>(row.cost_json),
    costTotal: row.cost_total === null || row.cost_total === undefined ? null : Number(row.cost_total),
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null,
    toolName: row.tool_name ? String(row.tool_name) : null,
    toolArgsJson: parseJSON<Record<string, unknown>>(row.tool_args_json),
    toolResultJson: parseJSON<Record<string, unknown>>(row.tool_result_json),
    toolStatus: row.tool_status ? String(row.tool_status) : null,
    editDiff: row.edit_diff ? String(row.edit_diff) : null,
    editFilePath: row.edit_file_path ? String(row.edit_file_path) : null,
    sessionStatus: row.session_status ? String(row.session_status) : null,
    workflowPhase: row.workflow_phase ? String(row.workflow_phase) : null,
    rawEventJson: parseJSON<Record<string, unknown>>(row.raw_event_json),
  }
}

function rowToPromptTemplate(row: Record<string, unknown>): PromptTemplate {
  return {
    id: Number(row.id),
    key: String(row.key),
    name: String(row.name),
    description: String(row.description ?? ""),
    templateText: String(row.template_text),
    variablesJson: parseJSON<string[]>(row.variables_json) ?? [],
    isActive: Number(row.is_active ?? 1) === 1,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

function rowToPromptTemplateVersion(row: Record<string, unknown>): PromptTemplateVersion {
  return {
    id: Number(row.id),
    promptTemplateId: Number(row.prompt_template_id),
    version: Number(row.version),
    templateText: String(row.template_text),
    variablesJson: parseJSON<string[]>(row.variables_json) ?? [],
    createdAt: Number(row.created_at ?? 0),
  }
}

function rowToPlanningPrompt(row: Record<string, unknown>): PlanningPrompt {
  return {
    id: Number(row.id),
    key: String(row.key),
    name: String(row.name),
    description: String(row.description ?? ""),
    promptText: String(row.prompt_text),
    isActive: Number(row.is_active ?? 1) === 1,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

function rowToPlanningPromptVersion(row: Record<string, unknown>): PlanningPromptVersion {
  return {
    id: Number(row.id),
    planningPromptId: Number(row.planning_prompt_id),
    version: Number(row.version),
    promptText: String(row.prompt_text),
    createdAt: Number(row.created_at ?? 0),
  }
}

// Default planning system prompt - can be customized by user via UI
const DEFAULT_PLANNING_SYSTEM_PROMPT = `You are a specialized Planning Assistant for software development task management.

Your role is to help users create well-structured implementation plans before they become kanban tasks.

## Core Capabilities

1. **Task Planning**: Break down complex requirements into actionable, well-defined tasks
2. **Architecture Design**: Suggest component structures, APIs, and data models
3. **Dependency Analysis**: Identify task dependencies and execution order
4. **Estimation Guidance**: Provide complexity assessments and implementation hints
5. **Visual Explanation**: Use diagrams and visual aids to explain complex concepts

## Interaction Guidelines

- Ask clarifying questions when requirements are ambiguous
- Suggest concrete next steps and validation approaches
- Reference existing codebase patterns when relevant
- Keep responses focused on planning and design
- Do NOT write actual implementation code unless specifically requested for prototyping
- **ALWAYS** try to visually explain things when possible using Mermaid charts
- **NEVER** use ASCII charts or text-based diagrams - always use Mermaid syntax instead

## Visual Explanations with Mermaid

When explaining:
- System architecture or component relationships
- Data flow between components
- Task dependencies and execution order
- State machines or workflows
- Class hierarchies or module structures
- Sequence of operations

Always use Mermaid chart syntax. Examples:

**Flowchart:**
\`\`\`mermaid
flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
\`\`\`

**Sequence Diagram:**
\`\`\`mermaid
sequenceDiagram
    User->>+API: Request
    API->>+Database: Query
    Database-->>-API: Results
    API-->>-User: Response
\`\`\`

**Class Diagram:**
\`\`\`mermaid
classDiagram
    class User {
        +String name
        +login()
    }
    class Order {
        +int id
        +place()
    }
    User "1" --> "*" Order : has
\`\`\`

## Output Format for Task Creation

When the user is ready to create tasks, help them structure:
- Clear task names
- Detailed prompts with context
- Suggested task dependencies
- Recommended execution order

## Tool Access

You have access to file exploration tools to understand the codebase structure when needed. Use them to provide context-aware planning suggestions.`

// Container Configuration Assistant system prompt
const CONTAINER_CONFIG_SYSTEM_PROMPT = `You are a Container Configuration Assistant helping users customize their Pi Agent container image.

Your goal is to understand what tools the user needs and help them configure the container image accordingly.

## Available Profiles

- **web-dev**: Chrome, Playwright, web testing tools
  - Packages: chromium, chromium-chromedriver, nss, freetype, harfbuzz, ttf-freefont

- **rust-dev**: Rust compiler, Cargo, build tools
  - Packages: rust, cargo, build-base, openssl-dev, pkgconfig

- **python-dev**: Python 3, pip, development headers
  - Packages: python3, py3-pip, python3-dev, gcc, musl-dev

- **data-science**: Python with NumPy/SciPy/pandas support
  - Extends python-dev, adds: lapack-dev, openblas-dev, libffi-dev

- **go-dev**: Go compiler and standard tools
  - Packages: go, git, make

- **node-dev**: Additional Node.js development tools
  - Packages: yarn, npm, nodejs

- **docker-tools**: Tools for working with Docker/Podman
  - Packages: docker-cli, buildah, skopeo

- **cloud-cli**: AWS, Azure, and GCP CLI tools
  - Packages: aws-cli, azure-cli, google-cloud-sdk

- **database-tools**: Database clients and tools
  - Packages: postgresql-client, mysql-client, redis, sqlite

## Capabilities

1. **Recommend profiles** based on user needs and development work
2. **Suggest specific Alpine packages** for common tools and libraries
3. **Explain what each package does** and why it's needed
4. **Validate package names** against Alpine repositories
5. **Guide users through the build process** and explain what to expect

## Interaction Flow

1. Ask what kind of development work they do
2. Suggest appropriate profile(s) based on their needs
3. Ask about specific tools they need
4. Build package list with explanations
5. Confirm before they trigger the rebuild

## Package Categories

When suggesting packages, categorize them appropriately:
- **browser**: Chrome, Chromium, and related browser tools
- **language**: Programming language runtimes and compilers (Rust, Python, Go, etc.)
- **tool**: CLI tools, utilities, and general purpose software
- **build**: Build tools, compilers, dev headers, libraries
- **system**: System libraries, fonts, security tools
- **math**: Math and science libraries (lapack, openblas, etc.)

## Tips

- Alpine packages are typically lowercase
- Common prefixes: lib*, py3-*, nodejs-*, *-dev, *-doc
- When a user mentions a tool, try to suggest the Alpine package name
- Warn about package availability - some packages may not be in Alpine repos
- Building can take several minutes - set expectations appropriately

## Response Style

Be conversational but focused. Don't overwhelm with technical details unless asked. Use clear, concise explanations.`

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial Pi workflow storage schema",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        idx INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        plan_model TEXT NOT NULL DEFAULT 'default',
        execution_model TEXT NOT NULL DEFAULT 'default',
        planmode INTEGER NOT NULL DEFAULT 0,
        auto_approve_plan INTEGER NOT NULL DEFAULT 0,
        review INTEGER NOT NULL DEFAULT 1,
        auto_commit INTEGER NOT NULL DEFAULT 1,
        delete_worktree INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'backlog',
        requirements TEXT NOT NULL DEFAULT '[]',
        agent_output TEXT NOT NULL DEFAULT '',
        review_count INTEGER NOT NULL DEFAULT 0,
        json_parse_retry_count INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        session_url TEXT,
        worktree_dir TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        thinking_level TEXT NOT NULL DEFAULT 'default',
        execution_phase TEXT NOT NULL DEFAULT 'not_started',
        awaiting_plan_approval INTEGER NOT NULL DEFAULT 0,
        plan_revision_count INTEGER NOT NULL DEFAULT 0,
        execution_strategy TEXT NOT NULL DEFAULT 'standard',
        best_of_n_config TEXT,
        best_of_n_substage TEXT NOT NULL DEFAULT 'idle',
        skip_permission_asking INTEGER NOT NULL DEFAULT 1,
        max_review_runs_override INTEGER,
        smart_repair_hints TEXT,
        review_activity TEXT NOT NULL DEFAULT 'idle',
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_idx ON tasks(idx);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status_idx ON tasks(status, idx);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_execution_strategy ON tasks(execution_strategy);`,
      `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        display_name TEXT NOT NULL DEFAULT '',
        target_task_id TEXT,
        task_order_json TEXT NOT NULL DEFAULT '[]',
        current_task_id TEXT,
        current_task_index INTEGER NOT NULL DEFAULT 0,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        stop_requested INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER,
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        color TEXT NOT NULL DEFAULT '#888888'
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_current_task_id ON workflow_runs(current_task_id);`,
      `
      CREATE TABLE IF NOT EXISTS workflow_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        task_run_id TEXT,
        session_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'starting',
        cwd TEXT NOT NULL,
        worktree_dir TEXT,
        branch TEXT,
        pi_session_id TEXT,
        pi_session_file TEXT,
        process_pid INTEGER,
        model TEXT NOT NULL DEFAULT 'default',
        thinking_level TEXT NOT NULL DEFAULT 'default',
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER,
        exit_code INTEGER,
        exit_signal TEXT,
        error_message TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_task_id ON workflow_sessions(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_status ON workflow_sessions(status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_task_status ON workflow_sessions(task_id, status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_pi_session ON workflow_sessions(pi_session_id);`,
      `
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        session_id TEXT NOT NULL,
        task_id TEXT,
        task_run_id TEXT,
        timestamp INTEGER NOT NULL,
        role TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        model_provider TEXT,
        model_id TEXT,
        agent_name TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tool_name TEXT,
        tool_args_json TEXT,
        tool_result_json TEXT,
        tool_status TEXT,
        edit_diff TEXT,
        edit_file_path TEXT,
        session_status TEXT,
        workflow_phase TEXT,
        raw_event_json TEXT,
        FOREIGN KEY(session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_task_id ON session_messages(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_session_timestamp ON session_messages(session_id, timestamp);`,
      `
      CREATE TABLE IF NOT EXISTS options (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        template_text TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_prompt_templates_key ON prompt_templates(key);`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_templates_active ON prompt_templates(is_active);`,
      `
      CREATE TABLE IF NOT EXISTS prompt_template_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_template_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        template_text TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(prompt_template_id) REFERENCES prompt_templates(id) ON DELETE CASCADE,
        UNIQUE(prompt_template_id, version)
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_template_id ON prompt_template_versions(prompt_template_id);`,
    ],
  },
  {
    version: 2,
    description: "Add task_runs and task_candidates for best-of-n APIs",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        slot_index INTEGER NOT NULL DEFAULT 0,
        attempt_index INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        task_suffix TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT,
        session_url TEXT,
        worktree_dir TEXT,
        summary TEXT,
        error_message TEXT,
        candidate_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_runs_phase ON task_runs(phase);`,
      `CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);`,
      `
      CREATE TABLE IF NOT EXISTS task_candidates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_run_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        diff_stats_json TEXT NOT NULL DEFAULT '{}',
        verification_json TEXT NOT NULL DEFAULT '{}',
        summary TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(worker_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_task_candidates_task_id ON task_candidates(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_candidates_worker_run_id ON task_candidates(worker_run_id);`,
    ],
  },
  {
    version: 3,
    description: "Rebuild session_messages into pi-native event schema",
    statements: [
      `
      CREATE TABLE session_messages_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq INTEGER NOT NULL,
        message_id TEXT,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        role TEXT NOT NULL,
        event_name TEXT,
        message_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        model_provider TEXT,
        model_id TEXT,
        agent_name TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        cost_json TEXT,
        cost_total REAL,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_args_json TEXT,
        tool_result_json TEXT,
        tool_status TEXT,
        edit_diff TEXT,
        edit_file_path TEXT,
        session_status TEXT,
        workflow_phase TEXT,
        raw_event_json TEXT,
        FOREIGN KEY(session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, seq)
      )
      `,
      `
      INSERT INTO session_messages_v3 (
        id,
        seq,
        message_id,
        session_id,
        timestamp,
        role,
        event_name,
        message_type,
        content_json,
        model_provider,
        model_id,
        agent_name,
        prompt_tokens,
        completion_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_json,
        cost_total,
        tool_call_id,
        tool_name,
        tool_args_json,
        tool_result_json,
        tool_status,
        edit_diff,
        edit_file_path,
        session_status,
        workflow_phase,
        raw_event_json
      )
      SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp ASC, id ASC),
        message_id,
        session_id,
        timestamp,
        role,
        NULL,
        message_type,
        content_json,
        model_provider,
        model_id,
        agent_name,
        prompt_tokens,
        completion_tokens,
        NULL,
        NULL,
        total_tokens,
        NULL,
        NULL,
        NULL,
        tool_name,
        tool_args_json,
        tool_result_json,
        tool_status,
        edit_diff,
        edit_file_path,
        session_status,
        workflow_phase,
        raw_event_json
      FROM session_messages
      `,
      `DROP TABLE session_messages;`,
      `ALTER TABLE session_messages_v3 RENAME TO session_messages;`,
      `CREATE INDEX idx_session_messages_session_id ON session_messages(session_id);`,
      `CREATE INDEX idx_session_messages_timestamp ON session_messages(timestamp);`,
      `CREATE INDEX idx_session_messages_session_timestamp ON session_messages(session_id, timestamp);`,
      `CREATE INDEX idx_session_messages_session_seq ON session_messages(session_id, seq);`,
      `CREATE INDEX idx_session_messages_event_name ON session_messages(event_name);`,
      `CREATE INDEX idx_session_messages_tool_call_id ON session_messages(tool_call_id);`,
    ],
  },
  {
    version: 4,
    description: "Add planning_prompts table for customizable planning agent system prompt",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS planning_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL DEFAULT 'default',
        name TEXT NOT NULL DEFAULT 'Default Planning Prompt',
        description TEXT NOT NULL DEFAULT 'System prompt for the planning assistant agent',
        prompt_text TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_planning_prompts_key ON planning_prompts(key);`,
      `CREATE INDEX IF NOT EXISTS idx_planning_prompts_active ON planning_prompts(is_active);`,
      `
      CREATE TABLE IF NOT EXISTS planning_prompt_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        planning_prompt_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(planning_prompt_id) REFERENCES planning_prompts(id) ON DELETE CASCADE,
        UNIQUE(planning_prompt_id, version)
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_planning_prompt_versions_prompt_id ON planning_prompt_versions(planning_prompt_id);`,
    ],
  },
  {
    version: 5,
    description: "Add container_packages and container_builds tables for customizable container image system",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS container_packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        version_constraint TEXT,
        install_order INTEGER DEFAULT 0,
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        source TEXT DEFAULT 'manual'
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_container_packages_category ON container_packages(category);`,
      `CREATE INDEX IF NOT EXISTS idx_container_packages_order ON container_packages(install_order);`,
      `
      CREATE TABLE IF NOT EXISTS container_builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        packages_hash TEXT,
        error_message TEXT,
        image_tag TEXT
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_container_builds_status ON container_builds(status);`,
    ],
  },
  {
    version: 6,
    description: "Add per-model thinking level columns to tasks and options",
    statements: [
      // Add per-model thinking level columns to tasks table
      `ALTER TABLE tasks ADD COLUMN plan_thinking_level TEXT NOT NULL DEFAULT 'default';`,
      `ALTER TABLE tasks ADD COLUMN execution_thinking_level TEXT NOT NULL DEFAULT 'default';`,
      // Add per-model thinking level columns to options
      `INSERT OR REPLACE INTO options (key, value) VALUES ('plan_thinking_level', 'default');`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('execution_thinking_level', 'default');`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('review_thinking_level', 'default');`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('repair_thinking_level', 'default');`,
    ],
  },
  {
    version: 7,
    description: "Add paused_session_states table for workflow pause/resume functionality",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS paused_session_states (
        session_id TEXT PRIMARY KEY,
        task_id TEXT,
        task_run_id TEXT,
        session_kind TEXT NOT NULL,
        cwd TEXT,
        worktree_dir TEXT,
        branch TEXT,
        model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        pi_session_id TEXT,
        pi_session_file TEXT,
        container_id TEXT,
        container_image TEXT,
        paused_at INTEGER NOT NULL,
        last_prompt TEXT,
        execution_phase TEXT,
        context_json TEXT NOT NULL,
        pause_reason TEXT,
        FOREIGN KEY (session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_paused_sessions_task_id ON paused_session_states(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_paused_sessions_session_id ON paused_session_states(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_paused_sessions_paused_at ON paused_session_states(paused_at);`,
    ],
  },
  {
    version: 8,
    description: "Add paused_run_states table for workflow-level pause state storage",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS paused_run_states (
        run_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_order_json TEXT NOT NULL DEFAULT '[]',
        current_task_index INTEGER NOT NULL DEFAULT 0,
        current_task_id TEXT,
        target_task_id TEXT,
        paused_at INTEGER NOT NULL,
        execution_phase TEXT NOT NULL DEFAULT 'executing',
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_paused_run_states_run_id ON paused_run_states(run_id);`,
      `CREATE INDEX IF NOT EXISTS idx_paused_run_states_paused_at ON paused_run_states(paused_at);`,
    ],
  },
  {
    version: 9,
    description: "Add workflow_runs_indicators table for tracking model failure metrics",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS workflow_runs_indicators (
        id TEXT PRIMARY KEY,
        json_out_fails TEXT NOT NULL DEFAULT '{"json-output-fails":[]}',
        FOREIGN KEY (id) REFERENCES workflow_sessions(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_indicators_id ON workflow_runs_indicators(id);`,
    ],
  },
  {
    version: 10,
    description: "Add logs column to container_builds for storing build output",
    statements: [
      `ALTER TABLE container_builds ADD COLUMN logs TEXT;`,
    ],
  },
  {
    version: 11,
    description: "Add container_image column to tasks table for per-task image selection",
    statements: [
      `ALTER TABLE tasks ADD COLUMN container_image TEXT;`,
    ],
  },
  {
    version: 12,
    description: "Add code style fields to tasks and options tables",
    statements: [
      `ALTER TABLE tasks ADD COLUMN code_style_review INTEGER NOT NULL DEFAULT 0;`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('code_style_prompt', '');`,
    ],
  },
  {
    version: 13,
    description: "Set default values for existing tasks code style fields",
    statements: [
      // Ensure all existing tasks have code_style_review = 0 (false)
      `UPDATE tasks SET code_style_review = 0 WHERE code_style_review IS NULL;`,
      // Ensure code_style_prompt exists in options with empty string default
      `INSERT OR REPLACE INTO options (key, value) VALUES ('code_style_prompt', '');`,
    ],
  },
  {
    version: 25,
    description: "Add task_groups and task_group_members tables for task grouping feature",
    statements: [
      // task_groups table
      `
      CREATE TABLE IF NOT EXISTS task_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#888888',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      )
      `,
      // task_group_members table
      `
      CREATE TABLE IF NOT EXISTS task_group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(group_id) REFERENCES task_groups(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(group_id, task_id)
      )
      `,
      // Indexes for task_groups
      `CREATE INDEX IF NOT EXISTS idx_task_groups_status ON task_groups(status);`,
      `CREATE INDEX IF NOT EXISTS idx_task_groups_name ON task_groups(name);`,
      // Indexes for task_group_members
      `CREATE INDEX IF NOT EXISTS idx_task_group_members_group_id ON task_group_members(group_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_group_members_task_id ON task_group_members(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_group_members_group_idx ON task_group_members(group_id, idx);`,
      // Add group_id column to tasks table
      `ALTER TABLE tasks ADD COLUMN group_id TEXT;`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_group_id ON tasks(group_id);`,
      // Add group_id column to workflow_runs table
      `ALTER TABLE workflow_runs ADD COLUMN group_id TEXT;`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_group_id ON workflow_runs(group_id);`,
    ],
  },
  {
    version: 26,
    description: "Migrate telegram_notifications_enabled to telegram_notification_level for granular notification control",
    statements: [
      // Migrate existing boolean value to new level format
      // true -> 'all' (preserve current behavior for users who had notifications enabled)
      // false -> 'failures' (minimum useful level for users who had notifications disabled)
      `UPDATE options SET value = 'all' WHERE key = 'telegram_notifications_enabled' AND value = 'true';`,
      `UPDATE options SET value = 'failures' WHERE key = 'telegram_notifications_enabled' AND value = 'false';`,
      // Delete the old boolean key after migration
      `DELETE FROM options WHERE key = 'telegram_notifications_enabled';`,
    ],
  },
  {
    version: 27,
    description: "Add indexes for archived tasks queries",
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_tasks_is_archived ON tasks(is_archived);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at);`,
    ],
  },
  {
    version: 28,
    description: "Add self-healing task state and self-heal reports",
    statements: [
      `ALTER TABLE tasks ADD COLUMN self_heal_status TEXT NOT NULL DEFAULT 'idle';`,
      `ALTER TABLE tasks ADD COLUMN self_heal_message TEXT;`,
      `ALTER TABLE tasks ADD COLUMN self_heal_report_id TEXT;`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_self_heal_status ON tasks(self_heal_status);`,
      `CREATE TABLE IF NOT EXISTS self_heal_reports (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_status TEXT NOT NULL,
        error_message TEXT,
        diagnostics_summary TEXT NOT NULL,
        root_causes_json TEXT NOT NULL DEFAULT '[]',
        proposed_solution TEXT NOT NULL,
        implementation_plan_json TEXT NOT NULL DEFAULT '[]',
        recoverable INTEGER NOT NULL DEFAULT 0,
        recommended_action TEXT NOT NULL,
        action_rationale TEXT NOT NULL,
        source_mode TEXT NOT NULL,
        source_path TEXT,
        github_url TEXT NOT NULL,
        tauroboros_version TEXT NOT NULL,
        db_path TEXT NOT NULL,
        db_schema_json TEXT NOT NULL,
        raw_response TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );`,
      `CREATE INDEX IF NOT EXISTS idx_self_heal_reports_run_id ON self_heal_reports(run_id);`,
      `CREATE INDEX IF NOT EXISTS idx_self_heal_reports_task_id ON self_heal_reports(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_self_heal_reports_created_at ON self_heal_reports(created_at DESC);`,
    ],
  },
  {
    version: 29,
    description: "Map legacy execution phase values in paused_run_states to current ExecutionPhase enum",
    statements: [
      // Old phases from before the plan-mode ExecutionPhase redesign:
      // "planning"   → "not_started"            (plan not yet finished)
      // "executing"  → "implementation_pending" (task was mid-execution when paused)
      // "reviewing"  → "implementation_done"    (execution finished, review pending)
      // "committing" → "implementation_done"    (about to commit = effectively done)
      `UPDATE paused_run_states SET execution_phase = 'not_started' WHERE execution_phase = 'planning';`,
      `UPDATE paused_run_states SET execution_phase = 'implementation_pending' WHERE execution_phase = 'executing';`,
      `UPDATE paused_run_states SET execution_phase = 'implementation_done' WHERE execution_phase = 'reviewing';`,
      `UPDATE paused_run_states SET execution_phase = 'implementation_done' WHERE execution_phase = 'committing';`,
    ],
  },
]

export class PiKanbanDB {
  private readonly db: Database
  private readonly dbPath: string
  private _taskStatusChangeListener: TaskStatusChangeListener | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    // Use WAL mode for better concurrency and performance
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 30000") // 30 seconds for high-concurrency scenarios
    this.db.exec("PRAGMA foreign_keys = ON")
    // WAL performance tuning
    this.db.exec("PRAGMA wal_autocheckpoint = 1000") // Checkpoint every 1000 pages

    runMigrations(this.db, MIGRATIONS)
    this.ensureWorkflowRunArchiveColumns()
    this.normalizeSessionMessages()
    this.seedDefaultOptions()
    this.seedPromptTemplates()
    this.seedPlanningPrompts()
  }

  private ensureWorkflowRunArchiveColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(workflow_runs)").all() as { name?: string }[]
    const hasArchived = columns.some((column) => column.name === "is_archived")
    if (!hasArchived) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0")
    }
    const hasArchivedAt = columns.some((column) => column.name === "archived_at")
    if (!hasArchivedAt) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN archived_at INTEGER")
    }
    const hasColor = columns.some((column) => column.name === "color")
    if (!hasColor) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'")
    }
  }

  close(): void {
    this.db.close(false)
  }

  setTaskStatusChangeListener(listener: TaskStatusChangeListener | null): void {
    this._taskStatusChangeListener = listener
  }

  getDatabasePath(): string {
    return this.dbPath
  }

  getSchemaSnapshot(): Record<string, { sql: string; columns: Array<{ name: string; type: string; notNull: boolean; defaultValue: unknown; pk: boolean }> }> {
    const tables = this.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .all() as Array<{ name: string; sql: string | null }>

    const snapshot: Record<string, { sql: string; columns: Array<{ name: string; type: string; notNull: boolean; defaultValue: unknown; pk: boolean }> }> = {}
    for (const table of tables) {
      const columns = this.db
        .prepare(`PRAGMA table_info(${table.name})`)
        .all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>

      snapshot[table.name] = {
        sql: table.sql ?? "",
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type,
          notNull: column.notnull === 1,
          defaultValue: column.dflt_value,
          pk: column.pk === 1,
        })),
      }
    }

    return snapshot
  }

  // ---- tasks ----

  getTasks(): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE is_archived = 0 ORDER BY idx ASC").all() as Record<string, unknown>[]
    return rows.map(rowToTask)
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND is_archived = 0").get(id) as Record<string, unknown> | null
    return row ? rowToTask(row) : null
  }

  createTask(input: CreateTaskInput): Task {
    const now = nowUnix()
    const idx = input.idx ?? this.getNextTaskIndex()
    const taskId = input.id ?? randomUUID().slice(0, 8)

    // Validate and clean requirements before creating
    const rawRequirements = input.requirements ?? []
    const { cleaned: validatedRequirements, removed } = this.validateAndCleanRequirements(rawRequirements, input.name)
    if (removed.length > 0) {
      console.log(`[db] Task "${input.name}" created with invalid dependencies auto-removed: ${removed.join(', ')}`)
    }

    this.db
      .prepare(`
        INSERT INTO tasks (
          id, name, idx, prompt, branch, plan_model, execution_model, planmode,
          auto_approve_plan, review, auto_commit, delete_worktree, status,
          requirements, agent_output, review_count, created_at, updated_at,
          thinking_level, plan_thinking_level, execution_thinking_level, execution_phase, awaiting_plan_approval, plan_revision_count,
          execution_strategy, best_of_n_config, best_of_n_substage, skip_permission_asking,
          max_review_runs_override, smart_repair_hints, review_activity, is_archived, archived_at, container_image, code_style_review
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
      `)
      .run(
        taskId,
        input.name,
        idx,
        input.prompt,
        input.branch ?? "",
        input.planModel ?? "",
        input.executionModel ?? "",
        input.planmode ? 1 : 0,
        input.autoApprovePlan ? 1 : 0,
        input.review !== false ? 1 : 0,
        input.autoCommit !== false ? 1 : 0,
        input.deleteWorktree !== false ? 1 : 0,
        input.status ?? "backlog",
        JSON.stringify(validatedRequirements),
        now,
        now,
        input.thinkingLevel ?? "default",
        input.planThinkingLevel ?? "default",
        input.executionThinkingLevel ?? "default",
        input.executionPhase ?? "not_started",
        input.awaitingPlanApproval ? 1 : 0,
        input.planRevisionCount ?? 0,
        input.executionStrategy ?? "standard",
        input.bestOfNConfig ? JSON.stringify(input.bestOfNConfig) : null,
        input.bestOfNSubstage ?? "idle",
        input.skipPermissionAsking !== false ? 1 : 0,
        input.maxReviewRunsOverride ?? null,
        input.smartRepairHints ?? null,
        input.reviewActivity ?? "idle",
        input.containerImage ?? null,
        input.codeStyleReview === true ? 1 : 0,
      )

    return this.getTask(taskId) as Task
  }

  updateTask(id: string, input: UpdateTaskInput): Task | null {
    const currentTask = this.getTask(id)
    const oldStatus = currentTask?.status

    const sets: string[] = []
    const values: any[] = []

    if (input.name !== undefined) {
      sets.push("name = ?")
      values.push(input.name)
    }
    if (input.prompt !== undefined) {
      sets.push("prompt = ?")
      values.push(input.prompt)
    }
    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.idx !== undefined) {
      sets.push("idx = ?")
      values.push(input.idx)
    }
    if (input.branch !== undefined) {
      sets.push("branch = ?")
      values.push(input.branch)
    }
    if (input.planModel !== undefined) {
      sets.push("plan_model = ?")
      values.push(input.planModel)
    }
    if (input.executionModel !== undefined) {
      sets.push("execution_model = ?")
      values.push(input.executionModel)
    }
    if (input.planmode !== undefined) {
      sets.push("planmode = ?")
      values.push(input.planmode ? 1 : 0)
    }
    if (input.autoApprovePlan !== undefined) {
      sets.push("auto_approve_plan = ?")
      values.push(input.autoApprovePlan ? 1 : 0)
    }
    if (input.review !== undefined) {
      sets.push("review = ?")
      values.push(input.review ? 1 : 0)
    }
    if (input.autoCommit !== undefined) {
      sets.push("auto_commit = ?")
      values.push(input.autoCommit ? 1 : 0)
    }
    if (input.deleteWorktree !== undefined) {
      sets.push("delete_worktree = ?")
      values.push(input.deleteWorktree ? 1 : 0)
    }
    if (input.requirements !== undefined) {
      // Validate and clean requirements
      const { cleaned, removed } = this.validateAndCleanRequirements(input.requirements, currentTask?.name)
      if (removed.length > 0) {
        console.log(`[db] Task "${currentTask?.name}" updated with invalid dependencies auto-removed: ${removed.join(', ')}`)
      }
      sets.push("requirements = ?")
      values.push(JSON.stringify(cleaned))
    }
    if (input.agentOutput !== undefined) {
      sets.push("agent_output = ?")
      values.push(input.agentOutput)
    }
    if (input.sessionId !== undefined) {
      sets.push("session_id = ?")
      values.push(input.sessionId)
    }
    if (input.sessionUrl !== undefined) {
      sets.push("session_url = ?")
      values.push(input.sessionUrl)
    }
    if (input.worktreeDir !== undefined) {
      sets.push("worktree_dir = ?")
      values.push(input.worktreeDir)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }
    if (input.reviewCount !== undefined) {
      sets.push("review_count = ?")
      values.push(input.reviewCount)
    }
    if (input.jsonParseRetryCount !== undefined) {
      sets.push("json_parse_retry_count = ?")
      values.push(input.jsonParseRetryCount)
    }
    if (input.completedAt !== undefined) {
      sets.push("completed_at = ?")
      values.push(input.completedAt)
    }
    if (input.thinkingLevel !== undefined) {
      sets.push("thinking_level = ?")
      values.push(input.thinkingLevel)
    }
    if (input.planThinkingLevel !== undefined) {
      sets.push("plan_thinking_level = ?")
      values.push(input.planThinkingLevel)
    }
    if (input.executionThinkingLevel !== undefined) {
      sets.push("execution_thinking_level = ?")
      values.push(input.executionThinkingLevel)
    }
    if (input.executionPhase !== undefined) {
      sets.push("execution_phase = ?")
      values.push(input.executionPhase)
    }
    if (input.awaitingPlanApproval !== undefined) {
      sets.push("awaiting_plan_approval = ?")
      values.push(input.awaitingPlanApproval ? 1 : 0)
    }
    if (input.planRevisionCount !== undefined) {
      sets.push("plan_revision_count = ?")
      values.push(input.planRevisionCount)
    }
    if (input.executionStrategy !== undefined) {
      sets.push("execution_strategy = ?")
      values.push(input.executionStrategy)
    }
    if (input.bestOfNConfig !== undefined) {
      sets.push("best_of_n_config = ?")
      values.push(input.bestOfNConfig ? JSON.stringify(input.bestOfNConfig) : null)
    }
    if (input.bestOfNSubstage !== undefined) {
      sets.push("best_of_n_substage = ?")
      values.push(input.bestOfNSubstage)
    }
    if (input.skipPermissionAsking !== undefined) {
      sets.push("skip_permission_asking = ?")
      values.push(input.skipPermissionAsking ? 1 : 0)
    }
    if (input.maxReviewRunsOverride !== undefined) {
      sets.push("max_review_runs_override = ?")
      values.push(input.maxReviewRunsOverride)
    }
    if (input.smartRepairHints !== undefined) {
      sets.push("smart_repair_hints = ?")
      values.push(input.smartRepairHints)
    }
    if (input.reviewActivity !== undefined) {
      sets.push("review_activity = ?")
      values.push(input.reviewActivity)
    }
    if (input.isArchived !== undefined) {
      sets.push("is_archived = ?")
      values.push(input.isArchived ? 1 : 0)
    }
    if (input.archivedAt !== undefined) {
      sets.push("archived_at = ?")
      values.push(input.archivedAt)
    }
    if (input.containerImage !== undefined) {
      sets.push("container_image = ?")
      values.push(input.containerImage ?? null)
    }
    if (input.codeStyleReview !== undefined) {
      sets.push("code_style_review = ?")
      values.push(input.codeStyleReview ? 1 : 0)
    }
    if (input.selfHealStatus !== undefined) {
      sets.push("self_heal_status = ?")
      values.push(input.selfHealStatus)
    }
    if (input.selfHealMessage !== undefined) {
      sets.push("self_heal_message = ?")
      values.push(input.selfHealMessage)
    }
    if (input.selfHealReportId !== undefined) {
      sets.push("self_heal_report_id = ?")
      values.push(input.selfHealReportId)
    }

    if (sets.length === 0) return this.getTask(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    const updatedTask = this.getTask(id)

    // Notify listener if status changed
    if (updatedTask && oldStatus && input.status !== undefined && input.status !== oldStatus) {
      this._taskStatusChangeListener?.(id, oldStatus, input.status)
    }

    return updatedTask
  }

    validateAndCleanRequirements(requirements: string[], taskName?: string): { cleaned: string[]; removed: string[] } {
    if (!requirements || requirements.length === 0) {
      return { cleaned: [], removed: [] }
    }

    // Get all valid (non-archived) task IDs
    const validTaskIds = new Set(this.getTasks().map(t => t.id))

    const cleaned: string[] = []
    const removed: string[] = []

    for (const reqId of requirements) {
      if (validTaskIds.has(reqId)) {
        cleaned.push(reqId)
      } else {
        removed.push(reqId)
      }
    }

    if (removed.length > 0) {
      console.log(`[db] Removed invalid dependencies from task "${taskName ?? 'unknown'}": ${removed.join(', ')}`)
    }

    return { cleaned, removed }
  }

  appendAgentOutput(taskId: string, chunk: string): Task | null {
    const task = this.getTask(taskId)
    if (!task) return null
    return this.updateTask(taskId, { agentOutput: `${task.agentOutput}${chunk}` })
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
    return result.changes > 0
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = ? AND is_archived = 0 ORDER BY idx ASC").all(status) as Record<string, unknown>[]
    return rows.map(rowToTask)
  }

  reorderTask(id: string, newIdx: number): Task | null {
    const task = this.getTask(id)
    if (!task) return null

    if (newIdx < task.idx) {
      this.db
        .prepare("UPDATE tasks SET idx = idx + 1, updated_at = unixepoch() WHERE idx >= ? AND idx < ? AND id != ?")
        .run(newIdx, task.idx, id)
    } else if (newIdx > task.idx) {
      this.db
        .prepare("UPDATE tasks SET idx = idx - 1, updated_at = unixepoch() WHERE idx > ? AND idx <= ? AND id != ?")
        .run(task.idx, newIdx, id)
    }

    this.db.prepare("UPDATE tasks SET idx = ?, updated_at = unixepoch() WHERE id = ?").run(newIdx, id)
    return this.getTask(id)
  }

  hasTaskExecutionHistory(taskId: string): boolean {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | null
    if (!task) return false

    if (task.session_id || task.session_url) return true
    if (typeof task.agent_output === "string" && task.agent_output.trim().length > 0) return true

    const runsCount = this.db.prepare("SELECT COUNT(*) AS cnt FROM task_runs WHERE task_id = ?").get(taskId) as { cnt: number }
    if ((runsCount?.cnt ?? 0) > 0) return true

    const sessionsCount = this.db.prepare("SELECT COUNT(*) AS cnt FROM workflow_sessions WHERE task_id = ?").get(taskId) as { cnt: number }
    if ((sessionsCount?.cnt ?? 0) > 0) return true

    const messagesCount = this.db
      .prepare(
        `
        SELECT COUNT(*) AS cnt
        FROM session_messages sm
        INNER JOIN workflow_sessions ws ON ws.id = sm.session_id
        WHERE ws.task_id = ?
        `,
      )
      .get(taskId) as { cnt: number }
    if ((messagesCount?.cnt ?? 0) > 0) return true

    return false
  }

  archiveTask(id: string): Task | null {
    const task = this.getTask(id)
    if (!task) return null

    const now = nowUnix()
    this.db.prepare("UPDATE tasks SET is_archived = 1, archived_at = ?, updated_at = unixepoch() WHERE id = ?").run(now, id)

    const allTasks = this.getTasks()
    for (const t of allTasks) {
      if (t.requirements.includes(id)) {
        this.db
          .prepare("UPDATE tasks SET requirements = ?, updated_at = unixepoch() WHERE id = ?")
          .run(JSON.stringify(t.requirements.filter((r) => r !== id)), t.id)
      }
    }

    return { ...task, isArchived: true, archivedAt: now }
  }

  hardDeleteTask(id: string): boolean {
    if (this.hasTaskExecutionHistory(id)) return false

    const allTasks = this.getTasks()
    for (const t of allTasks) {
      if (t.requirements.includes(id)) {
        this.db
          .prepare("UPDATE tasks SET requirements = ?, updated_at = unixepoch() WHERE id = ?")
          .run(JSON.stringify(t.requirements.filter((r) => r !== id)), t.id)
      }
    }

    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
    return result.changes > 0
  }

  getActiveWorkflowRunForTask(taskId: string): WorkflowRun | null {
    const runs = this.getWorkflowRuns()
    return runs.find((run) =>
      (run.status === "queued" || run.status === "running" || run.status === "stopping" || run.status === "paused")
      && run.taskOrder.includes(taskId)
    ) ?? null
  }

  // ---- task runs / candidates ----

  getTaskRuns(taskId: string): TaskRun[] {
    const rows = this.db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Record<string, unknown>[]
    return rows.map(rowToTaskRun)
  }

  getTaskRun(id: string): TaskRun | null {
    const row = this.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToTaskRun(row) : null
  }

  getTaskRunsByPhase(taskId: string, phase: TaskRun["phase"]): TaskRun[] {
    const rows = this.db
      .prepare("SELECT * FROM task_runs WHERE task_id = ? AND phase = ? ORDER BY created_at ASC")
      .all(taskId, phase) as Record<string, unknown>[]
    return rows.map(rowToTaskRun)
  }

  createTaskRun(input: CreateTaskRunInput): TaskRun {
    const now = nowUnix()
    const id = input.id ?? Math.random().toString(36).slice(2, 10)
    const createdAt = input.createdAt ?? now

    this.db
      .prepare(`
        INSERT INTO task_runs (
          id, task_id, phase, slot_index, attempt_index, model, task_suffix,
          status, session_id, session_url, worktree_dir, summary, error_message,
          candidate_id, metadata_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.taskId,
        input.phase,
        input.slotIndex,
        input.attemptIndex,
        input.model,
        input.taskSuffix ?? null,
        input.status ?? "pending",
        input.sessionId ?? null,
        input.sessionUrl ?? null,
        input.worktreeDir ?? null,
        input.summary ?? null,
        input.errorMessage ?? null,
        input.candidateId ?? null,
        input.metadataJson != null ? JSON.stringify(input.metadataJson) : '{}',
        createdAt,
        now,
        input.completedAt ?? null,
      )

    return this.getTaskRun(id) as TaskRun
  }

  updateTaskRun(id: string, input: UpdateTaskRunInput): TaskRun | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.sessionId !== undefined) {
      sets.push("session_id = ?")
      values.push(input.sessionId)
    }
    if (input.sessionUrl !== undefined) {
      sets.push("session_url = ?")
      values.push(input.sessionUrl)
    }
    if (input.worktreeDir !== undefined) {
      sets.push("worktree_dir = ?")
      values.push(input.worktreeDir)
    }
    if (input.summary !== undefined) {
      sets.push("summary = ?")
      values.push(input.summary)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }
    if (input.candidateId !== undefined) {
      sets.push("candidate_id = ?")
      values.push(input.candidateId)
    }
    if (input.metadataJson !== undefined) {
      sets.push("metadata_json = ?")
      values.push(JSON.stringify(input.metadataJson))
    }
    if (input.completedAt !== undefined) {
      sets.push("completed_at = ?")
      values.push(input.completedAt)
    }

    if (sets.length === 0) return this.getTaskRun(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)
    this.db.prepare(`UPDATE task_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values)

    return this.getTaskRun(id)
  }

  getTaskCandidates(taskId: string): TaskCandidate[] {
    const rows = this.db.prepare("SELECT * FROM task_candidates WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Record<string, unknown>[]
    return rows.map(rowToTaskCandidate)
  }

  getTaskCandidate(id: string): TaskCandidate | null {
    const row = this.db.prepare("SELECT * FROM task_candidates WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToTaskCandidate(row) : null
  }

  createTaskCandidate(input: CreateTaskCandidateInput): TaskCandidate {
    const now = nowUnix()
    const id = input.id ?? Math.random().toString(36).slice(2, 10)
    const createdAt = input.createdAt ?? now

    this.db
      .prepare(`
        INSERT INTO task_candidates (
          id, task_id, worker_run_id, status, changed_files_json, diff_stats_json,
          verification_json, summary, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.taskId,
        input.workerRunId,
        input.status ?? "available",
        input.changedFilesJson != null ? JSON.stringify(input.changedFilesJson) : '[]',
        input.diffStatsJson != null ? JSON.stringify(input.diffStatsJson) : '{}',
        input.verificationJson != null ? JSON.stringify(input.verificationJson) : '{}',
        input.summary ?? null,
        input.errorMessage ?? null,
        createdAt,
        now,
      )

    return this.getTaskCandidate(id) as TaskCandidate
  }

  updateTaskCandidate(id: string, input: UpdateTaskCandidateInput): TaskCandidate | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.changedFilesJson !== undefined) {
      sets.push("changed_files_json = ?")
      values.push(JSON.stringify(input.changedFilesJson))
    }
    if (input.diffStatsJson !== undefined) {
      sets.push("diff_stats_json = ?")
      values.push(JSON.stringify(input.diffStatsJson))
    }
    if (input.verificationJson !== undefined) {
      sets.push("verification_json = ?")
      values.push(JSON.stringify(input.verificationJson))
    }
    if (input.summary !== undefined) {
      sets.push("summary = ?")
      values.push(input.summary)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }

    if (sets.length === 0) return this.getTaskCandidate(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)
    this.db.prepare(`UPDATE task_candidates SET ${sets.join(", ")} WHERE id = ?`).run(...values)

    return this.getTaskCandidate(id)
  }

  getBestOfNSummary(taskId: string): {
    taskId: string
    workersTotal: number
    workersDone: number
    workersFailed: number
    reviewersTotal: number
    reviewersDone: number
    reviewersFailed: number
    finalApplierStatus: TaskRun["status"] | "not_started"
    availableCandidates: number
    selectedCandidates: number
  } {
    const task = this.getTask(taskId)
    if (!task) throw new Error("Task not found")

    const workersTotal = this.db.prepare("SELECT COUNT(*) AS cnt FROM task_runs WHERE task_id = ? AND phase = 'worker'").get(taskId) as { cnt: number }
    const workersDone = this.db.prepare("SELECT COUNT(*) AS cnt FROM task_runs WHERE task_id = ? AND phase = 'worker' AND status = 'done'").get(taskId) as { cnt: number }
    const workersFailed = this.db.prepare("SELECT COUNT(*) AS cnt FROM task_runs WHERE task_id = ? AND phase = 'worker' AND status = 'failed'").get(taskId) as { cnt: number }

    const reviewersTotal = this.db.prepare("SELECT COUNT(*) AS cnt FROM task_runs WHERE task_id = ? AND phase = 'reviewer'").get(taskId) as { cnt: number }
    const reviewersDone = this.db.prepare("SELECT COUNT(*) AS cnt FROM task_runs WHERE task_id = ? AND phase = 'reviewer' AND status = 'done'").get(taskId) as { cnt: number }
    const reviewersFailed = this.db.prepare("SELECT COUNT(*) AS cnt FROM task_runs WHERE task_id = ? AND phase = 'reviewer' AND status = 'failed'").get(taskId) as { cnt: number }

    const finalRun = this.db
      .prepare("SELECT status FROM task_runs WHERE task_id = ? AND phase = 'final_applier' ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as { status?: TaskRun["status"] } | null

    const availableCandidates = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM task_candidates WHERE task_id = ? AND status = 'available'")
      .get(taskId) as { cnt: number }
    const selectedCandidates = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM task_candidates WHERE task_id = ? AND status = 'selected'")
      .get(taskId) as { cnt: number }

    return {
      taskId,
      workersTotal: workersTotal.cnt ?? 0,
      workersDone: workersDone.cnt ?? 0,
      workersFailed: workersFailed.cnt ?? 0,
      reviewersTotal: reviewersTotal.cnt ?? 0,
      reviewersDone: reviewersDone.cnt ?? 0,
      reviewersFailed: reviewersFailed.cnt ?? 0,
      finalApplierStatus: finalRun?.status ?? "not_started",
      availableCandidates: availableCandidates.cnt ?? 0,
      selectedCandidates: selectedCandidates.cnt ?? 0,
    }
  }

  // ---- workflow runs ----

  getNextRunColor(): string {
    const rows = this.db.prepare("SELECT color FROM workflow_runs WHERE is_archived = 0 AND status IN ('queued', 'running', 'stopping', 'paused')").all() as Record<string, unknown>[]
    const usedColors = rows.map((row) => row.color).filter((c): c is string => typeof c === "string" && c !== "#888888")
    return pickRunColor(usedColors)
  }

  createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRun {
    const now = nowUnix()
    const createdAt = input.createdAt ?? now
    const startedAt = input.startedAt ?? now

    this.db
      .prepare(`
        INSERT INTO workflow_runs (
          id, kind, status, display_name, target_task_id, task_order_json,
          current_task_id, current_task_index, pause_requested, stop_requested,
          error_message, created_at, started_at, updated_at, finished_at, color, group_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.kind,
        input.status ?? "queued",
        input.displayName ?? "",
        input.targetTaskId ?? null,
        JSON.stringify(input.taskOrder ?? []),
        input.currentTaskId ?? null,
        input.currentTaskIndex ?? 0,
        input.pauseRequested ? 1 : 0,
        input.stopRequested ? 1 : 0,
        input.errorMessage ?? null,
        createdAt,
        startedAt,
        now,
        input.finishedAt ?? null,
        input.color ?? "#888888",
        input.groupId ?? null,
      )

    return this.getWorkflowRun(input.id) as WorkflowRun
  }

  getWorkflowRun(id: string): WorkflowRun | null {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToWorkflowRun(row) : null
  }

  getWorkflowRuns(): WorkflowRun[] {
    const rows = this.db.prepare("SELECT * FROM workflow_runs WHERE is_archived = 0 ORDER BY created_at DESC, started_at DESC").all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowRun)
  }

  createSelfHealReport(input: CreateSelfHealReportInput): SelfHealReport {
    const now = nowUnix()
    const id = input.id ?? randomUUID().slice(0, 8)
    const createdAt = input.createdAt ?? now

    this.db
      .prepare(`
        INSERT INTO self_heal_reports (
          id, run_id, task_id, task_status, error_message,
          diagnostics_summary, root_causes_json, proposed_solution, implementation_plan_json,
          recoverable, recommended_action, action_rationale,
          source_mode, source_path, github_url, tauroboros_version,
          db_path, db_schema_json, raw_response,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.runId,
        input.taskId,
        input.taskStatus,
        input.errorMessage ?? null,
        input.diagnosticsSummary,
        JSON.stringify(input.rootCauses),
        input.proposedSolution,
        JSON.stringify(input.implementationPlan),
        input.recoverable ? 1 : 0,
        input.recommendedAction,
        input.actionRationale,
        input.sourceMode,
        input.sourcePath ?? null,
        input.githubUrl,
        input.tauroborosVersion,
        input.dbPath,
        JSON.stringify(input.dbSchemaJson),
        input.rawResponse,
        createdAt,
        now,
      )

    return this.getSelfHealReport(id) as SelfHealReport
  }

  getSelfHealReport(id: string): SelfHealReport | null {
    const row = this.db.prepare("SELECT * FROM self_heal_reports WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToSelfHealReport(row) : null
  }

  getSelfHealReportsForRun(runId: string): SelfHealReport[] {
    const rows = this.db
      .prepare("SELECT * FROM self_heal_reports WHERE run_id = ? ORDER BY created_at DESC")
      .all(runId) as Record<string, unknown>[]
    return rows.map(rowToSelfHealReport)
  }

  countSelfHealReportsForTaskInRun(runId: string, taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM self_heal_reports WHERE run_id = ? AND task_id = ?")
      .get(runId, taskId) as { cnt: number }
    return Number(row?.cnt ?? 0)
  }

  // ---- Archived Tasks ----

  getArchivedTasks(): Task[] {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE is_archived = 1 ORDER BY archived_at DESC")
    const rows = stmt.all() as unknown[]
    if (!Array.isArray(rows)) throw new Error("getArchivedTasks: expected array result from database")
    return rows.map((r) => rowToTask(r as Record<string, unknown>))
  }

  getArchivedTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND is_archived = 1").get(id) as Record<string, unknown> | null
    return row ? rowToTask(row) : null
  }

  getArchivedTasksByRun(runId: string): Task[] {
    const run = this.getWorkflowRun(runId)
    if (!run || run.taskOrder.length === 0) return []

    const placeholders = run.taskOrder.map(() => "?").join(",")
    const stmt = this.db.prepare(
      `SELECT * FROM tasks WHERE id IN (${placeholders}) AND is_archived = 1 ORDER BY archived_at DESC`
    )
    const rows = stmt.all(...run.taskOrder) as unknown[]
    if (!Array.isArray(rows)) throw new Error("getArchivedTasksByRun: expected array result from database")
    return rows.map((r) => rowToTask(r as Record<string, unknown>))
  }

  getWorkflowRunsWithArchivedTasks(): WorkflowRun[] {
    const runsStmt = this.db.prepare("SELECT * FROM workflow_runs ORDER BY finished_at DESC, created_at DESC")
    const runsResult = runsStmt.all() as unknown[]
    if (!Array.isArray(runsResult)) throw new Error("getWorkflowRunsWithArchivedTasks: expected array result from database")

    const runsWithArchived: WorkflowRun[] = []

    for (const row of runsResult) {
      const runRow = row as Record<string, unknown>
      const taskOrder = parseJSON<string[]>(runRow.task_order_json) ?? []
      if (taskOrder.length === 0) continue

      const placeholders = taskOrder.map(() => "?").join(",")
      const countStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND is_archived = 1`)
      const countResult = countStmt.get(...taskOrder) as unknown
      if (countResult === null || typeof countResult !== "object") throw new Error("getWorkflowRunsWithArchivedTasks: expected object result for count query")
      const countRow = countResult as Record<string, unknown>
      const cnt = typeof countRow.cnt === "number" ? countRow.cnt : Number(countRow.cnt)
      if (Number.isNaN(cnt)) throw new Error("getWorkflowRunsWithArchivedTasks: invalid count result from database")

      if (cnt > 0) {
        runsWithArchived.push(rowToWorkflowRun(runRow))
      }
    }

    return runsWithArchived
  }

  getArchivedTasksGroupedByRun(): Map<string, { run: WorkflowRun; tasks: Task[] }> {
    const result = new Map<string, { run: WorkflowRun; tasks: Task[] }>()
    const runs = this.getWorkflowRunsWithArchivedTasks()

    for (const run of runs) {
      const tasks = this.getArchivedTasksByRun(run.id)
      if (tasks.length > 0) {
        result.set(run.id, { run, tasks })
      }
    }

    return result
  }

    hasRunningWorkflows(): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM workflow_runs WHERE is_archived = 0 AND status IN ('queued', 'running', 'stopping', 'paused')"
    ).get() as { count: number }
    return row.count > 0
  }

  archiveWorkflowRun(id: string): WorkflowRun | null {
    const run = this.getWorkflowRun(id)
    if (!run) return null
    const now = nowUnix()
    this.db
      .prepare("UPDATE workflow_runs SET is_archived = 1, archived_at = ?, updated_at = unixepoch() WHERE id = ?")
      .run(now, id)
    return { ...run, isArchived: true, archivedAt: now, updatedAt: now }
  }

  updateWorkflowRun(id: string, input: UpdateWorkflowRunInput): WorkflowRun | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.displayName !== undefined) {
      sets.push("display_name = ?")
      values.push(input.displayName)
    }
    if (input.targetTaskId !== undefined) {
      sets.push("target_task_id = ?")
      values.push(input.targetTaskId)
    }
    if (input.taskOrder !== undefined) {
      sets.push("task_order_json = ?")
      values.push(JSON.stringify(input.taskOrder))
    }
    if (input.currentTaskId !== undefined) {
      sets.push("current_task_id = ?")
      values.push(input.currentTaskId)
    }
    if (input.currentTaskIndex !== undefined) {
      sets.push("current_task_index = ?")
      values.push(input.currentTaskIndex)
    }
    if (input.pauseRequested !== undefined) {
      sets.push("pause_requested = ?")
      values.push(input.pauseRequested ? 1 : 0)
    }
    if (input.stopRequested !== undefined) {
      sets.push("stop_requested = ?")
      values.push(input.stopRequested ? 1 : 0)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }
    if (input.finishedAt !== undefined) {
      sets.push("finished_at = ?")
      values.push(input.finishedAt)
    }

    if (sets.length === 0) return this.getWorkflowRun(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getWorkflowRun(id)
  }

  // ---- workflow sessions ----

  createWorkflowSession(input: CreatePiWorkflowSessionInput): PiWorkflowSession {
    const now = nowUnix()
    const startedAt = input.startedAt ?? now

    this.db
      .prepare(`
        INSERT INTO workflow_sessions (
          id, task_id, task_run_id, session_kind, status, cwd, worktree_dir, branch,
          pi_session_id, pi_session_file, process_pid, model, thinking_level,
          started_at, updated_at, finished_at, exit_code, exit_signal, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.taskId ?? null,
        input.taskRunId ?? null,
        input.sessionKind,
        input.status ?? "starting",
        input.cwd,
        input.worktreeDir ?? null,
        input.branch ?? null,
        input.piSessionId ?? null,
        input.piSessionFile ?? null,
        input.processPid ?? null,
        input.model ?? "default",
        input.thinkingLevel ?? "default",
        startedAt,
        now,
        input.finishedAt ?? null,
        input.exitCode ?? null,
        input.exitSignal ?? null,
        input.errorMessage ?? null,
      )

    return this.getWorkflowSession(input.id) as PiWorkflowSession
  }

  getWorkflowSession(id: string): PiWorkflowSession | null {
    const row = this.db.prepare("SELECT * FROM workflow_sessions WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToWorkflowSession(row) : null
  }

  getWorkflowSessionsByTask(taskId: string): PiWorkflowSession[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_sessions WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId) as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  getActiveWorkflowSessions(): PiWorkflowSession[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_sessions WHERE status IN ('starting', 'active', 'paused') ORDER BY started_at ASC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  updateWorkflowSession(id: string, input: UpdatePiWorkflowSessionInput): PiWorkflowSession | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.taskId !== undefined) {
      sets.push("task_id = ?")
      values.push(input.taskId)
    }
    if (input.taskRunId !== undefined) {
      sets.push("task_run_id = ?")
      values.push(input.taskRunId)
    }
    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.cwd !== undefined) {
      sets.push("cwd = ?")
      values.push(input.cwd)
    }
    if (input.worktreeDir !== undefined) {
      sets.push("worktree_dir = ?")
      values.push(input.worktreeDir)
    }
    if (input.branch !== undefined) {
      sets.push("branch = ?")
      values.push(input.branch)
    }
    if (input.piSessionId !== undefined) {
      sets.push("pi_session_id = ?")
      values.push(input.piSessionId)
    }
    if (input.piSessionFile !== undefined) {
      sets.push("pi_session_file = ?")
      values.push(input.piSessionFile)
    }
    if (input.processPid !== undefined) {
      sets.push("process_pid = ?")
      values.push(input.processPid)
    }
    if (input.model !== undefined) {
      sets.push("model = ?")
      values.push(input.model)
    }
    if (input.thinkingLevel !== undefined) {
      sets.push("thinking_level = ?")
      values.push(input.thinkingLevel)
    }
    if (input.finishedAt !== undefined) {
      sets.push("finished_at = ?")
      values.push(input.finishedAt)
    }
    if (input.exitCode !== undefined) {
      sets.push("exit_code = ?")
      values.push(input.exitCode)
    }
    if (input.exitSignal !== undefined) {
      sets.push("exit_signal = ?")
      values.push(input.exitSignal)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }

    if (sets.length === 0) return this.getWorkflowSession(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE workflow_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getWorkflowSession(id)
  }

  private getNextSessionMessageSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_messages WHERE session_id = ?")
      .get(sessionId) as { max_seq: number }
    return Number(row.max_seq ?? 0) + 1
  }

  private getSessionMessageRow(id: number): Record<string, unknown> | null {
    return this.db
      .prepare(`${SESSION_MESSAGE_SELECT} WHERE sm.id = ?`)
      .get(id) as Record<string, unknown> | null
  }

  private normalizeSessionMessages(): void {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM session_messages
        ORDER BY session_id ASC, seq ASC, timestamp ASC, id ASC
        `,
      )
      .all() as Record<string, unknown>[]

    if (rows.length === 0) return

    const update = this.db.prepare(`
      UPDATE session_messages
      SET
        seq = ?,
        message_id = ?,
        timestamp = ?,
        role = ?,
        event_name = ?,
        message_type = ?,
        content_json = ?,
        model_provider = ?,
        model_id = ?,
        agent_name = ?,
        prompt_tokens = ?,
        completion_tokens = ?,
        cache_read_tokens = ?,
        cache_write_tokens = ?,
        total_tokens = ?,
        cost_json = ?,
        cost_total = ?,
        tool_call_id = ?,
        tool_name = ?,
        tool_args_json = ?,
        tool_result_json = ?,
        tool_status = ?,
        edit_diff = ?,
        edit_file_path = ?,
        session_status = ?,
        workflow_phase = ?,
        raw_event_json = ?
      WHERE id = ?
    `)

    const tx = this.db.transaction((records: Record<string, unknown>[]) => {
      let currentSessionId = ""
      let seq = 0

      for (const row of records) {
        const sessionId = String(row.session_id)
        if (sessionId !== currentSessionId) {
          currentSessionId = sessionId
          seq = 0
        }
        seq += 1

        const rawEventJson = parseJSON<Record<string, unknown>>(row.raw_event_json)
        const legacyContent = parseJSON<Record<string, unknown>>(row.content_json) ?? {}
        const projected = rawEventJson
          ? projectPiEventToSessionMessage({ event: rawEventJson, sessionId })
          : null

        const timestamp = projected?.timestamp
          ?? (row.timestamp === null || row.timestamp === undefined ? nowUnix() : Number(row.timestamp))

        const updateArgs: (string | number | null)[] = [
          seq,
          projected?.messageId ?? (row.message_id ? String(row.message_id) : null),
          timestamp,
          projected?.role ?? String(row.role ?? "system"),
          projected?.eventName ?? pickString(legacyContent.eventName, legacyContent.eventType, legacyContent.method) ?? null,
          projected?.messageType ?? asMessageType(row.message_type),
          JSON.stringify(projected?.contentJson ?? legacyContent),
          projected?.modelProvider ?? (row.model_provider ? String(row.model_provider) : null),
          projected?.modelId ?? (row.model_id ? String(row.model_id) : null),
          projected?.agentName ?? (row.agent_name ? String(row.agent_name) : null),
          projected?.promptTokens ?? (row.prompt_tokens === null || row.prompt_tokens === undefined ? null : Number(row.prompt_tokens)),
          projected?.completionTokens ?? (row.completion_tokens === null || row.completion_tokens === undefined ? null : Number(row.completion_tokens)),
          projected?.cacheReadTokens ?? (row.cache_read_tokens === null || row.cache_read_tokens === undefined ? null : Number(row.cache_read_tokens)),
          projected?.cacheWriteTokens ?? (row.cache_write_tokens === null || row.cache_write_tokens === undefined ? null : Number(row.cache_write_tokens)),
          projected?.totalTokens ?? (row.total_tokens === null || row.total_tokens === undefined ? null : Number(row.total_tokens)),
          projected?.costJson ? JSON.stringify(projected.costJson) : (row.cost_json as string | null) ?? null,
          projected?.costTotal ?? (row.cost_total === null || row.cost_total === undefined ? null : Number(row.cost_total)),
          projected?.toolCallId ?? (row.tool_call_id ? String(row.tool_call_id) : null),
          projected?.toolName ?? (row.tool_name ? String(row.tool_name) : null),
          projected?.toolArgsJson ? JSON.stringify(projected.toolArgsJson) : (row.tool_args_json as string | null) ?? null,
          projected?.toolResultJson ? JSON.stringify(projected.toolResultJson) : (row.tool_result_json as string | null) ?? null,
          projected?.toolStatus ?? (row.tool_status ? String(row.tool_status) : null),
          projected?.editDiff ?? (row.edit_diff ? String(row.edit_diff) : null),
          projected?.editFilePath ?? (row.edit_file_path ? String(row.edit_file_path) : null),
          projected?.sessionStatus ?? (row.session_status ? String(row.session_status) : null),
          projected?.workflowPhase ?? (row.workflow_phase ? String(row.workflow_phase) : null),
          rawEventJson ? JSON.stringify(rawEventJson) : (row.raw_event_json as string | null) ?? null,
          Number(row.id),
        ]
        update.run(...(updateArgs as Parameters<typeof update.run>))
      }
    })

    tx(rows)
  }

  createSessionMessage(input: CreateSessionMessageInput): SessionMessage {
    const seq = input.seq ?? this.getNextSessionMessageSeq(input.sessionId)
    const timestamp = input.timestamp ?? nowUnix()
    const result = this.db
      .prepare(`
        INSERT INTO session_messages (
          seq, message_id, session_id, timestamp, role, event_name, message_type,
          content_json, model_provider, model_id, agent_name, prompt_tokens,
          completion_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
          cost_json, cost_total, tool_call_id, tool_name, tool_args_json, tool_result_json,
          tool_status, edit_diff, edit_file_path, session_status, workflow_phase, raw_event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        seq,
        input.messageId ?? null,
        input.sessionId,
        timestamp,
        input.role,
        input.eventName ?? null,
        input.messageType,
        JSON.stringify(input.contentJson),
        input.modelProvider ?? null,
        input.modelId ?? null,
        input.agentName ?? null,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.cacheReadTokens ?? null,
        input.cacheWriteTokens ?? null,
        input.totalTokens ?? null,
        input.costJson ? JSON.stringify(input.costJson) : null,
        input.costTotal ?? null,
        input.toolCallId ?? null,
        input.toolName ?? null,
        input.toolArgsJson ? JSON.stringify(input.toolArgsJson) : null,
        input.toolResultJson ? JSON.stringify(input.toolResultJson) : null,
        input.toolStatus ?? null,
        input.editDiff ?? null,
        input.editFilePath ?? null,
        input.sessionStatus ?? null,
        input.workflowPhase ?? null,
        input.rawEventJson ? JSON.stringify(input.rawEventJson) : null,
      )

    const row = this.getSessionMessageRow(Number(result.lastInsertRowid)) as Record<string, unknown>
    return rowToSessionMessage(row)
  }

  getSessionMessages(sessionId: string, options: SessionMessageQueryOptions = {}): SessionMessage[] {
    const limit = options.limit ?? 500
    const offset = options.offset ?? 0

    if (options.messageType) {
      const rows = this.db
        .prepare(
          `
          ${SESSION_MESSAGE_SELECT}
          WHERE sm.session_id = ? AND sm.message_type = ?
          ORDER BY sm.seq ASC, sm.id ASC
          LIMIT ? OFFSET ?
          `,
        )
      .all(sessionId, options.messageType, limit, offset) as Record<string, unknown>[]
      return rows.map(rowToSessionMessage)
    }

    const rows = this.db
      .prepare(
        `
        ${SESSION_MESSAGE_SELECT}
        WHERE sm.session_id = ?
        ORDER BY sm.seq ASC, sm.id ASC
        LIMIT ? OFFSET ?
        `,
      )
      .all(sessionId, limit, offset) as Record<string, unknown>[]
    return rows.map(rowToSessionMessage)
  }

  getSessionTimeline(sessionId: string): SessionMessage[] {
    return this.getSessionMessages(sessionId)
  }

  getSessionTimelineEntries(sessionId: string): TimelineEntry[] {
    const messages = this.getSessionMessages(sessionId)
    if (messages.length === 0) return []

    const base = messages[0]?.timestamp ?? 0
    return messages.map((message) => {
      const textContent = typeof message.contentJson?.text === "string"
        ? message.contentJson.text
        : JSON.stringify(message.contentJson)
      const summarySource = textContent.length > 180 ? `${textContent.slice(0, 177)}...` : textContent

      return {
        id: message.id,
        timestamp: message.timestamp,
        relativeTime: Math.max(0, message.timestamp - base),
        role: message.role,
        messageType: message.messageType,
        summary: summarySource || message.messageType,
        hasToolCalls: message.messageType === "tool_call" || message.messageType === "tool_result" || Boolean(message.toolName),
        hasEdits: Boolean(message.editDiff || message.editFilePath),
        modelProvider: message.modelProvider,
        modelId: message.modelId,
        agentName: message.agentName,
      }
    })
  }

  getSessionMessagesByType(sessionId: string, messageType: MessageType): SessionMessage[] {
    return this.getSessionMessages(sessionId, { messageType })
  }

  getSessionUsageRollup(sessionId: string): SessionUsageRollup {
    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS message_count,
          COUNT(total_tokens) AS tokenized_message_count,
          COUNT(cost_total) AS costed_message_count,
          MIN(timestamp) AS first_timestamp,
          MAX(timestamp) AS last_timestamp,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost_total), 0) AS total_cost
        FROM session_messages
        WHERE session_id = ?
        `,
      )
      .get(sessionId) as Record<string, unknown>

    return {
      sessionId,
      messageCount: Number(row.message_count ?? 0),
      tokenizedMessageCount: Number(row.tokenized_message_count ?? 0),
      costedMessageCount: Number(row.costed_message_count ?? 0),
      firstTimestamp: row.first_timestamp === null || row.first_timestamp === undefined ? null : Number(row.first_timestamp),
      lastTimestamp: row.last_timestamp === null || row.last_timestamp === undefined ? null : Number(row.last_timestamp),
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      totalCost: Number(row.total_cost ?? 0),
    }
  }

  /**
   * Get the timestamp of the most recent message for a task across all its sessions.
   * Returns null if the task has no messages.
   */
  getTaskLastMessageTimestamp(taskId: string): number | null {
    const row = this.db
      .prepare(
        `
        SELECT MAX(sm.timestamp) AS last_timestamp
        FROM session_messages sm
        INNER JOIN workflow_sessions ws ON ws.id = sm.session_id
        WHERE ws.task_id = ?
        `,
      )
      .get(taskId) as { last_timestamp: number | null } | null

    return row?.last_timestamp ?? null
  }

  updateSessionMessage(id: number, updates: Partial<CreateSessionMessageInput>): SessionMessage | null {
    const sets: string[] = []
    const values: any[] = []

    if (updates.seq !== undefined) {
      sets.push("seq = ?")
      values.push(updates.seq)
    }
    if (updates.messageId !== undefined) {
      sets.push("message_id = ?")
      values.push(updates.messageId)
    }
    if (updates.timestamp !== undefined) {
      sets.push("timestamp = ?")
      values.push(updates.timestamp)
    }
    if (updates.role !== undefined) {
      sets.push("role = ?")
      values.push(updates.role)
    }
    if (updates.eventName !== undefined) {
      sets.push("event_name = ?")
      values.push(updates.eventName)
    }
    if (updates.messageType !== undefined) {
      sets.push("message_type = ?")
      values.push(updates.messageType)
    }
    if (updates.contentJson !== undefined) {
      sets.push("content_json = ?")
      values.push(JSON.stringify(updates.contentJson))
    }
    if (updates.modelProvider !== undefined) {
      sets.push("model_provider = ?")
      values.push(updates.modelProvider)
    }
    if (updates.modelId !== undefined) {
      sets.push("model_id = ?")
      values.push(updates.modelId)
    }
    if (updates.agentName !== undefined) {
      sets.push("agent_name = ?")
      values.push(updates.agentName)
    }
    if (updates.promptTokens !== undefined) {
      sets.push("prompt_tokens = ?")
      values.push(updates.promptTokens)
    }
    if (updates.completionTokens !== undefined) {
      sets.push("completion_tokens = ?")
      values.push(updates.completionTokens)
    }
    if (updates.cacheReadTokens !== undefined) {
      sets.push("cache_read_tokens = ?")
      values.push(updates.cacheReadTokens)
    }
    if (updates.cacheWriteTokens !== undefined) {
      sets.push("cache_write_tokens = ?")
      values.push(updates.cacheWriteTokens)
    }
    if (updates.totalTokens !== undefined) {
      sets.push("total_tokens = ?")
      values.push(updates.totalTokens)
    }
    if (updates.costJson !== undefined) {
      sets.push("cost_json = ?")
      values.push(updates.costJson ? JSON.stringify(updates.costJson) : null)
    }
    if (updates.costTotal !== undefined) {
      sets.push("cost_total = ?")
      values.push(updates.costTotal)
    }
    if (updates.toolCallId !== undefined) {
      sets.push("tool_call_id = ?")
      values.push(updates.toolCallId)
    }
    if (updates.toolName !== undefined) {
      sets.push("tool_name = ?")
      values.push(updates.toolName)
    }
    if (updates.toolArgsJson !== undefined) {
      sets.push("tool_args_json = ?")
      values.push(updates.toolArgsJson ? JSON.stringify(updates.toolArgsJson) : null)
    }
    if (updates.toolResultJson !== undefined) {
      sets.push("tool_result_json = ?")
      values.push(updates.toolResultJson ? JSON.stringify(updates.toolResultJson) : null)
    }
    if (updates.toolStatus !== undefined) {
      sets.push("tool_status = ?")
      values.push(updates.toolStatus)
    }
    if (updates.editDiff !== undefined) {
      sets.push("edit_diff = ?")
      values.push(updates.editDiff)
    }
    if (updates.editFilePath !== undefined) {
      sets.push("edit_file_path = ?")
      values.push(updates.editFilePath)
    }
    if (updates.sessionStatus !== undefined) {
      sets.push("session_status = ?")
      values.push(updates.sessionStatus)
    }
    if (updates.workflowPhase !== undefined) {
      sets.push("workflow_phase = ?")
      values.push(updates.workflowPhase)
    }
    if (updates.rawEventJson !== undefined) {
      sets.push("raw_event_json = ?")
      values.push(updates.rawEventJson ? JSON.stringify(updates.rawEventJson) : null)
    }

    if (sets.length === 0) {
      const row = this.getSessionMessageRow(id)
      return row ? rowToSessionMessage(row) : null
    }

    values.push(id)
    this.db.prepare(`UPDATE session_messages SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    const row = this.getSessionMessageRow(id)
    return row ? rowToSessionMessage(row) : null
  }

  getSessionMessageViewsByTask(taskId: string): SessionMessage[] {
    const rows = this.db
      .prepare(
        `
        ${SESSION_MESSAGE_SELECT}
        WHERE ws.task_id = ?
        ORDER BY sm.seq ASC, sm.id ASC
        `,
      )
      .all(taskId) as Record<string, unknown>[]
    return rows.map(rowToSessionMessage)
  }

  getSessionMessageViewsByTaskRun(taskRunId: string): SessionMessage[] {
    const rows = this.db
      .prepare(
        `
        ${SESSION_MESSAGE_SELECT}
        WHERE ws.task_run_id = ?
        ORDER BY sm.seq ASC, sm.id ASC
        `,
      )
      .all(taskRunId) as Record<string, unknown>[]
    return rows.map(rowToSessionMessage)
  }

  // ---- options ----

  getOptions(): Options {
    const rows = this.db.prepare("SELECT key, value FROM options").all() as Array<{ key: string; value: string }>
    const values = new Map<string, string>()
    for (const row of rows) values.set(row.key, row.value)

    // Parse columnSorts from JSON if present
    let columnSorts: ColumnSortPreferences | undefined
    const columnSortsJson = values.get("column_sorts")
    if (columnSortsJson) {
      columnSorts = JSON.parse(columnSortsJson) as ColumnSortPreferences
    }

    const getValue = (key: string, treatDefaultAsEmpty = false): string => {
      const value = values.get(key) || ""
      if (treatDefaultAsEmpty && value === "default") return ""
      return value
    }

    const getNumber = (key: string): number => {
      const value = values.get(key)
      return value ? Number(value) : 0
    }

    const getBoolean = (key: string): boolean => {
      const value = values.get(key)
      return value === "true" || value === "1"
    }

    return {
      commitPrompt: getValue("commit_prompt"),
      extraPrompt: getValue("extra_prompt"),
      branch: getValue("branch"),
      planModel: getValue("plan_model", true),
      executionModel: getValue("execution_model", true),
      reviewModel: getValue("review_model", true),
      repairModel: getValue("repair_model", true),
      command: getValue("command"),
      parallelTasks: getNumber("parallel_tasks"),
      autoDeleteNormalSessions: getBoolean("auto_delete_normal_sessions"),
      autoDeleteReviewSessions: getBoolean("auto_delete_review_sessions"),
      showExecutionGraph: getBoolean("show_execution_graph"),
      port: getNumber("port"),
      thinkingLevel: asThinkingLevel(values.get("thinking_level")),
      planThinkingLevel: asThinkingLevel(values.get("plan_thinking_level")),
      executionThinkingLevel: asThinkingLevel(values.get("execution_thinking_level")),
      reviewThinkingLevel: asThinkingLevel(values.get("review_thinking_level")),
      repairThinkingLevel: asThinkingLevel(values.get("repair_thinking_level")),
      codeStylePrompt: getValue("code_style_prompt") || DEFAULT_CODE_STYLE_PROMPT,
      telegramBotToken: getValue("telegram_bot_token"),
      telegramChatId: getValue("telegram_chat_id"),
      telegramNotificationLevel: this.asTelegramNotificationLevel(values.get("telegram_notification_level")),
      maxReviews: getNumber("max_reviews"),
      maxJsonParseRetries: getNumber("max_json_parse_retries") || 5,
      columnSorts,
    }
  }

  updateOptions(partial: Partial<Options>): Options {
    const upsert = this.db.prepare(
      "INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )

    if (partial.commitPrompt !== undefined) upsert.run("commit_prompt", partial.commitPrompt)
    if (partial.extraPrompt !== undefined) upsert.run("extra_prompt", partial.extraPrompt)
    if (partial.branch !== undefined) upsert.run("branch", partial.branch)
    if (partial.planModel !== undefined) upsert.run("plan_model", partial.planModel)
    if (partial.executionModel !== undefined) upsert.run("execution_model", partial.executionModel)
    if (partial.reviewModel !== undefined) upsert.run("review_model", partial.reviewModel)
    if (partial.repairModel !== undefined) upsert.run("repair_model", partial.repairModel)
    if (partial.command !== undefined) upsert.run("command", partial.command)
    if (partial.parallelTasks !== undefined) upsert.run("parallel_tasks", String(partial.parallelTasks))
    if (partial.autoDeleteNormalSessions !== undefined) upsert.run("auto_delete_normal_sessions", String(partial.autoDeleteNormalSessions))
    if (partial.autoDeleteReviewSessions !== undefined) upsert.run("auto_delete_review_sessions", String(partial.autoDeleteReviewSessions))
    if (partial.showExecutionGraph !== undefined) upsert.run("show_execution_graph", String(partial.showExecutionGraph))
    if (partial.port !== undefined) upsert.run("port", String(partial.port))
    if (partial.thinkingLevel !== undefined) upsert.run("thinking_level", partial.thinkingLevel)
    if (partial.telegramNotificationLevel !== undefined) upsert.run("telegram_notification_level", partial.telegramNotificationLevel)
    if (partial.planThinkingLevel !== undefined) upsert.run("plan_thinking_level", partial.planThinkingLevel)
    if (partial.executionThinkingLevel !== undefined) upsert.run("execution_thinking_level", partial.executionThinkingLevel)
    if (partial.reviewThinkingLevel !== undefined) upsert.run("review_thinking_level", partial.reviewThinkingLevel)
    if (partial.repairThinkingLevel !== undefined) upsert.run("repair_thinking_level", partial.repairThinkingLevel)
    if (partial.codeStylePrompt !== undefined) upsert.run("code_style_prompt", partial.codeStylePrompt)
    if (partial.telegramBotToken !== undefined) upsert.run("telegram_bot_token", partial.telegramBotToken)
    if (partial.telegramChatId !== undefined) upsert.run("telegram_chat_id", partial.telegramChatId)
    if (partial.maxReviews !== undefined) upsert.run("max_reviews", String(partial.maxReviews))
    if (partial.maxJsonParseRetries !== undefined) upsert.run("max_json_parse_retries", String(partial.maxJsonParseRetries))
    if (partial.columnSorts !== undefined) upsert.run("column_sorts", JSON.stringify(partial.columnSorts))

    return this.getOptions()
  }

  // ---- prompt templates ----

  getPromptTemplate(key: PromptTemplateKey | string): PromptTemplate | null {
    const row = this.db
      .prepare("SELECT * FROM prompt_templates WHERE key = ? AND is_active = 1 LIMIT 1")
      .get(key) as Record<string, unknown> | null
    return row ? rowToPromptTemplate(row) : null
  }

  getAllPromptTemplates(): PromptTemplate[] {
    const rows = this.db
      .prepare("SELECT * FROM prompt_templates ORDER BY key ASC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToPromptTemplate)
  }

  getPromptTemplateVersions(key: PromptTemplateKey | string): PromptTemplateVersion[] {
    const rows = this.db
      .prepare(
        `
        SELECT v.*
        FROM prompt_template_versions v
        INNER JOIN prompt_templates t ON t.id = v.prompt_template_id
        WHERE t.key = ?
        ORDER BY v.version ASC
        `,
      )
      .all(key) as Record<string, unknown>[]
    return rows.map(rowToPromptTemplateVersion)
  }

  upsertPromptTemplate(input: UpsertPromptTemplateInput): PromptTemplate {
    const existing = this.db
      .prepare("SELECT * FROM prompt_templates WHERE key = ? LIMIT 1")
      .get(input.key) as Record<string, unknown> | null

    const variablesJson = JSON.stringify(input.variablesJson ?? [])

    if (!existing) {
      const result = this.db
        .prepare(
          `
          INSERT INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
          `,
        )
        .run(
          input.key,
          input.name,
          input.description ?? "",
          input.templateText,
          variablesJson,
          input.isActive === false ? 0 : 1,
        )

      const createdRow = this.db.prepare("SELECT * FROM prompt_templates WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
      this.insertPromptTemplateVersion(Number(createdRow.id), input.templateText, variablesJson)
      return rowToPromptTemplate(createdRow)
    }

    const existingTemplate = rowToPromptTemplate(existing)
    const templateChanged = existingTemplate.templateText !== input.templateText
    const varsChanged = JSON.stringify(existingTemplate.variablesJson) !== variablesJson

    this.db
      .prepare(
        `
        UPDATE prompt_templates
        SET name = ?, description = ?, template_text = ?, variables_json = ?, is_active = ?, updated_at = unixepoch()
        WHERE key = ?
        `,
      )
      .run(
        input.name,
        input.description ?? existingTemplate.description,
        input.templateText,
        variablesJson,
        input.isActive === undefined ? (existingTemplate.isActive ? 1 : 0) : input.isActive ? 1 : 0,
        input.key,
      )

    if (templateChanged || varsChanged) {
      this.insertPromptTemplateVersion(existingTemplate.id, input.templateText, variablesJson)
    }

    const updatedRow = this.db.prepare("SELECT * FROM prompt_templates WHERE key = ?").get(input.key) as Record<string, unknown>
    return rowToPromptTemplate(updatedRow)
  }

  renderPrompt(key: PromptTemplateKey | string, variables: Record<string, unknown> = {}): PromptRenderResult {
    const template = this.getPromptTemplate(key)
    if (!template) {
      throw new Error(`Prompt template not found or inactive: ${key}`)
    }

    const renderedText = renderTemplate(template, variables)

    return { template, renderedText }
  }

  renderPromptAndCapture(input: PromptRenderAndCaptureInput): PromptRenderResult {
    if (input.key == null) {
      throw new Error(`Prompt render key is required but was not provided`)
    }
    return this.renderPrompt(input.key, input.variables)
  }

  // ---- low-level helpers ----

  getRawHandle(): Database {
    return this.db
  }

  private asTelegramNotificationLevel(value: unknown): TelegramNotificationLevel {
    if (value === "all" || value === "failures" || value === "done_and_failures" || value === "workflow_done_and_failures") {
      return value
    }
    throw new Error(`Invalid telegram notification level: ${JSON.stringify(value)}. Expected "all", "failures", "done_and_failures", or "workflow_done_and_failures"`)
  }

  private getNextTaskIndex(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(idx), -1) AS max_idx FROM tasks").get() as { max_idx: number }
    return Number(row.max_idx ?? -1) + 1
  }

  private seedDefaultOptions(): void {
    const upsert = this.db.prepare(
      "INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    )

    const entries = [
      ["commit_prompt", DEFAULT_OPTIONS.commitPrompt],
      ["extra_prompt", DEFAULT_OPTIONS.extraPrompt],
      ["branch", DEFAULT_OPTIONS.branch],
      ["plan_model", DEFAULT_OPTIONS.planModel],
      ["execution_model", DEFAULT_OPTIONS.executionModel],
      ["review_model", DEFAULT_OPTIONS.reviewModel],
      ["repair_model", DEFAULT_OPTIONS.repairModel],
      ["command", DEFAULT_OPTIONS.command],
      ["parallel_tasks", String(DEFAULT_OPTIONS.parallelTasks)],
      ["auto_delete_normal_sessions", String(DEFAULT_OPTIONS.autoDeleteNormalSessions)],
      ["auto_delete_review_sessions", String(DEFAULT_OPTIONS.autoDeleteReviewSessions)],
      ["show_execution_graph", String(DEFAULT_OPTIONS.showExecutionGraph)],
      ["port", String(DEFAULT_OPTIONS.port)],
      ["thinking_level", DEFAULT_OPTIONS.thinkingLevel],
      ["plan_thinking_level", DEFAULT_OPTIONS.planThinkingLevel],
      ["execution_thinking_level", DEFAULT_OPTIONS.executionThinkingLevel],
      ["review_thinking_level", DEFAULT_OPTIONS.reviewThinkingLevel],
      ["repair_thinking_level", DEFAULT_OPTIONS.repairThinkingLevel],
      ["code_style_prompt", DEFAULT_OPTIONS.codeStylePrompt],
      ["telegram_bot_token", DEFAULT_OPTIONS.telegramBotToken],
      ["telegram_chat_id", DEFAULT_OPTIONS.telegramChatId],
      ["telegram_notification_level", DEFAULT_OPTIONS.telegramNotificationLevel],
      ["max_reviews", String(DEFAULT_OPTIONS.maxReviews)],
    ] as const

    for (const [key, value] of entries) {
      upsert.run(key, value)
    }
  }

  private seedPromptTemplates(): void {
    for (const template of DEFAULT_PROMPT_TEMPLATES) {
      this.upsertPromptTemplate(template)
    }
  }

  private insertPromptTemplateVersion(templateId: number, templateText: string, variablesJsonText: string): void {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS max_version FROM prompt_template_versions WHERE prompt_template_id = ?")
      .get(templateId) as { max_version: number }
    const nextVersion = Number(row.max_version ?? 0) + 1

    this.db
      .prepare(
        `
        INSERT INTO prompt_template_versions (
          prompt_template_id, version, template_text, variables_json, created_at
        ) VALUES (?, ?, ?, ?, unixepoch())
        `,
      )
      .run(templateId, nextVersion, templateText, variablesJsonText)
  }

  // ---- planning prompts ----

  private seedPlanningPrompts(): void {
    // Seed default planning prompt
    const existingDefault = this.db.prepare("SELECT 1 FROM planning_prompts WHERE key = 'default'").get()
    if (!existingDefault) {
      this.db
        .prepare(
          `
          INSERT INTO planning_prompts (key, name, description, prompt_text, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, unixepoch(), unixepoch())
          `,
        )
        .run(
          "default",
          "Default Planning Prompt",
          "System prompt for the planning assistant agent",
          DEFAULT_PLANNING_SYSTEM_PROMPT,
        )
    }

    // Seed container config prompt
    const existingContainer = this.db.prepare("SELECT 1 FROM planning_prompts WHERE key = 'container_config'").get()
    if (!existingContainer) {
      this.db
        .prepare(
          `
          INSERT INTO planning_prompts (key, name, description, prompt_text, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, unixepoch(), unixepoch())
          `,
        )
        .run(
          "container_config",
          "Container Configuration Prompt",
          "System prompt for the container configuration assistant agent",
          CONTAINER_CONFIG_SYSTEM_PROMPT,
        )
    }
  }

  getPlanningPrompt(key: string = "default"): PlanningPrompt | null {
    const row = this.db
      .prepare("SELECT * FROM planning_prompts WHERE key = ? AND is_active = 1")
      .get(key) as Record<string, unknown> | null
    return row ? rowToPlanningPrompt(row) : null
  }

  getAllPlanningPrompts(): PlanningPrompt[] {
    const rows = this.db
      .prepare("SELECT * FROM planning_prompts ORDER BY key ASC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToPlanningPrompt)
  }

  getPlanningPromptVersions(key: string): PlanningPromptVersion[] {
    const rows = this.db
      .prepare(
        `
        SELECT v.*
        FROM planning_prompt_versions v
        INNER JOIN planning_prompts p ON p.id = v.planning_prompt_id
        WHERE p.key = ?
        ORDER BY v.version ASC
        `,
      )
      .all(key) as Record<string, unknown>[]
    return rows.map(rowToPlanningPromptVersion)
  }

  upsertPlanningPrompt(input: UpsertPlanningPromptInput): PlanningPrompt {
    const key = input.key ?? "default"
    const existing = this.db.prepare("SELECT * FROM planning_prompts WHERE key = ?").get(key) as Record<string, unknown> | null

    if (!existing) {
      const result = this.db
        .prepare(
          `
          INSERT INTO planning_prompts (key, name, description, prompt_text, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
          `,
        )
        .run(
          key,
          input.name,
          input.description ?? "",
          input.promptText,
          input.isActive === false ? 0 : 1,
        )

      const createdRow = this.db.prepare("SELECT * FROM planning_prompts WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
      this.insertPlanningPromptVersion(Number(createdRow.id), input.promptText)
      return rowToPlanningPrompt(createdRow)
    }

    const existingPrompt = rowToPlanningPrompt(existing)
    const promptChanged = existingPrompt.promptText !== input.promptText

    this.db
      .prepare(
        `
        UPDATE planning_prompts
        SET name = ?, description = ?, prompt_text = ?, is_active = ?, updated_at = unixepoch()
        WHERE key = ?
        `,
      )
      .run(
        input.name,
        input.description ?? existingPrompt.description,
        input.promptText,
        input.isActive === undefined ? (existingPrompt.isActive ? 1 : 0) : input.isActive ? 1 : 0,
        key,
      )

    if (promptChanged) {
      this.insertPlanningPromptVersion(existingPrompt.id, input.promptText)
    }

    const updatedRow = this.db.prepare("SELECT * FROM planning_prompts WHERE key = ?").get(key) as Record<string, unknown>
    return rowToPlanningPrompt(updatedRow)
  }

  updatePlanningPrompt(id: number, input: UpdatePlanningPromptInput): PlanningPrompt | null {
    const existing = this.db.prepare("SELECT * FROM planning_prompts WHERE id = ?").get(id) as Record<string, unknown> | null
    if (!existing) return null

    const sets: string[] = []
    const values: any[] = []

    if (input.name !== undefined) {
      sets.push("name = ?")
      values.push(input.name)
    }
    if (input.description !== undefined) {
      sets.push("description = ?")
      values.push(input.description)
    }
    if (input.promptText !== undefined) {
      sets.push("prompt_text = ?")
      values.push(input.promptText)
    }
    if (input.isActive !== undefined) {
      sets.push("is_active = ?")
      values.push(input.isActive ? 1 : 0)
    }

    if (sets.length === 0) return this.getPlanningPromptById(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE planning_prompts SET ${sets.join(", ")} WHERE id = ?`).run(...values)

    if (input.promptText !== undefined) {
      const existingPrompt = rowToPlanningPrompt(existing)
      this.insertPlanningPromptVersion(id, input.promptText)
    }

    return this.getPlanningPromptById(id)
  }

  getPlanningPromptById(id: number): PlanningPrompt | null {
    const row = this.db.prepare("SELECT * FROM planning_prompts WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToPlanningPrompt(row) : null
  }

  deletePlanningPrompt(id: number): boolean {
    const result = this.db.prepare("DELETE FROM planning_prompts WHERE id = ?").run(id)
    return result.changes > 0
  }

  private insertPlanningPromptVersion(planningPromptId: number, promptText: string): void {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS max_version FROM planning_prompt_versions WHERE planning_prompt_id = ?")
      .get(planningPromptId) as { max_version: number }
    const nextVersion = Number(row.max_version ?? 0) + 1

    this.db
      .prepare(
        `
        INSERT INTO planning_prompt_versions (planning_prompt_id, version, prompt_text, created_at)
        VALUES (?, ?, ?, unixepoch())
        `,
      )
      .run(planningPromptId, nextVersion, promptText)
  }

  // ---- planning sessions (chat) ----

  getPlanningSessions(): PiWorkflowSession[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_sessions WHERE session_kind IN ('planning', 'container_config') ORDER BY started_at DESC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  getActivePlanningSessions(): PiWorkflowSession[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM workflow_sessions WHERE session_kind IN ('planning', 'container_config') AND status IN ('starting', 'active', 'paused') ORDER BY started_at DESC"
      )
      .all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  getContainerConfigSessions(): PiWorkflowSession[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_sessions WHERE session_kind = 'container_config' ORDER BY started_at DESC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  getActiveContainerConfigSessions(): PiWorkflowSession[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM workflow_sessions WHERE session_kind = 'container_config' AND status IN ('starting', 'active', 'paused') ORDER BY started_at DESC"
      )
      .all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  // ---- Container Configuration ----

  getContainerPackages(): ContainerPackage[] {
    const rows = this.db
      .prepare("SELECT * FROM container_packages ORDER BY install_order ASC, added_at ASC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToContainerPackage)
  }

  addContainerPackage(input: CreateContainerPackageInput): ContainerPackage {
    const result = this.db
      .prepare(
        `
        INSERT INTO container_packages (name, category, version_constraint, install_order, source, added_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(name) DO UPDATE SET
          category = excluded.category,
          version_constraint = excluded.version_constraint,
          install_order = excluded.install_order,
          source = excluded.source,
          added_at = unixepoch()
        `
      )
      .run(
        input.name,
        input.category,
        input.versionConstraint ?? null,
        input.installOrder ?? 0,
        input.source ?? "manual",
      )

    const row = this.db
      .prepare("SELECT * FROM container_packages WHERE id = ?")
      .get(result.lastInsertRowid) as Record<string, unknown>
    return rowToContainerPackage(row)
  }

  removeContainerPackage(name: string): boolean {
    const result = this.db.prepare("DELETE FROM container_packages WHERE name = ?").run(name)
    return result.changes > 0
  }

  clearContainerPackages(): void {
    this.db.exec("DELETE FROM container_packages")
  }

  // ---- Container Builds ----

  createContainerBuild(input: { status: ContainerBuild["status"]; startedAt: number; packagesHash?: string; imageTag?: string; logs?: string }): number {
    const result = this.db
      .prepare(
        `
        INSERT INTO container_builds (status, started_at, packages_hash, image_tag, logs)
        VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(input.status, input.startedAt, input.packagesHash ?? null, input.imageTag ?? null, input.logs ?? null)
    return Number(result.lastInsertRowid)
  }

  updateContainerBuild(id: number, input: { status?: ContainerBuild["status"]; completedAt?: number; errorMessage?: string; logs?: string }): ContainerBuild | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.completedAt !== undefined) {
      sets.push("completed_at = ?")
      values.push(input.completedAt)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }
    if (input.logs !== undefined) {
      sets.push("logs = ?")
      values.push(input.logs)
    }

    if (sets.length === 0) return this.getContainerBuild(id)

    values.push(id)
    this.db.prepare(`UPDATE container_builds SET ${sets.join(", ")} WHERE id = ?`).run(...values)

    return this.getContainerBuild(id)
  }

  getContainerBuild(id: number): ContainerBuild | null {
    const row = this.db.prepare("SELECT * FROM container_builds WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToContainerBuild(row) : null
  }

  getContainerBuilds(limit: number = 10): ContainerBuild[] {
    const rows = this.db
      .prepare("SELECT * FROM container_builds ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
    return rows.map(rowToContainerBuild)
  }

  getLatestContainerBuild(): ContainerBuild | null {
    const row = this.db
      .prepare("SELECT * FROM container_builds ORDER BY started_at DESC LIMIT 1")
      .get() as Record<string, unknown> | null
    return row ? rowToContainerBuild(row) : null
  }

  // ---- Paused Session States ----

  savePausedSessionState(state: {
    sessionId: string
    taskId: string | null
    taskRunId: string | null
    sessionKind: string
    cwd: string | null
    worktreeDir: string | null
    branch: string | null
    model: string
    thinkingLevel: string
    piSessionId: string | null
    piSessionFile: string | null
    containerId: string | null
    containerImage: string | null
    pausedAt: number
    lastPrompt: string | null
    executionPhase: string | null
    context: { agentOutputSnapshot: string | null; pendingToolCalls: unknown[] | null; reviewCount: number }
    pauseReason?: string | null
  }): void {
    const contextJson = JSON.stringify(state.context)

    this.db.run(
      `INSERT INTO paused_session_states (
        session_id, task_id, task_run_id, session_kind, cwd, worktree_dir, branch,
        model, thinking_level, pi_session_id, pi_session_file, container_id,
        container_image, paused_at, last_prompt, execution_phase, context_json, pause_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        task_id = excluded.task_id,
        task_run_id = excluded.task_run_id,
        session_kind = excluded.session_kind,
        cwd = excluded.cwd,
        worktree_dir = excluded.worktree_dir,
        branch = excluded.branch,
        model = excluded.model,
        thinking_level = excluded.thinking_level,
        pi_session_id = excluded.pi_session_id,
        pi_session_file = excluded.pi_session_file,
        container_id = excluded.container_id,
        container_image = excluded.container_image,
        paused_at = excluded.paused_at,
        last_prompt = excluded.last_prompt,
        execution_phase = excluded.execution_phase,
        context_json = excluded.context_json,
        pause_reason = excluded.pause_reason`,
      [
        state.sessionId,
        state.taskId,
        state.taskRunId,
        state.sessionKind,
        state.cwd,
        state.worktreeDir,
        state.branch,
        state.model,
        state.thinkingLevel,
        state.piSessionId,
        state.piSessionFile,
        state.containerId,
        state.containerImage,
        state.pausedAt,
        state.lastPrompt,
        state.executionPhase,
        contextJson,
        state.pauseReason ?? null,
      ]
    )
  }

  loadPausedSessionState(sessionId: string): {
    sessionId: string
    taskId: string | null
    taskRunId: string | null
    sessionKind: string
    cwd: string | null
    worktreeDir: string | null
    branch: string | null
    model: string
    thinkingLevel: string
    piSessionId: string | null
    piSessionFile: string | null
    containerId: string | null
    containerImage: string | null
    pausedAt: number
    lastPrompt: string | null
    executionPhase: string | null
    context: { agentOutputSnapshot: string | null; pendingToolCalls: unknown[] | null; reviewCount: number }
    pauseReason: string | null
  } | null {
    const row = this.db
      .prepare("SELECT * FROM paused_session_states WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | null

    if (!row) return null

    const context = parseJSON<{ agentOutputSnapshot: string | null; pendingToolCalls: unknown[] | null; reviewCount: number }>(row.context_json)
      ?? { agentOutputSnapshot: null, pendingToolCalls: null, reviewCount: 0 }

    return {
      sessionId: String(row.session_id),
      taskId: row.task_id ? String(row.task_id) : null,
      taskRunId: row.task_run_id ? String(row.task_run_id) : null,
      sessionKind: String(row.session_kind),
      cwd: row.cwd ? String(row.cwd) : null,
      worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
      branch: row.branch ? String(row.branch) : null,
      model: String(row.model),
      thinkingLevel: String(row.thinking_level),
      piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
      piSessionFile: row.pi_session_file ? String(row.pi_session_file) : null,
      containerId: row.container_id ? String(row.container_id) : null,
      containerImage: row.container_image ? String(row.container_image) : null,
      pausedAt: Number(row.paused_at),
      lastPrompt: row.last_prompt ? String(row.last_prompt) : null,
      executionPhase: row.execution_phase ? String(row.execution_phase) : null,
      context: {
        agentOutputSnapshot: context.agentOutputSnapshot ?? null,
        pendingToolCalls: context.pendingToolCalls ?? null,
        reviewCount: context.reviewCount ?? 0,
      },
      pauseReason: row.pause_reason ? String(row.pause_reason) : null,
    }
  }

  clearPausedSessionState(sessionId: string): void {
    this.db.prepare("DELETE FROM paused_session_states WHERE session_id = ?").run(sessionId)
  }

  listPausedSessions(): Array<{
    sessionId: string
    taskId: string | null
    taskRunId: string | null
    sessionKind: string
    cwd: string | null
    worktreeDir: string | null
    branch: string | null
    model: string
    thinkingLevel: string
    piSessionId: string | null
    piSessionFile: string | null
    containerId: string | null
    containerImage: string | null
    pausedAt: number
    lastPrompt: string | null
    executionPhase: string | null
    context: { agentOutputSnapshot: string | null; pendingToolCalls: unknown[] | null; reviewCount: number }
    pauseReason: string | null
  }> {
    const rows = this.db.prepare("SELECT * FROM paused_session_states ORDER BY paused_at DESC").all() as Record<string, unknown>[]

    return rows.map((row) => {
      const context = parseJSON<{ agentOutputSnapshot: string | null; pendingToolCalls: unknown[] | null; reviewCount: number }>(row.context_json)
        ?? { agentOutputSnapshot: null, pendingToolCalls: null, reviewCount: 0 }

      return {
        sessionId: String(row.session_id),
        taskId: row.task_id ? String(row.task_id) : null,
        taskRunId: row.task_run_id ? String(row.task_run_id) : null,
        sessionKind: String(row.session_kind),
        cwd: row.cwd ? String(row.cwd) : null,
        worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
        branch: row.branch ? String(row.branch) : null,
        model: String(row.model),
        thinkingLevel: String(row.thinking_level),
        piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
        piSessionFile: row.pi_session_file ? String(row.pi_session_file) : null,
        containerId: row.container_id ? String(row.container_id) : null,
        containerImage: row.container_image ? String(row.container_image) : null,
        pausedAt: Number(row.paused_at),
        lastPrompt: row.last_prompt ? String(row.last_prompt) : null,
        executionPhase: row.execution_phase ? String(row.execution_phase) : null,
        context: {
          agentOutputSnapshot: context.agentOutputSnapshot ?? null,
          pendingToolCalls: context.pendingToolCalls ?? null,
          reviewCount: context.reviewCount ?? 0,
        },
        pauseReason: row.pause_reason ? String(row.pause_reason) : null,
      }
    })
  }

  getPausedSessionsByTask(taskId: string): Array<{
    sessionId: string
    taskId: string | null
    taskRunId: string | null
    sessionKind: string
    cwd: string | null
    worktreeDir: string | null
    branch: string | null
    model: string
    thinkingLevel: string
    piSessionId: string | null
    piSessionFile: string | null
    containerId: string | null
    containerImage: string | null
    pausedAt: number
    lastPrompt: string | null
    executionPhase: string | null
    context: { agentOutputSnapshot: string | null; pendingToolCalls: unknown[] | null; reviewCount: number }
    pauseReason: string | null
  }> {
    const rows = this.db
      .prepare("SELECT * FROM paused_session_states WHERE task_id = ? ORDER BY paused_at DESC")
      .all(taskId) as Record<string, unknown>[]

    return rows.map((row) => {
      const context = parseJSON<{ agentOutputSnapshot: string | null; pendingToolCalls: unknown[] | null; reviewCount: number }>(row.context_json)
        ?? { agentOutputSnapshot: null, pendingToolCalls: null, reviewCount: 0 }

      return {
        sessionId: String(row.session_id),
        taskId: row.task_id ? String(row.task_id) : null,
        taskRunId: row.task_run_id ? String(row.task_run_id) : null,
        sessionKind: String(row.session_kind),
        cwd: row.cwd ? String(row.cwd) : null,
        worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
        branch: row.branch ? String(row.branch) : null,
        model: String(row.model),
        thinkingLevel: String(row.thinking_level),
        piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
        piSessionFile: row.pi_session_file ? String(row.pi_session_file) : null,
        containerId: row.container_id ? String(row.container_id) : null,
        containerImage: row.container_image ? String(row.container_image) : null,
        pausedAt: Number(row.paused_at),
        lastPrompt: row.last_prompt ? String(row.last_prompt) : null,
        executionPhase: row.execution_phase ? String(row.execution_phase) : null,
        context: {
          agentOutputSnapshot: context.agentOutputSnapshot ?? null,
          pendingToolCalls: context.pendingToolCalls ?? null,
          reviewCount: context.reviewCount ?? 0,
        },
        pauseReason: row.pause_reason ? String(row.pause_reason) : null,
      }
    })
  }

  clearAllPausedSessionStates(): void {
    this.db.exec("DELETE FROM paused_session_states")
  }

  // ---- Paused Run States (workflow-level pause state) ----

  savePausedRunState(state: {
    runId: string
    kind: "all_tasks" | "single_task" | "workflow_review" | "group_tasks"
    taskOrder: string[]
    currentTaskIndex: number
    currentTaskId: string | null
    targetTaskId: string | null
    pausedAt: number
    executionPhase: "not_started" | "planning" | "executing" | "reviewing" | "committing"
  }): void {
    this.db.run(
      `INSERT INTO paused_run_states (
        run_id, kind, task_order_json, current_task_index, current_task_id,
        target_task_id, paused_at, execution_phase
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        kind = excluded.kind,
        task_order_json = excluded.task_order_json,
        current_task_index = excluded.current_task_index,
        current_task_id = excluded.current_task_id,
        target_task_id = excluded.target_task_id,
        paused_at = excluded.paused_at,
        execution_phase = excluded.execution_phase`,
      [
        state.runId,
        state.kind,
        JSON.stringify(state.taskOrder),
        state.currentTaskIndex,
        state.currentTaskId,
        state.targetTaskId,
        state.pausedAt,
        state.executionPhase,
      ]
    )
  }

  loadPausedRunState(runId: string): {
    runId: string
    kind: "all_tasks" | "single_task" | "workflow_review" | "group_tasks"
    taskOrder: string[]
    currentTaskIndex: number
    currentTaskId: string | null
    targetTaskId: string | null
    pausedAt: number
    executionPhase: ExecutionPhase
  } | null {
    const row = this.db
      .prepare("SELECT * FROM paused_run_states WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | null

    if (!row) return null

    return {
      runId: String(row.run_id),
      kind: asWorkflowRunKind(row.kind),
      taskOrder: parseJSON<string[]>(row.task_order_json) ?? [],
      currentTaskIndex: Number(row.current_task_index ?? 0),
      currentTaskId: row.current_task_id ? String(row.current_task_id) : null,
      targetTaskId: row.target_task_id ? String(row.target_task_id) : null,
      pausedAt: Number(row.paused_at),
      executionPhase: asExecutionPhase(row.execution_phase),
    }
  }

  clearPausedRunState(runId: string): void {
    this.db.prepare("DELETE FROM paused_run_states WHERE run_id = ?").run(runId)
  }

  hasPausedRunState(runId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM paused_run_states WHERE run_id = ?")
      .get(runId) as { 1: number } | null
    return row !== null
  }

  listPausedRunStates(): Array<{
    runId: string
    kind: WorkflowRunKind
    taskOrder: string[]
    currentTaskIndex: number
    currentTaskId: string | null
    targetTaskId: string | null
    pausedAt: number
    executionPhase: ExecutionPhase
  }> {
    const rows = this.db.prepare("SELECT * FROM paused_run_states ORDER BY paused_at DESC").all() as Record<string, unknown>[]

    return rows.map((row) => ({
      runId: String(row.run_id),
      kind: asWorkflowRunKind(row.kind),
      taskOrder: parseJSON<string[]>(row.task_order_json) ?? [],
      currentTaskIndex: Number(row.current_task_index ?? 0),
      currentTaskId: row.current_task_id ? String(row.current_task_id) : null,
      targetTaskId: row.target_task_id ? String(row.target_task_id) : null,
      pausedAt: Number(row.paused_at),
      executionPhase: asExecutionPhase(row.execution_phase),
    }))
  }

  clearAllPausedRunStates(): void {
    this.db.exec("DELETE FROM paused_run_states")
  }

  // ---- workflow runs indicators ----

  getWorkflowRunIndicators(sessionId: string): WorkflowRunIndicators | null {
    const row = this.db.prepare("SELECT * FROM workflow_runs_indicators WHERE id = ?").get(sessionId) as Record<string, unknown> | null
    return row ? rowToWorkflowRunIndicators(row) : null
  }

  createWorkflowRunIndicators(input: CreateWorkflowRunIndicatorsInput): WorkflowRunIndicators {
    const defaultFails = { "json-output-fails": [] as JsonOutFailEntry[] }
    const jsonOutFails = input.jsonOutFails ?? defaultFails

    this.db
      .prepare("INSERT INTO workflow_runs_indicators (id, json_out_fails) VALUES (?, ?)")
      .run(input.id, JSON.stringify(jsonOutFails))

    return this.getWorkflowRunIndicators(input.id) as WorkflowRunIndicators
  }

  incrementJsonOutFail(sessionId: string, model: string): void {
    const modelSelection = parseModelSelection(model)
    const provider = modelSelection?.provider ?? "unknown"
    const modelId = modelSelection?.modelId ?? model
    const now = nowUnix()

    // Get or create indicators record
    let indicators = this.getWorkflowRunIndicators(sessionId)
    if (!indicators) {
      indicators = this.createWorkflowRunIndicators({ id: sessionId })
    }

    // Parse existing fails
    const fails = indicators.jsonOutFails["json-output-fails"] ?? []

    // Find existing entry for this model/provider
    const existingIndex = fails.findIndex((entry) => entry.model === modelId && entry.provider === provider)

    if (existingIndex >= 0) {
      // Update existing entry
      fails[existingIndex].fails += 1
      fails[existingIndex].lastFailAt = now
    } else {
      // Create new entry
      fails.push({
        model: modelId,
        provider,
        fails: 1,
        lastFailAt: now,
      })
    }

    // Save updated fails
    const updatedJson = JSON.stringify({ "json-output-fails": fails })
    this.db.prepare("UPDATE workflow_runs_indicators SET json_out_fails = ? WHERE id = ?").run(updatedJson, sessionId)
  }

  // ---- Task Groups ----

  /**
   * List all non-archived groups with task counts
   * Returns groups ordered by created_at DESC with taskCount included
   */
  getTaskGroups(): Array<TaskGroup & { taskCount: number }> {
    const rows = this.db.prepare(`
      SELECT tg.*, COUNT(tgm.task_id) as task_count
      FROM task_groups tg
      LEFT JOIN task_group_members tgm ON tg.id = tgm.group_id
      WHERE tg.status != 'archived'
      GROUP BY tg.id
      ORDER BY tg.created_at DESC
    `).all() as Record<string, unknown>[]

    return rows.map(row => ({
      ...rowToTaskGroup(row),
      taskCount: Number(row.task_count ?? 0),
    }))
  }

  /**
   * Get single group with task IDs
   * Returns TaskGroup with taskIds array, or null if not found
   */
  getTaskGroup(id: string): (TaskGroup & { taskIds: string[] }) | null {
    const row = this.db.prepare("SELECT * FROM task_groups WHERE id = ?").get(id) as Record<string, unknown> | null
    if (!row) return null

    const taskIds = this.getTaskGroupMemberIds(id)

    return {
      ...rowToTaskGroup(row),
      taskIds,
    }
  }

  /**
   * Create new group with optional members
   * Validates all task IDs exist before creation
   * Wraps in transaction: create group → add members → update tasks.group_id
   */
  createTaskGroup(input: CreateTaskGroupDTO): TaskGroup & { taskIds: string[] } {
    const now = nowUnix()
    const id = input.id ?? randomUUID().slice(0, 8)
    const createdAt = input.createdAt ?? now

    // Validation
    if (!input.name || input.name.trim().length === 0) {
      throw new Error("Task group name is required and cannot be empty")
    }
    if (input.name.length > 100) {
      throw new Error("Task group name must be 100 characters or less")
    }

    const color = input.color ?? '#888888'
    if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      throw new Error("Color must be a valid hex color format (e.g., #888888)")
    }

    // Validate member task IDs if provided
    const memberTaskIds = input.memberTaskIds ?? []
    if (memberTaskIds.length > 0) {
      for (const taskId of memberTaskIds) {
        const task = this.getTask(taskId)
        if (!task) {
          throw new Error(`Task with ID "${taskId}" does not exist`)
        }
        if (task.groupId && task.groupId !== id) {
          throw new Error(`Task "${taskId}" is already in another group`)
        }
      }
    }

    // Transaction: create group, add members, update tasks
    const tx = this.db.transaction((groupId: string, taskIds: string[]) => {
      // Create group
      this.db
        .prepare(`
          INSERT INTO task_groups (
            id, name, color, status, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          groupId,
          input.name.trim(),
          color,
          input.status ?? 'active',
          createdAt,
          now,
          input.completedAt ?? null,
        )

      // Add members
      for (let i = 0; i < taskIds.length; i++) {
        const taskId = taskIds[i]
        this.db
          .prepare(`
            INSERT INTO task_group_members (group_id, task_id, idx, added_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(groupId, taskId, i, now)

        // Update task's group_id
        this.db.prepare("UPDATE tasks SET group_id = ? WHERE id = ?").run(groupId, taskId)
      }

      return groupId
    })

    tx(id, memberTaskIds)

    return this.getTaskGroup(id) as TaskGroup & { taskIds: string[] }
  }

  /**
   * Update group properties
   * Validates group exists, validates name/color if provided
   * Auto-updates updated_at timestamp
   */
  updateTaskGroup(id: string, input: UpdateTaskGroupDTO): (TaskGroup & { taskIds: string[] }) | null {
    const group = this.getTaskGroup(id)
    if (!group) {
      throw new Error(`Task group with ID "${id}" does not exist`)
    }

    const sets: string[] = []
    const values: any[] = []

    if (input.name !== undefined) {
      if (!input.name || input.name.trim().length === 0) {
        throw new Error("Task group name cannot be empty")
      }
      if (input.name.length > 100) {
        throw new Error("Task group name must be 100 characters or less")
      }
      sets.push("name = ?")
      values.push(input.name.trim())
    }

    if (input.color !== undefined) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(input.color)) {
        throw new Error("Color must be a valid hex color format (e.g., #888888)")
      }
      sets.push("color = ?")
      values.push(input.color)
    }

    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }

    if (input.completedAt !== undefined) {
      sets.push("completed_at = ?")
      values.push(input.completedAt)
    }

    if (sets.length === 0) return group

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE task_groups SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getTaskGroup(id)
  }

  /**
   * Delete group (cascades to members via FK)
   * Clears group_id on all related tasks before deletion
   */
  deleteTaskGroup(id: string): boolean {
    const group = this.getTaskGroup(id)
    if (!group) {
      return false
    }

    // Clear group_id on all tasks in this group
    this.db.prepare("UPDATE tasks SET group_id = NULL WHERE group_id = ?").run(id)

    // Delete group (cascade will clean up task_group_members)
    const result = this.db.prepare("DELETE FROM task_groups WHERE id = ?").run(id)
    return result.changes > 0
  }

  /**
   * Add multiple tasks to existing group
   * Validates all task IDs exist and are not already in another group
   * Returns count of added tasks
   */
  addTasksToGroup(groupId: string, taskIds: string[]): number {
    if (taskIds.length === 0) return 0

    const group = this.getTaskGroup(groupId)
    if (!group) {
      throw new Error(`Task group with ID "${groupId}" does not exist`)
    }

    // Validate all tasks
    for (const taskId of taskIds) {
      const task = this.getTask(taskId)
      if (!task) {
        throw new Error(`Task with ID "${taskId}" does not exist`)
      }
      if (task.groupId && task.groupId !== groupId) {
        throw new Error(`Task "${taskId}" is already in another group`)
      }
    }

    const now = nowUnix()
    const startIdx = this.getNextTaskIndexInGroup(groupId)

    const tx = this.db.transaction((ids: string[], startIndex: number) => {
      let added = 0
      for (let i = 0; i < ids.length; i++) {
        const taskId = ids[i]
        this.db
          .prepare(`
            INSERT INTO task_group_members (group_id, task_id, idx, added_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id, task_id) DO UPDATE SET
              idx = excluded.idx,
              added_at = excluded.added_at
          `)
          .run(groupId, taskId, startIndex + i, now)

        // Update task's group_id
        this.db.prepare("UPDATE tasks SET group_id = ? WHERE id = ?").run(groupId, taskId)
        added++
      }
      return added
    })

    return tx(taskIds, startIdx)
  }

  /**
   * Remove multiple tasks from group
   * Clears group_id on removed tasks
   * Reorders remaining members to maintain contiguous indices
   */
  removeTasksFromGroup(groupId: string, taskIds: string[]): number {
    if (taskIds.length === 0) return 0

    const group = this.getTaskGroup(groupId)
    if (!group) {
      throw new Error(`Task group with ID "${groupId}" does not exist`)
    }

    const tx = this.db.transaction((ids: string[]) => {
      let removed = 0

      // Remove tasks from members table
      for (const taskId of ids) {
        const result = this.db
          .prepare("DELETE FROM task_group_members WHERE group_id = ? AND task_id = ?")
          .run(groupId, taskId)

        if (result.changes > 0) {
          removed++
          // Clear task's group_id
          this.db.prepare("UPDATE tasks SET group_id = NULL WHERE id = ? AND group_id = ?").run(taskId, groupId)
        }
      }

      // Reorder remaining members
      if (removed > 0) {
        const remaining = this.db
          .prepare("SELECT task_id FROM task_group_members WHERE group_id = ? ORDER BY idx ASC")
          .all(groupId) as Array<{ task_id: string }>

        for (let i = 0; i < remaining.length; i++) {
          this.db
            .prepare("UPDATE task_group_members SET idx = ? WHERE group_id = ? AND task_id = ?")
            .run(i, groupId, remaining[i].task_id)
        }
      }

      return removed
    })

    return tx(taskIds)
  }

  /**
   * Get all members of a group
   * Returns TaskGroupMember[] ordered by idx ASC
   */
  getTaskGroupMembers(groupId: string): TaskGroupMember[] {
    const group = this.getTaskGroup(groupId)
    if (!group) {
      throw new Error(`Task group with ID "${groupId}" does not exist`)
    }

    const rows = this.db
      .prepare("SELECT * FROM task_group_members WHERE group_id = ? ORDER BY idx ASC")
      .all(groupId) as Record<string, unknown>[]

    return rows.map(rowToTaskGroupMember)
  }

  /**
   * Get just task IDs in order
   * Returns string[] of task IDs in index order
   */
  getTaskGroupMemberIds(groupId: string): string[] {
    const rows = this.db
      .prepare("SELECT task_id FROM task_group_members WHERE group_id = ? ORDER BY idx ASC")
      .all(groupId) as Record<string, unknown>[]

    return rows.map(row => String(row.task_id))
  }

  /**
   * Get group a task belongs to
   * Returns { groupId: string | null; group?: TaskGroup }
   */
  getTaskGroupMembership(taskId: string): { groupId: string | null; group?: TaskGroup } {
    const task = this.getTask(taskId)
    if (!task) {
      throw new Error(`Task with ID "${taskId}" does not exist`)
    }

    if (!task.groupId) {
      return { groupId: null }
    }

    const group = this.getTaskGroup(task.groupId)
    if (!group) {
      // Group reference exists but group was deleted - clean up
      this.db.prepare("UPDATE tasks SET group_id = NULL WHERE id = ?").run(taskId)
      return { groupId: null }
    }

    return { groupId: task.groupId, group: { ...group, taskIds: undefined } as TaskGroup }
  }

  // ---- Single Task Group Operations (legacy/utility methods) ----

  addTaskToGroup(groupId: string, taskId: string, idx?: number): TaskGroupMember | null {
    const group = this.getTaskGroup(groupId)
    if (!group) return null

    const now = nowUnix()
    const taskIdx = idx ?? this.getNextTaskIndexInGroup(groupId)

    const result = this.db
      .prepare(`
        INSERT INTO task_group_members (group_id, task_id, idx, added_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_id, task_id) DO UPDATE SET
          idx = excluded.idx,
          added_at = excluded.added_at
      `)
      .run(groupId, taskId, taskIdx, now)

    // Update task's group_id
    this.db.prepare("UPDATE tasks SET group_id = ? WHERE id = ?").run(groupId, taskId)

    const row = this.db.prepare("SELECT * FROM task_group_members WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
    return row ? rowToTaskGroupMember(row) : null
  }

  removeTaskFromGroup(groupId: string, taskId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM task_group_members WHERE group_id = ? AND task_id = ?")
      .run(groupId, taskId)

    // Clear task's group_id if it was in this group
    this.db.prepare("UPDATE tasks SET group_id = NULL WHERE id = ? AND group_id = ?").run(taskId, groupId)

    return result.changes > 0
  }

  getTasksInGroup(groupId: string): Array<{ taskId: string; idx: number; addedAt: number }> {
    const rows = this.db
      .prepare("SELECT task_id, idx, added_at FROM task_group_members WHERE group_id = ? ORDER BY idx ASC")
      .all(groupId) as Record<string, unknown>[]

    return rows.map(row => ({
      taskId: String(row.task_id),
      idx: Number(row.idx ?? 0),
      addedAt: Number(row.added_at ?? 0),
    }))
  }

  private getNextTaskIndexInGroup(groupId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(idx), -1) AS max_idx FROM task_group_members WHERE group_id = ?")
      .get(groupId) as { max_idx: number }
    return Number(row.max_idx ?? -1) + 1
  }

  private getTimeRangeBoundary(range: StatsTimeRange): { start: number; previousStart: number } {
    const now = nowUnix()
    switch (range) {
      case "24h":
        return { start: now - SECONDS_IN_DAY, previousStart: now - 2 * SECONDS_IN_DAY }
      case "7d":
        return { start: now - 7 * SECONDS_IN_DAY, previousStart: now - 14 * SECONDS_IN_DAY }
      case "30d":
        return { start: now - 30 * SECONDS_IN_DAY, previousStart: now - 60 * SECONDS_IN_DAY }
      case "lifetime":
        return { start: 0, previousStart: 0 }
      default:
        throw new Error(`Invalid time range: ${JSON.stringify(range)}. Expected "24h", "7d", "30d", or "lifetime".`)
    }
  }

  private getSessionKindResponsibility(kind: string): "plan" | "execution" | "review" | "other" {
    if (kind === "plan" || kind === "plan_revision" || kind === "planning") return "plan"
    if (kind === "task" || kind === "task_run_worker" || kind === "task_run_final_applier" || kind === "repair") return "execution"
    if (kind === "task_run_reviewer" || kind === "review_scratch") return "review"
    return "other"
  }

  getUsageStats(range: StatsTimeRange): UsageStats {
    const { start, previousStart } = this.getTimeRangeBoundary(range)

    const currentRow = this.db
      .prepare(
        `
        SELECT 
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost_total), 0) AS total_cost
        FROM session_messages
        WHERE timestamp >= ?
        `
      )
      .get(start) as TokenCostRow

    let previousTokens = 0
    let previousCost = 0

    if (range !== "lifetime" && previousStart > 0) {
      const previousRow = this.db
        .prepare(
          `
          SELECT 
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_total), 0) AS total_cost
          FROM session_messages
          WHERE timestamp >= ? AND timestamp < ?
          `
        )
        .get(previousStart, start) as TokenCostRow

      previousTokens = Number(previousRow.total_tokens ?? 0)
      previousCost = Number(previousRow.total_cost ?? 0)
    }

    const totalTokens = Number(currentRow.total_tokens ?? 0)
    const totalCost = Number(currentRow.total_cost ?? 0)

    const tokenChange = previousTokens > 0 ? ((totalTokens - previousTokens) / previousTokens) * 100 : 0
    const costChange = previousCost > 0 ? ((totalCost - previousCost) / previousCost) * 100 : 0

    return {
      totalTokens,
      totalCost,
      tokenChange: Math.round(tokenChange * 100) / 100,
      costChange: Math.round(costChange * 100) / 100,
    }
  }

  getTaskStats(): TaskStats {
    const completedRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'done'")
      .get() as CountRow

    const failedRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'failed'")
      .get() as CountRow

    const avgReviewsRow = this.db
      .prepare(
        `
        SELECT COALESCE(AVG(review_count), 0) AS avg_reviews
        FROM tasks
        WHERE status = 'done'
        `
      )
      .get() as AvgReviewsRow

    return {
      completed: Number(completedRow.cnt ?? 0),
      failed: Number(failedRow.cnt ?? 0),
      averageReviews: Math.round(Number(avgReviewsRow.avg_reviews ?? 0) * 100) / 100,
    }
  }

  getModelUsageByResponsibility(): ModelUsageStats {
    const rows = this.db
      .prepare(
        `
        SELECT 
          session_kind,
          model,
          COUNT(*) AS cnt
        FROM workflow_sessions
        WHERE model IS NOT NULL AND model != '' AND model != 'default'
        GROUP BY session_kind, model
        `
      )
      .all() as ModelUsageRow[]

    const plan: Array<{ model: string; count: number }> = []
    const execution: Array<{ model: string; count: number }> = []
    const review: Array<{ model: string; count: number }> = []

    for (const row of rows) {
      const responsibility = this.getSessionKindResponsibility(row.session_kind)
      const entry = { model: row.model, count: Number(row.cnt ?? 0) }

      switch (responsibility) {
        case "plan":
          plan.push(entry)
          break
        case "execution":
          execution.push(entry)
          break
        case "review":
          review.push(entry)
          break
        case "other":
          break
      }
    }

    const sortByCount = (a: { count: number }, b: { count: number }) => b.count - a.count
    plan.sort(sortByCount)
    execution.sort(sortByCount)
    review.sort(sortByCount)

    return { plan, execution, review }
  }

  getAverageTaskDuration(): number {
    const row = this.db
      .prepare(
        `
        SELECT 
          COALESCE(AVG(completed_at - created_at), 0) AS avg_duration
        FROM tasks
        WHERE completed_at IS NOT NULL AND created_at IS NOT NULL
        `
      )
      .get() as AvgDurationRow

    // Convert from seconds to minutes for display
    const seconds = Number(row.avg_duration ?? 0)
    return Math.round(seconds / 60)
  }

  getHourlyUsageTimeSeries(): HourlyUsage[] {
    const now = nowUnix()
    const twentyFourHoursAgo = now - SECONDS_IN_DAY

    const rows = this.db
      .prepare(
        `
        SELECT 
          (timestamp / 3600) * 3600 AS hour_bucket,
          COALESCE(SUM(total_tokens), 0) AS tokens,
          COALESCE(SUM(cost_total), 0) AS cost
        FROM session_messages
        WHERE timestamp >= ?
        GROUP BY hour_bucket
        ORDER BY hour_bucket ASC
        `
      )
      .all(twentyFourHoursAgo) as HourlyUsageRow[]

    return rows.map((row) => ({
      hour: new Date(row.hour_bucket * 1000).toISOString(),
      tokens: Number(row.tokens ?? 0),
      cost: Number(row.cost ?? 0),
    }))
  }

  getDailyUsageTimeSeries(days: number): DailyUsage[] {
    const now = nowUnix()
    const startTime = now - days * SECONDS_IN_DAY

    const rows = this.db
      .prepare(
        `
        SELECT 
          date(timestamp, 'unixepoch') AS date_str,
          COALESCE(SUM(total_tokens), 0) AS tokens,
          COALESCE(SUM(cost_total), 0) AS cost
        FROM session_messages
        WHERE timestamp >= ?
        GROUP BY date_str
        ORDER BY date_str ASC
        `
      )
      .all(startTime) as DailyUsageRow[]

    return rows.map((row) => ({
      date: row.date_str,
      tokens: Number(row.tokens ?? 0),
      cost: Number(row.cost ?? 0),
    }))
  }

}

const CONTAINER_BUILD_STATUSES: ContainerBuild["status"][] = ["pending", "running", "success", "failed", "cancelled"]

function isContainerBuildStatus(value: unknown): value is ContainerBuild["status"] {
  return typeof value === "string" && CONTAINER_BUILD_STATUSES.includes(value as ContainerBuild["status"])
}

// Row converters for indicators
function rowToWorkflowRunIndicators(row: Record<string, unknown>): WorkflowRunIndicators {
  const jsonOutFails = parseJSON<{ "json-output-fails": JsonOutFailEntry[] }>(row.json_out_fails) ?? { "json-output-fails": [] }
  return {
    id: String(row.id),
    jsonOutFails,
  }
}

// Row converters for container types
function rowToContainerPackage(row: Record<string, unknown>): ContainerPackage {
  return {
    id: Number(row.id),
    name: String(row.name),
    category: String(row.category),
    versionConstraint: row.version_constraint ? String(row.version_constraint) : undefined,
    installOrder: Number(row.install_order ?? 0),
    addedAt: Number(row.added_at ?? 0),
    source: String(row.source ?? "manual"),
  }
}

function rowToContainerBuild(row: Record<string, unknown>): ContainerBuild {
  const status = isContainerBuildStatus(row.status) ? row.status : "pending"

  return {
    id: Number(row.id),
    status,
    startedAt: row.started_at ? Number(row.started_at) : null,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    packagesHash: row.packages_hash ? String(row.packages_hash) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    imageTag: row.image_tag ? String(row.image_tag) : null,
    logs: row.logs ? String(row.logs) : null,
  }
}

// Row converters for task group types
function rowToTaskGroup(row: Record<string, unknown>): TaskGroup {
  return {
    id: String(row.id),
    name: String(row.name),
    color: String(row.color ?? '#888888'),
    status: asTaskGroupStatus(row.status),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
  }
}

function rowToTaskGroupMember(row: Record<string, unknown>): TaskGroupMember {
  return {
    id: Number(row.id),
    groupId: String(row.group_id),
    taskId: String(row.task_id),
    idx: Number(row.idx ?? 0),
    addedAt: Number(row.added_at ?? 0),
  }
}
