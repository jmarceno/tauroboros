use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{get, Route};
use sqlx::{Pool, QueryBuilder, Sqlite};

fn parse_task_order(run: &WorkflowRun) -> Vec<String> {
    serde_json::from_str(&run.task_order.clone().unwrap_or_else(|| "[]".to_string()))
        .unwrap_or_default()
}

async fn get_workflow_runs_with_archived_tasks(pool: &Pool<Sqlite>) -> ApiResult<Vec<WorkflowRun>> {
    let runs: Vec<WorkflowRun> = sqlx::query_as(
        r#"
        SELECT * FROM workflow_runs ORDER BY finished_at DESC, created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::Database)?;

    let mut result = Vec::new();
    for run in runs {
        let task_order = parse_task_order(&run);
        if task_order.is_empty() {
            continue;
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT COUNT(*) FROM tasks WHERE is_archived = 1 AND id IN (",
        );
        {
            let mut separated = query.separated(", ");
            for task_id in &task_order {
                separated.push_bind(task_id);
            }
        }
        query.push(")");

        let count: i64 = query
            .build_query_scalar()
            .fetch_one(pool)
            .await
            .map_err(ApiError::Database)?;

        if count > 0 {
            result.push(run);
        }
    }

    Ok(result)
}

async fn get_archived_tasks_by_run(pool: &Pool<Sqlite>, run: &WorkflowRun) -> ApiResult<Vec<Task>> {
    let task_order = parse_task_order(run);
    if task_order.is_empty() {
        return Ok(Vec::new());
    }

    let mut query =
        QueryBuilder::<Sqlite>::new("SELECT * FROM tasks WHERE is_archived = 1 AND id IN (");
    {
        let mut separated = query.separated(", ");
        for task_id in &task_order {
            separated.push_bind(task_id);
        }
    }
    query.push(") ORDER BY archived_at DESC");

    query
        .build_query_as::<Task>()
        .fetch_all(pool)
        .await
        .map_err(ApiError::Database)
}

fn normalize_archived_task(state: &State<AppStateType>, task: &Task) -> Value {
    let mut json = serde_json::to_value(task).unwrap_or_default();
    if let Some(session_id) = &task.session_id {
        json["sessionUrl"] = json!(state.session_url_for(session_id));
    }
    json
}

#[get("/api/archived/tasks")]
async fn get_archived_tasks(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let archived_runs = get_workflow_runs_with_archived_tasks(&state.db).await?;
    let mut runs = Vec::new();

    for run in archived_runs {
        let tasks = get_archived_tasks_by_run(&state.db, &run).await?;
        if tasks.is_empty() {
            continue;
        }

        runs.push(json!({
            "run": run,
            "tasks": tasks
                .iter()
                .map(|task| normalize_archived_task(state, task))
                .collect::<Vec<_>>(),
        }));
    }

    Ok(Json(json!({ "runs": runs })))
}

#[get("/api/archived/runs")]
async fn get_archived_runs(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let archived_runs = get_workflow_runs_with_archived_tasks(&state.db).await?;
    Ok(Json(json!({ "runs": archived_runs })))
}

#[get("/api/archived/tasks/<task_id>")]
async fn get_archived_task_by_id(
    state: &State<AppStateType>,
    task_id: String,
) -> ApiResult<Json<Value>> {
    let task = get_archived_task(&state.db, &task_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound))?;

    Ok(Json(normalize_archived_task(state, &task)))
}

pub fn routes() -> Vec<Route> {
    routes![
        get_archived_tasks,
        get_archived_runs,
        get_archived_task_by_id,
    ]
}
