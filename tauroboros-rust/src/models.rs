use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};
use sqlx::FromRow;

fn parse_json_value(raw: &str) -> Option<Value> {
    serde_json::from_str::<Value>(raw).ok()
}

fn serialize_json_array_or_empty<S>(raw: &Option<String>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match raw.as_deref().and_then(parse_json_value) {
        Some(Value::Array(values)) => Value::Array(values).serialize(serializer),
        _ => Value::Array(vec![]).serialize(serializer),
    }
}

fn serialize_json_object_or_empty<S>(raw: &Option<String>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match raw.as_deref().and_then(parse_json_value) {
        Some(Value::Object(values)) => Value::Object(values).serialize(serializer),
        Some(other) => other.serialize(serializer),
        None => Value::Object(Map::new()).serialize(serializer),
    }
}

fn serialize_json_value_or_null<S>(raw: &Option<String>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    raw.as_deref()
        .and_then(parse_json_value)
        .unwrap_or(Value::Null)
        .serialize(serializer)
}

fn serialize_json_content<S>(raw: &String, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    parse_json_value(raw)
        .unwrap_or_else(|| serde_json::json!({ "text": raw }))
        .serialize(serializer)
}

fn serialize_json_array_from_string<S>(raw: &String, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match parse_json_value(raw) {
        Some(Value::Array(values)) => Value::Array(values).serialize(serializer),
        _ => Value::Array(vec![]).serialize(serializer),
    }
}

fn serialize_json_object_from_string<S>(raw: &String, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match parse_json_value(raw) {
        Some(Value::Object(values)) => Value::Object(values).serialize(serializer),
        _ => Value::Object(Map::new()).serialize(serializer),
    }
}

// ============================================================================
// Enums (matching TypeScript string literal types)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum TaskStatus {
    Template,
    Backlog,
    Queued,
    Executing,
    Review,
    CodeStyle,
    Done,
    Failed,
    Stuck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum AutoDeployCondition {
    BeforeWorkflowStart,
    AfterWorkflowEnd,
    WorkflowDone,
    WorkflowFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum TaskGroupStatus {
    Active,
    Completed,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Default,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum ExecutionPhase {
    NotStarted,
    PlanCompleteWaitingApproval,
    PlanRevisionPending,
    ImplementationPending,
    ImplementationDone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum RunExecutionPhase {
    NotStarted,
    Planning,
    Executing,
    Reviewing,
    Committing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum ExecutionStrategy {
    Standard,
    BestOfN,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BestOfNSubstage {
    Idle,
    WorkersRunning,
    ReviewersRunning,
    FinalApplyRunning,
    BlockedForManualReview,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum RunPhase {
    Worker,
    Reviewer,
    FinalApplier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum RunStatus {
    Pending,
    Running,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum SelectionMode {
    PickBest,
    Synthesize,
    PickOrSynthesize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum WorkflowRunKind {
    AllTasks,
    SingleTask,
    WorkflowReview,
    GroupTasks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum WorkflowRunStatus {
    Queued,
    Running,
    Paused,
    Stopping,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum SelfHealStatus {
    Idle,
    Investigating,
    Recovering,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum TelegramNotificationLevel {
    All,
    Failures,
    DoneAndFailures,
    WorkflowDoneAndFailures,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum PiSessionKind {
    Task,
    TaskRunWorker,
    TaskRunReviewer,
    TaskRunFinalApplier,
    ReviewScratch,
    Repair,
    Plan,
    PlanRevision,
    Planning,
    ContainerConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum PiSessionStatus {
    Starting,
    Active,
    Paused,
    Completed,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum AuditLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Text,
    ToolCall,
    ToolResult,
    Error,
    StepStart,
    StepFinish,
    SessionStart,
    SessionEnd,
    SessionStatus,
    Thinking,
    UserPrompt,
    AssistantResponse,
    ToolRequest,
    PermissionAsked,
    PermissionReplied,
    SessionError,
    MessagePart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateStatus {
    Available,
    Selected,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnSortOption {
    Manual,
    NameAsc,
    NameDesc,
    CreatedAsc,
    CreatedDesc,
    UpdatedAsc,
    UpdatedDesc,
}

// ============================================================================
// Supporting Structs
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BestOfNSlot {
    pub model: String,
    pub count: i32,
    pub task_suffix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BestOfNFinalApplier {
    pub model: String,
    pub task_suffix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BestOfNConfig {
    pub workers: Vec<BestOfNSlot>,
    pub reviewers: Vec<BestOfNSlot>,
    pub final_applier: BestOfNFinalApplier,
    pub selection_mode: SelectionMode,
    pub min_successful_workers: i32,
    pub verification_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSortPreferences {
    pub template: Option<ColumnSortOption>,
    pub backlog: Option<ColumnSortOption>,
    pub executing: Option<ColumnSortOption>,
    pub review: Option<ColumnSortOption>,
    #[serde(rename = "code-style")]
    pub code_style: Option<ColumnSortOption>,
    pub done: Option<ColumnSortOption>,
}

// ============================================================================
// Main Data Models (matching TypeScript types exactly)
// ============================================================================

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub idx: i32,
    pub prompt: String,
    pub branch: Option<String>,
    pub plan_model: Option<String>,
    pub execution_model: Option<String>,
    #[sqlx(rename = "planmode")]
    #[serde(rename = "planmode")]
    pub plan_mode: bool,
    pub auto_approve_plan: bool,
    pub review: bool,
    pub auto_commit: bool,
    pub auto_deploy: bool,
    pub auto_deploy_condition: Option<AutoDeployCondition>,
    pub delete_worktree: bool,
    pub status: TaskStatus,
    #[serde(serialize_with = "serialize_json_array_or_empty")]
    pub requirements: Option<String>, // JSON array stored as string
    pub agent_output: String,
    pub review_count: i32,
    pub json_parse_retry_count: i32,
    pub session_id: Option<String>,
    pub session_url: Option<String>,
    pub worktree_dir: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub thinking_level: ThinkingLevel,
    pub plan_thinking_level: ThinkingLevel,
    pub execution_thinking_level: ThinkingLevel,
    pub execution_phase: ExecutionPhase,
    pub awaiting_plan_approval: bool,
    pub plan_revision_count: i32,
    pub execution_strategy: ExecutionStrategy,
    #[serde(serialize_with = "serialize_json_value_or_null")]
    pub best_of_n_config: Option<String>, // JSON stored as string
    pub best_of_n_substage: BestOfNSubstage,
    pub skip_permission_asking: bool,
    pub max_review_runs_override: Option<i32>,
    pub smart_repair_hints: Option<String>,
    pub review_activity: String, // "idle" or "running"
    pub is_archived: bool,
    pub archived_at: Option<i64>,
    pub container_image: Option<String>,
    pub code_style_review: bool,
    pub group_id: Option<String>,
    pub self_heal_status: SelfHealStatus,
    pub self_heal_message: Option<String>,
    pub self_heal_report_id: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub kind: WorkflowRunKind,
    pub status: WorkflowRunStatus,
    pub display_name: String,
    pub target_task_id: Option<String>,
    #[serde(serialize_with = "serialize_json_array_or_empty")]
    pub task_order: Option<String>, // JSON array stored as string
    pub current_task_id: Option<String>,
    pub current_task_index: i32,
    pub pause_requested: bool,
    pub stop_requested: bool,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    pub is_archived: bool,
    pub archived_at: Option<i64>,
    pub color: String,
    pub group_id: Option<String>,
    pub queued_task_count: Option<i32>,
    pub executing_task_count: Option<i32>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub phase: RunPhase,
    pub slot_index: i32,
    pub attempt_index: i32,
    pub model: String,
    pub task_suffix: Option<String>,
    pub status: RunStatus,
    pub session_id: Option<String>,
    pub session_url: Option<String>,
    pub worktree_dir: Option<String>,
    pub summary: Option<String>,
    pub error_message: Option<String>,
    pub candidate_id: Option<String>,
    #[serde(serialize_with = "serialize_json_object_or_empty")]
    pub metadata_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCandidate {
    pub id: String,
    pub task_id: String,
    pub worker_run_id: String,
    pub status: String, // "available", "selected", "rejected"
    #[serde(serialize_with = "serialize_json_array_or_empty")]
    pub changed_files_json: Option<String>,
    #[serde(serialize_with = "serialize_json_object_or_empty")]
    pub diff_stats_json: Option<String>,
    #[serde(serialize_with = "serialize_json_object_or_empty")]
    pub verification_json: Option<String>,
    pub summary: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    pub id: String,
    pub name: String,
    pub color: String,
    pub status: TaskGroupStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    #[sqlx(skip)]
    pub task_ids: Vec<String>, // Populated separately
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroupMember {
    pub id: i64,
    pub group_id: String,
    pub task_id: String,
    pub idx: i32,
    pub added_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiWorkflowSession {
    pub id: String,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub session_kind: PiSessionKind,
    pub status: PiSessionStatus,
    pub cwd: String,
    pub worktree_dir: Option<String>,
    pub branch: Option<String>,
    pub pi_session_id: Option<String>,
    pub pi_session_file: Option<String>,
    pub process_pid: Option<i32>,
    pub model: String,
    pub thinking_level: ThinkingLevel,
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub error_message: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: i64,
    pub seq: i32,
    pub message_id: Option<String>,
    pub session_id: String,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub timestamp: i64,
    pub role: MessageRole,
    pub event_name: Option<String>,
    pub message_type: MessageType,
    #[serde(serialize_with = "serialize_json_content")]
    pub content_json: String,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub agent_name: Option<String>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub cache_read_tokens: Option<i32>,
    pub cache_write_tokens: Option<i32>,
    pub total_tokens: Option<i32>,
    #[serde(serialize_with = "serialize_json_value_or_null")]
    pub cost_json: Option<String>,
    pub cost_total: Option<f64>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    #[serde(serialize_with = "serialize_json_value_or_null")]
    pub tool_args_json: Option<String>,
    #[serde(serialize_with = "serialize_json_value_or_null")]
    pub tool_result_json: Option<String>,
    pub tool_status: Option<String>,
    pub edit_diff: Option<String>,
    pub edit_file_path: Option<String>,
    pub session_status: Option<String>,
    pub workflow_phase: Option<String>,
    #[serde(serialize_with = "serialize_json_value_or_null")]
    pub raw_event_json: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: i64,
    pub created_at: i64,
    pub level: AuditLevel,
    pub source: String,
    pub event_type: String,
    pub message: String,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub session_id: Option<String>,
    #[serde(serialize_with = "serialize_json_content")]
    pub details_json: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub id: i64,
    pub commit_prompt: String,
    pub extra_prompt: String,
    pub branch: String,
    pub plan_model: String,
    pub execution_model: String,
    pub review_model: String,
    pub repair_model: String,
    pub command: String,
    pub parallel_tasks: i32,
    pub auto_delete_normal_sessions: bool,
    pub auto_delete_review_sessions: bool,
    pub show_execution_graph: bool,
    pub port: i32,
    pub thinking_level: ThinkingLevel,
    pub plan_thinking_level: ThinkingLevel,
    pub execution_thinking_level: ThinkingLevel,
    pub review_thinking_level: ThinkingLevel,
    pub repair_thinking_level: ThinkingLevel,
    pub code_style_prompt: String,
    pub telegram_bot_token: String,
    pub telegram_chat_id: String,
    pub telegram_notification_level: TelegramNotificationLevel,
    pub max_reviews: i32,
    pub max_json_parse_retries: i32,
    #[serde(serialize_with = "serialize_json_value_or_null")]
    pub column_sorts: Option<String>, // JSON stored as string
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningPrompt {
    pub id: i64,
    pub key: String,
    pub name: String,
    pub description: String,
    pub prompt_text: String,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningPromptVersion {
    pub id: i64,
    pub planning_prompt_id: i64,
    pub version: i32,
    pub prompt_text: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: i64,
    pub key: String,
    pub name: String,
    pub description: String,
    pub template_text: String,
    pub variables_json: String, // JSON array stored as string
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfHealReport {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub task_status: TaskStatus,
    pub error_message: Option<String>,
    pub diagnostics_summary: String,
    pub is_tauroboros_bug: bool,
    #[serde(rename = "rootCause", serialize_with = "serialize_json_object_from_string")]
    pub root_cause_json: String,
    pub proposed_solution: String,
    #[serde(rename = "implementationPlan", serialize_with = "serialize_json_array_from_string")]
    pub implementation_plan_json: String,
    pub confidence: String, // "high", "medium", "low"
    #[serde(rename = "externalFactors", serialize_with = "serialize_json_array_from_string")]
    pub external_factors_json: String,
    pub source_mode: String, // "local", "github_clone", "github_metadata_only"
    pub source_path: Option<String>,
    pub github_url: String,
    pub tauroboros_version: String,
    pub db_path: String,
    #[serde(serialize_with = "serialize_json_object_from_string")]
    pub db_schema_json: String,
    pub raw_response: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// ============================================================================
// WebSocket Message Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WSMessage {
    pub r#type: String,
    pub payload: serde_json::Value,
}

// ============================================================================
// API Input/Output Types
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub id: Option<String>,
    pub name: String,
    pub prompt: String,
    pub status: Option<TaskStatus>,
    pub branch: Option<String>,
    pub plan_model: Option<String>,
    pub execution_model: Option<String>,
    #[serde(rename = "planmode")]
    pub plan_mode: Option<bool>,
    pub auto_approve_plan: Option<bool>,
    pub review: Option<bool>,
    pub code_style_review: Option<bool>,
    pub auto_commit: Option<bool>,
    pub auto_deploy: Option<bool>,
    pub auto_deploy_condition: Option<AutoDeployCondition>,
    pub delete_worktree: Option<bool>,
    pub requirements: Option<Vec<String>>,
    pub thinking_level: Option<ThinkingLevel>,
    pub plan_thinking_level: Option<ThinkingLevel>,
    pub execution_thinking_level: Option<ThinkingLevel>,
    pub execution_strategy: Option<ExecutionStrategy>,
    pub best_of_n_config: Option<BestOfNConfig>,
    pub best_of_n_substage: Option<BestOfNSubstage>,
    pub skip_permission_asking: Option<bool>,
    pub max_review_runs_override: Option<i32>,
    pub container_image: Option<String>,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub status: Option<TaskStatus>,
    pub branch: Option<Option<String>>,
    pub plan_model: Option<Option<String>>,
    pub execution_model: Option<Option<String>>,
    #[serde(rename = "planmode")]
    pub plan_mode: Option<bool>,
    pub auto_approve_plan: Option<bool>,
    pub review: Option<bool>,
    pub auto_commit: Option<bool>,
    pub auto_deploy: Option<bool>,
    pub auto_deploy_condition: Option<Option<AutoDeployCondition>>,
    pub delete_worktree: Option<bool>,
    pub requirements: Option<Vec<String>>,
    pub agent_output: Option<Option<String>>,
    pub session_id: Option<Option<String>>,
    pub session_url: Option<Option<String>>,
    pub worktree_dir: Option<Option<String>>,
    pub error_message: Option<Option<String>>,
    pub review_count: Option<i32>,
    pub json_parse_retry_count: Option<i32>,
    pub completed_at: Option<Option<i64>>,
    pub thinking_level: Option<ThinkingLevel>,
    pub plan_thinking_level: Option<ThinkingLevel>,
    pub execution_thinking_level: Option<ThinkingLevel>,
    pub execution_phase: Option<ExecutionPhase>,
    pub awaiting_plan_approval: Option<bool>,
    pub plan_revision_count: Option<i32>,
    pub execution_strategy: Option<ExecutionStrategy>,
    pub best_of_n_config: Option<Option<BestOfNConfig>>,
    pub best_of_n_substage: Option<BestOfNSubstage>,
    pub skip_permission_asking: Option<bool>,
    pub max_review_runs_override: Option<i32>,
    pub smart_repair_hints: Option<Option<String>>,
    pub review_activity: Option<Option<String>>,
    pub is_archived: Option<bool>,
    pub archived_at: Option<Option<i64>>,
    pub container_image: Option<Option<String>>,
    pub code_style_review: Option<bool>,
    pub group_id: Option<Option<String>>,
    pub self_heal_status: Option<SelfHealStatus>,
    pub self_heal_message: Option<Option<String>>,
    pub self_heal_report_id: Option<Option<String>>,
}

// ============================================================================
// Additional Models for Frontend Compatibility
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub providers: Vec<ModelProvider>,
    pub defaults: std::collections::HashMap<String, String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchList {
    pub current: String,
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    pub commit: String,
    pub display_version: String,
    pub is_compiled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedState {
    pub has_paused_run: bool,
    pub state: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStatus {
    pub enabled: bool,
    pub available: bool,
    pub has_running_workflows: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub image: String,
    pub dockerfile_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerBuild {
    pub id: i64,
    pub status: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub packages_hash: Option<String>,
    pub error_message: Option<String>,
    pub image_tag: Option<String>,
    pub logs: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerImage {
    pub tag: String,
    pub created_at: i64,
    pub source: String,
    pub in_use_by_tasks: i32,
    pub size: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourlyUsage {
    pub hour: String,
    pub requests: i64,
    pub tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyUsage {
    pub date: String,
    pub requests: i64,
    pub tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageStats {
    pub range: String,
    pub total_tokens: i64,
    pub total_cost: f64,
    pub hourly_data: Vec<HourlyUsage>,
    pub daily_data: Vec<DailyUsage>,
    pub token_change: f64,
    pub cost_change: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageStats {
    pub models: Vec<ModelStatEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStatEntry {
    pub model: String,
    pub count: i64,
    pub tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchivedTasksResponse {
    pub runs: Vec<ArchivedRunWithTasks>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchivedRunWithTasks {
    pub run: WorkflowRun,
    pub tasks: Vec<Task>,
}
