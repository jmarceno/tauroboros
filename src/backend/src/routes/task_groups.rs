use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::{session_url_for, AppStateType};
use rocket::http::Status;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{delete, get, patch, post, Route};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct CreateGroupRequest {
    name: String,
    color: Option<String>,
    status: Option<TaskGroupStatus>,
    #[serde(rename = "taskIds")]
    task_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct UpdateGroupRequest {
    name: Option<String>,
    color: Option<String>,
    status: Option<TaskGroupStatus>,
}

#[derive(Debug, Deserialize)]
struct AddTasksRequest {
    #[serde(rename = "taskIds")]
    task_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RemoveTasksRequest {
    #[serde(rename = "taskIds")]
    task_ids: Vec<String>,
}

fn validate_hex_color(color: &str) -> bool {
    color.starts_with('#') && color.len() == 7 && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn validate_group_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is required".to_string());
    }
    if trimmed.len() > 100 {
        return Err("name must be 100 characters or less".to_string());
    }
    Ok(())
}

async fn broadcast_group_created(state: &State<AppStateType>, group: &TaskGroup) {
    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "task_group_created".to_string(),
            payload: serde_json::to_value(group).unwrap_or_default(),
        })
        .await;
}

async fn broadcast_group_updated(state: &State<AppStateType>, group: &TaskGroup) {
    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "task_group_updated".to_string(),
            payload: serde_json::to_value(group).unwrap_or_default(),
        })
        .await;
}

async fn broadcast_group_deleted(state: &State<AppStateType>, group_id: &str) {
    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "task_group_deleted".to_string(),
            payload: json!({ "id": group_id }),
        })
        .await;
}

async fn broadcast_members_added(
    state: &State<AppStateType>,
    group_id: &str,
    task_ids: &[String],
    count: i32,
) {
    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "task_group_members_added".to_string(),
            payload: json!({
                "groupId": group_id,
                "taskIds": task_ids,
                "addedCount": count,
            }),
        })
        .await;
}

async fn broadcast_members_removed(
    state: &State<AppStateType>,
    group_id: &str,
    task_ids: &[String],
    count: i32,
) {
    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "task_group_members_removed".to_string(),
            payload: json!({
                "groupId": group_id,
                "taskIds": task_ids,
                "removedCount": count,
            }),
        })
        .await;
}

#[get("/api/task-groups")]
async fn list_groups(state: &State<AppStateType>) -> ApiResult<Json<Vec<TaskGroup>>> {
    let groups = get_task_groups(&state.db).await?;
    Ok(Json(groups))
}

#[post("/api/task-groups", data = "<req>")]
async fn create_group(
    state: &State<AppStateType>,
    req: Json<CreateGroupRequest>,
) -> ApiResult<(Status, Json<TaskGroup>)> {
    // Validate name
    if let Err(e) = validate_group_name(&req.name) {
        return Err(ApiError::bad_request(e).with_code(ErrorCode::InvalidRequestBody));
    }

    // Validate color if provided
    if let Some(ref color) = req.color {
        if !validate_hex_color(color) {
            return Err(
                ApiError::bad_request("color must be a valid hex color (e.g., #888888)")
                    .with_code(ErrorCode::InvalidColor),
            );
        }
    }

    // Validate status if provided
    if let Some(status) = req.status {
        if !matches!(
            status,
            TaskGroupStatus::Active | TaskGroupStatus::Completed | TaskGroupStatus::Archived
        ) {
            return Err(
                ApiError::bad_request("status must be active, completed, or archived")
                    .with_code(ErrorCode::InvalidTaskGroupStatus),
            );
        }
    }

    // Validate task IDs if provided
    let member_task_ids = if let Some(ref task_ids) = req.task_ids {
        let all_tasks = get_tasks(&state.db).await?;
        let valid_ids: std::collections::HashSet<_> = all_tasks.iter().map(|t| &t.id).collect();

        let invalid: Vec<&String> = task_ids
            .iter()
            .filter(|id| !valid_ids.contains(*id))
            .collect();
        if !invalid.is_empty() {
            return Err(ApiError::bad_request(format!(
                "Invalid task IDs: {}",
                invalid
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
            .with_code(ErrorCode::InvalidRequestBody));
        }
        task_ids.clone()
    } else {
        vec![]
    };

    let group = create_task_group(
        &state.db,
        req.name.trim(),
        req.color.clone(),
        member_task_ids,
    )
    .await?;
    broadcast_group_created(state, &group).await;

    Ok((Status::Created, Json(group)))
}

#[get("/api/task-groups/<id>")]
async fn get_group(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let group = get_task_group(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Task group not found").with_code(ErrorCode::TaskGroupNotFound)
    })?;

    // Fetch tasks with full details
    let mut tasks = Vec::new();
    for task_id in &group.task_ids {
        if let Ok(Some(t)) = get_task(&state.db, task_id).await {
            let mut json = serde_json::to_value(&t).unwrap_or_default();
            if let Some(ref session_id) = t.session_id {
                json["sessionUrl"] = json!(session_url_for(session_id));
            }
            tasks.push(json);
        }
    }

    let mut response = serde_json::to_value(&group).unwrap_or_default();
    response["tasks"] = json!(tasks);

    Ok(Json(response))
}

#[patch("/api/task-groups/<id>", data = "<req>")]
async fn update_group(
    state: &State<AppStateType>,
    id: String,
    req: Json<UpdateGroupRequest>,
) -> ApiResult<Json<TaskGroup>> {
    let _existing = get_task_group(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Task group not found").with_code(ErrorCode::TaskGroupNotFound)
    })?;

    // Validate name if provided
    if let Some(ref name) = req.name {
        if let Err(e) = validate_group_name(name) {
            return Err(ApiError::bad_request(e).with_code(ErrorCode::InvalidRequestBody));
        }
    }

    // Validate color if provided
    if let Some(ref color) = req.color {
        if !validate_hex_color(color) {
            return Err(
                ApiError::bad_request("color must be a valid hex color (e.g., #888888)")
                    .with_code(ErrorCode::InvalidColor),
            );
        }
    }

    // Validate status if provided
    if let Some(status) = req.status {
        if !matches!(
            status,
            TaskGroupStatus::Active | TaskGroupStatus::Completed | TaskGroupStatus::Archived
        ) {
            return Err(
                ApiError::bad_request("status must be active, completed, or archived")
                    .with_code(ErrorCode::InvalidTaskGroupStatus),
            );
        }
    }

    let updated = update_task_group(
        &state.db,
        &id,
        req.name.clone().map(|s| s.trim().to_string()),
        req.color.clone(),
        req.status,
    )
    .await?
    .ok_or_else(|| ApiError::internal("Failed to update task group"))?;

    broadcast_group_updated(state, &updated).await;

    Ok(Json(updated))
}

#[delete("/api/task-groups/<id>")]
async fn delete_group(state: &State<AppStateType>, id: String) -> ApiResult<()> {
    let _group = get_task_group(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Task group not found").with_code(ErrorCode::TaskGroupNotFound)
    })?;

    let success = delete_task_group(&state.db, &id).await?;
    if !success {
        return Err(ApiError::internal("Failed to delete task group"));
    }

    broadcast_group_deleted(state, &id).await;

    Ok(())
}

#[post("/api/task-groups/<id>/tasks", data = "<req>")]
async fn add_tasks(
    state: &State<AppStateType>,
    id: String,
    req: Json<AddTasksRequest>,
) -> ApiResult<Json<TaskGroup>> {
    let _group = get_task_group(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Task group not found").with_code(ErrorCode::TaskGroupNotFound)
    })?;

    if req.task_ids.is_empty() {
        return Err(ApiError::bad_request("taskIds array is required")
            .with_code(ErrorCode::InvalidRequestBody));
    }

    // Validate task IDs
    let all_tasks = get_tasks(&state.db).await?;
    let valid_ids: std::collections::HashSet<_> = all_tasks.iter().map(|t| &t.id).collect();

    let invalid: Vec<&String> = req
        .task_ids
        .iter()
        .filter(|id| !valid_ids.contains(*id))
        .collect();
    if !invalid.is_empty() {
        return Err(ApiError::bad_request(format!(
            "Invalid task IDs: {}",
            invalid
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
        .with_code(ErrorCode::InvalidRequestBody));
    }

    let added = add_tasks_to_group(&state.db, &id, req.task_ids.clone()).await?;

    let updated = get_task_group(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to get updated group"))?;

    broadcast_members_added(state, &id, &req.task_ids, added).await;

    Ok(Json(updated))
}

#[delete("/api/task-groups/<id>/tasks", data = "<req>")]
async fn remove_tasks(
    state: &State<AppStateType>,
    id: String,
    req: Json<RemoveTasksRequest>,
) -> ApiResult<Json<TaskGroup>> {
    let _group = get_task_group(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Task group not found").with_code(ErrorCode::TaskGroupNotFound)
    })?;

    if req.task_ids.is_empty() {
        return Err(ApiError::bad_request("taskIds array is required")
            .with_code(ErrorCode::InvalidRequestBody));
    }

    let removed = remove_tasks_from_group(&state.db, &id, &req.task_ids).await?;

    let updated = get_task_group(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to get updated group"))?;

    broadcast_members_removed(state, &id, &req.task_ids, removed).await;

    Ok(Json(updated))
}

#[post("/api/task-groups/<id>/start")]
async fn start_group(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let run = state.orchestrator.start_group(&id).await?;
    Ok(Json(serde_json::to_value(run)?))
}

#[get("/api/tasks/<id>/group")]
async fn get_task_membership(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    if get_task(&state.db, &id).await?.is_none() {
        return Err(ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound));
    }

    let membership = get_task_group_membership(&state.db, &id).await?;

    if let (Some(group_id), Some(group)) = membership {
        Ok(Json(json!({
            "groupId": group_id,
            "group": group,
        })))
    } else {
        Ok(Json(json!({
            "groupId": Value::Null,
            "group": Value::Null,
        })))
    }
}

pub fn routes() -> Vec<Route> {
    routes![
        list_groups,
        create_group,
        get_group,
        update_group,
        delete_group,
        add_tasks,
        remove_tasks,
        start_group,
        get_task_membership,
    ]
}
