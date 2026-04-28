export type TaskStatus = "template" | "backlog" | "queued" | "executing" | "review" | "code-style" | "done" | "failed" | "stuck"
export type AutoDeployCondition = "before_workflow_start" | "after_workflow_end" | "workflow_done" | "workflow_failed"
export type TelegramNotificationLevel = "all" | "failures" | "done_and_failures" | "workflow_done_and_failures"
export type TaskGroupStatus = "active" | "completed" | "archived"
export type ThinkingLevel = "default" | "low" | "medium" | "high"
export type ExecutionPhase = "not_started" | "plan_complete_waiting_approval" | "plan_revision_pending" | "implementation_pending" | "implementation_done"
export type RunExecutionPhase = "not_started" | "planning" | "executing" | "reviewing" | "committing"
export type ExecutionStrategy = "standard" | "best_of_n"
export type BestOfNSubstage = "idle" | "workers_running" | "reviewers_running" | "final_apply_running" | "blocked_for_manual_review" | "completed"
export type RunPhase = "worker" | "reviewer" | "final_applier"
export type RunStatus = "pending" | "running" | "done" | "failed" | "skipped"
export type SelectionMode = "pick_best" | "synthesize" | "pick_or_synthesize"
export type WorkflowRunKind = "all_tasks" | "single_task" | "workflow_review" | "group_tasks"
export type WorkflowRunStatus = "queued" | "running" | "paused" | "stopping" | "completed" | "failed"
export type SelfHealStatus = "idle" | "investigating" | "recovering"
export type MessageRole = "user" | "assistant" | "system" | "tool"
export type MessageType = "text" | "tool_call" | "tool_result" | "error" | "step_start" | "step_finish" | "session_start" | "session_end" | "session_status" | "thinking" | "user_prompt" | "assistant_response" | "tool_request" | "permission_asked" | "permission_replied" | "session_error" | "message_part"
export type ColumnSortOption = 'manual' | 'name-asc' | 'name-desc' | 'created-asc' | 'created-desc' | 'updated-asc' | 'updated-desc'
export type PathAccessMode = 'ro' | 'rw'
export type SessionIsolationMode = 'none' | 'bubblewrap'

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

export interface TaskPathGrant {
  path: string
  access: PathAccessMode
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
  additionalAgentAccess?: TaskPathGrant[]
  codeStyleReview: boolean
  groupId?: string
  selfHealStatus: SelfHealStatus
  selfHealMessage: string | null
  selfHealReportId: string | null
}

export interface ColumnSortPreferences {
  template?: ColumnSortOption
  backlog?: ColumnSortOption
  executing?: ColumnSortOption
  review?: ColumnSortOption
  "code-style"?: ColumnSortOption
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
  bubblewrapEnabled: boolean
  bubblewrapAvailable?: boolean
  bubblewrapStartupNotice?: string | null
  columnSorts?: ColumnSortPreferences
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
  groupId?: string | null
  queuedTaskCount?: number | null
  executingTaskCount?: number | null
}

export interface TaskRun {
  id: string
  taskId: string
  phase: RunPhase
  slotIndex: number
  attemptIndex: number
  model: string
  taskSuffix?: string | null
  status: RunStatus
  sessionId?: string | null
  sessionUrl?: string | null
  worktreeDir?: string | null
  summary?: string | null
  errorMessage?: string | null
  candidateId?: string | null
  metadataJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt?: number | null
}

export interface TaskCandidate {
  id: string
  taskId: string
  workerRunId: string
  status: string
  changedFiles?: string[]
  diffStats?: Record<string, unknown>
  verification?: Record<string, unknown>
  summary?: string | null
  errorMessage?: string | null
  createdAt: number
  updatedAt: number
}

export interface BestOfNSummary {
  substage: BestOfNSubstage
  workerCount: number
  reviewerCount: number
  candidates: TaskCandidate[]
  workerStatuses: Array<{ slotIndex: number; model: string; status: RunStatus }>
  reviewerStatuses: Array<{ slotIndex: number; model: string; status: RunStatus }>
  consensusReached?: boolean
}

export interface SelfHealReport {
  id: string
  runId: string
  taskId: string
  taskStatus: TaskStatus
  errorMessage: string | null
  diagnosticsSummary: string
  isTauroborosBug: boolean
  rootCause: { description: string; affectedFiles: readonly string[]; codeSnippet: string }
  proposedSolution: string
  implementationPlan: readonly string[]
  confidence: "high" | "medium" | "low"
  externalFactors: readonly string[]
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

export interface TaskGroup {
  id: string
  name: string
  color: string
  status: TaskGroupStatus
  createdAt: number
  updatedAt: number
  completedAt?: number | null
  taskIds: string[]
}

export interface TaskGroupWithTasks extends TaskGroup {
  tasks: Task[]
}

export interface Session {
  id: string
  taskId: string | null
  model: string | null
  status: 'pending' | 'active' | 'completed' | 'failed'
  thinkingLevel: ThinkingLevel
  sessionKind: string
  createdAt: number
  updatedAt: number
  isolationMode?: SessionIsolationMode
  pathGrantsJson?: string
}

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
  contentJson: string | Record<string, unknown>
  modelProvider: string | null
  modelId: string | null
  agentName: string | null
  promptTokens: number | null
  completionTokens: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  totalTokens: number | null
  costJson?: string | Record<string, unknown> | null
  costTotal?: number | null
  toolCallId: string | null
  toolName: string | null
  toolArgsJson?: string | Record<string, unknown> | null
  toolResultJson?: string | Record<string, unknown> | null
  toolStatus?: string | null
  editDiff?: string | null
  editFilePath?: string | null
  sessionStatus?: string | null
  workflowPhase?: string | null
  rawEventJson?: string | null
}

export interface SessionUsageRollup {
  totalTokens: number
  totalCost: number
  promptTokens: number
  completionTokens: number
  model: string | null
}

export interface ModelEntry {
  id: string
  label: string
  value: string
}

export interface ModelProvider {
  id: string
  name: string
  models: ModelEntry[]
}

export interface ModelCatalog {
  providers: ModelProvider[]
  defaults: Record<string, string>
  warning?: string | null
}

export interface BranchList {
  current: string
  branches: string[]
}

export interface ReviewStatus {
  taskId: string
  reviewCount: number
  maxReviews: number
  canRequestMore: boolean
}

export interface PlanningSession {
  id: string
  sessionKind: string
  status: string
  cwd: string
  model: string
  thinkingLevel: ThinkingLevel
  startedAt: number
  updatedAt: number
  finishedAt?: number | null
  exitCode?: number | null
  errorMessage?: string | null
  name?: string | null
  sessionUrl?: string
  sessionFile?: string
  taskId?: string | null
  taskRunId?: string | null
}

export interface PlanningPrompt {
  id: number
  key: string
  name: string
  description: string
  promptText: string
  isActive: boolean
  createdAt: number
  updatedAt: number
}

export interface PlanningPromptVersion {
  id: number
  planningPromptId: number
  version: number
  promptText: string
  createdAt: number
}

export interface ContainerImage {
  tag: string
  createdAt: number
  source: string
  inUseByTasks: number
  size?: string | null
}

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
  range: string
  totalTokens: number
  totalCost: number
  hourlyData: HourlyUsage[]
  dailyData: DailyUsage[]
  tokenChange: number
  costChange: number
}

export interface TaskStats {
  total: number
  done: number
  failed: number
  inProgress: number
}

export interface ModelUsageStats {
  models: Array<{ model: string; count: number; tokens: number; cost: number }>
}

export interface ExecutionGraph {
  nodes: ExecutionGraphNode[]
  edges: ExecutionGraphEdge[]
}

export interface ExecutionGraphNode {
  id: string
  label: string
  status: string
  type?: string
}

export interface ExecutionGraphEdge {
  from: string
  to: string
}

export interface WSMessage {
  type: string
  payload: Record<string, unknown>
}

export type WSMessageType = string

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

export interface LogEntry {
  id: string
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source?: string
}

export interface ControlState {
  isRunning: boolean
  isPaused: boolean
  activeRunId: string | null
}

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
  additionalAgentAccess?: TaskPathGrant[]
}

export interface UpdateTaskDTO extends Partial<CreateTaskDTO> {
  planningPrompt?: string
  completedAt?: number | null
}

export type Candidate = TaskCandidate

export const DEFAULT_CODE_STYLE_PROMPT = `You are a code style enforcement agent. Review the code and enforce the project's style guidelines.

Rules:
- Follow existing project conventions
- Use consistent indentation (match existing files)
- Remove trailing whitespace
- Fix obvious linting issues
- Do not touch unchanged files.`
