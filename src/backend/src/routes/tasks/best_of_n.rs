use crate::db::queries::*;
use crate::db::UpdateTaskInput;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use rocket::serde::json::{json, Json, Value};
use rocket::{get, post, State};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SelectCandidateRequest {
    pub(super) candidate_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct AbortBestOfNRequest {
    pub(super) reason: Option<String>,
}

#[get("/api/tasks/<id>/candidates")]
pub(super) async fn get_task_candidates_route(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<TaskCandidate>>> {
    if get_task(&state.db, &id).await?.is_none() {
        return Err(ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound));
    }

    let candidates = get_task_candidates(&state.db, &id).await?;
    Ok(Json(candidates))
}

#[get("/api/tasks/<id>/best-of-n-summary")]
pub(super) async fn get_best_of_n_summary(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    if task.execution_strategy != ExecutionStrategy::BestOfN {
        return Err(ApiError::bad_request("Task is not a best_of_n task")
            .with_code(ErrorCode::InvalidExecutionStrategy));
    }

    let task_runs = get_task_runs(&state.db, &id).await?;
    let candidates = get_task_candidates(&state.db, &id).await?;

    let worker_runs: Vec<&TaskRun> = task_runs
        .iter()
        .filter(|r| matches!(r.phase, RunPhase::Worker))
        .collect();
    let reviewer_runs: Vec<&TaskRun> = task_runs
        .iter()
        .filter(|r| matches!(r.phase, RunPhase::Reviewer))
        .collect();
    let applier_runs: Vec<&TaskRun> = task_runs
        .iter()
        .filter(|r| matches!(r.phase, RunPhase::FinalApplier))
        .collect();

    let has_final_applier = !applier_runs.is_empty();
    let final_applier_done = applier_runs
        .iter()
        .any(|r| matches!(r.status, RunStatus::Done));
    let final_applier_running = applier_runs
        .iter()
        .any(|r| matches!(r.status, RunStatus::Running));

    let final_applier_status = if final_applier_done {
        "done"
    } else if final_applier_running {
        "running"
    } else if has_final_applier {
        "failed"
    } else {
        "not_started"
    };

    let summary = json!({
        "taskId": id,
        "substage": task.best_of_n_substage,
        "workersTotal": worker_runs.len(),
        "workersDone": worker_runs.iter().filter(|r| matches!(r.status, RunStatus::Done)).count(),
        "workersFailed": worker_runs.iter().filter(|r| matches!(r.status, RunStatus::Failed)).count(),
        "reviewersTotal": reviewer_runs.len(),
        "reviewersDone": reviewer_runs.iter().filter(|r| matches!(r.status, RunStatus::Done)).count(),
        "reviewersFailed": reviewer_runs.iter().filter(|r| matches!(r.status, RunStatus::Failed)).count(),
        "hasFinalApplier": has_final_applier,
        "finalApplierDone": final_applier_done,
        "finalApplierStatus": final_applier_status,
        "expandedWorkerCount": worker_runs.len(),
        "expandedReviewerCount": reviewer_runs.len(),
        "totalExpandedRuns": task_runs.len(),
        "successfulCandidateCount": candidates.len(),
        "selectedCandidate": candidates.iter().find(|c| c.status == "selected").map(|c| &c.id),
        "availableCandidates": candidates.iter().filter(|c| c.status == "available").count(),
        "selectedCandidates": candidates.iter().filter(|c| c.status == "selected").count(),
    });

    Ok(Json(summary))
}

#[post("/api/tasks/<id>/best-of-n/select-candidate", data = "<req>")]
pub(super) async fn select_candidate(
    state: &State<AppStateType>,
    id: String,
    req: Json<SelectCandidateRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    if task.execution_strategy != ExecutionStrategy::BestOfN {
        return Err(ApiError::bad_request("Task is not a best_of_n task")
            .with_code(ErrorCode::InvalidExecutionStrategy));
    }

    let candidates = get_task_candidates(&state.db, &id).await?;
    if !candidates.iter().any(|c| c.id == req.candidate_id) {
        return Err(ApiError::not_found("Candidate not found").with_code(ErrorCode::TaskNotFound));
    }

    for candidate in candidates {
        let new_status = if candidate.id == req.candidate_id {
            "selected"
        } else {
            "rejected"
        };
        if let Err(e) = update_task_candidate(&state.db, &candidate.id, new_status).await {
            tracing::warn!(
                candidate_id = %candidate.id,
                error = %e,
                "Failed to update candidate status during selection"
            );
        }
    }

    let hub = state.sse_hub.read().await;
    for candidate in get_task_candidates(&state.db, &id).await? {
        let payload = match serde_json::to_value(&candidate) {
            Ok(value) => value,
            Err(e) => {
                tracing::error!(
                    candidate_id = %candidate.id,
                    error = %e,
                    "Failed to serialize candidate for broadcast"
                );
                json!({ "id": candidate.id, "error": "serialization_failed" })
            }
        };
        hub.broadcast(&WSMessage {
            r#type: "task_candidate_updated".to_string(),
            payload,
        })
        .await;
    }

    Ok(Json(
        json!({ "ok": true, "selectedCandidate": req.candidate_id }),
    ))
}

#[post("/api/tasks/<id>/best-of-n/abort", data = "<req>")]
pub(super) async fn abort_best_of_n(
    state: &State<AppStateType>,
    id: String,
    req: Json<AbortBestOfNRequest>,
) -> ApiResult<Json<Value>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    if task.execution_strategy != ExecutionStrategy::BestOfN {
        return Err(ApiError::bad_request("Task is not a best_of_n task")
            .with_code(ErrorCode::InvalidExecutionStrategy));
    }

    let reason = req
        .reason
        .clone()
        .unwrap_or_else(|| "Best-of-n execution aborted manually".to_string());

    let update = UpdateTaskInput {
        status: Some(TaskStatus::Review),
        best_of_n_substage: Some(BestOfNSubstage::BlockedForManualReview),
        error_message: Some(Some(reason)),
        ..Default::default()
    };

    let updated = update_task(&state.db, &id, update)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    let base_url = format!("http://localhost:{}", state.port);
    super::broadcast_task_update(state, &updated, &base_url).await;

    Ok(Json(
        json!({ "ok": true, "task": super::normalize_task_for_client(&updated, &base_url) }),
    ))
}
