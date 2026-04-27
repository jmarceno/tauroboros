use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use rocket::serde::json::{json, Json, Value};
use rocket::routes;
use rocket::{get, Route};
use rocket::State;

#[get("/api/archived/tasks")]
async fn get_archived_tasks(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let archived_tasks = get_archived_tasks_db(&state.db).await?;
    
    // Group by run (simplified - just return all archived tasks)
    let runs: Vec<Value> = vec![json!({
        "run": null,
        "tasks": archived_tasks,
    })];
    
    Ok(Json(json!({ "runs": runs })))
}

#[get("/api/archived/runs")]
async fn get_archived_runs(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let archived_runs: Vec<WorkflowRun> = sqlx::query_as(
        r#"
        SELECT * FROM workflow_runs 
        WHERE is_archived = 1
        ORDER BY archived_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::Database)?;
    
    // Get tasks for each run
    let mut runs_with_tasks = vec![];
    for run in &archived_runs {
        let task_order: Vec<String> = serde_json::from_str(&run.task_order.clone().unwrap_or("[]".to_string()))
            .unwrap_or_default();
        
        let mut tasks = vec![];
        for task_id in &task_order {
            if let Ok(Some(task)) = get_archived_task(&state.db, task_id).await {
                tasks.push(task);
            }
        }
        
        runs_with_tasks.push(json!({
            "run": run,
            "tasks": tasks,
        }));
    }
    
    Ok(Json(json!({ "runs": runs_with_tasks })))
}

#[get("/api/archived/tasks/<task_id>")]
async fn get_archived_task_by_id(state: &State<AppStateType>, task_id: String) -> ApiResult<Json<Value>> {
    let task = get_archived_task(&state.db, &task_id).await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;
    
    Ok(Json(json!(task)))
}

// Helper function to get all archived tasks
async fn get_archived_tasks_db(pool: &sqlx::Pool<sqlx::Sqlite>) -> Result<Vec<Task>, sqlx::Error> {
    let tasks = sqlx::query_as::<_, Task>(
        r#"
        SELECT * FROM tasks WHERE is_archived = 1 ORDER BY archived_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;
    
    Ok(tasks)
}

pub fn routes() -> Vec<Route> {
    routes![
        get_archived_tasks,
        get_archived_runs,
        get_archived_task_by_id,
    ]
}
