import type {
  BestOfNConfig,
  BestOfNSubstage,
  CreateSessionMessageInput,
  ExecutionPhase,
  ExecutionStrategy,
  MessageType,
  Options,
  SessionUsageRollup,
  RunPhase,
  RunStatus,
  SessionMessage,
  Task,
  TaskCandidate,
  TaskRun,
  TaskStatus,
  ThinkingLevel,
  WorkflowRun,
  WorkflowRunKind,
  WorkflowRunStatus,
} from "../types.ts"

export type {
  BestOfNConfig,
  BestOfNSubstage,
  CreateSessionMessageInput,
  ExecutionPhase,
  ExecutionStrategy,
  MessageType,
  Options,
  SessionUsageRollup,
  RunPhase,
  RunStatus,
  SessionMessage,
  Task,
  TaskCandidate,
  TaskRun,
  TaskStatus,
  ThinkingLevel,
  WorkflowRun,
  WorkflowRunKind,
  WorkflowRunStatus,
}

export type PiSessionKind =
  | "task"
  | "task_run_worker"
  | "task_run_reviewer"
  | "task_run_final_applier"
  | "review_scratch"
  | "repair"
  | "plan"
  | "plan_revision"
  | "planning"
  | "container_config"

export type PiSessionStatus = "starting" | "active" | "paused" | "completed" | "failed" | "aborted"

export interface PiWorkflowSession {
  id: string
  taskId: string | null
  taskRunId: string | null
  sessionKind: PiSessionKind
  status: PiSessionStatus
  cwd: string
  worktreeDir: string | null
  branch: string | null
  piSessionId: string | null
  piSessionFile: string | null
  processPid: number | null
  model: string
  thinkingLevel: ThinkingLevel
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  exitCode: number | null
  exitSignal: string | null
  errorMessage: string | null
}

export interface CreatePiWorkflowSessionInput {
  id: string
  taskId?: string | null
  taskRunId?: string | null
  sessionKind: PiSessionKind
  status?: PiSessionStatus
  cwd: string
  worktreeDir?: string | null
  branch?: string | null
  piSessionId?: string | null
  piSessionFile?: string | null
  processPid?: number | null
  model?: string
  thinkingLevel?: ThinkingLevel
  startedAt?: number
  finishedAt?: number | null
  exitCode?: number | null
  exitSignal?: string | null
  errorMessage?: string | null
}

export interface UpdatePiWorkflowSessionInput {
  taskId?: string | null
  taskRunId?: string | null
  status?: PiSessionStatus
  cwd?: string
  worktreeDir?: string | null
  branch?: string | null
  piSessionId?: string | null
  piSessionFile?: string | null
  processPid?: number | null
  model?: string
  thinkingLevel?: ThinkingLevel
  finishedAt?: number | null
  exitCode?: number | null
  exitSignal?: string | null
  errorMessage?: string | null
}

export type SessionIOStream = "stdin" | "stdout" | "stderr" | "server"

export type SessionIORecordType =
  | "rpc_command"
  | "rpc_response"
  | "rpc_event"
  | "stderr_chunk"
  | "lifecycle"
  | "snapshot"
  | "prompt_rendered"

export interface SessionIORecord {
  id: number
  sessionId: string
  seq: number
  stream: SessionIOStream
  recordType: SessionIORecordType
  payloadJson: Record<string, unknown> | null
  payloadText: string | null
  createdAt: number
}

export interface AppendSessionIOInput {
  sessionId: string
  seq?: number
  stream: SessionIOStream
  recordType: SessionIORecordType
  payloadJson?: Record<string, unknown> | null
  payloadText?: string | null
  createdAt?: number
}

export interface GetSessionIOOptions {
  offset?: number
  limit?: number
  recordType?: SessionIORecordType
}

export type PromptTemplateKey =
  | "execution"
  | "planning"
  | "plan_revision"
  | "review"
  | "review_fix"
  | "repair"
  | "best_of_n_worker"
  | "best_of_n_reviewer"
  | "best_of_n_final_applier"
  | "commit"

export interface PromptTemplate {
  id: number
  key: PromptTemplateKey | string
  name: string
  description: string
  templateText: string
  variablesJson: string[]
  isActive: boolean
  createdAt: number
  updatedAt: number
}

export interface PromptTemplateVersion {
  id: number
  promptTemplateId: number
  version: number
  templateText: string
  variablesJson: string[]
  createdAt: number
}

export interface UpsertPromptTemplateInput {
  key: PromptTemplateKey | string
  name: string
  description?: string
  templateText: string
  variablesJson?: string[]
  isActive?: boolean
}

export interface CreateWorkflowRunInput {
  id: string
  kind: WorkflowRunKind
  status?: WorkflowRunStatus
  displayName?: string
  targetTaskId?: string | null
  taskOrder?: string[]
  currentTaskId?: string | null
  currentTaskIndex?: number
  pauseRequested?: boolean
  stopRequested?: boolean
  errorMessage?: string | null
  createdAt?: number
  startedAt?: number
  finishedAt?: number | null
  color?: string
}

export interface UpdateWorkflowRunInput {
  status?: WorkflowRunStatus
  displayName?: string
  targetTaskId?: string | null
  taskOrder?: string[]
  currentTaskId?: string | null
  currentTaskIndex?: number
  pauseRequested?: boolean
  stopRequested?: boolean
  errorMessage?: string | null
  finishedAt?: number | null
}

export interface CreateTaskInput {
  id?: string
  name: string
  prompt: string
  status?: TaskStatus
  idx?: number
  branch?: string
  planModel?: string
  executionModel?: string
  planmode?: boolean
  autoApprovePlan?: boolean
  review?: boolean
  autoCommit?: boolean
  deleteWorktree?: boolean
  requirements?: string[]
  thinkingLevel?: ThinkingLevel
  planThinkingLevel?: ThinkingLevel
  executionThinkingLevel?: ThinkingLevel
  executionPhase?: ExecutionPhase
  awaitingPlanApproval?: boolean
  planRevisionCount?: number
  executionStrategy?: ExecutionStrategy
  bestOfNConfig?: BestOfNConfig | null
  bestOfNSubstage?: BestOfNSubstage
  skipPermissionAsking?: boolean
  maxReviewRunsOverride?: number | null
  smartRepairHints?: string | null
  reviewActivity?: "idle" | "running"
}

export interface UpdateTaskInput {
  name?: string
  prompt?: string
  status?: TaskStatus
  idx?: number
  branch?: string
  planModel?: string
  executionModel?: string
  planmode?: boolean
  autoApprovePlan?: boolean
  review?: boolean
  autoCommit?: boolean
  deleteWorktree?: boolean
  requirements?: string[]
  agentOutput?: string
  sessionId?: string | null
  sessionUrl?: string | null
  worktreeDir?: string | null
  errorMessage?: string | null
  reviewCount?: number
  jsonParseRetryCount?: number
  completedAt?: number | null
  thinkingLevel?: ThinkingLevel
  planThinkingLevel?: ThinkingLevel
  executionThinkingLevel?: ThinkingLevel
  executionPhase?: ExecutionPhase
  awaitingPlanApproval?: boolean
  planRevisionCount?: number
  executionStrategy?: ExecutionStrategy
  bestOfNConfig?: BestOfNConfig | null
  bestOfNSubstage?: BestOfNSubstage
  skipPermissionAsking?: boolean
  maxReviewRunsOverride?: number | null
  smartRepairHints?: string | null
  reviewActivity?: "idle" | "running"
  isArchived?: boolean
  archivedAt?: number | null
}

export interface PromptRenderResult {
  template: PromptTemplate
  renderedText: string
}

export interface PromptRenderAndCaptureInput {
  key: PromptTemplateKey | string
  variables?: Record<string, unknown>
  sessionId?: string
  stream?: SessionIOStream
}

export interface CreateTaskRunInput {
  id?: string
  taskId: string
  phase: RunPhase
  slotIndex: number
  attemptIndex: number
  model: string
  taskSuffix?: string | null
  status?: RunStatus
  sessionId?: string | null
  sessionUrl?: string | null
  worktreeDir?: string | null
  summary?: string | null
  errorMessage?: string | null
  candidateId?: string | null
  metadataJson?: Record<string, any>
  createdAt?: number
  completedAt?: number | null
}

export interface UpdateTaskRunInput {
  status?: RunStatus
  sessionId?: string | null
  sessionUrl?: string | null
  worktreeDir?: string | null
  summary?: string | null
  errorMessage?: string | null
  candidateId?: string | null
  metadataJson?: Record<string, any>
  completedAt?: number | null
}

export interface CreateTaskCandidateInput {
  id?: string
  taskId: string
  workerRunId: string
  status?: TaskCandidate["status"]
  changedFilesJson?: string[]
  diffStatsJson?: Record<string, number>
  verificationJson?: Record<string, any>
  summary?: string | null
  errorMessage?: string | null
  createdAt?: number
}

export interface UpdateTaskCandidateInput {
  status?: TaskCandidate["status"]
  changedFilesJson?: string[]
  diffStatsJson?: Record<string, number>
  verificationJson?: Record<string, any>
  summary?: string | null
  errorMessage?: string | null
}

export interface SessionMessageQueryOptions {
  offset?: number
  limit?: number
  messageType?: MessageType
}

// Planning Prompt Types
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

export interface UpsertPlanningPromptInput {
  key?: string
  name: string
  description?: string
  promptText: string
  isActive?: boolean
}

export interface UpdatePlanningPromptInput {
  name?: string
  description?: string
  promptText?: string
  isActive?: boolean
}

// Container Configuration Types

export interface ContainerPackage {
  id: number
  name: string
  category: string
  versionConstraint?: string
  installOrder: number
  addedAt: number
  source: string
}

export interface ContainerBuild {
  id: number
  status: "pending" | "running" | "success" | "failed" | "cancelled"
  startedAt: number | null
  completedAt: number | null
  packagesHash: string | null
  errorMessage: string | null
  imageTag: string | null
  logs: string | null
}

export interface ContainerConfig {
  version: number
  baseImage: string
  customDockerfilePath: string
  generatedDockerfilePath: string
  packages: PackageDefinition[]
  lastBuild: {
    timestamp: string
    imageTag: string
    success: boolean
  } | null
}

export interface PackageDefinition {
  name: string
  category: string
  versionConstraint?: string
  installOrder: number
}

export interface ContainerProfile {
  id: string
  name: string
  description: string
  image: string
  dockerfileTemplate: string
}

export interface PackageValidationResult {
  valid: string[]
  invalid: string[]
  suggestions: Record<string, string[]>
}

export interface ContainerBuildResult {
  success: boolean
  imageTag: string
  logs: string[]
  errorMessage?: string
}

export interface CreateContainerPackageInput {
  name: string
  category: string
  versionConstraint?: string
  installOrder?: number
  source?: string
}

export interface ContainerBuildStatus {
  status: "pending" | "running" | "success" | "failed" | "cancelled"
  progress?: number
  message: string
  logs: string[]
  errorMessage?: string
  canCancel: boolean
}

// Workflow Run Indicators Types

export interface JsonOutFailEntry {
  model: string
  provider: string
  fails: number
  lastFailAt: number
}

export interface WorkflowRunIndicators {
  id: string
  jsonOutFails: {
    "json-output-fails": JsonOutFailEntry[]
  }
}

export interface CreateWorkflowRunIndicatorsInput {
  id: string
  jsonOutFails?: Record<string, unknown>
}
