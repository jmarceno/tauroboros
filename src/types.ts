import { Schema } from "effect"
import { PROMPT_CATALOG, joinPrompt } from "./prompts/catalog.ts"

/**
 * Tagged error for container image resolution failures
 */
export class ContainerImageError extends Schema.TaggedError<ContainerImageError>()("ContainerImageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type TaskStatus = "template" | "backlog" | "queued" | "executing" | "review" | "code-style" | "done" | "failed" | "stuck"
export type AutoDeployCondition = "before_workflow_start" | "after_workflow_end" | "workflow_done" | "workflow_failed"

export type TelegramNotificationLevel = "all" | "failures" | "done_and_failures" | "workflow_done_and_failures"

export type TaskGroupStatus = "active" | "completed" | "archived"

export type ThinkingLevel = "default" | "low" | "medium" | "high"

export type ExecutionPhase = "not_started" | "plan_complete_waiting_approval" | "plan_revision_pending" | "implementation_pending" | "implementation_done"

export type RunExecutionPhase = "not_started" | "planning" | "executing" | "reviewing" | "committing"

export type ExecutionStrategy = "standard" | "best_of_n"

export type BestOfNSubstage =
  | "idle"
  | "workers_running"
  | "reviewers_running"
  | "final_apply_running"
  | "blocked_for_manual_review"
  | "completed"

export interface BestOfNSlot {
  model: string
  count: number
  taskSuffix?: string | null
}

export interface BestOfNFinalApplier {
  model: string
  taskSuffix?: string | null
}

export interface BestOfNConfig {
  workers: BestOfNSlot[]
  reviewers: BestOfNSlot[]
  finalApplier: BestOfNFinalApplier
  selectionMode: SelectionMode
  minSuccessfulWorkers: number
  verificationCommand?: string | null
}

export type RunPhase = "worker" | "reviewer" | "final_applier"

export type RunStatus = "pending" | "running" | "done" | "failed" | "skipped"

export type SelectionMode = "pick_best" | "synthesize" | "pick_or_synthesize"

export type WorkflowRunKind = "all_tasks" | "single_task" | "workflow_review" | "group_tasks"

export type WorkflowRunStatus = "queued" | "running" | "paused" | "stopping" | "completed" | "failed"
export type SelfHealStatus = "idle" | "investigating" | "recovering"

export interface RunContext {
  id: string
  kind: WorkflowRunKind
  status: WorkflowRunStatus
  displayName: string
  targetTaskId: string | null
  groupId?: string
  createdAt: number
  startedAt: number
  finishedAt: number | null
  taskIds: string[]
}

export interface TaskExecutionState {
  taskId: string
  runId: string
  slotIndex: number | null
  status: "queued" | "executing" | "done" | "failed" | "stuck"
  startedAt: number | null
  finishedAt: number | null
  sessionId: string | null
}

export interface SlotTaskInfo {
  taskId: string
  runId: string
  taskName: string
  slotIndex: number
}

export interface SlotUtilization {
  maxSlots: number
  usedSlots: number
  availableSlots: number
  tasks: SlotTaskInfo[]
}

export interface RunQueueStatus {
  runId: string
  status: WorkflowRunStatus
  totalTasks: number
  queuedTasks: number
  executingTasks: number
  completedTasks: number
}

export interface TaskGroup {
  id: string
  name: string
  color: string
  status: TaskGroupStatus
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface TaskGroupMember {
  id: number
  groupId: string
  taskId: string
  idx: number
  addedAt: number
}

export interface Task {
  id: string
  name: string
  idx: number
  prompt: string
  branch: string
  planModel: string
  executionModel: string
  planmode: boolean
  autoApprovePlan: boolean
  review: boolean
  autoCommit: boolean
  autoDeploy: boolean
  autoDeployCondition: AutoDeployCondition | null
  deleteWorktree: boolean
  status: TaskStatus
  requirements: string[]
  agentOutput: string
  reviewCount: number
  jsonParseRetryCount: number
  sessionId: string | null
  sessionUrl: string | null
  worktreeDir: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  thinkingLevel: ThinkingLevel
  planThinkingLevel: ThinkingLevel
  executionThinkingLevel: ThinkingLevel
  executionPhase: ExecutionPhase
  awaitingPlanApproval: boolean
  planRevisionCount: number
  executionStrategy: ExecutionStrategy
  bestOfNConfig: BestOfNConfig | null
  bestOfNSubstage: BestOfNSubstage
  skipPermissionAsking: boolean
  maxReviewRunsOverride: number | null
  smartRepairHints: string | null
  reviewActivity: "idle" | "running"
  isArchived: boolean
  archivedAt: number | null
  containerImage?: string
  codeStyleReview: boolean
  groupId?: string
  selfHealStatus: SelfHealStatus
  selfHealMessage: string | null
  selfHealReportId: string | null
}

export interface SelfHealReport {
  id: string
  runId: string
  taskId: string
  taskStatus: TaskStatus
  errorMessage: string | null
  diagnosticsSummary: string
  rootCauses: string[]
  proposedSolution: string
  implementationPlan: string[]
  recoverable: boolean
  recommendedAction: "restart_task" | "keep_failed"
  actionRationale: string
  sourceMode: "local" | "github_clone" | "github_metadata_only"
  sourcePath: string | null
  githubUrl: string
  tauroborosVersion: string
  dbPath: string
  dbSchemaJson: Record<string, unknown>
  rawResponse: string
  createdAt: number
  updatedAt: number
}

export interface WorkflowRun {
  id: string
  kind: WorkflowRunKind
  status: WorkflowRunStatus
  displayName: string
  targetTaskId: string | null
  taskOrder: string[]
  currentTaskId: string | null
  currentTaskIndex: number
  pauseRequested: boolean
  stopRequested: boolean
  errorMessage: string | null
  createdAt: number
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  isArchived: boolean
  archivedAt: number | null
  color: string
  groupId?: string
  queuedTaskCount?: number
  executingTaskCount?: number
}

export interface TaskRun {
  id: string
  taskId: string
  phase: RunPhase
  slotIndex: number
  attemptIndex: number
  model: string
  taskSuffix: string | null
  status: RunStatus
  sessionId: string | null
  sessionUrl: string | null
  worktreeDir: string | null
  summary: string | null
  errorMessage: string | null
  candidateId: string | null
  metadataJson: Record<string, any>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface TaskCandidate {
  id: string
  taskId: string
  workerRunId: string
  status: "available" | "selected" | "rejected"
  changedFilesJson: string[]
  diffStatsJson: Record<string, number>
  verificationJson: Record<string, any>
  summary: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface ReviewerOutput {
  status: "pass" | "needs_manual_review"
  summary: string
  bestCandidateIds: string[]
  gaps: string[]
  recommendedFinalStrategy: SelectionMode
  recommendedPrompt: string | null
}

export interface AggregatedReviewResult {
  candidateVoteCounts: Record<string, number>
  recurringRisks: string[]
  recurringGaps: string[]
  consensusReached: boolean
  recommendedFinalStrategy: SelectionMode
  usableResults: ReviewerOutput[]
}

export type ColumnSortOption = 'manual' | 'name-asc' | 'name-desc' | 'created-asc' | 'created-desc' | 'updated-asc' | 'updated-desc'

export interface ColumnSortPreferences {
  template?: ColumnSortOption
  backlog?: ColumnSortOption
  executing?: ColumnSortOption
  review?: ColumnSortOption
  'code-style'?: ColumnSortOption
  done?: ColumnSortOption
}

export interface Options {
  commitPrompt: string
  extraPrompt: string
  branch: string
  planModel: string
  executionModel: string
  reviewModel: string
  repairModel: string
  command: string
  parallelTasks: number
  autoDeleteNormalSessions: boolean
  autoDeleteReviewSessions: boolean
  showExecutionGraph: boolean
  port: number
  thinkingLevel: ThinkingLevel
  planThinkingLevel: ThinkingLevel
  executionThinkingLevel: ThinkingLevel
  reviewThinkingLevel: ThinkingLevel
  repairThinkingLevel: ThinkingLevel
  codeStylePrompt: string
  telegramBotToken: string
  telegramChatId: string
  telegramNotificationLevel: TelegramNotificationLevel
  maxReviews: number
  maxJsonParseRetries: number
  columnSorts?: ColumnSortPreferences
}

export const DEFAULT_COMMIT_PROMPT = joinPrompt(PROMPT_CATALOG.defaultCommitPromptLines)

export const DEFAULT_CODE_STYLE_PROMPT = joinPrompt(PROMPT_CATALOG.defaultCodeStylePromptLines)

/**
 * Resolves the code style prompt to use.
 * Returns the provided prompt if non-empty, otherwise returns DEFAULT_CODE_STYLE_PROMPT.
 */
export function resolveCodeStylePrompt(codeStylePrompt: string | undefined | null): string {
  if (typeof codeStylePrompt === "string" && codeStylePrompt.trim().length > 0) {
    return codeStylePrompt
  }
  return DEFAULT_CODE_STYLE_PROMPT
}

export type WSMessageType =
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "task_archived"
  | "task_reordered"
  | "options_updated"
  | "execution_started"
  | "execution_queued"
  | "execution_stopped"
  | "execution_complete"
  | "execution_paused"
  | "execution_resumed"
  | "execution_failed"
  | "run_created"
  | "run_archived"
  | "run_updated"
  | "run_paused"           // NEW: Run was paused
  | "run_resumed"          // NEW: Run was resumed
  | "run_stopped"          // NEW: Run was stopped (with destructive flag)
  | "run_cleaned"          // NEW: Run was cleaned/reset
  | "error"
  | "task_run_created"
  | "task_run_updated"
  | "task_candidate_created"
  | "task_candidate_updated"
  | "plan_revision_requested"
  | "session_started"
  | "session_message_created"
  | "session_status_changed"
  | "session_completed"
  | "image_status"
  // Planning chat events
  | "planning_prompt_updated"
  | "planning_session_created"
  | "planning_session_updated"
  | "planning_session_message"
  | "planning_session_closed"
  // Container events
  | "container_config_updated"
  | "container_package_added"
  | "container_package_removed"
  | "container_dockerfile_custom_updated"
  | "container_build_started"
  | "container_build_progress"
  | "container_build_completed"
  | "container_build_cancelled"
  | "container_profile_applied"
  // Task Group events
  | "task_group_created"
  | "task_group_updated"
  | "task_group_deleted"
  | "task_group_members_added"
  | "task_group_members_removed"
  // Group execution lifecycle events (broadcast when group execution is implemented)
  | "group_execution_started"
  | "group_execution_complete"
  | "group_task_added"
  | "group_task_removed"
  | "container_profile_created"
  | "self_heal_status"

export interface WSMessage {
  type: WSMessageType
  payload: any
}

export interface ImageStatusPayload {
  status: "not_present" | "preparing" | "ready" | "error"
  message: string
  progress?: number
  errorMessage?: string
}

export interface ReviewResult {
  status: "pass" | "gaps_found" | "blocked" | "json_parse_max_retries"
  summary: string
  gaps: string[]
  recommendedPrompt: string
}

// Session message logging types
export type MessageRole = "user" | "assistant" | "system" | "tool"
export type MessageType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "error"
  | "step_start"
  | "step_finish"
  | "session_start"
  | "session_end"
  | "session_status"
  | "thinking"
  | "user_prompt"
  | "assistant_response"
  | "tool_request"
  | "permission_asked"
  | "permission_replied"
  | "session_error"
  | "message_part"

export interface SessionMessage {
  id: number
  seq: number
  messageId: string | null
  sessionId: string
  taskId: string | null
  taskRunId: string | null
  timestamp: number
  role: MessageRole
  eventName: string | null
  messageType: MessageType
  contentJson: Record<string, any>
  modelProvider: string | null
  modelId: string | null
  agentName: string | null
  promptTokens: number | null
  completionTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
  costJson: Record<string, any> | null
  costTotal: number | null
  toolCallId: string | null
  toolName: string | null
  toolArgsJson: Record<string, any> | null
  toolResultJson: Record<string, any> | null
  toolStatus: string | null
  editDiff: string | null
  editFilePath: string | null
  sessionStatus: string | null
  workflowPhase: string | null
  rawEventJson: Record<string, any> | null
}

export interface CreateSessionMessageInput {
  seq?: number
  messageId?: string | null
  sessionId: string
  taskId?: string | null
  taskRunId?: string | null
  timestamp?: number
  role: MessageRole
  eventName?: string | null
  messageType: MessageType
  contentJson: Record<string, any>
  modelProvider?: string | null
  modelId?: string | null
  agentName?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  totalTokens?: number | null
  costJson?: Record<string, any> | null
  costTotal?: number | null
  toolCallId?: string | null
  toolName?: string | null
  toolArgsJson?: Record<string, any> | null
  toolResultJson?: Record<string, any> | null
  toolStatus?: string | null
  editDiff?: string | null
  editFilePath?: string | null
  sessionStatus?: string | null
  workflowPhase?: string | null
  rawEventJson?: Record<string, any> | null
}

export interface TimelineEntry {
  id: number
  timestamp: number
  relativeTime: number
  role: MessageRole
  messageType: MessageType
  summary: string
  hasToolCalls: boolean
  hasEdits: boolean
  modelProvider: string | null
  modelId: string | null
  agentName: string | null
}

export interface SessionUsageRollup {
  sessionId: string
  messageCount: number
  tokenizedMessageCount: number
  costedMessageCount: number
  firstTimestamp: number | null
  lastTimestamp: number | null
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  totalCost: number
}

/**
 * Resolve the container image to use for a task.
 * Priority: task-specific image > system default
 * @throws Error if neither task-specific nor system image is available
 */
export function resolveContainerImage(
  task: Pick<Task, 'containerImage'>,
  systemImage: string | undefined
): string {
  if (task.containerImage) {
    return task.containerImage
  }
  if (systemImage) {
    return systemImage
  }
  throw new ContainerImageError({
    operation: "resolveContainerImage",
    message: "No container image available: task has no containerImage set and no system default is configured",
  })
}

// ============================================================================
// Additional Types for UI (kanban-solid / kanban-react)
// ============================================================================

// Alias Candidate to TaskCandidate for UI compatibility
export type Candidate = TaskCandidate

export interface BestOfNSummary {
  taskId: string
  substage: BestOfNSubstage
  workersTotal: number
  workersDone: number
  workersFailed: number
  reviewersTotal: number
  reviewersDone: number
  reviewersFailed: number
  hasFinalApplier: boolean
  finalApplierDone: boolean
  finalApplierStatus: string
  expandedWorkerCount: number
  expandedReviewerCount: number
  totalExpandedRuns: number
  successfulCandidateCount: number
  selectedCandidate: string | null
  availableCandidates: number
  selectedCandidates: number
}

export interface ContainerImage {
  tag: string
  createdAt: number
  source: 'build' | 'podman'
  inUseByTasks: number
}

export interface ExecutionGraph {
  batches: { idx: number; taskIds: string[]; taskNames: string[] }[]
  nodes: ExecutionGraphNode[]
  edges: ExecutionGraphEdge[]
  totalTasks: number
  parallelLimit: number
  warnings?: string[]
  pendingApprovals?: {
    id: string
    name: string
    status: string
    awaitingPlanApproval: boolean
    planRevisionCount?: number
  }[]
}

export interface ExecutionGraphNode {
  id: string
  name: string
  status: string
  requirements: string[]
  expandedWorkerRuns?: number
  expandedReviewerRuns?: number
  hasFinalApplier?: boolean
  estimatedRunCount?: number
}

export interface ExecutionGraphEdge {
  from: string
  to: string
}

export interface PlanningSession {
  id: string
  taskId?: string
  title: string
  createdAt: number
  updatedAt: number
  name?: string | null
  sessionUrl?: string
  status?: string
  model?: string
  thinkingLevel?: string
}

export interface ModelEntry {
  id: string
  name: string
  provider: string
  description?: string
}

export interface ModelCatalog {
  models: ModelEntry[]
  lastUpdated: number
}

// Stats types
export interface HourlyUsage {
  hour: string
  requests: number
  tokens: number
  cost: number
}

export interface DailyUsage {
  date: string
  requests: number
  tokens: number
  cost: number
}

export interface UsageStats {
  totalRequests: number
  totalTokens: number
  totalCost: number
  hourlyData: HourlyUsage[]
  dailyData: DailyUsage[]
}

export interface TaskStats {
  total: number
  byStatus: Record<TaskStatus, number>
  completionRate: number
  averageExecutionTime: number
}

export interface ModelUsageStats {
  modelId: string
  requests: number
  tokens: number
  cost: number
}

// DTO types
export interface CreateTaskDTO {
  name: string
  prompt: string
  status?: TaskStatus
  branch?: string
  planModel?: string
  executionModel?: string
  planmode?: boolean
  autoApprovePlan?: boolean
  review?: boolean
  codeStyleReview?: boolean
  autoCommit?: boolean
  autoDeploy?: boolean
  autoDeployCondition?: AutoDeployCondition | null
  deleteWorktree?: boolean
  skipPermissionAsking?: boolean
  requirements?: string[]
  thinkingLevel?: ThinkingLevel
  planThinkingLevel?: ThinkingLevel
  executionThinkingLevel?: ThinkingLevel
  executionStrategy?: ExecutionStrategy
  bestOfNConfig?: BestOfNConfig | null
  maxReviewRunsOverride?: number | null
  containerImage?: string
  groupId?: string
}

export interface UpdateTaskDTO extends Partial<CreateTaskDTO> {
  planningPrompt?: string
  completedAt?: number | null
}

// UI State types
export interface Toast {
  id: number
  message: string
  variant: 'info' | 'success' | 'warning' | 'error'
}

export type ToastVariant = Toast['variant']

export interface LogEntry {
  ts: string
  message: string
  variant: ToastVariant
}

export interface ControlState {
  isRunning: boolean
  isPaused: boolean
  canPause: boolean
  canResume: boolean
  canStop: boolean
}

// Session types
export interface Session {
  id: string
  taskId: string | null
  model: string | null
  status: 'pending' | 'active' | 'completed' | 'failed'
  thinkingLevel: ThinkingLevel
  sessionKind: string
  createdAt: number
  updatedAt: number
}

// Branch list
export interface BranchList {
  current: string
  branches: string[]
}

// Review status
export interface ReviewStatus {
  taskId: string
  reviewCount: number
  maxReviews: number
  canRequestMore: boolean
}

// Planning prompt
export interface PlanningPrompt {
  taskId: string
  prompt: string
  createdAt: number
  updatedAt: number
}

// Chat session
export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

// Task group with tasks
export interface TaskGroupWithTasks extends TaskGroup {
  tasks: Task[]
}
