use crate::db::queries::*;
use crate::db::UpdateTaskInput;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use chrono::Utc;
use rocket::serde::json::{json, Json, Value};
use rocket::{get, post, State};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(super) struct RepairRequest {
    pub(super) action: Option<String>,
    pub(super) reason: Option<String>,
    pub(super) error_message: Option<String>,
    pub(super) smart_repair_hints: Option<String>,
}

#[post("/api/tasks/<id>/repair-state", data = "<req>")]
pub(super) async fn repair_task(
    state: &State<AppStateType>,
    id: String,
    req: Json<RepairRequest>,
) -> ApiResult<Json<Value>> {
    let _task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let action = req.action.clone().unwrap_or_else(|| "smart".to_string());
    let base_url = format!("http://localhost:{}", state.port);

    if action == "smart" {
        let update = UpdateTaskInput {
            status: Some(TaskStatus::Backlog),
            error_message: Some(None),
            execution_phase: Some(ExecutionPhase::NotStarted),
            ..Default::default()
        };

        let updated = update_task(&state.db, &id, update)
            .await?
            .ok_or_else(|| ApiError::not_found("Task not found"))?;

        super::broadcast_task_update(state, &updated, &base_url).await;

        return Ok(Json(json!({
            "ok": true,
            "action": "reset_backlog",
            "reason": "Smart repair applied",
            "task": super::normalize_task_for_client(&updated, &base_url),
        })));
    }

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
            error_message: Some(
                req.error_message
                    .clone()
                    .or_else(|| Some("Manual repair: marked as failed".to_string())),
            ),
            ..Default::default()
        },
        _ => {
            return Err(
                ApiError::bad_request(format!("Unsupported repair action: {}", action))
                    .with_code(ErrorCode::InvalidRequestBody),
            )
        }
    };

    let updated = update_task(&state.db, &id, update)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;

    super::broadcast_task_update(state, &updated, &base_url).await;

    Ok(Json(json!({
        "ok": true,
        "action": action,
        "reason": req.reason.clone().unwrap_or_else(|| "Manual repair action".to_string()),
        "task": super::normalize_task_for_client(&updated, &base_url),
    })))
}

#[get("/api/tasks/<id>/self-heal-reports")]
pub(super) async fn get_self_heal_reports(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<SelfHealReport>>> {
    let _task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    let reports = get_self_heal_reports_for_task(&state.db, &id).await?;
    Ok(Json(reports))
}
