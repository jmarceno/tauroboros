// This route module intentionally stays above the soft 1000-line limit because
// it owns the full task API surface and keeps task-specific request/response
// normalization in one place while the Rust backend is still converging on the
// TypeScript contract.
use crate::db::queries::*;
use rocket::routes;
use crate::db::{CreateTaskInput, UpdateTaskInput};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::sse::hub::SseHub;
use crate::state::AppStateType;
use rocket::State;
use chrono::Utc;
use rocket::serde::json::{json, Json, Value};
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
struct RepairRequest {
    action: Option<String>,
    reason: Option<String>,
    error_message: Option<String>,
    smart_repair_hints: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectCandidateRequest {
    candidate_id: String,
}

#[derive(Debug, Deserialize)]
struct AbortBestOfNRequest {
    reason: Option<String>,
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
// Helper Functions
// ============================================================================

pub(crate) fn normalize_task_for_client(task: &Task, base_url: &str) -> Value {
    // Convert task to JSON with sessionUrl computed
    let mut json = serde_json::to_value(task).unwrap_or_default();
    if let Some(session_id) = &task.session_id {
        json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, session_id));
    }
    json
}

pub(crate) fn normalize_task_run_for_client(run: &TaskRun, base_url: &str) -> Value {
    let mut json = serde_json::to_value(run).unwrap_or_default();
    if let Some(session_id) = &run.session_id {
        json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, session_id));
    }
    json
}

async fn broadcast_task_update(state: &State<AppStateType>, task: &Task, base_url: &str) {
    let hub = state.sse_hub.read().await;
    let normalized = normalize_task_for_client(task, base_url);
    let _ = hub.broadcast(&WSMessage {
        r#type: "task_updated".to_string(),
        payload: normalized,
    }).await;
}

async fn broadcast_task_created(state: &State<AppStateType>, task: &Task, base_url: &str) {
    let hub = state.sse_hub.read().await;
    let normalized = normalize_task_for_client(task, base_url);
    let _ = hub.broadcast(&WSMessage {
        r#type: "task_created".to_string(),
        payload: normalized,
    }).await;
}

async fn broadcast_task_deleted(state: &State<AppStateType>, task_id: &str) {
    let hub = state.sse_hub.read().await;
    let _ = hub.broadcast(&WSMessage {
        r#type: "task_deleted".to_string(),
        payload: json!({ "id": task_id }),
    }).await;
}

async fn broadcast_task_archived(state: &State<AppStateType>, task_id: &str) {
    let hub = state.sse_hub.read().await;
    let _ = hub.broadcast(&WSMessage {
        r#type: "task_archived".to_string(),
        payload: json!({ "id": task_id }),
    }).await;
}

async fn broadcast_group_event(state: &State<AppStateType>, event_type: &str, group_id: &str, task_id: Option<&str>) {
    let hub = state.sse_hub.read().await;
    let payload = if let Some(tid) = task_id {
        json!({ "groupId": group_id, "taskId": tid })
    } else {
        json!({ "groupId": group_id })
    };
    let _ = hub.broadcast(&WSMessage {
        r#type: event_type.to_string(),
        payload,
    }).await;
}

// ============================================================================
// Routes
// ============================================================================

#[get("/api/tasks")]
async fn list_tasks(state: &State<AppStateType>) -> ApiResult<Json<Vec<Value>>> {
    let tasks = get_tasks(&state.db).await?;
    let base_url = format!("http://localhost:{}", state.port);
    let normalized: Vec<Value> = tasks.iter()
        .map(|t| normalize_task_for_client(t, &base_url))
        .collect();
    Ok(Json(normalized))
}

#[post("/api/tasks", data = "<req>")]
async fn create_task(state: &State<AppStateType>, req: Json<CreateTaskRequest>) -> ApiResult<Json<Value>> {
    let base_url = format!("http://localhost:{}", state.port);
    
    // Validate requirements - check all task IDs exist
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
    broadcast_task_created(&state, &task, &base_url).await;
    
    let normalized = normalize_task_for_client(&task, &base_url);
    
    if !removed_deps.is_empty() {
        let mut response = normalized.clone();
        response["warning"] = json!(format!(
            "Invalid dependencies auto-removed: {}",
            removed_deps.join(", ")
        ));
        Ok(Json(response))
    } else {
        Ok(Json(normalized))
    }
}

#[get("/api/tasks/<id>")]
async fn get_task_by_id(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
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
    let existing = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    // Check if task is executing (unless it's just marking done)
    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if active_run.is_some() {
        // Only allow status/completedAt updates during execution
        let input = &req.input;
        let only_status_or_done = 
            input.name.is_none() &&
            input.prompt.is_none() &&
            input.branch.is_none() &&
            input.plan_model.is_none() &&
            input.execution_model.is_none() &&
            input.requirements.is_none();
        
        if !only_status_or_done {
            return Err(ApiError::conflict(format!(
                "Cannot modify task \"{}\" while it is executing in run {}.",
                existing.name,
                active_run.unwrap().id
            )).with_code(ErrorCode::TaskAlreadyExecuting));
        }
    }
    
    let base_url = format!("http://localhost:{}", state.port);
    
    // Handle status transition logic
    let mut input = req.input.clone();
    
    // Reset execution phase when moving to backlog
    if let Some(TaskStatus::Backlog) = input.status {
        if input.execution_phase.is_none() {
            input.execution_phase = Some(ExecutionPhase::NotStarted);
        }
        if input.best_of_n_substage.is_none() {
            input.best_of_n_substage = Some(BestOfNSubstage::Idle);
        }
        input.awaiting_plan_approval = Some(false);
    }
    
    // Remove from group if moving to template
    if let Some(TaskStatus::Template) = input.status {
        if existing.group_id.is_some() {
            if let Some(ref group_id) = existing.group_id {
                remove_task_from_group(&state.db, group_id, &id).await.ok();
                broadcast_group_event(&state, "group_task_removed", group_id, Some(&id)).await;
            }
            input.group_id = None;
        }
    }
    
    let task = update_task(&state.db, &id, input).await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    
    broadcast_task_update(&state, &task, &base_url).await;
    
    // If task moved to done and all group tasks are done, mark group completed
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
                    update_task_group(&state.db, group_id, None, None, Some(TaskGroupStatus::Completed)).await.ok();
                }
            }
        }
    }
    
    Ok(Json(normalize_task_for_client(&task, &base_url)))
}

#[delete("/api/tasks/<id>")]
async fn delete_task(state: &State<AppStateType>, id: String) -> ApiResult<Value> {
    let existing = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    // Check if task is executing
    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if active_run.is_some() {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            existing.name,
            active_run.unwrap().id
        )).with_code(ErrorCode::TaskAlreadyExecuting));
    }
    
    let has_history = has_task_execution_history(&state.db, &id).await?;
    
    if has_history {
        archive_task(&state.db, &id).await?;
        broadcast_task_archived(&state, &id).await;
        Ok(json!({ "id": id, "archived": true }))
    } else {
        hard_delete_task(&state.db, &id).await?;
        broadcast_task_deleted(&state, &id).await;
        Ok(Value::Null) // 204 No Content
    }
}

#[put("/api/tasks/reorder", data = "<req>")]
async fn reorder_task_route(state: &State<AppStateType>, req: Json<ReorderRequest>) -> ApiResult<Json<Value>> {
    reorder_task(&state.db, &req.id, req.new_idx).await?;
    
    let hub = state.sse_hub.read().await;
    let _ = hub.broadcast(&WSMessage {
        r#type: "task_reordered".to_string(),
        payload: json!({}),
    }).await;
    
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
            archive_task(&state.db, &task.id).await.ok();
            broadcast_task_archived(&state, &task.id).await;
            archived += 1;
        } else {
            hard_delete_task(&state.db, &task.id).await.ok();
            broadcast_task_deleted(&state, &task.id).await;
            deleted += 1;
        }
    }
    
    Ok(Json(json!({ "archived": archived, "deleted": deleted })))
}

#[get("/api/tasks/<id>/runs")]
async fn get_task_runs_route(state: &State<AppStateType>, id: String) -> ApiResult<Json<Vec<Value>>> {
    // Check if task exists (including archived)
    let task_exists = get_task(&state.db, &id).await?.is_some()
        || get_archived_task(&state.db, &id).await?.is_some();
    
    if !task_exists {
        return Err(ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound));
    }
    
    let runs = get_task_runs(&state.db, &id).await?;
    let base_url = format!("http://localhost:{}", state.port);
    
    let normalized: Vec<Value> = runs.iter()
        .map(|r| normalize_task_run_for_client(r, &base_url))
        .collect();
    
    Ok(Json(normalized))
}

#[get("/api/tasks/<id>/sessions")]
async fn get_task_sessions(state: &State<AppStateType>, id: String) -> ApiResult<Json<Vec<PiWorkflowSession>>> {
    let task_exists = get_task(&state.db, &id).await?.is_some()
        || get_archived_task(&state.db, &id).await?.is_some();
    
    if !task_exists {
        return Err(ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound));
    }
    
    let sessions = get_workflow_sessions_by_task(&state.db, &id).await?;
    Ok(Json(sessions))
}

#[get("/api/tasks/<id>/candidates")]
async fn get_task_candidates_route(state: &State<AppStateType>, id: String) -> ApiResult<Json<Vec<TaskCandidate>>> {
    if get_task(&state.db, &id).await?.is_none() {
        return Err(ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound));
    }
    
    let candidates = get_task_candidates(&state.db, &id).await?;
    Ok(Json(candidates))
}

#[get("/api/tasks/<id>/best-of-n-summary")]
async fn get_best_of_n_summary(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    if task.execution_strategy != ExecutionStrategy::BestOfN {
        return Err(ApiError::bad_request("Task is not a best_of_n task")
            .with_code(ErrorCode::InvalidExecutionStrategy));
    }
    
    let candidates = get_task_candidates(&state.db, &id).await?;
    let summary = json!({
        "taskId": id,
        "substage": task.best_of_n_substage,
        "workersTotal": 0, // TODO: implement
        "workersDone": 0,
        "workersFailed": 0,
        "reviewersTotal": 0,
        "reviewersDone": 0,
        "reviewersFailed": 0,
        "hasFinalApplier": false,
        "finalApplierDone": false,
        "finalApplierStatus": "not_started",
        "expandedWorkerCount": 0,
        "expandedReviewerCount": 0,
        "totalExpandedRuns": 0,
        "successfulCandidateCount": candidates.len(),
        "selectedCandidate": candidates.iter().find(|c| c.status == "selected").map(|c| &c.id),
        "availableCandidates": candidates.len(),
        "selectedCandidates": candidates.iter().filter(|c| c.status == "selected").count(),
    });
    
    Ok(Json(summary))
}

#[post("/api/tasks/<id>/best-of-n/select-candidate", data = "<req>")]
async fn select_candidate(
    state: &State<AppStateType>,
    id: String,
    req: Json<SelectCandidateRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    if task.execution_strategy != ExecutionStrategy::BestOfN {
        return Err(ApiError::bad_request("Task is not a best_of_n task")
            .with_code(ErrorCode::InvalidExecutionStrategy));
    }
    
    let candidates = get_task_candidates(&state.db, &id).await?;
    if !candidates.iter().any(|c| c.id == req.candidate_id) {
        return Err(ApiError::not_found("Candidate not found").with_code(ErrorCode::TaskNotFound));
    }
    
    // Update all candidates - reject others, select this one
    for candidate in candidates {
        let new_status = if candidate.id == req.candidate_id {
            "selected"
        } else {
            "rejected"
        };
        update_task_candidate(&state.db, &candidate.id, new_status).await.ok();
    }
    
    let hub = state.sse_hub.read().await;
    for candidate in get_task_candidates(&state.db, &id).await? {
        let _ = hub.broadcast(&WSMessage {
            r#type: "task_candidate_updated".to_string(),
            payload: serde_json::to_value(&candidate).unwrap_or_default(),
        }).await;
    }
    
    Ok(Json(json!({ "ok": true, "selectedCandidate": req.candidate_id })))
}

#[post("/api/tasks/<id>/best-of-n/abort", data = "<req>")]
async fn abort_best_of_n(
    state: &State<AppStateType>,
    id: String,
    req: Json<AbortBestOfNRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    if task.execution_strategy != ExecutionStrategy::BestOfN {
        return Err(ApiError::bad_request("Task is not a best_of_n task")
            .with_code(ErrorCode::InvalidExecutionStrategy));
    }
    
    let reason = req.reason.clone().unwrap_or_else(|| "Best-of-n execution aborted manually".to_string());
    
    let update = UpdateTaskInput {
        status: Some(TaskStatus::Review),
        best_of_n_substage: Some(BestOfNSubstage::BlockedForManualReview),
        error_message: Some(Some(reason)),
        ..Default::default()
    };
    
    let updated = update_task(&state.db, &id, update).await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    
    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(&state, &updated, &base_url).await;
    
    Ok(Json(json!({ "ok": true, "task": normalize_task_for_client(&updated, &base_url) })))
}

#[get("/api/tasks/<id>/review-status")]
async fn get_review_status(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    let options = get_options(&state.db).await?;
    
    Ok(Json(json!({
        "taskId": id,
        "reviewCount": task.review_count,
        "maxReviewRuns": options.max_reviews,
        "maxReviewRunsOverride": task.max_review_runs_override,
    })))
}

#[post("/api/tasks/<id>/approve-plan", data = "<req>")]
async fn approve_plan(
    state: &State<AppStateType>,
    id: String,
    req: Json<ApprovalRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
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
    
    let updated = update_task(&state.db, &id, update).await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    
    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(&state, &updated, &base_url).await;
    
    Ok(Json(normalize_task_for_client(&updated, &base_url)))
}

#[post("/api/tasks/<id>/request-plan-revision", data = "<req>")]
async fn request_plan_revision(
    state: &State<AppStateType>,
    id: String,
    req: Json<FeedbackRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    if !task.plan_mode {
        return Err(ApiError::bad_request("Task is not in plan mode")
            .with_code(ErrorCode::InvalidRequestBody));
    }
    
    if req.feedback.trim().is_empty() {
        return Err(ApiError::bad_request("feedback is required"));
    }
    
    let next_count = task.plan_revision_count + 1;
    let new_output = format!(
        "{}\n[user-revision-request]\n{}\n",
        task.agent_output,
        req.feedback.trim()
    );
    
    let update = UpdateTaskInput {
        status: Some(TaskStatus::Backlog),
        awaiting_plan_approval: Some(false),
        execution_phase: Some(ExecutionPhase::PlanRevisionPending),
        plan_revision_count: Some(next_count),
        agent_output: Some(Some(new_output)),
        ..Default::default()
    };
    
    let updated = update_task(&state.db, &id, update).await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    
    let hub = state.sse_hub.read().await;
    let _ = hub.broadcast(&WSMessage {
        r#type: "plan_revision_requested".to_string(),
        payload: json!({ "taskId": id }),
    }).await;
    
    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(&state, &updated, &base_url).await;
    
    Ok(Json(normalize_task_for_client(&updated, &base_url)))
}

#[post("/api/tasks/<id>/request-revision", data = "<req>")]
async fn request_revision(
    state: &State<AppStateType>,
    id: String,
    req: Json<FeedbackRequest>,
) -> ApiResult<Json<Value>> {
    // Alias for request_plan_revision
    request_plan_revision(state, id, req).await
}

#[post("/api/tasks/<id>/start")]
async fn start_task(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let run = state.orchestrator.start_single(&id).await?;
    Ok(Json(serde_json::to_value(run)?))
}

#[post("/api/tasks/<id>/reset")]
async fn reset_task(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    // Check if task is executing
    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if active_run.is_some() {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            task.name,
            active_run.unwrap().id
        )).with_code(ErrorCode::TaskAlreadyExecuting));
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
    
    let reset = update_task(&state.db, &id, update).await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    
    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(&state, &reset, &base_url).await;
    
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
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    // Check if task is executing
    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if active_run.is_some() {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            task.name,
            active_run.unwrap().id
        )).with_code(ErrorCode::TaskAlreadyExecuting));
    }
    
    let membership = get_task_group_membership(&state.db, &id).await?;
    let group_id = membership.0.clone()
        .ok_or_else(|| ApiError::bad_request("Task was not in a group"))?;
    let group = membership.1
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
    
    let reset = update_task(&state.db, &id, update).await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    
    // Re-add to group
    add_task_to_group(&state.db, &group_id, &id).await?;
    
    let base_url = format!("http://localhost:{}", state.port);
    broadcast_task_update(&state, &reset, &base_url).await;
    broadcast_group_event(&state, "group_task_added", &group_id, Some(&id)).await;
    
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
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    // Check if task is executing
    let active_run = get_active_workflow_run_for_task(&state.db, &id).await?;
    if active_run.is_some() {
        return Err(ApiError::conflict(format!(
            "Cannot modify task \"{}\" while it is executing in run {}.",
            task.name,
            active_run.unwrap().id
        )).with_code(ErrorCode::TaskAlreadyExecuting));
    }
    
    let base_url = format!("http://localhost:{}", state.port);
    
    match &req.group_id {
        None => {
            // Remove from group
            if let Some(ref old_group_id) = task.group_id {
                remove_task_from_group(&state.db, old_group_id, &id).await?;
                broadcast_group_event(&state, "group_task_removed", old_group_id, Some(&id)).await;
            }
            
            let updated = update_task(&state.db, &id, UpdateTaskInput {
                group_id: Some(None),
                ..Default::default()
            }).await?;
            
            if let Some(ref task) = updated {
                broadcast_task_update(&state, task, &base_url).await;
            }
            
            Ok(Json(normalize_task_for_client(&updated.unwrap_or(task), &base_url)))
        }
        Some(group_id) => {
            // Validate group exists
            if get_task_group(&state.db, group_id).await?.is_none() {
                return Err(ApiError::not_found("Group not found").with_code(ErrorCode::TaskGroupNotFound));
            }
            
            // Remove from old group if different
            if let Some(ref old_group_id) = task.group_id {
                if old_group_id != group_id {
                    remove_task_from_group(&state.db, old_group_id, &id).await.ok();
                    broadcast_group_event(&state, "group_task_removed", old_group_id, Some(&id)).await;
                }
            }
            
            // Add to new group
            add_task_to_group(&state.db, group_id, &id).await?;
            
            let updated = get_task(&state.db, &id).await?.unwrap_or(task);
            broadcast_task_update(&state, &updated, &base_url).await;
            broadcast_group_event(&state, "group_task_added", group_id, Some(&id)).await;
            
            Ok(Json(normalize_task_for_client(&updated, &base_url)))
        }
    }
}

#[post("/api/tasks/<id>/repair-state", data = "<req>")]
async fn repair_task(
    state: &State<AppStateType>,
    id: String,
    req: Json<RepairRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    let action = req.action.clone().unwrap_or_else(|| "smart".to_string());
    let base_url = format!("http://localhost:{}", state.port);
    
    if action == "smart" {
        // For now, just reset to backlog as a simple smart repair
        let update = UpdateTaskInput {
            status: Some(TaskStatus::Backlog),
            error_message: Some(None),
            execution_phase: Some(ExecutionPhase::NotStarted),
            ..Default::default()
        };
        
        let updated = update_task(&state.db, &id, update).await?
            .ok_or_else(|| ApiError::not_found("Task not found"))?;
        
        broadcast_task_update(&state, &updated, &base_url).await;
        
        return Ok(Json(json!({
            "ok": true,
            "action": "reset_backlog",
            "reason": "Smart repair applied",
            "task": normalize_task_for_client(&updated, &base_url),
        })));
    }
    
    // Handle specific actions
    let update = match action.as_str() {
        "reset_backlog" => UpdateTaskInput {
            status: Some(TaskStatus::Backlog),
            error_message: Some(None),
            execution_phase: Some(ExecutionPhase::NotStarted),
            ..Default::default()
        },
        "mark_done" => UpdateTaskInput {
            status: Some(TaskStatus::Done),
            completed_at: Some(Some(Utc::now().timestamp())),
            ..Default::default()
        },
        "fail_task" => UpdateTaskInput {
            status: Some(TaskStatus::Failed),
            error_message: Some(req.error_message.clone().or_else(|| Some("Manual repair: marked as failed".to_string()))),
            ..Default::default()
        },
        _ => return Err(ApiError::bad_request(format!("Unsupported repair action: {}", action))
            .with_code(ErrorCode::InvalidRequestBody)),
    };
    
    let updated = update_task(&state.db, &id, update).await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    
    broadcast_task_update(&state, &updated, &base_url).await;
    
    Ok(Json(json!({
        "ok": true,
        "action": action,
        "reason": req.reason.clone().unwrap_or_else(|| "Manual repair action".to_string()),
        "task": normalize_task_for_client(&updated, &base_url),
    })))
}

#[get("/api/tasks/<id>/self-heal-reports")]
async fn get_self_heal_reports(state: &State<AppStateType>, id: String) -> ApiResult<Json<Vec<SelfHealReport>>> {
    let _task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let reports = get_self_heal_reports_for_task(&state.db, &id).await?;
    Ok(Json(reports))
}

#[get("/api/tasks/<id>/messages")]
async fn get_task_messages(state: &State<AppStateType>, id: String) -> ApiResult<Json<Vec<SessionMessage>>> {
    let messages = get_session_messages_for_task(&state.db, &id).await?;
    Ok(Json(messages))
}

#[get("/api/tasks/<id>/last-update")]
async fn get_task_last_update(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    // Get last message timestamp from sessions
    let last_update: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT MAX(timestamp) FROM session_messages
        WHERE task_id = ?
        "#,
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await
    .ok()
    .flatten();
    
    Ok(Json(json!({
        "taskId": id,
        "lastUpdateAt": last_update.unwrap_or(task.updated_at),
    })))
}

// ============================================================================
// Export Routes
// ============================================================================

#[post("/api/tasks/create-and-wait", data = "<req>")]
async fn create_and_wait_task(state: &State<AppStateType>, req: Json<CreateAndWaitTaskRequest>) -> ApiResult<Json<Value>> {
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
    broadcast_task_created(&state, &task, &base_url).await;

    let run = state.orchestrator.start_single(&task.id).await?;
    let timeout_ms = req.timeout_ms.unwrap_or(1_800_000).clamp(60_000, 7_200_000);
    let poll_interval_ms = req.poll_interval_ms.unwrap_or(2_000).clamp(1_000, 30_000);
    let start = std::time::Instant::now();

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(poll_interval_ms)).await;

        let current_task = get_task(&state.db, &task.id).await?
            .ok_or_else(|| ApiError::internal("Task was deleted during execution").with_code(ErrorCode::TaskNotFound))?;

        if matches!(current_task.status, TaskStatus::Done | TaskStatus::Failed | TaskStatus::Stuck) {
            let current_run = get_workflow_run(&state.db, &run.id).await?;
            return Ok(Json(json!({
                "task": normalize_task_for_client(&current_task, &base_url),
                "run": current_run,
                "completedAt": chrono::Utc::now().timestamp_millis(),
                "durationMs": start.elapsed().as_millis() as u64,
                "status": current_task.status,
            })));
        }

        if start.elapsed().as_millis() as u64 >= timeout_ms {
            let stop_result = state.orchestrator.stop_run(&run.id, false).await?;
            return Ok(Json(json!({
                "error": "Timeout waiting for task completion",
                "code": ErrorCode::ExecutionOperationFailed.as_str(),
                "task": normalize_task_for_client(&current_task, &base_url),
                "run": stop_result.run,
                "timeoutMs": timeout_ms,
                "elapsedMs": start.elapsed().as_millis() as u64,
            })));
        }
    }
}

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
        get_task_candidates_route,
        get_best_of_n_summary,
        select_candidate,
        abort_best_of_n,
        get_review_status,
        approve_plan,
        request_plan_revision,
        request_revision,
        reset_task,
        reset_to_group,
        move_to_group,
        repair_task,
        start_task,
        get_self_heal_reports,
        get_task_messages,
        get_task_last_update,
    ]
}
