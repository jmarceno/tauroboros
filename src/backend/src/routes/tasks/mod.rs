// This route module intentionally stays above the soft 1000-line limit because
// it owns the full task API surface and keeps task-specific request/response
// normalization in one place while the Rust backend is still converging on the
// TypeScript contract.

pub mod best_of_n;
pub mod diff;
pub mod repair;

use crate::db::queries::*;
use crate::db::{CreateTaskInput, UpdateTaskInput};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::{session_url_for, AppStateType};
use rocket::http::Status;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{delete, get, patch, post, put, Route};
use serde::Deserialize;
use std::collections::HashSet;

// ============================================================================
// Input Types
// ============================================================================

#[derive(Debug, Deserialize)]
struct CreateTaskRequest {
    #[serde(flatten)]
    input: CreateTaskInput,
}

#[derive(Debug, Deserialize)]
struct UpdateTaskRequest {
    #[serde(flatten)]
    input: UpdateTaskInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderRequest {
    id: String,
    new_idx: i32,
}

#[derive(Debug, Deserialize)]
struct FeedbackRequest {
    feedback: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    approval_note: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveToGroupRequest {
    group_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAndWaitTaskRequest {
    #[serde(flatten)]
    input: CreateTaskInput,
    timeout_ms: Option<u64>,
    poll_interval_ms: Option<u64>,
}

// ============================================================================
// Helper Functions (pub(super) for sub-module access)
// ============================================================================

pub(crate) fn normalize_task_for_client(task: &Task, _base_url: &str) -> Value {
    let mut json = match serde_json::to_value(task) {
        Ok(value) => value,
        Err(e) => {
            tracing::error!(
                task_id = %task.id,
                error = %e,
                "Failed to serialize task for client - this is a bug"
            );
            json!({
                "id": task.id,
                "error": "serialization_failed",
                "name": &task.name
            })
        }
    };
    if let Some(session_id) = &task.session_id {
        json["sessionUrl"] = json!(session_url_for(session_id));
    }
    json
}

pub(crate) fn normalize_task_run_for_client(run: &TaskRun, _base_url: &str) -> Value {
    let mut json = match serde_json::to_value(run) {
        Ok(value) => value,
        Err(e) => {
            tracing::error!(
                run_id = %run.id,
                error = %e,
                "Failed to serialize task run for client - this is a bug"
            );
            json!({
                "id": run.id,
                "error": "serialization_failed",
                "taskId": &run.task_id
            })
        }
    };
    if let Some(session_id) = &run.session_id {
        json["sessionUrl"] = json!(session_url_for(session_id));
    }
    json
}

pub(super) async fn broadcast_task_update(
    state: &State<AppStateType>,
    task: &Task,
    base_url: &str,
) {
    let hub = state.sse_hub.read().await;
    let normalized = normalize_task_for_client(task, base_url);
    hub.broadcast(&WSMessage {
        r#type: "task_updated".to_string(),
        payload: normalized,
    })
    .await;
}

async fn broadcast_task_created(state: &State<AppStateType>, task: &Task, base_url: &str) {
    let hub = state.sse_hub.read().await;
    let normalized = normalize_task_for_client(task, base_url);
    hub.broadcast(&WSMessage {
        r#type: "task_created".to_string(),
        payload: normalized,
    })
    .await;
}

async fn broadcast_task_deleted(state: &State<AppStateType>, task_id: &str) {
    let hub = state.sse_hub.read().await;
    hub.broadcast(&WSMessage {
        r#type: "task_deleted".to_string(),
        payload: json!({ "id": task_id }),
    })
    .await;
}

async fn broadcast_task_archived(state: &State<AppStateType>, task_id: &str) {
    let hub = state.sse_hub.read().await;
    hub.broadcast(&WSMessage {
        r#type: "task_archived".to_string(),
        payload: json!({ "id": task_id }),
    })
    .await;
}

async fn broadcast_group_event(
    state: &State<AppStateType>,
    event_type: &str,
    group_id: &str,
    task_id: Option<&str>,
) {
    let hub = state.sse_hub.read().await;
    let payload = if let Some(tid) = task_id {
        json!({ "groupId": group_id, "taskId": tid })
    } else {
        json!({ "groupId": group_id })
    };
    hub.broadcast(&WSMessage {
        r#type: event_type.to_string(),
        payload,
    })
    .await;
}

// ============================================================================
// Routes - Core CRUD
// ============================================================================

#[get("/api/tasks")]
async fn list_tasks(state: &State<AppStateType>) -> ApiResult<Json<Vec<Value>>> {
    let tasks = get_tasks(&state.db).await?;
    let base_url = format!("http://localhost:{}", state.port);
    let normalized: Vec<Value> = tasks
        .iter()
        .map(|t| normalize_task_for_client(t, &base_url))
        .collect();
    Ok(Json(normalized))
}

#[post("/api/tasks", data = "<req>")]
async fn create_task(
    state: &State<AppStateType>,
    req: Json<CreateTaskRequest>,
) -> ApiResult<(Status, Json<Value>)> {
    let base_url = format!("http://localhost:{}", state.port);

    let all_tasks = get_tasks(&state.db).await?;
    let valid_ids: HashSet<_> = all_tasks.iter().map(|t| &t.id).collect();

    let requirements = req.input.requirements.clone().unwrap_or_default();
    let valid_requirements: Vec<String> = requirements
        .iter()
        .filter(|id| valid_ids.contains(*id))
        .cloned()
        .collect();
    let removed_deps: Vec<String> = requirements
        .iter()
        .filter(|id| !valid_ids.contains(*id))
        .cloned()
        .collect();

    let mut input = req.input.clone();
    input.requirements = Some(valid_requirements);

    let task = create_task_db(&state.db, input).await?;
    broadcast_task_created(state, &task, &base_url).await;

    let normalized = normalize_task_for_client(&task, &base_url);

    if !removed_deps.is_empty() {
        let mut response = normalized.clone();
        response["warning"] = json!(format!(
            "Invalid dependencies auto-removed: {}",
            removed_deps.join(", ")
        ));
        Ok((Status::Created, Json(response)))
    } else {
        Ok((Status::Created, Json(normalized)))
    }
}

#[get("/api/tasks/<id>")]
async fn get_task_by_id(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let base_url = format!("http://localhost:{}", state.port);
    Ok(Json(normalize_task_for_client(&task, &base_url)))
}

#[patch("/api/tasks/<id>", data = "<req>")]
async fn update_task_route(
    state: &State<AppStateType>,
    id: String,
    req: Json<UpdateTaskRequest>,
) -> ApiResult<Json<Value>> {
    let existing = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if let Some(active_run) = active_run {
        let input = &req.input;
        let only_status_or_done = input.name.is_none()
            && input.prompt.is_none()
            && input.branch.is_none()
            && input.plan_model.is_none()
            && input.execution_model.is_none()
            && input.requirements.is_none();

        if !only_status_or_done {
            return Err(ApiError::conflict(format!(
                "Cannot modify task \"{}\" while it is executing in run {}.",
                existing.name, active_run.id
            ))
            .with_code(ErrorCode::TaskAlreadyExecuting));
        }
    }

    let base_url = format!("http://localhost:{}", state.port);

    let mut input = req.input.clone();

    if let Some(TaskStatus::Backlog) = input.status {
        if input.execution_phase.is_none() {
            input.execution_phase = Some(ExecutionPhase::NotStarted);
        }
        if input.best_of_n_substage.is_none() {
            input.best_of_n_substage = Some(BestOfNSubstage::Idle);
        }
        input.awaiting_plan_approval = Some(false);
    }

    if let Some(TaskStatus::Template) = input.status {
        if existing.group_id.is_some() {
            if let Some(ref group_id) = existing.group_id {
                if let Err(e) = remove_task_from_group(&state.db, group_id, &id).await {
                    tracing::warn!(
                        task_id = %id,
                        group_id = %group_id,
                        error = %e,
                        "Failed to remove task from group when converting to template"
                    );
                }
                broadcast_group_event(state, "group_task_removed", group_id, Some(&id)).await;
            }
            input.group_id = None;
        }
    }

    let task = update_task(&state.db, &id, input)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    broadcast_task_update(state, &task, &base_url).await;

    if task.status == TaskStatus::Done {
        if let Some(ref group_id) = task.group_id {
            if let Ok(Some(group)) = get_task_group(&state.db, group_id).await {
                let mut all_done = true;
                for tid in &group.task_ids {
                    if let Ok(Some(t)) = get_task(&state.db, tid).await {
                        if t.status != TaskStatus::Done {
                            all_done = false;
                            break;
                        }
                    } else {
                        all_done = false;
                        break;
                    }
                }

                if all_done && !group.task_ids.is_empty() {
                    if let Err(e) = update_task_group(
                        &state.db,
                        group_id,
                        None,
                        None,
                        Some(TaskGroupStatus::Completed),
                    )
                    .await
                    {
                        tracing::warn!(
                            group_id = %group_id,
                            error = %e,
                            "Failed to mark group as completed when all tasks done"
                        );
                    }
                }
            }
        }
    }

    Ok(Json(normalize_task_for_client(&task, &base_url)))
}

#[delete("/api/tasks/<id>")]
async fn delete_task(state: &State<AppStateType>, id: String) -> ApiResult<Value> {
    let existing = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if let Some(active_run) = active_run {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            existing.name, active_run.id
        ))
        .with_code(ErrorCode::TaskAlreadyExecuting));
    }

    let has_history = has_task_execution_history(&state.db, &id).await?;

    if has_history {
        archive_task(&state.db, &id).await?;
        broadcast_task_archived(state, &id).await;
        Ok(json!({ "id": id, "archived": true }))
    } else {
        hard_delete_task(&state.db, &id).await?;
        broadcast_task_deleted(state, &id).await;
        Ok(Value::Null)
    }
}

#[put("/api/tasks/reorder", data = "<req>")]
async fn reorder_task_route(
    state: &State<AppStateType>,
    req: Json<ReorderRequest>,
) -> ApiResult<Json<Value>> {
    reorder_task(&state.db, &req.id, req.new_idx).await?;

    let hub = state.sse_hub.read().await;
    hub.broadcast(&WSMessage {
        r#type: "task_reordered".to_string(),
        payload: json!({}),
    })
    .await;

    Ok(Json(json!({ "ok": true })))
}

#[delete("/api/tasks/done/all")]
async fn delete_done_tasks(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let done_tasks = get_tasks_by_status(&state.db, TaskStatus::Done).await?;

    let mut archived = 0;
    let mut deleted = 0;

    for task in done_tasks {
        let has_history = has_task_execution_history(&state.db, &task.id).await?;

        if has_history {
            if let Err(e) = archive_task(&state.db, &task.id).await {
                tracing::warn!(
                    task_id = %task.id,
                    error = %e,
                    "Failed to archive done task during bulk delete"
                );
                continue;
            }
            broadcast_task_archived(state, &task.id).await;
            archived += 1;
        } else {
            if let Err(e) = hard_delete_task(&state.db, &task.id).await {
                tracing::warn!(
                    task_id = %task.id,
                    error = %e,
                    "Failed to hard delete done task during bulk delete"
                );
                continue;
            }
            broadcast_task_deleted(state, &task.id).await;
            deleted += 1;
        }
    }

    Ok(Json(json!({ "archived": archived, "deleted": deleted })))
}

// ============================================================================
// Routes - Task Sub-resources
// ============================================================================

#[get("/api/tasks/<id>/runs")]
async fn get_task_runs_route(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<Value>>> {
    let task_exists = get_task(&state.db, &id).await?.is_some()
        || get_archived_task(&state.db, &id).await?.is_some();

    if !task_exists {
        return Err(ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound));
    }

    let runs = get_task_runs(&state.db, &id).await?;
    let base_url = format!("http://localhost:{}", state.port);

    let normalized: Vec<Value> = runs
        .iter()
        .map(|r| normalize_task_run_for_client(r, &base_url))
        .collect();

    Ok(Json(normalized))
}

#[get("/api/tasks/<id>/sessions")]
async fn get_task_sessions(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<PiWorkflowSession>>> {
    let task_exists = get_task(&state.db, &id).await?.is_some()
        || get_archived_task(&state.db, &id).await?.is_some();

    if !task_exists {
        return Err(ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound));
    }

    let sessions = get_workflow_sessions_by_task(&state.db, &id).await?;
    Ok(Json(sessions))
}

#[get("/api/tasks/<id>/messages")]
async fn get_task_messages(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<SessionMessage>>> {
    let messages = get_session_messages_for_task(&state.db, &id).await?;
    Ok(Json(messages))
}

#[get("/api/tasks/<id>/last-update")]
async fn get_task_last_update(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let last_update: Option<i64> = match sqlx::query_scalar(
        r#"
        SELECT MAX(timestamp) FROM session_messages
        WHERE task_id = ?
        "#,
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await
    {
        Ok(result) => result,
        Err(e) => {
            tracing::debug!(
                task_id = %id,
                error = %e,
                "Failed to fetch last update timestamp (no messages likely)"
            );
            None
        }
    };

    Ok(Json(json!({
        "taskId": id,
        "lastUpdateAt": last_update.unwrap_or(task.updated_at),
    })))
}

#[get("/api/tasks/<id>/review-status")]
async fn get_review_status(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let options = get_options(&state.db).await?;

    Ok(Json(json!({
        "taskId": id,
        "reviewCount": task.review_count,
        "maxReviewRuns": options.max_reviews,
        "maxReviewRunsOverride": task.max_review_runs_override,
    })))
}

// ============================================================================
// Routes - Plan Approval / Revision
// ============================================================================

#[post("/api/tasks/<id>/approve-plan", data = "<req>")]
async fn approve_plan(
    state: &State<AppStateType>,
    id: String,
    req: Json<ApprovalRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    if !task.plan_mode {
        return Err(ApiError::bad_request("Task is not in plan mode")
            .with_code(ErrorCode::InvalidRequestBody));
    }

    let approval_note = req.approval_note.clone().or_else(|| req.message.clone());
    let new_output = if let Some(note) = approval_note {
        format!("{}\n[user-approval-note]\n{}\n", task.agent_output, note)
    } else {
        task.agent_output
    };

    let update = UpdateTaskInput {
        status: Some(TaskStatus::Backlog),
        awaiting_plan_approval: Some(false),
        execution_phase: Some(ExecutionPhase::ImplementationPending),
        error_message: Some(None),
        agent_output: Some(Some(new_output)),
        ..Default::default()
    };

    let updated = update_task(&state.db, &id, update)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(state, &updated, &base_url).await;

    Ok(Json(normalize_task_for_client(&updated, &base_url)))
}

#[post("/api/tasks/<id>/request-plan-revision", data = "<req>")]
async fn request_plan_revision(
    state: &State<AppStateType>,
    id: String,
    req: Json<FeedbackRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    if !task.plan_mode {
        return Err(ApiError::bad_request("Task is not in plan mode")
            .with_code(ErrorCode::InvalidRequestBody));
    }

    if req.feedback.trim().is_empty() {
        return Err(ApiError::bad_request("feedback is required"));
    }

    let feedback = req.feedback.trim().to_string();
    let next_count = task.plan_revision_count + 1;
    let new_output = format!(
        "{}\n[user-revision-request]\n{}\n",
        task.agent_output, feedback
    );

    // Retry loop: wait for active run to complete before starting the revision
    let max_attempts = 24;
    let delay_ms = std::time::Duration::from_millis(50);
    let mut run: Option<WorkflowRun> = None;

    for attempt in 0..max_attempts {
        let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
        if active_run.is_some() && attempt < max_attempts - 1 {
            tokio::time::sleep(delay_ms).await;
            continue;
        }

        // Update task state once we have a clear slot
        let update = UpdateTaskInput {
            status: Some(TaskStatus::Backlog),
            awaiting_plan_approval: Some(false),
            execution_phase: Some(ExecutionPhase::PlanRevisionPending),
            plan_revision_count: Some(next_count),
            agent_output: Some(Some(new_output.clone())),
            ..Default::default()
        };

        let updated = update_task(&state.db, &id, update)
            .await?
            .ok_or_else(|| ApiError::not_found("Task not found"))?;

        let hub = state.sse_hub.read().await;
        let _ = hub
            .broadcast(&WSMessage {
                r#type: "plan_revision_requested".to_string(),
                payload: json!({ "taskId": id }),
            })
            .await;
        drop(hub);

        let base_url = format!("http://localhost:{}", state.port);
        broadcast_task_update(state, &updated, &base_url).await;

        // Auto-start the revision run
        if let Ok(new_run) = state.orchestrator.start_single(&id).await {
            run = Some(new_run);
        }
        break;
    }

    let task_for_response = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    let base_url = format!("http://localhost:{}", state.port);

    if let Some(run) = run {
        Ok(Json(json!({
            "task": normalize_task_for_client(&task_for_response, &base_url),
            "run": run,
        })))
    } else {
        Err(ApiError::bad_request(
            "Could not queue plan revision because a prior run is still active",
        )
        .with_code(ErrorCode::ExecutionOperationFailed))
    }
}

#[post("/api/tasks/<id>/request-revision", data = "<req>")]
async fn request_revision(
    state: &State<AppStateType>,
    id: String,
    req: Json<FeedbackRequest>,
) -> ApiResult<Json<Value>> {
    request_plan_revision(state, id, req).await
}

// ============================================================================
// Routes - Reset / Move
// ============================================================================

#[post("/api/tasks/<id>/start")]
async fn start_task(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let run = state.orchestrator.start_single(&id).await?;
    Ok(Json(serde_json::to_value(run)?))
}

#[post("/api/tasks/<id>/reset")]
async fn reset_task(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if let Some(active_run) = active_run {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            task.name, active_run.id
        ))
        .with_code(ErrorCode::TaskAlreadyExecuting));
    }

    let membership = get_task_group_membership(&state.db, &id).await?;

    let update = UpdateTaskInput {
        status: Some(TaskStatus::Backlog),
        review_count: Some(0),
        error_message: Some(None),
        completed_at: Some(None),
        session_id: Some(None),
        session_url: Some(None),
        worktree_dir: Some(None),
        execution_phase: Some(ExecutionPhase::NotStarted),
        awaiting_plan_approval: Some(false),
        plan_revision_count: Some(0),
        ..Default::default()
    };

    let reset = update_task(&state.db, &id, update)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(state, &reset, &base_url).await;

    if membership.0.is_some() {
        Ok(Json(json!({
            "task": normalize_task_for_client(&reset, &base_url),
            "group": membership.1,
            "wasInGroup": true,
        })))
    } else {
        Ok(Json(json!({
            "task": normalize_task_for_client(&reset, &base_url),
            "wasInGroup": false,
        })))
    }
}

#[post("/api/tasks/<id>/reset-to-group")]
async fn reset_to_group(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if let Some(active_run) = active_run {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            task.name, active_run.id
        ))
        .with_code(ErrorCode::TaskAlreadyExecuting));
    }

    let membership = get_task_group_membership(&state.db, &id).await?;
    let group_id = membership
        .0
        .clone()
        .ok_or_else(|| ApiError::bad_request("Task was not in a group"))?;
    let group = membership
        .1
        .ok_or_else(|| ApiError::not_found("Group not found"))?;

    let update = UpdateTaskInput {
        status: Some(TaskStatus::Backlog),
        review_count: Some(0),
        error_message: Some(None),
        completed_at: Some(None),
        session_id: Some(None),
        session_url: Some(None),
        worktree_dir: Some(None),
        execution_phase: Some(ExecutionPhase::NotStarted),
        awaiting_plan_approval: Some(false),
        plan_revision_count: Some(0),
        ..Default::default()
    };

    let reset = update_task(&state.db, &id, update)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    add_task_to_group(&state.db, &group_id, &id).await?;

    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(state, &reset, &base_url).await;
    broadcast_group_event(state, "group_task_added", &group_id, Some(&id)).await;

    Ok(Json(json!({
        "task": normalize_task_for_client(&reset, &base_url),
        "group": group,
        "restoredToGroup": true,
    })))
}

#[post("/api/tasks/<id>/move-to-group", data = "<req>")]
async fn move_to_group(
    state: &State<AppStateType>,
    id: String,
    req: Json<MoveToGroupRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if let Some(active_run) = active_run {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            task.name, active_run.id
        ))
        .with_code(ErrorCode::TaskAlreadyExecuting));
    }

    let base_url = format!("http://localhost:{}", state.port);

    match &req.group_id {
        None => {
            if let Some(ref old_group_id) = task.group_id {
                remove_task_from_group(&state.db, old_group_id, &id).await?;
                broadcast_group_event(state, "group_task_removed", old_group_id, Some(&id)).await;
            }

            let updated = update_task(
                &state.db,
                &id,
                UpdateTaskInput {
                    group_id: Some(None),
                    ..Default::default()
                },
            )
            .await?;

            if let Some(ref task) = updated {
                broadcast_task_update(state, task, &base_url).await;
            }

            Ok(Json(normalize_task_for_client(
                &updated.unwrap_or(task),
                &base_url,
            )))
        }
        Some(group_id) => {
            if get_task_group(&state.db, group_id).await?.is_none() {
                return Err(
                    ApiError::not_found("Group not found").with_code(ErrorCode::TaskGroupNotFound)
                );
            }

            if let Some(ref old_group_id) = task.group_id {
                if old_group_id != group_id {
                    remove_task_from_group(&state.db, old_group_id, &id)
                        .await
                        .ok();
                    broadcast_group_event(state, "group_task_removed", old_group_id, Some(&id))
                        .await;
                }
            }

            add_task_to_group(&state.db, group_id, &id).await?;

            let updated = get_task(&state.db, &id).await?.unwrap_or(task);
            broadcast_task_update(state, &updated, &base_url).await;
            broadcast_group_event(state, "group_task_added", group_id, Some(&id)).await;

            Ok(Json(normalize_task_for_client(&updated, &base_url)))
        }
    }
}

// ============================================================================
// Routes - Create-and-Wait
// ============================================================================

#[post("/api/tasks/create-and-wait", data = "<req>")]
async fn create_and_wait_task(
    state: &State<AppStateType>,
    req: Json<CreateAndWaitTaskRequest>,
) -> ApiResult<(Status, Json<Value>)> {
    let base_url = format!("http://localhost:{}", state.port);

    let all_tasks = get_tasks(&state.db).await?;
    let valid_ids: HashSet<_> = all_tasks.iter().map(|t| &t.id).collect();

    let requirements = req.input.requirements.clone().unwrap_or_default();
    let valid_requirements: Vec<String> = requirements
        .iter()
        .filter(|id| valid_ids.contains(*id))
        .cloned()
        .collect();

    let mut input = req.input.clone();
    input.requirements = Some(valid_requirements);
    input.status = Some(TaskStatus::Backlog);

    let task = create_task_db(&state.db, input).await?;
    broadcast_task_created(state, &task, &base_url).await;

    let run = state.orchestrator.start_single(&task.id).await?;
    let timeout_ms = req.timeout_ms.unwrap_or(1_800_000).clamp(60_000, 7_200_000);
    let poll_interval_ms = req.poll_interval_ms.unwrap_or(2_000).clamp(1_000, 30_000);
    let start = std::time::Instant::now();

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(poll_interval_ms)).await;

        let current_task = get_task(&state.db, &task.id).await?.ok_or_else(|| {
            ApiError::internal("Task was deleted during execution")
                .with_code(ErrorCode::TaskNotFound)
        })?;

        if matches!(
            current_task.status,
            TaskStatus::Done | TaskStatus::Failed | TaskStatus::Stuck
        ) {
            let current_run = get_workflow_run(&state.db, &run.id).await?;
            return Ok((
                Status::Created,
                Json(json!({
                    "task": normalize_task_for_client(&current_task, &base_url),
                    "run": current_run,
                    "completedAt": chrono::Utc::now().timestamp_millis(),
                    "durationMs": start.elapsed().as_millis() as u64,
                    "status": current_task.status,
                })),
            ));
        }

        if start.elapsed().as_millis() as u64 >= timeout_ms {
            let stop_result = state.orchestrator.stop_run(&run.id, false).await?;
            return Ok((
                Status::Created,
                Json(json!({
                    "error": "Timeout waiting for task completion",
                    "code": ErrorCode::ExecutionOperationFailed.as_str(),
                    "task": normalize_task_for_client(&current_task, &base_url),
                    "run": stop_result.run,
                    "timeoutMs": timeout_ms,
                    "elapsedMs": start.elapsed().as_millis() as u64,
                })),
            ));
        }
    }
}

// ============================================================================
// Export Routes
// ============================================================================

pub fn routes() -> Vec<Route> {
    routes![
        list_tasks,
        create_task,
        create_and_wait_task,
        get_task_by_id,
        update_task_route,
        delete_task,
        reorder_task_route,
        delete_done_tasks,
        get_task_runs_route,
        get_task_sessions,
        get_task_messages,
        get_task_last_update,
        get_review_status,
        approve_plan,
        request_plan_revision,
        request_revision,
        reset_task,
        reset_to_group,
        move_to_group,
        start_task,
        // Sub-module routes (included via module re-exports)
        best_of_n::get_task_candidates_route,
        best_of_n::get_best_of_n_summary,
        best_of_n::select_candidate,
        best_of_n::abort_best_of_n,
        repair::repair_task,
        repair::get_self_heal_reports,
        diff::get_task_diffs_route,
    ]
}
