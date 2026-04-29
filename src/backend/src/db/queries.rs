use crate::db::models::*;
use crate::error::{ApiError, ApiResult};
use crate::orchestrator::isolation;
use chrono::Utc;
use sqlx::{Pool, Sqlite};
use uuid::Uuid;

// ============================================================================
// Task Queries
// ============================================================================

pub async fn get_tasks(pool: &Pool<Sqlite>) -> ApiResult<Vec<Task>> {
    let tasks = sqlx::query_as::<_, Task>(
        r#"
        SELECT * FROM tasks WHERE is_archived = 0 ORDER BY idx ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(tasks)
}

pub async fn get_task(pool: &Pool<Sqlite>, task_id: &str) -> ApiResult<Option<Task>> {
    let task = sqlx::query_as::<_, Task>(
        r#"
        SELECT * FROM tasks WHERE id = ? AND is_archived = 0
        "#,
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(task)
}

pub async fn get_archived_task(pool: &Pool<Sqlite>, task_id: &str) -> ApiResult<Option<Task>> {
    let task = sqlx::query_as::<_, Task>(
        r#"
        SELECT * FROM tasks WHERE id = ? AND is_archived = 1
        "#,
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(task)
}

pub async fn get_tasks_by_status(pool: &Pool<Sqlite>, status: TaskStatus) -> ApiResult<Vec<Task>> {
    let tasks = sqlx::query_as::<_, Task>(
        r#"
        SELECT * FROM tasks WHERE status = ? AND is_archived = 0
        "#,
    )
    .bind(status)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(tasks)
}

pub async fn create_task_db(pool: &Pool<Sqlite>, input: CreateTaskInput) -> ApiResult<Task> {
    let now = Utc::now().timestamp();
    let id = input
        .id
        .unwrap_or_else(|| Uuid::new_v4().to_string()[..8].to_string());

    // Get next idx
    let max_idx: i32 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(MAX(idx), -1) + 1 FROM tasks WHERE is_archived = 0
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    let requirements_json = input
        .requirements
        .map(|r| serde_json::to_string(&r).unwrap_or_default())
        .unwrap_or_else(|| "[]".to_string());

    let best_of_n_config_json = input
        .best_of_n_config
        .map(|c| serde_json::to_string(&c).unwrap_or_default());

    if let Some(grants) = input.additional_agent_access.as_ref() {
        isolation::validate_extra_grants(grants)?;
    }

    let additional_access_json = input
        .additional_agent_access
        .as_ref()
        .map(|grants| serde_json::to_string(grants).unwrap_or_default());

    sqlx::query(
        r#"
        INSERT INTO tasks (
            id, name, idx, prompt, status, branch, plan_model, execution_model,
            planmode, auto_approve_plan, review, code_style_review, auto_commit, auto_deploy,
            auto_deploy_condition, delete_worktree, requirements, agent_output,
            thinking_level, plan_thinking_level, execution_thinking_level,
            execution_strategy, best_of_n_config, best_of_n_substage,
            skip_permission_asking, max_review_runs_override, additional_agent_access, group_id,
            created_at, updated_at, self_heal_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.name)
    .bind(max_idx)
    .bind(&input.prompt)
    .bind(input.status.unwrap_or(TaskStatus::Backlog))
    .bind(&input.branch)
    .bind(&input.plan_model)
    .bind(&input.execution_model)
    .bind(input.plan_mode.unwrap_or(false) as i32)
    .bind(input.auto_approve_plan.unwrap_or(false) as i32)
    .bind(input.review.unwrap_or(false) as i32)
    .bind(input.code_style_review.unwrap_or(false) as i32)
    .bind(input.auto_commit.unwrap_or(false) as i32)
    .bind(input.auto_deploy.unwrap_or(false) as i32)
    .bind(input.auto_deploy_condition)
    .bind(input.delete_worktree.unwrap_or(false) as i32)
    .bind(requirements_json)
    .bind(input.thinking_level.unwrap_or(ThinkingLevel::Default))
    .bind(input.plan_thinking_level.unwrap_or(ThinkingLevel::Default))
    .bind(input.execution_thinking_level.unwrap_or(ThinkingLevel::Default))
    .bind(input.execution_strategy.unwrap_or(ExecutionStrategy::Standard))
    .bind(best_of_n_config_json)
    .bind(input.best_of_n_substage.unwrap_or(BestOfNSubstage::Idle))
    .bind(input.skip_permission_asking.unwrap_or(false) as i32)
    .bind(input.max_review_runs_override)
    .bind(&additional_access_json)
    .bind(&input.group_id)
    .bind(now)
    .bind(now)
    .bind(SelfHealStatus::Idle)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    get_task(pool, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to create task"))
}

pub async fn update_task(
    pool: &Pool<Sqlite>,
    task_id: &str,
    input: UpdateTaskInput,
) -> ApiResult<Option<Task>> {
    let now = Utc::now().timestamp();

    // Execute individual field updates for each provided field
    // This is less efficient than a single UPDATE but is type-safe

    macro_rules! update_field {
        ($field:expr, $column:expr) => {
            if let Some(val) = $field {
                sqlx::query(&format!(
                    "UPDATE tasks SET {} = ?, updated_at = ? WHERE id = ?",
                    $column
                ))
                .bind(val)
                .bind(now)
                .bind(task_id)
                .execute(pool)
                .await
                .map_err(ApiError::Database)?;
            }
        };
    }

    update_field!(input.name, "name");
    update_field!(input.prompt, "prompt");
    update_field!(input.status, "status");
    update_field!(input.branch, "branch");
    update_field!(input.plan_model, "plan_model");
    update_field!(input.execution_model, "execution_model");
    update_field!(input.plan_mode, "planmode");
    update_field!(input.auto_approve_plan, "auto_approve_plan");
    update_field!(input.review, "review");
    update_field!(input.auto_commit, "auto_commit");
    update_field!(input.auto_deploy, "auto_deploy");
    update_field!(input.auto_deploy_condition, "auto_deploy_condition");
    update_field!(input.delete_worktree, "delete_worktree");

    if let Some(reqs) = input.requirements {
        sqlx::query("UPDATE tasks SET requirements = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&reqs).unwrap_or_default())
            .bind(now)
            .bind(task_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    update_field!(input.agent_output, "agent_output");
    update_field!(input.session_id, "session_id");
    update_field!(input.session_url, "session_url");
    update_field!(input.worktree_dir, "worktree_dir");
    update_field!(input.error_message, "error_message");
    update_field!(input.review_count, "review_count");
    update_field!(input.json_parse_retry_count, "json_parse_retry_count");
    update_field!(input.completed_at, "completed_at");
    update_field!(input.thinking_level, "thinking_level");
    update_field!(input.plan_thinking_level, "plan_thinking_level");
    update_field!(input.execution_thinking_level, "execution_thinking_level");
    update_field!(input.execution_phase, "execution_phase");
    update_field!(input.awaiting_plan_approval, "awaiting_plan_approval");
    update_field!(input.plan_revision_count, "plan_revision_count");
    update_field!(input.execution_strategy, "execution_strategy");

    if let Some(config) = input.best_of_n_config {
        sqlx::query("UPDATE tasks SET best_of_n_config = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&config).unwrap_or_default())
            .bind(now)
            .bind(task_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    update_field!(input.best_of_n_substage, "best_of_n_substage");
    update_field!(input.skip_permission_asking, "skip_permission_asking");
    update_field!(input.max_review_runs_override, "max_review_runs_override");
    update_field!(input.smart_repair_hints, "smart_repair_hints");
    update_field!(input.review_activity, "review_activity");
    update_field!(input.is_archived, "is_archived");
    update_field!(input.archived_at, "archived_at");
    update_field!(input.code_style_review, "code_style_review");

    if let Some(grants) = input.additional_agent_access {
        let additional_access_json = match grants {
            Some(grants) => {
                isolation::validate_extra_grants(&grants)?;
                Some(serde_json::to_string(&grants).unwrap_or_default())
            }
            None => None,
        };

        sqlx::query("UPDATE tasks SET additional_agent_access = ?, updated_at = ? WHERE id = ?")
            .bind(additional_access_json)
            .bind(now)
            .bind(task_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }
    update_field!(input.group_id, "group_id");
    update_field!(input.self_heal_status, "self_heal_status");
    update_field!(input.self_heal_message, "self_heal_message");
    update_field!(input.self_heal_report_id, "self_heal_report_id");

    get_task(pool, task_id).await
}

pub async fn archive_task(pool: &Pool<Sqlite>, task_id: &str) -> ApiResult<()> {
    let now = Utc::now().timestamp();

    sqlx::query(
        r#"
        UPDATE tasks SET is_archived = 1, archived_at = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(task_id)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(())
}

pub async fn hard_delete_task(pool: &Pool<Sqlite>, task_id: &str) -> ApiResult<()> {
    sqlx::query(r#"DELETE FROM tasks WHERE id = ?"#)
        .bind(task_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;

    Ok(())
}

pub async fn has_task_execution_history(pool: &Pool<Sqlite>, task_id: &str) -> ApiResult<bool> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM task_runs WHERE task_id = ?
        "#,
    )
    .bind(task_id)
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(count > 0)
}

pub async fn reorder_task(pool: &Pool<Sqlite>, task_id: &str, new_idx: i32) -> ApiResult<()> {
    sqlx::query(
        r#"
        UPDATE tasks SET idx = ?, updated_at = ? WHERE id = ?
        "#,
    )
    .bind(new_idx)
    .bind(Utc::now().timestamp())
    .bind(task_id)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(())
}

pub async fn get_active_workflow_run_for_task(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<Option<WorkflowRun>> {
    let run = sqlx::query_as::<_, WorkflowRun>(
        r#"
        SELECT wr.* FROM workflow_runs wr
        JOIN task_runs tr ON tr.session_id IN (
            SELECT id FROM pi_workflow_sessions WHERE task_id = ?
        )
        WHERE wr.status IN ('queued', 'running', 'paused')
        AND wr.is_archived = 0
        LIMIT 1
        "#,
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(run)
}

// ============================================================================
// Task Group Queries
// ============================================================================

pub async fn get_task_groups(pool: &Pool<Sqlite>) -> ApiResult<Vec<TaskGroup>> {
    let groups = sqlx::query_as::<_, TaskGroup>(
        r#"
        SELECT * FROM task_groups ORDER BY created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    // Load task_ids for each group
    let mut result = vec![];
    for mut group in groups {
        let task_ids: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT task_id FROM task_group_members
            WHERE group_id = ? ORDER BY idx ASC
            "#,
        )
        .bind(&group.id)
        .fetch_all(pool)
        .await
        .map_err(ApiError::Database)?;

        group.task_ids = task_ids;
        result.push(group);
    }

    Ok(result)
}

pub async fn get_task_group(pool: &Pool<Sqlite>, group_id: &str) -> ApiResult<Option<TaskGroup>> {
    let mut group = sqlx::query_as::<_, TaskGroup>(
        r#"
        SELECT * FROM task_groups WHERE id = ?
        "#,
    )
    .bind(group_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    if let Some(ref mut g) = group {
        let task_ids: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT task_id FROM task_group_members
            WHERE group_id = ? ORDER BY idx ASC
            "#,
        )
        .bind(&g.id)
        .fetch_all(pool)
        .await
        .map_err(ApiError::Database)?;

        g.task_ids = task_ids;
    }

    Ok(group)
}

pub async fn create_task_group(
    pool: &Pool<Sqlite>,
    name: &str,
    color: Option<String>,
    member_task_ids: Vec<String>,
) -> ApiResult<TaskGroup> {
    let now = Utc::now().timestamp();
    let id = Uuid::new_v4().to_string()[..8].to_string();
    let color = color.unwrap_or_else(|| "#888888".to_string());

    sqlx::query(
        r#"
        INSERT INTO task_groups (id, name, color, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(name)
    .bind(&color)
    .bind(TaskGroupStatus::Active)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    // Add member tasks
    for (idx, task_id) in member_task_ids.iter().enumerate() {
        sqlx::query(
            r#"
            INSERT INTO task_group_members (group_id, task_id, idx, added_at)
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(task_id)
        .bind(idx as i32)
        .bind(now)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }

    get_task_group(pool, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to create task group"))
}

pub async fn update_task_group(
    pool: &Pool<Sqlite>,
    group_id: &str,
    name: Option<String>,
    color: Option<String>,
    status: Option<TaskGroupStatus>,
) -> ApiResult<Option<TaskGroup>> {
    let now = Utc::now().timestamp();

    if let Some(name) = name {
        sqlx::query(r#"UPDATE task_groups SET name = ? WHERE id = ?"#)
            .bind(name)
            .bind(group_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(color) = color {
        sqlx::query(r#"UPDATE task_groups SET color = ? WHERE id = ?"#)
            .bind(color)
            .bind(group_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    if let Some(status) = status {
        let completed_at = if status == TaskGroupStatus::Completed {
            Some(now)
        } else {
            None
        };

        sqlx::query(
            r#"
            UPDATE task_groups 
            SET status = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(status)
        .bind(completed_at)
        .bind(now)
        .bind(group_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }

    get_task_group(pool, group_id).await
}

pub async fn delete_task_group(pool: &Pool<Sqlite>, group_id: &str) -> ApiResult<bool> {
    // Delete members first
    sqlx::query(r#"DELETE FROM task_group_members WHERE group_id = ?"#)
        .bind(group_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;

    let result = sqlx::query(r#"DELETE FROM task_groups WHERE id = ?"#)
        .bind(group_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;

    Ok(result.rows_affected() > 0)
}

pub async fn add_task_to_group(
    pool: &Pool<Sqlite>,
    group_id: &str,
    task_id: &str,
) -> ApiResult<()> {
    let now = Utc::now().timestamp();

    // Get next idx
    let max_idx: i32 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(MAX(idx), -1) + 1 FROM task_group_members WHERE group_id = ?
        "#,
    )
    .bind(group_id)
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO task_group_members (group_id, task_id, idx, added_at)
        VALUES (?, ?, ?, ?)
        "#,
    )
    .bind(group_id)
    .bind(task_id)
    .bind(max_idx)
    .bind(now)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    // Update task's group_id
    sqlx::query(r#"UPDATE tasks SET group_id = ? WHERE id = ?"#)
        .bind(group_id)
        .bind(task_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;

    Ok(())
}

pub async fn add_tasks_to_group(
    pool: &Pool<Sqlite>,
    group_id: &str,
    task_ids: Vec<String>,
) -> ApiResult<i32> {
    let now = Utc::now().timestamp();

    let mut added = 0;
    for task_id in task_ids {
        let max_idx: i32 = sqlx::query_scalar(
            r#"
            SELECT COALESCE(MAX(idx), -1) + 1 FROM task_group_members WHERE group_id = ?
            "#,
        )
        .bind(group_id)
        .fetch_one(pool)
        .await
        .map_err(ApiError::Database)?;

        let result = sqlx::query(
            r#"
            INSERT INTO task_group_members (group_id, task_id, idx, added_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id, task_id) DO NOTHING
            "#,
        )
        .bind(group_id)
        .bind(&task_id)
        .bind(max_idx)
        .bind(now)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;

        if result.rows_affected() > 0 {
            added += 1;
            // Update task's group_id
            sqlx::query(r#"UPDATE tasks SET group_id = ? WHERE id = ?"#)
                .bind(group_id)
                .bind(&task_id)
                .execute(pool)
                .await
                .map_err(ApiError::Database)?;
        }
    }

    Ok(added)
}

pub async fn remove_task_from_group(
    pool: &Pool<Sqlite>,
    group_id: &str,
    task_id: &str,
) -> ApiResult<bool> {
    let result = sqlx::query(
        r#"
        DELETE FROM task_group_members WHERE group_id = ? AND task_id = ?
        "#,
    )
    .bind(group_id)
    .bind(task_id)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    if result.rows_affected() > 0 {
        // Clear task's group_id
        sqlx::query(r#"UPDATE tasks SET group_id = NULL WHERE id = ?"#)
            .bind(task_id)
            .execute(pool)
            .await
            .map_err(ApiError::Database)?;
    }

    Ok(result.rows_affected() > 0)
}

pub async fn remove_tasks_from_group(
    pool: &Pool<Sqlite>,
    group_id: &str,
    task_ids: &[String],
) -> ApiResult<i32> {
    let mut removed = 0;

    for task_id in task_ids {
        let result = sqlx::query(
            r#"
            DELETE FROM task_group_members WHERE group_id = ? AND task_id = ?
            "#,
        )
        .bind(group_id)
        .bind(task_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;

        if result.rows_affected() > 0 {
            removed += 1;
            // Clear task's group_id
            sqlx::query(r#"UPDATE tasks SET group_id = NULL WHERE id = ?"#)
                .bind(task_id)
                .execute(pool)
                .await
                .map_err(ApiError::Database)?;
        }
    }

    Ok(removed)
}

pub async fn get_task_group_membership(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<(Option<String>, Option<TaskGroup>)> {
    let task = get_task(pool, task_id).await?;

    if let Some(task) = task {
        if let Some(group_id) = &task.group_id {
            let group = get_task_group(pool, group_id).await?;
            return Ok((Some(group_id.clone()), group));
        }
    }

    Ok((None, None))
}

// ============================================================================
// Workflow Run Queries
// ============================================================================

pub async fn get_workflow_runs(pool: &Pool<Sqlite>) -> ApiResult<Vec<WorkflowRun>> {
    let runs = sqlx::query_as::<_, WorkflowRun>(
        r#"
        SELECT * FROM workflow_runs WHERE is_archived = 0 ORDER BY created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(runs)
}

pub async fn get_workflow_run(pool: &Pool<Sqlite>, run_id: &str) -> ApiResult<Option<WorkflowRun>> {
    let run = sqlx::query_as::<_, WorkflowRun>(
        r#"
        SELECT * FROM workflow_runs WHERE id = ?
        "#,
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(run)
}

pub async fn has_running_workflows(pool: &Pool<Sqlite>) -> ApiResult<bool> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM workflow_runs 
        WHERE status IN ('queued', 'running', 'paused') AND is_archived = 0
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(count > 0)
}

// ============================================================================
// Session Queries
// ============================================================================

pub async fn get_workflow_session(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> ApiResult<Option<PiWorkflowSession>> {
    let session = sqlx::query_as::<_, PiWorkflowSession>(
        r#"
        SELECT * FROM pi_workflow_sessions WHERE id = ?
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(session)
}

pub async fn get_workflow_sessions_by_task(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<Vec<PiWorkflowSession>> {
    let sessions = sqlx::query_as::<_, PiWorkflowSession>(
        r#"
        SELECT * FROM pi_workflow_sessions WHERE task_id = ? ORDER BY started_at DESC
        "#,
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(sessions)
}

pub async fn get_session_messages_db(
    pool: &Pool<Sqlite>,
    session_id: &str,
    limit: i32,
    offset: i32,
) -> ApiResult<Vec<SessionMessage>> {
    let messages = sqlx::query_as::<_, SessionMessage>(
        r#"
        SELECT * FROM session_messages 
        WHERE session_id = ? 
        ORDER BY seq ASC
        LIMIT ? OFFSET ?
        "#,
    )
    .bind(session_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(messages)
}

pub async fn get_session_messages_for_task(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<Vec<SessionMessage>> {
    let messages = sqlx::query_as::<_, SessionMessage>(
        r#"
        SELECT
            sm.id,
            sm.seq,
            sm.message_id,
            sm.session_id,
            COALESCE(sm.task_id, ws.task_id) AS task_id,
            COALESCE(sm.task_run_id, ws.task_run_id) AS task_run_id,
            sm.timestamp,
            sm.role,
            sm.event_name,
            sm.message_type,
            sm.content_json,
            sm.model_provider,
            sm.model_id,
            sm.agent_name,
            sm.prompt_tokens,
            sm.completion_tokens,
            sm.cache_read_tokens,
            sm.cache_write_tokens,
            sm.total_tokens,
            sm.cost_json,
            sm.cost_total,
            sm.tool_call_id,
            sm.tool_name,
            sm.tool_args_json,
            sm.tool_result_json,
            sm.tool_status,
            sm.edit_diff,
            sm.edit_file_path,
            sm.session_status,
            sm.workflow_phase,
            sm.raw_event_json
        FROM session_messages sm
        LEFT JOIN pi_workflow_sessions ws ON ws.id = sm.session_id
        WHERE COALESCE(sm.task_id, ws.task_id) = ?
        ORDER BY sm.seq ASC, sm.id ASC
        "#,
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(messages)
}

pub async fn create_session_message(
    pool: &Pool<Sqlite>,
    message: &SessionMessage,
) -> ApiResult<SessionMessage> {
    let inserted = sqlx::query_as::<_, SessionMessage>(
        r#"
        INSERT INTO session_messages (
            seq, message_id, session_id, task_id, task_run_id, timestamp,
            role, event_name, message_type, content_json, model_provider, model_id,
            agent_name, prompt_tokens, completion_tokens, cache_read_tokens,
            cache_write_tokens, total_tokens, cost_json, cost_total, tool_call_id,
            tool_name, tool_args_json, tool_result_json, tool_status, edit_diff,
            edit_file_path, session_status, workflow_phase, raw_event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
        "#,
    )
    .bind(message.seq)
    .bind(&message.message_id)
    .bind(&message.session_id)
    .bind(&message.task_id)
    .bind(&message.task_run_id)
    .bind(message.timestamp)
    .bind(message.role)
    .bind(&message.event_name)
    .bind(message.message_type)
    .bind(&message.content_json)
    .bind(&message.model_provider)
    .bind(&message.model_id)
    .bind(&message.agent_name)
    .bind(message.prompt_tokens)
    .bind(message.completion_tokens)
    .bind(message.cache_read_tokens)
    .bind(message.cache_write_tokens)
    .bind(message.total_tokens)
    .bind(&message.cost_json)
    .bind(message.cost_total)
    .bind(&message.tool_call_id)
    .bind(&message.tool_name)
    .bind(&message.tool_args_json)
    .bind(&message.tool_result_json)
    .bind(&message.tool_status)
    .bind(&message.edit_diff)
    .bind(&message.edit_file_path)
    .bind(&message.session_status)
    .bind(&message.workflow_phase)
    .bind(&message.raw_event_json)
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(inserted)
}

// ============================================================================
// Options Queries
// ============================================================================

pub async fn get_options(pool: &Pool<Sqlite>) -> ApiResult<Options> {
    let options = sqlx::query_as::<_, Options>(
        r#"
        SELECT * FROM options WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(options)
}

// ============================================================================
// Task Candidate Queries
// ============================================================================

pub async fn get_task_candidates(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<Vec<TaskCandidate>> {
    let candidates = sqlx::query_as::<_, TaskCandidate>(
        r#"
        SELECT * FROM task_candidates WHERE task_id = ? ORDER BY created_at DESC
        "#,
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(candidates)
}

pub async fn update_task_candidate(
    pool: &Pool<Sqlite>,
    candidate_id: &str,
    status: &str,
) -> ApiResult<Option<TaskCandidate>> {
    let now = Utc::now().timestamp();

    sqlx::query(
        r#"
        UPDATE task_candidates SET status = ?, updated_at = ? WHERE id = ?
        "#,
    )
    .bind(status)
    .bind(now)
    .bind(candidate_id)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    let candidate = sqlx::query_as::<_, TaskCandidate>(
        r#"
        SELECT * FROM task_candidates WHERE id = ?
        "#,
    )
    .bind(candidate_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(candidate)
}

// ============================================================================
// Self-Heal Report Queries
// ============================================================================

pub async fn get_self_heal_reports_for_run(
    pool: &Pool<Sqlite>,
    run_id: &str,
) -> ApiResult<Vec<SelfHealReport>> {
    let reports = sqlx::query_as::<_, SelfHealReport>(
        r#"
        SELECT * FROM self_heal_reports WHERE run_id = ? ORDER BY created_at DESC
        "#,
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(reports)
}

pub async fn get_self_heal_reports_for_task(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<Vec<SelfHealReport>> {
    let reports = sqlx::query_as::<_, SelfHealReport>(
        r#"
        SELECT * FROM self_heal_reports WHERE task_id = ? ORDER BY created_at DESC
        "#,
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(reports)
}

pub async fn get_planning_prompt_versions(
    pool: &Pool<Sqlite>,
    key: &str,
) -> ApiResult<Vec<PlanningPromptVersion>> {
    let versions = sqlx::query_as::<_, PlanningPromptVersion>(
        r#"
        SELECT v.*
        FROM planning_prompt_versions v
        INNER JOIN planning_prompts p ON p.id = v.planning_prompt_id
        WHERE p.key = ?
        ORDER BY v.version ASC
        "#,
    )
    .bind(key)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(versions)
}

// ============================================================================
// Task Run Queries
// ============================================================================

pub async fn get_task_runs(pool: &Pool<Sqlite>, task_id: &str) -> ApiResult<Vec<TaskRun>> {
    let runs = sqlx::query_as::<_, TaskRun>(
        r#"
        SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC
        "#,
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(runs)
}

#[allow(dead_code)]
pub async fn get_task_runs_by_phase(
    pool: &Pool<Sqlite>,
    task_id: &str,
    phase: &str,
) -> ApiResult<Vec<TaskRun>> {
    let runs = sqlx::query_as::<_, TaskRun>(
        r#"
        SELECT * FROM task_runs WHERE task_id = ? AND phase = ? ORDER BY created_at DESC
        "#,
    )
    .bind(task_id)
    .bind(phase)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(runs)
}

pub async fn create_task_candidate(
    pool: &Pool<Sqlite>,
    task_id: &str,
    worker_run_id: &str,
    summary: Option<&str>,
    changed_files_json: Option<&str>,
    diff_stats_json: Option<&str>,
    verification_json: Option<&str>,
) -> ApiResult<TaskCandidate> {
    let now = Utc::now().timestamp();
    let id = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        r#"
        INSERT INTO task_candidates (
            id, task_id, worker_run_id, status, changed_files_json, diff_stats_json,
            verification_json, summary, created_at, updated_at
        ) VALUES (?, ?, ?, 'available', ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(task_id)
    .bind(worker_run_id)
    .bind(changed_files_json)
    .bind(diff_stats_json)
    .bind(verification_json)
    .bind(summary)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    let candidate = sqlx::query_as::<_, TaskCandidate>(
        r#"
        SELECT * FROM task_candidates WHERE id = ?
        "#,
    )
    .bind(&id)
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(candidate)
}
