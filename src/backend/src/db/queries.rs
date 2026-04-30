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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

pub async fn claim_task_for_execution(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<Option<Task>> {
    let now = Utc::now().timestamp();
    let result = sqlx::query(
        r#"
        UPDATE tasks
        SET status = ?, error_message = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ? AND status = ? AND is_archived = 0
        "#,
    )
    .bind(TaskStatus::Executing)
    .bind(now)
    .bind(task_id)
    .bind(TaskStatus::Queued)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

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
        SELECT COUNT(*) FROM (
            SELECT 1 FROM task_runs WHERE task_id = ?
            UNION ALL
            SELECT 1 FROM pi_workflow_sessions WHERE task_id = ?
            UNION ALL
            SELECT 1 FROM session_messages WHERE task_id = ?
            UNION ALL
            SELECT 1 FROM session_messages sm
            INNER JOIN pi_workflow_sessions ws ON ws.id = sm.session_id
            WHERE ws.task_id = ?
        )
        "#,
    )
    .bind(task_id)
    .bind(task_id)
    .bind(task_id)
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
        add_task_to_group(pool, &id, task_id).await?;

        sqlx::query(
            r#"
            UPDATE task_group_members SET idx = ?, added_at = ?
            WHERE group_id = ? AND task_id = ?
            "#,
        )
        .bind(idx as i32)
        .bind(now)
        .bind(&id)
        .bind(task_id)
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
    sqlx::query(r#"UPDATE tasks SET group_id = NULL WHERE group_id = ?"#)
        .bind(group_id)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;

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

pub async fn fix_stale_workflow_runs(pool: &Pool<Sqlite>) -> ApiResult<usize> {
    let now = Utc::now().timestamp();
    let error_msg = "Server restarted while this run was in progress. Run has been marked as failed.";
    let result = sqlx::query(
        r#"
        UPDATE workflow_runs SET
            status = 'failed',
            error_message = ?,
            updated_at = ?,
            finished_at = ?
        WHERE status IN ('queued', 'running', 'paused', 'stopping')
        "#,
    )
    .bind(error_msg)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(ApiError::Database)?;

    let count = result.rows_affected() as usize;
    if count > 0 {
        tracing::info!("Fixed {} stale workflow run(s) on startup", count);
    }
    Ok(count)
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
    .fetch_optional(pool)
    .await
    .map_err(ApiError::Database)?;

    match options {
        Some(opts) => Ok(opts),
        None => {
            sqlx::query("INSERT OR IGNORE INTO options (id) VALUES (1)")
                .execute(pool)
                .await
                .map_err(ApiError::Database)?;

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
    }
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

pub async fn get_task_diffs(
    pool: &Pool<Sqlite>,
    task_id: &str,
) -> ApiResult<Vec<TaskDiff>> {
    let diffs = sqlx::query_as::<_, TaskDiff>(
        r#"
        SELECT * FROM task_diffs WHERE task_id = ? ORDER BY captured_at ASC, file_path ASC
        "#,
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(diffs)
}

pub async fn insert_task_diffs(
    pool: &Pool<Sqlite>,
    task_id: &str,
    run_id: Option<&str>,
    capture_phase: &str,
    diffs: &[(String, String)],
) -> ApiResult<()> {
    let now = Utc::now().timestamp();
    for (file_path, diff_content) in diffs {
        sqlx::query(
            r#"
            INSERT INTO task_diffs (task_id, run_id, capture_phase, file_path, diff_content, captured_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(task_id)
        .bind(run_id)
        .bind(capture_phase)
        .bind(file_path)
        .bind(diff_content)
        .bind(now)
        .execute(pool)
        .await
        .map_err(ApiError::Database)?;
    }
    Ok(())
}

pub async fn create_task_candidate(
    pool: &Pool<Sqlite>,
    task_id: &str,
    worker_run_id: &str,
    changed_files_json: Option<&str>,
    diff_stats_json: Option<&str>,
    verification_json: Option<&str>,
    summary: Option<&str>,
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

// ============================================================================
// Regression Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    /// Create an in-memory SQLite pool with just the tasks table.
    async fn create_test_pool() -> Pool<Sqlite> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        // Create the tasks table (full schema matching production)
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                idx INTEGER NOT NULL DEFAULT 0,
                prompt TEXT NOT NULL,
                branch TEXT,
                plan_model TEXT,
                execution_model TEXT,
                planmode INTEGER NOT NULL DEFAULT 0,
                auto_approve_plan INTEGER NOT NULL DEFAULT 0,
                review INTEGER NOT NULL DEFAULT 0,
                auto_commit INTEGER NOT NULL DEFAULT 0,
                auto_deploy INTEGER NOT NULL DEFAULT 0,
                auto_deploy_condition TEXT,
                delete_worktree INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'backlog',
                requirements TEXT,
                agent_output TEXT NOT NULL DEFAULT '',
                review_count INTEGER NOT NULL DEFAULT 0,
                json_parse_retry_count INTEGER NOT NULL DEFAULT 0,
                session_id TEXT,
                session_url TEXT,
                worktree_dir TEXT,
                error_message TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                thinking_level TEXT NOT NULL DEFAULT 'default',
                plan_thinking_level TEXT NOT NULL DEFAULT 'default',
                execution_thinking_level TEXT NOT NULL DEFAULT 'default',
                execution_phase TEXT NOT NULL DEFAULT 'not_started',
                awaiting_plan_approval INTEGER NOT NULL DEFAULT 0,
                plan_revision_count INTEGER NOT NULL DEFAULT 0,
                execution_strategy TEXT NOT NULL DEFAULT 'standard',
                best_of_n_config TEXT,
                best_of_n_substage TEXT NOT NULL DEFAULT 'idle',
                skip_permission_asking INTEGER NOT NULL DEFAULT 0,
                max_review_runs_override INTEGER,
                smart_repair_hints TEXT,
                review_activity TEXT NOT NULL DEFAULT 'idle',
                is_archived INTEGER NOT NULL DEFAULT 0,
                archived_at INTEGER,
                additional_agent_access TEXT,
                code_style_review INTEGER NOT NULL DEFAULT 0,
                group_id TEXT,
                self_heal_status TEXT NOT NULL DEFAULT 'idle',
                self_heal_message TEXT,
                self_heal_report_id TEXT
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        pool
    }

    #[tokio::test]
    async fn test_create_task_minimal() {
        let pool = create_test_pool().await;

        let input = CreateTaskInput {
            id: None,
            name: "Test Task".to_string(),
            prompt: "Do the thing".to_string(),
            status: None,
            branch: None,
            plan_model: None,
            execution_model: None,
            plan_mode: None,
            auto_approve_plan: None,
            review: None,
            code_style_review: None,
            auto_commit: None,
            auto_deploy: None,
            auto_deploy_condition: None,
            delete_worktree: None,
            requirements: None,
            thinking_level: None,
            plan_thinking_level: None,
            execution_thinking_level: None,
            execution_strategy: None,
            best_of_n_config: None,
            best_of_n_substage: None,
            skip_permission_asking: None,
            max_review_runs_override: None,
            group_id: None,
            additional_agent_access: None,
        };

        let task = create_task_db(&pool, input).await.unwrap();
        assert_eq!(task.name, "Test Task");
        assert_eq!(task.prompt, "Do the thing");
        assert_eq!(task.status, TaskStatus::Backlog);
        assert_eq!(task.agent_output, "");
    }

    #[tokio::test]
    async fn test_create_task_all_fields() {
        let pool = create_test_pool().await;

        let input = CreateTaskInput {
            id: Some("my-task".to_string()),
            name: "Full Task".to_string(),
            prompt: "Execute full".to_string(),
            status: Some(TaskStatus::Backlog),
            branch: Some("feature-branch".to_string()),
            plan_model: Some("gpt-4".to_string()),
            execution_model: Some("gpt-4-turbo".to_string()),
            plan_mode: Some(true),
            auto_approve_plan: Some(true),
            review: Some(true),
            code_style_review: Some(true),
            auto_commit: Some(true),
            auto_deploy: Some(true),
            auto_deploy_condition: Some(AutoDeployCondition::WorkflowDone),
            delete_worktree: Some(true),
            requirements: Some(vec![]),
            thinking_level: Some(ThinkingLevel::High),
            plan_thinking_level: Some(ThinkingLevel::High),
            execution_thinking_level: Some(ThinkingLevel::Default),
            execution_strategy: Some(ExecutionStrategy::BestOfN),
            best_of_n_config: Some(BestOfNConfig {
                workers: vec![],
                reviewers: vec![],
                final_applier: BestOfNFinalApplier {
                    model: "gpt-4".to_string(),
                    task_suffix: None,
                },
                selection_mode: SelectionMode::PickBest,
                min_successful_workers: 1,
                verification_command: None,
            }),
            best_of_n_substage: Some(BestOfNSubstage::Idle),
            skip_permission_asking: Some(true),
            max_review_runs_override: Some(5),
            group_id: None,
            additional_agent_access: None,
        };

        let task = create_task_db(&pool, input).await.unwrap();
        assert_eq!(task.id, "my-task");
        assert_eq!(task.name, "Full Task");
        assert_eq!(task.status, TaskStatus::Backlog);
        assert!(task.plan_mode);
        assert!(task.auto_approve_plan);
        assert!(task.review);
        assert!(task.code_style_review);
        assert!(task.auto_commit);
        assert!(task.auto_deploy);
        assert!(!task.is_archived);
        assert_eq!(task.execution_strategy, ExecutionStrategy::BestOfN);
    }

    #[tokio::test]
    async fn test_create_task_default_status() {
        let pool = create_test_pool().await;

        let input = CreateTaskInput {
            id: None,
            name: "Default Status".to_string(),
            prompt: "Test".to_string(),
            status: None,
            branch: None,
            plan_model: None,
            execution_model: None,
            plan_mode: None,
            auto_approve_plan: None,
            review: None,
            code_style_review: None,
            auto_commit: None,
            auto_deploy: None,
            auto_deploy_condition: None,
            delete_worktree: None,
            requirements: None,
            thinking_level: None,
            plan_thinking_level: None,
            execution_thinking_level: None,
            execution_strategy: None,
            best_of_n_config: None,
            best_of_n_substage: None,
            skip_permission_asking: None,
            max_review_runs_override: None,
            group_id: None,
            additional_agent_access: None,
        };

        let task = create_task_db(&pool, input).await.unwrap();
        assert_eq!(task.status, TaskStatus::Backlog);
        assert_eq!(task.execution_strategy, ExecutionStrategy::Standard);
        assert!(!task.plan_mode);
        assert!(!task.review);
    }

    #[tokio::test]
    async fn test_claim_task_for_execution_is_atomic() {
        let pool = create_test_pool().await;

        let input = CreateTaskInput {
            id: Some("queued-task".to_string()),
            name: "Queued Task".to_string(),
            prompt: "Execute queued task".to_string(),
            status: Some(TaskStatus::Queued),
            branch: None,
            plan_model: None,
            execution_model: None,
            plan_mode: None,
            auto_approve_plan: None,
            review: None,
            code_style_review: None,
            auto_commit: None,
            auto_deploy: None,
            auto_deploy_condition: None,
            delete_worktree: None,
            requirements: None,
            thinking_level: None,
            plan_thinking_level: None,
            execution_thinking_level: None,
            execution_strategy: None,
            best_of_n_config: None,
            best_of_n_substage: None,
            skip_permission_asking: None,
            max_review_runs_override: None,
            group_id: None,
            additional_agent_access: None,
        };

        create_task_db(&pool, input).await.unwrap();

        let claimed = claim_task_for_execution(&pool, "queued-task")
            .await
            .unwrap()
            .expect("task should be claimed");
        assert_eq!(claimed.status, TaskStatus::Executing);
        assert!(claimed.error_message.is_none());

        let second_claim = claim_task_for_execution(&pool, "queued-task")
            .await
            .unwrap();
        assert!(second_claim.is_none());
    }
}
