use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use rocket::form::FromForm;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{get, post, Route};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct CleanRunRequest {
    #[serde(rename = "runId")]
    run_id: String,
}

#[derive(Debug, FromForm)]
struct ExecutionGraphQuery {
    #[field(name = uncased("groupId"))]
    group_id: Option<String>,
}

async fn build_execution_graph_response(
    state: &State<AppStateType>,
    group_id: Option<String>,
) -> ApiResult<Json<Value>> {
    let mut tasks = get_tasks(&state.db).await?;
    let options = get_options(&state.db).await?;

    if let Some(ref selected_group_id) = group_id {
        let group = get_task_group(&state.db, selected_group_id)
            .await?
            .ok_or_else(|| {
                ApiError::not_found("Task group not found").with_code(ErrorCode::TaskGroupNotFound)
            })?;
        tasks.retain(|task| group.task_ids.contains(&task.id));
    }

    let mut nodes = vec![];
    let mut edges = vec![];

    for task in &tasks {
        let requirements: Vec<String> =
            serde_json::from_str(&task.requirements.clone().unwrap_or("[]".to_string()))
                .unwrap_or_default();

        nodes.push(json!({
            "id": task.id,
            "name": task.name,
            "status": task.status,
            "requirements": requirements,
        }));

        for req_id in requirements {
            edges.push(json!({
                "from": req_id,
                "to": task.id,
            }));
        }
    }

    Ok(Json(json!({
        "batches": [],
        "nodes": nodes,
        "edges": edges,
        "totalTasks": tasks.len(),
        "parallelLimit": options.parallel_tasks,
    })))
}

#[get("/api/workflow/status")]
async fn get_workflow_status(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let has_running = has_running_workflows(&state.db).await?;

    Ok(Json(json!({
        "active": has_running,
        "hasRunningWorkflows": has_running,
    })))
}

#[post("/api/workflow/start")]
async fn start_workflow(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let run = state.orchestrator.start_all().await?;
    Ok(Json(serde_json::to_value(run)?))
}

#[post("/api/workflow/start-single", data = "<req>")]
async fn start_single_task(
    state: &State<AppStateType>,
    req: Json<Value>,
) -> ApiResult<Json<Value>> {
    let task_id = req
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad_request("taskId is required"))?;

    let run = state.orchestrator.start_single(task_id).await?;
    Ok(Json(serde_json::to_value(run)?))
}

#[post("/api/workflow/stop")]
async fn stop_workflow(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
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
        "cleaned": result.cleaned,
    })))
}

#[post("/api/workflow/pause")]
async fn pause_workflow(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let active = state.orchestrator.active_run().await?;
    let Some(run) = active else {
        return Err(
            ApiError::not_found("No running workflow run").with_code(ErrorCode::RunNotFound)
        );
    };

    let updated = state.orchestrator.pause_run(&run.id).await?;
    Ok(Json(json!({ "success": true, "run": updated })))
}

#[post("/api/workflow/resume")]
async fn resume_workflow(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    let active = state.orchestrator.active_run().await?;
    let Some(run) = active else {
        let paused = get_workflow_runs(&state.db)
            .await?
            .into_iter()
            .find(|candidate| candidate.status == WorkflowRunStatus::Paused)
            .ok_or_else(|| {
                ApiError::not_found("No paused workflow run").with_code(ErrorCode::RunNotFound)
            })?;
        let updated = state.orchestrator.resume_run(&paused.id).await?;
        return Ok(Json(json!({ "success": true, "run": updated })));
    };

    let updated = state.orchestrator.resume_run(&run.id).await?;
    Ok(Json(json!({ "success": true, "run": updated })))
}

#[get("/api/workflow/slots")]
async fn get_slots(state: &State<AppStateType>) -> ApiResult<Json<Value>> {
    Ok(Json(state.orchestrator.get_slot_utilization().await?))
}

#[get("/api/workflow/queue/<id>")]
async fn get_run_queue_status(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    Ok(Json(state.orchestrator.get_run_queue_status(&id).await?))
}

#[post("/api/workflow/clean-run", data = "<req>")]
async fn clean_run(
    state: &State<AppStateType>,
    req: Json<CleanRunRequest>,
) -> ApiResult<Json<CleanRunResult>> {
    let run_id = &req.run_id;
    let result = state.orchestrator.clean_run(run_id).await?;
    Ok(Json(result))
}

#[get("/api/execution-graph?<query..>")]
async fn get_execution_graph(
    state: &State<AppStateType>,
    query: Option<ExecutionGraphQuery>,
) -> ApiResult<Json<Value>> {
    build_execution_graph_response(state, query.and_then(|value| value.group_id)).await
}

#[get("/api/workflow/execution-graph?<query..>")]
async fn get_workflow_execution_graph(
    state: &State<AppStateType>,
    query: Option<ExecutionGraphQuery>,
) -> ApiResult<Json<Value>> {
    build_execution_graph_response(state, query.and_then(|value| value.group_id)).await
}

pub fn routes() -> Vec<Route> {
    routes![
        get_workflow_status,
        start_workflow,
        start_single_task,
        stop_workflow,
        pause_workflow,
        resume_workflow,
        get_slots,
        get_run_queue_status,
        clean_run,
        get_execution_graph,
        get_workflow_execution_graph,
    ]
}
