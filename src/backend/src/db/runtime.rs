use crate::db::models::*;
use crate::db::queries::{get_workflow_run, get_workflow_session};
use crate::error::{ApiError, ApiResult};
use chrono::Utc;
use sqlx::{Pool, Sqlite};
use uuid::Uuid;

const RUN_COLORS: [&str; 12] = [
    "#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#feca57", "#ff9ff3", "#54a0ff", "#48dbfb",
    "#1dd1a1", "#ffc048", "#5f27cd", "#00d2d3",
];

#[derive(Debug, Clone)]
pub struct CreateWorkflowRunRecord {
    pub id: Option<String>,
    pub kind: WorkflowRunKind,
    pub status: WorkflowRunStatus,
    pub display_name: String,
    pub target_task_id: Option<String>,
    pub task_order: Vec<String>,
    pub current_task_id: Option<String>,
    pub current_task_index: i32,
    pub pause_requested: bool,
    pub stop_requested: bool,
    pub error_message: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub color: Option<String>,
    pub group_id: Option<String>,
    pub queued_task_count: Option<i32>,
    pub executing_task_count: Option<i32>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateWorkflowRunRecord {
    pub status: Option<WorkflowRunStatus>,
    pub display_name: Option<String>,
    pub target_task_id: Option<Option<String>>,
    pub task_order: Option<Vec<String>>,
    pub current_task_id: Option<Option<String>>,
    pub current_task_index: Option<i32>,
    pub pause_requested: Option<bool>,
    pub stop_requested: Option<bool>,
    pub error_message: Option<Option<String>>,
    pub finished_at: Option<Option<i64>>,
    pub is_archived: Option<bool>,
    pub archived_at: Option<Option<i64>>,
    pub group_id: Option<Option<String>>,
    pub queued_task_count: Option<Option<i32>>,
    pub executing_task_count: Option<Option<i32>>,
}

#[derive(Debug, Clone)]
pub struct CreateTaskRunRecord {
    pub id: Option<String>,
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
    pub metadata_json: Option<serde_json::Value>,
    pub created_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateTaskRunRecord {
    pub status: Option<RunStatus>,
    pub session_id: Option<Option<String>>,
    pub session_url: Option<Option<String>>,
    pub worktree_dir: Option<Option<String>>,
    pub summary: Option<Option<String>>,
    pub error_message: Option<Option<String>>,
    pub candidate_id: Option<Option<String>>,
    pub metadata_json: Option<Option<serde_json::Value>>,
    pub completed_at: Option<Option<i64>>,
}

#[derive(Debug, Clone)]
pub struct CreateWorkflowSessionRecord {
    pub id: Option<String>,
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
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub error_message: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateWorkflowSessionRecord {
    pub status: Option<PiSessionStatus>,
    pub cwd: Option<String>,
    pub worktree_dir: Option<Option<String>>,
    pub branch: Option<Option<String>>,
    pub pi_session_id: Option<Option<String>>,
    pub pi_session_file: Option<Option<String>>,
    pub process_pid: Option<Option<i32>>,
    pub model: Option<String>,
    pub thinking_level: Option<ThinkingLevel>,
    pub finished_at: Option<Option<i64>>,
    pub exit_code: Option<Option<i32>>,
    pub exit_signal: Option<Option<String>>,
    pub error_message: Option<Option<String>>,
    pub name: Option<Option<String>>,
}

pub async fn get_prompt_template(
    pool: &Pool<Sqlite>,
    key: &str,
) -> ApiResult<Option<PromptTemplate>> {
    sqlx::query_as::<_, PromptTemplate>(
        r#"
        SELECT * FROM prompt_templates WHERE key = ? AND is_active = 1 LIMIT 1
        "#,
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)
}

pub async fn get_next_session_message_seq(pool: &Pool<Sqlite>, session_id: &str) -> ApiResult<i32> {
    let current: Option<i32> = sqlx::query_scalar(
        r#"
        SELECT MAX(seq) FROM session_messages WHERE session_id = ?
        "#,
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(current.unwrap_or(0) + 1)
}

pub async fn get_next_run_color(pool: &Pool<Sqlite>) -> ApiResult<String> {
    let used_colors: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT color FROM workflow_runs
        WHERE is_archived = 0 AND status IN ('queued', 'running', 'stopping', 'paused')
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    let color = RUN_COLORS
        .iter()
        .find(|candidate| !used_colors.iter().any(|used| used == **candidate))
        .copied()
        .unwrap_or(RUN_COLORS[0]);

    Ok(color.to_string())
}

pub async fn create_workflow_run_record(
    pool: &Pool<Sqlite>,
    input: CreateWorkflowRunRecord,
) -> ApiResult<WorkflowRun> {
    let now = Utc::now().timestamp();
    let id = input
        .id
        .unwrap_or_else(|| Uuid::new_v4().to_string()[..8].to_string());
    let started_at = input.started_at.unwrap_or(now);
    let color = match input.color {
        Some(color) => color,
        None => get_next_run_color(pool).await?,
    };

    sqlx::query(
        r#"
        INSERT INTO workflow_runs (
            id, kind, status, display_name, target_task_id, task_order,
            current_task_id, current_task_index, pause_requested, stop_requested,
            error_message, created_at, started_at, updated_at, finished_at,
            is_archived, archived_at, color, group_id, queued_task_count, executing_task_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(input.kind)
    .bind(input.status)
    .bind(&input.display_name)
    .bind(&input.target_task_id)
    .bind(serde_json::to_string(&input.task_order)?)
    .bind(&input.current_task_id)
    .bind(input.current_task_index)
    .bind(input.pause_requested)
    .bind(input.stop_requested)
    .bind(&input.error_message)
    .bind(now)
    .bind(started_at)
    .bind(now)
    .bind(input.finished_at)
    .bind(&color)
    .bind(&input.group_id)
    .bind(input.queued_task_count)
    .bind(input.executing_task_count)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    get_workflow_run(pool, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to reload workflow run after insert"))
}

pub async fn update_workflow_run_record(
    pool: &Pool<Sqlite>,
    run_id: &str,
    input: UpdateWorkflowRunRecord,
) -> ApiResult<Option<WorkflowRun>> {
    let now = Utc::now().timestamp();

    macro_rules! update_field {
        ($value:expr, $column:expr) => {
            if let Some(value) = $value {
                sqlx::query(&format!(
                    "UPDATE workflow_runs SET {} = ?, updated_at = ? WHERE id = ?",
                    $column
                ))
                .bind(value)
                .bind(now)
                .bind(run_id)
                .execute(pool)
                .await
                .map_err(ApiError::Database)?;
            }
        };
    }

    update_field!(input.status, "status");
    update_field!(input.display_name, "display_name");
    update_field!(input.current_task_index, "current_task_index");
    update_field!(input.pause_requested, "pause_requested");
    update_field!(input.stop_requested, "stop_requested");
    update_field!(input.is_archived, "is_archived");

    if let Some(value) = input.target_task_id {
        sqlx::query("UPDATE workflow_runs SET target_task_id = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.task_order {
        sqlx::query("UPDATE workflow_runs SET task_order = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&value)?)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.current_task_id {
        sqlx::query("UPDATE workflow_runs SET current_task_id = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.error_message {
        sqlx::query("UPDATE workflow_runs SET error_message = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.finished_at {
        sqlx::query("UPDATE workflow_runs SET finished_at = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.archived_at {
        sqlx::query("UPDATE workflow_runs SET archived_at = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.group_id {
        sqlx::query("UPDATE workflow_runs SET group_id = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.queued_task_count {
        sqlx::query("UPDATE workflow_runs SET queued_task_count = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.executing_task_count {
        sqlx::query(
            "UPDATE workflow_runs SET executing_task_count = ?, updated_at = ? WHERE id = ?",
        )
        .bind(value)
        .bind(now)
        .bind(run_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }

    get_workflow_run(pool, run_id).await
}

pub async fn get_task_run_record(pool: &Pool<Sqlite>, run_id: &str) -> ApiResult<Option<TaskRun>> {
    let run = sqlx::query_as::<_, TaskRun>(
        r#"
        SELECT * FROM task_runs WHERE id = ?
        "#,
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(run)
}

pub async fn create_task_run_record(
    pool: &Pool<Sqlite>,
    input: CreateTaskRunRecord,
) -> ApiResult<TaskRun> {
    let now = Utc::now().timestamp();
    let id = input
        .id
        .unwrap_or_else(|| Uuid::new_v4().to_string()[..8].to_string());
    let created_at = input.created_at.unwrap_or(now);

    sqlx::query(
        r#"
        INSERT INTO task_runs (
            id, task_id, phase, slot_index, attempt_index, model, task_suffix,
            status, session_id, session_url, worktree_dir, summary, error_message,
            candidate_id, metadata_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.task_id)
    .bind(input.phase)
    .bind(input.slot_index)
    .bind(input.attempt_index)
    .bind(&input.model)
    .bind(&input.task_suffix)
    .bind(input.status)
    .bind(&input.session_id)
    .bind(&input.session_url)
    .bind(&input.worktree_dir)
    .bind(&input.summary)
    .bind(&input.error_message)
    .bind(&input.candidate_id)
    .bind(
        input
            .metadata_json
            .map(|value| value.to_string())
            .unwrap_or_else(|| "{}".to_string()),
    )
    .bind(created_at)
    .bind(now)
    .bind(input.completed_at)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    get_task_run_record(pool, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to reload task run after insert"))
}

pub async fn update_task_run_record(
    pool: &Pool<Sqlite>,
    run_id: &str,
    input: UpdateTaskRunRecord,
) -> ApiResult<Option<TaskRun>> {
    let now = Utc::now().timestamp();

    macro_rules! update_field {
        ($value:expr, $column:expr) => {
            if let Some(value) = $value {
                sqlx::query(&format!(
                    "UPDATE task_runs SET {} = ?, updated_at = ? WHERE id = ?",
                    $column
                ))
                .bind(value)
                .bind(now)
                .bind(run_id)
                .execute(pool)
                .await
                .map_err(ApiError::Database)?;
            }
        };
    }

    update_field!(input.status, "status");

    if let Some(value) = input.session_id {
        sqlx::query("UPDATE task_runs SET session_id = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.session_url {
        sqlx::query("UPDATE task_runs SET session_url = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.worktree_dir {
        sqlx::query("UPDATE task_runs SET worktree_dir = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.summary {
        sqlx::query("UPDATE task_runs SET summary = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.error_message {
        sqlx::query("UPDATE task_runs SET error_message = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.candidate_id {
        sqlx::query("UPDATE task_runs SET candidate_id = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.metadata_json {
        let metadata = value
            .map(|payload| payload.to_string())
            .unwrap_or_else(|| "{}".to_string());
        sqlx::query("UPDATE task_runs SET metadata_json = ?, updated_at = ? WHERE id = ?")
            .bind(metadata)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.completed_at {
        sqlx::query("UPDATE task_runs SET completed_at = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(run_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    get_task_run_record(pool, run_id).await
}

pub async fn create_workflow_session_record(
    pool: &Pool<Sqlite>,
    input: CreateWorkflowSessionRecord,
) -> ApiResult<PiWorkflowSession> {
    let now = Utc::now().timestamp();
    let id = input
        .id
        .unwrap_or_else(|| Uuid::new_v4().to_string()[..8].to_string());
    let started_at = input.started_at.unwrap_or(now);
    let name = input
        .name
        .unwrap_or_else(|| format!("Session {}", &id[..4]));

    sqlx::query(
        r#"
        INSERT INTO pi_workflow_sessions (
            id, task_id, task_run_id, session_kind, status, cwd, worktree_dir,
            branch, pi_session_id, pi_session_file, process_pid, model,
            thinking_level, started_at, updated_at, finished_at, exit_code,
            exit_signal, error_message, name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.task_id)
    .bind(&input.task_run_id)
    .bind(input.session_kind)
    .bind(input.status)
    .bind(&input.cwd)
    .bind(&input.worktree_dir)
    .bind(&input.branch)
    .bind(&input.pi_session_id)
    .bind(&input.pi_session_file)
    .bind(input.process_pid)
    .bind(&input.model)
    .bind(input.thinking_level)
    .bind(started_at)
    .bind(now)
    .bind(input.finished_at)
    .bind(input.exit_code)
    .bind(&input.exit_signal)
    .bind(&input.error_message)
    .bind(&name)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    get_workflow_session(pool, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to reload workflow session after insert"))
}

pub async fn update_workflow_session_record(
    pool: &Pool<Sqlite>,
    session_id: &str,
    input: UpdateWorkflowSessionRecord,
) -> ApiResult<Option<PiWorkflowSession>> {
    let now = Utc::now().timestamp();

    macro_rules! update_field {
        ($value:expr, $column:expr) => {
            if let Some(value) = $value {
                sqlx::query(&format!(
                    "UPDATE pi_workflow_sessions SET {} = ?, updated_at = ? WHERE id = ?",
                    $column
                ))
                .bind(value)
                .bind(now)
                .bind(session_id)
                .execute(pool)
                .await
                .map_err(ApiError::Database)?;
            }
        };
    }

    update_field!(input.status, "status");
    update_field!(input.cwd, "cwd");
    update_field!(input.model, "model");
    update_field!(input.thinking_level, "thinking_level");

    if let Some(value) = input.worktree_dir {
        sqlx::query(
            "UPDATE pi_workflow_sessions SET worktree_dir = ?, updated_at = ? WHERE id = ?",
        )
        .bind(value)
        .bind(now)
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.branch {
        sqlx::query("UPDATE pi_workflow_sessions SET branch = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.pi_session_id {
        sqlx::query(
            "UPDATE pi_workflow_sessions SET pi_session_id = ?, updated_at = ? WHERE id = ?",
        )
        .bind(value)
        .bind(now)
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.pi_session_file {
        sqlx::query(
            "UPDATE pi_workflow_sessions SET pi_session_file = ?, updated_at = ? WHERE id = ?",
        )
        .bind(value)
        .bind(now)
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.process_pid {
        sqlx::query("UPDATE pi_workflow_sessions SET process_pid = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.finished_at {
        sqlx::query("UPDATE pi_workflow_sessions SET finished_at = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.exit_code {
        sqlx::query("UPDATE pi_workflow_sessions SET exit_code = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.exit_signal {
        sqlx::query("UPDATE pi_workflow_sessions SET exit_signal = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.error_message {
        sqlx::query(
            "UPDATE pi_workflow_sessions SET error_message = ?, updated_at = ? WHERE id = ?",
        )
        .bind(value)
        .bind(now)
        .bind(session_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }

    if let Some(value) = input.name {
        sqlx::query("UPDATE pi_workflow_sessions SET name = ?, updated_at = ? WHERE id = ?")
            .bind(value)
            .bind(now)
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    get_workflow_session(pool, session_id).await
}
