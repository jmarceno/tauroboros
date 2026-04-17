export type TaskStatus = 'template' | 'backlog' | 'executing' | 'review' | 'code-style' | 'done' | 'failed' | 'stuck'
export type ThinkingLevel = 'default' | 'low' | 'medium' | 'high'
export type ExecutionStrategy = 'standard' | 'best_of_n'
export type SelectionMode = 'pick_best' | 'synthesize' | 'pick_or_synthesize'
export type RunStatus = 'running' | 'stopping' | 'paused' | 'failed' | 'completed'
export type SessionStatus = 'pending' | 'active' | 'completed' | 'failed'
export type MessageRole = 'assistant' | 'user' | 'system' | 'tool'
export type TaskPhase = 'not_started' | 'planning' | 'plan_complete_waiting_approval' | 'implementation_pending' | 'implementation_done' | 'reviewing'
export type BestOfNSubstage = 'idle' | 'workers_running' | 'reviewers_running' | 'final_apply_running' | 'blocked_for_manual_review' | 'completed'

export interface Task {
  id: string
  idx: number
  name: string
  prompt: string
  status: TaskStatus
  branch: string
  planModel?: string
  executionModel?: string
  planmode: boolean
  autoApprovePlan: boolean
  review: boolean
  codeStyleReview: boolean
  autoCommit: boolean
  deleteWorktree: boolean
  skipPermissionAsking: boolean
  requirements: string[]
  thinkingLevel: ThinkingLevel
  planThinkingLevel: ThinkingLevel
  executionThinkingLevel: ThinkingLevel
  executionStrategy: ExecutionStrategy
  bestOfNConfig?: BestOfNConfig
  bestOfNSubstage?: BestOfNSubstage
  reviewCount: number
  jsonParseRetryCount: number
  maxReviewRunsOverride?: number
  planRevisionCount: number
  errorMessage?: string
  sessionId?: string
  sessionUrl?: string
  worktreeDir?: string
  executionPhase: string
  awaitingPlanApproval: boolean
  completedAt?: number
  createdAt: number
  updatedAt: number
  reviewActivity?: 'idle' | 'running'
  containerImage?: string
}

export interface ContainerImage {
  tag: string
  createdAt: number
  source: 'build' | 'podman'
  inUseByTasks: number
}

export interface BestOfNConfig {
  workers: BestOfNSlot[]
  reviewers: BestOfNSlot[]
  finalApplier: {
    model: string
    taskSuffix?: string
    thinkingLevel?: ThinkingLevel
  }
  selectionMode: SelectionMode
  minSuccessfulWorkers: number
  verificationCommand?: string
}

export interface BestOfNSlot {
  model: string
  count: number
  taskSuffix?: string
  thinkingLevel?: ThinkingLevel
}

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

export interface TaskRun {
  id: string
  taskId: string
  phase: 'worker' | 'reviewer' | 'final_applier'
  slotIndex: number
  attemptIndex: number
  model: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  summary?: string
  errorMessage?: string
  worktreeDir?: string
  sessionId?: string
  sessionUrl?: string
  createdAt: number
  updatedAt: number
}

export interface Candidate {
  id: string
  taskId: string
  runId: string
  status: 'pending' | 'selected' | 'rejected'
  summary?: string
  changedFilesJson: string[]
  createdAt: number
  updatedAt: number
}

export interface WorkflowRun {
  id: string
  displayName?: string
  kind: string
  status: RunStatus
  taskOrder: string[]
  currentTaskIndex: number
  currentTaskId?: string
  color?: string
  errorMessage?: string
  pauseRequested: boolean
  stopRequested: boolean
  isArchived: boolean
  createdAt: number
  updatedAt: number
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
  branch: string
  planModel?: string
  executionModel?: string
  reviewModel?: string
  repairModel?: string
  command?: string
  commitPrompt?: string
  extraPrompt?: string
  codeStylePrompt?: string
  parallelTasks: number
  maxReviews: number
  maxJsonParseRetries: number
  showExecutionGraph?: boolean
  autoDeleteNormalSessions?: boolean
  autoDeleteReviewSessions?: boolean
  thinkingLevel: ThinkingLevel
  planThinkingLevel: ThinkingLevel
  executionThinkingLevel: ThinkingLevel
  reviewThinkingLevel: ThinkingLevel
  repairThinkingLevel: ThinkingLevel
  telegramNotificationsEnabled?: boolean
  telegramBotToken?: string
  telegramChatId?: string
  columnSorts?: ColumnSortPreferences
  container?: {
    enabled?: boolean
    image?: string
    imageSource?: string
    dockerfilePath?: string
    autoPrepare?: boolean
    registryUrl?: string
  }
}

export interface BranchList {
  branches: string[]
  current: string | null
  error?: string
}

export interface ModelEntry {
  value: string
  label: string
  providerId: string
  providerName: string
  labelWithProvider: string
}

export interface ModelProvider {
  id: string
  name: string
  models: ModelEntry[]
}

export interface ModelCatalog {
  providers: ModelProvider[]
  defaults?: Record<string, string>
  error?: string
  warning?: string
}

export interface ExecutionGraph {
  totalTasks: number
  parallelLimit: number
  nodes: ExecutionNode[]
  batches: ExecutionBatch[]
  pendingApprovals: PendingApprovalTask[]
}

export interface ExecutionNode {
  id: string
  name: string
  idx: number
  expandedWorkerRuns: number
  expandedReviewerRuns: number
  hasFinalApplier: boolean
  estimatedRunCount: number
}

export interface ExecutionBatch {
  idx: number
  taskIds: string[]
  taskNames: string[]
}

export interface PendingApprovalTask {
  id: string
  name: string
  status: string
  awaitingPlanApproval: boolean
  planRevisionCount: number
}

export interface Session {
  id: string
  taskId?: string
  taskRunId?: string
  sessionKind: string
  status: SessionStatus
  model?: string
  thinkingLevel?: ThinkingLevel
  errorMessage?: string
  processPid?: number
  piSessionId?: string
  piSessionFile?: string
  exitCode?: number
  exitSignal?: string
  finishedAt?: number
  createdAt: number
  updatedAt: number
}

export interface SessionMessage {
  id: string
  sessionId: string
  taskId?: string
  taskRunId?: string
  role: MessageRole
  eventName?: string | null
  messageType: string
  contentJson: Record<string, unknown>
  modelProvider?: string | null
  modelId?: string | null
  agentName?: string | null
  toolName?: string | null
  toolArgsJson?: unknown
  toolResultJson?: unknown
  timestamp: number
  createdAt: number
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

export interface ReviewStatus {
  taskId: string
  reviewCount: number
  maxReviewRuns: number
  maxReviewRunsOverride?: number
}

export type WSMessageType =
  | 'task_created'
  | 'task_updated'
  | 'task_deleted'
  | 'task_archived'
  | 'task_reordered'
  | 'run_created'
  | 'run_updated'
  | 'run_archived'
  | 'run_paused'
  | 'run_resumed'
  | 'run_stopped'
  | 'options_updated'
  | 'session_started'
  | 'session_message_created'
  | 'session_status_changed'
  | 'session_completed'
  | 'task_run_created'
  | 'task_run_updated'
  | 'task_candidate_created'
  | 'task_candidate_updated'
  | 'image_status'
  | 'error'
  | 'plan_revision_requested'
  | 'execution_started'
  | 'execution_stopped'
  | 'execution_complete'
  | 'execution_paused'
  | 'execution_resumed'
  // Planning chat events
  | 'planning_prompt_updated'
  | 'planning_session_created'
  | 'planning_session_updated'
  | 'planning_session_message'
  | 'planning_session_closed'
  // Container events
  | 'container_config_updated'
  | 'container_package_added'
  | 'container_package_removed'
  | 'container_dockerfile_custom_updated'
  | 'container_build_started'
  | 'container_build_progress'
  | 'container_build_completed'
  | 'container_build_cancelled'
  | 'container_profile_applied'

export interface WSMessage {
  type: WSMessageType
  payload: unknown
}

export interface ImageStatusPayload {
  status: string
  message: string
  progress?: number
  errorMessage?: string
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
  deleteWorktree?: boolean
  skipPermissionAsking?: boolean
  requirements?: string[]
  thinkingLevel?: ThinkingLevel
  planThinkingLevel?: ThinkingLevel
  executionThinkingLevel?: ThinkingLevel
  executionStrategy?: ExecutionStrategy
  bestOfNConfig?: BestOfNConfig
  bestOfNSubstage?: BestOfNSubstage
  containerImage?: string
}

// Extended DTO for create-and-wait endpoint with timeout options
export interface CreateTaskAndWaitDTO extends CreateTaskDTO {
  timeoutMs?: number        // Max time to wait (default: 30 min, max: 2 hours)
  pollIntervalMs?: number   // Polling interval (default: 2s, min: 1s, max: 30s)
}

// Result from create-and-wait endpoint
export interface CreateAndWaitResult {
  task: Task
  run?: WorkflowRun
  completedAt?: number
  durationMs?: number
  status: TaskStatus | 'timeout'
  error?: string
  timeoutMs?: number
  elapsedMs?: number
}

export interface UpdateTaskDTO {
  name?: string
  prompt?: string
  status?: TaskStatus
  branch?: string
  planModel?: string
  executionModel?: string
  planmode?: boolean
  autoApprovePlan?: boolean
  review?: boolean
  codeStyleReview?: boolean
  autoCommit?: boolean
  deleteWorktree?: boolean
  skipPermissionAsking?: boolean
  requirements?: string[]
  thinkingLevel?: ThinkingLevel
  planThinkingLevel?: ThinkingLevel
  executionThinkingLevel?: ThinkingLevel
  executionStrategy?: ExecutionStrategy
  bestOfNConfig?: BestOfNConfig | null
  bestOfNSubstage?: BestOfNSubstage
  reviewCount?: number
  errorMessage?: string | null
  completedAt?: number | null
  sessionId?: string | null
  sessionUrl?: string | null
  worktreeDir?: string | null
  executionPhase?: string
  awaitingPlanApproval?: boolean
  maxReviewRunsOverride?: number
  containerImage?: string
}

// Planning Chat Types
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

export interface PlanningSession extends Session {
  sessionKind: 'planning'
}

export interface CreatePlanningSessionDTO {
  cwd?: string
  model?: string
  thinkingLevel?: ThinkingLevel
}

// Toast Types
export type ToastVariant = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

export interface LogEntry {
  ts: string
  message: string
  variant: ToastVariant
}

// Control State Types
export type ControlState = 'idle' | 'running' | 'pausing' | 'paused' | 'resuming' | 'stopping'

// Task Run Context
export interface TaskRunContext {
  taskId: string | null
  phase: string | null
  slotIndex: number
  attemptIndex: number
}
