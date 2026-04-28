use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use chrono::Utc;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{delete, get, post, Route};

#[post("/api/start")]
async fn api_start(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let run = state.orchestrator.start_all().await?;
    Ok(Json(serde_json::to_value(run)?))
}

#[post("/api/execution/start")]
async fn execution_start(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    api_start(state).await
}

#[post("/api/stop")]
async fn api_stop(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let active = state.orchestrator.active_run().await?;
    let Some(run) = active else {
        return Ok(Json(json!({ "ok": true })));
    };

    let result = state.orchestrator.stop_run(&run.id, false).await?;
    Ok(Json(json!({
        "success": true,
        "run": result.run,
        "destructive": false,
        "killed": result.killed,
    })))
}

#[post("/api/execution/stop")]
async fn execution_stop(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    api_stop(state).await
}

#[post("/api/execution/pause")]
async fn execution_pause(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let active = state.orchestrator.active_run().await?;
    let Some(run) = active else {
        return Err(
            ApiError::not_found("No running workflow run").with_code(ErrorCode::RunNotFound)
        );
    };

    let updated = state.orchestrator.pause_run(&run.id).await?;
    Ok(Json(json!({ "success": true, "run": updated })))
}

#[get("/api/runs/<id>/paused-state")]
async fn get_run_paused_state(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let run = get_workflow_run(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

    // Get sessions for tasks in this run
    let task_order: Vec<String> =
        serde_json::from_str(&run.task_order.clone().unwrap_or("[]".to_string()))
            .unwrap_or_default();

    let mut sessions = vec![];
    for task_id in task_order {
        if let Ok(Some(task)) = get_task(&state.db, &task_id).await {
            if let Some(ref session_id) = task.session_id {
                if let Ok(Some(session)) = get_workflow_session(&state.db, session_id).await {
                    sessions.push(session);
                }
            }
        }
    }

    Ok(Json(json!({
        "runId": id,
        "hasPausedSessions": !sessions.is_empty(),
        "pausedSessions": sessions,
        "runStatus": run.status,
    })))
}

#[get("/api/slots")]
async fn get_slots_info(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    Ok(Json(state.orchestrator.get_slot_utilization().await?))
}

#[get("/api/runs/<id>/queue-status")]
async fn get_run_queue_status(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    Ok(Json(state.orchestrator.get_run_queue_status(&id).await?))
}

#[delete("/api/runs/<id>")]
async fn archive_run_direct(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let run = get_workflow_run(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

    if run.is_archived {
        return Err(ApiError::not_found("Run not found"));
    }

    if matches!(
        run.status,
        WorkflowRunStatus::Queued
            | WorkflowRunStatus::Running
            | WorkflowRunStatus::Stopping
            | WorkflowRunStatus::Paused
    ) {
        return Err(
            ApiError::conflict("Only completed or failed workflow runs can be archived")
                .with_code(ErrorCode::ExecutionOperationFailed),
        );
    }

    let now = Utc::now().timestamp();

    sqlx::query(
        r#"
        UPDATE workflow_runs 
        SET is_archived = 1, archived_at = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(&id)
    .execute(&state.db)
    .await
    .map_err(ApiError::Database)?;

    let hub = state.sse_hub.read().await;
    hub.broadcast(&WSMessage {
        r#type: "run_archived".to_string(),
        payload: json!({ "id": id }),
    })
    .await;

    Ok(Json(json!({ "id": id, "archived": true })))
}

pub fn routes() -> Vec<Route> {
    routes![
        api_start,
        execution_start,
        api_stop,
        execution_stop,
        execution_pause,
        get_run_paused_state,
        get_slots_info,
        get_run_queue_status,
        archive_run_direct,
    ]
}
