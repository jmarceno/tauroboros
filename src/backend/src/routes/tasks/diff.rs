use crate::db::queries::{get_task, get_task_diffs};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::TaskDiffsResponse;
use crate::state::AppStateType;
use rocket::serde::json::Json;
use rocket::State;
use rocket::routes;
use rocket::{get, Route};

#[get("/api/tasks/<id>/diffs")]
pub async fn get_task_diffs_route(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<TaskDiffsResponse>> {
    let task = get_task(&state.db, &id)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound)
        })?;

    let diffs = get_task_diffs(&state.db, &id).await?;

    Ok(Json(TaskDiffsResponse {
        task_id: task.id,
        has_changes: !diffs.is_empty(),
        diffs,
    }))
}

pub fn routes() -> Vec<Route> {
    routes![get_task_diffs_route]
}
