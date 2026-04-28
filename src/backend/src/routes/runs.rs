use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use chrono::Utc;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{get, post, Route};

#[get("/api/runs")]
async fn list_runs(state: &State<AppStateType>) -> ApiResult<Json<Vec<WorkflowRun>>> {
    let runs = get_workflow_runs(&state.db).await?;
    Ok(Json(runs))
}

#[get("/api/runs/<id>")]
async fn get_run_by_id(state: &State<AppStateType>, id: String) -> ApiResult<Json<WorkflowRun>> {
    let run = get_workflow_run(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;
    Ok(Json(run))
}

#[get("/api/runs/active")]
async fn get_active_runs(state: &State<AppStateType>) -> ApiResult<Json<Vec<WorkflowRun>>> {
    let runs: Vec<WorkflowRun> = sqlx::query_as(
        r#"
        SELECT * FROM workflow_runs 
        WHERE status IN ('queued', 'running', 'paused') AND is_archived = 0
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::Database)?;

    Ok(Json(runs))
}

#[post("/api/runs/<id>/archive")]
async fn archive_run(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let _run = get_workflow_run(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

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

#[get("/api/runs/<id>/sessions")]
async fn get_run_sessions(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<PiWorkflowSession>>> {
    let run = get_workflow_run(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

    // Get task IDs from run
    let task_order: Vec<String> =
        serde_json::from_str(&run.task_order.clone().unwrap_or("[]".to_string()))
            .unwrap_or_default();

    let mut sessions = vec![];
    for task_id in task_order {
        let mut task_sessions = get_workflow_sessions_by_task(&state.db, &task_id).await?;
        sessions.append(&mut task_sessions);
    }

    Ok(Json(sessions))
}

#[get("/api/runs/<id>/self-heal-reports")]
async fn get_run_self_heal_reports(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<SelfHealReport>>> {
    let _run = get_workflow_run(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

    let reports = get_self_heal_reports_for_run(&state.db, &id).await?;
    Ok(Json(reports))
}

#[post("/api/runs/<id>/stop", data = "<req>")]
async fn stop_run(
    state: &State<AppStateType>,
    id: String,
    req: Json<Value>,
) -> ApiResult<Json<Value>> {
    let destructive = req
        .get("destructive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let result = state.orchestrator.stop_run(&id, destructive).await?;
    Ok(Json(json!({
        "success": true,
        "run": result.run,
        "destructive": destructive,
        "killed": result.killed,
        "cleaned": result.cleaned,
    })))
}

#[post("/api/runs/<id>/pause")]
async fn pause_run(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let run = state.orchestrator.pause_run(&id).await?;
    Ok(Json(json!({
        "success": true,
        "run": run,
    })))
}

#[post("/api/runs/<id>/resume")]
async fn resume_run(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let run = state.orchestrator.resume_run(&id).await?;
    Ok(Json(json!({
        "success": true,
        "run": run,
    })))
}

#[post("/api/runs/<id>/clean")]
async fn clean_run_route(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<CleanRunResult>> {
    let result = state.orchestrator.clean_run(&id).await?;
    Ok(Json(result))
}

#[get("/api/runs/paused-state")]
async fn get_paused_state(state: &State<AppStateType>) -> ApiResult<Json<PausedState>> {
    let has_paused: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM workflow_runs 
            WHERE status = 'paused' AND is_archived = 0
        )
        "#,
    )
    .fetch_one(&state.db)
    .await
    .map_err(ApiError::Database)?;

    let state_json = if has_paused {
        let paused_run: Option<WorkflowRun> = sqlx::query_as(
            r#"
            SELECT * FROM workflow_runs 
            WHERE status = 'paused' AND is_archived = 0
            LIMIT 1
            "#,
        )
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::Database)?;

        paused_run.map(|run| {
            json!({
                "runId": run.id,
                "kind": run.kind,
                "taskOrder": run.task_order,
                "currentTaskIndex": run.current_task_index,
                "currentTaskId": run.current_task_id,
                "targetTaskId": run.target_task_id,
                "pausedAt": run.updated_at,
                "executionPhase": if run.pause_requested { "paused" } else { "running" },
            })
        })
    } else {
        None
    };

    Ok(Json(PausedState {
        has_paused_run: has_paused,
        state: state_json,
    }))
}

#[post("/api/runs/<id>/force-stop")]
async fn force_stop_run(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let result = state.orchestrator.stop_run(&id, true).await?;
    Ok(Json(json!({
        "success": true,
        "killed": result.killed,
        "cleaned": result.cleaned,
        "run": result.run,
    })))
}

pub fn routes() -> Vec<Route> {
    routes![
        list_runs,
        get_run_by_id,
        get_active_runs,
        get_paused_state,
        archive_run,
        get_run_sessions,
        get_run_self_heal_reports,
        stop_run,
        pause_run,
        resume_run,
        clean_run_route,
        force_stop_run,
    ]
}
