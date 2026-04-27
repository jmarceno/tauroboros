use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use chrono::Utc;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{get, post, Route};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::interval;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEventRequest {
    #[serde(rename = "type")]
    event_type: String,
    process_pid: Option<i32>,
    pi_session_id: Option<String>,
    pi_session_file: Option<String>,
    message: Option<serde_json::Value>,
    usage: Option<serde_json::Value>,
    message_id: Option<String>,
    role: Option<String>,
    event_name: Option<String>,
    message_type: Option<String>,
    text: Option<String>,
    content_json: Option<serde_json::Value>,
    model_provider: Option<String>,
    model_id: Option<String>,
    agent_name: Option<String>,
    status: Option<String>,
    error_message: Option<String>,
    exit_code: Option<i32>,
    exit_signal: Option<String>,
}

#[get("/api/sessions/<id>")]
async fn get_session(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<PiWorkflowSession>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    Ok(Json(session))
}

#[get("/api/sessions/<id>/messages?<limit>&<offset>")]
async fn get_session_messages(
    state: &State<AppStateType>,
    id: String,
    limit: Option<i32>,
    offset: Option<i32>,
) -> ApiResult<Json<Vec<SessionMessage>>> {
    let _session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    let messages =
        get_session_messages_db(&state.db, &id, limit.unwrap_or(500), offset.unwrap_or(0)).await?;
    Ok(Json(messages))
}

#[get("/api/sessions/<id>/timeline")]
async fn get_session_timeline(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<Value>>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    // Simplified timeline - just return messages with summary info
    let messages = get_session_messages_db(&state.db, &id, 1000, 0).await?;

    let timeline: Vec<Value> = messages
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "timestamp": m.timestamp,
                "relativeTime": m.timestamp - session.started_at,
                "role": m.role,
                "messageType": m.message_type,
                "summary": serde_json::from_str::<Value>(&m.content_json).ok()
                    .and_then(|v| v.get("text").or_else(|| v.get("summary")).cloned())
                    .unwrap_or_else(|| json!("")),
                "hasToolCalls": m.tool_call_id.is_some(),
                "hasEdits": m.edit_diff.is_some(),
                "modelProvider": m.model_provider,
                "modelId": m.model_id,
                "agentName": m.agent_name,
            })
        })
        .collect();

    Ok(Json(timeline))
}

#[get("/api/sessions/<id>/usage")]
async fn get_session_usage(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let _session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    let messages = get_session_messages_db(&state.db, &id, 10000, 0).await?;

    let total_prompt: i64 = messages
        .iter()
        .filter_map(|m| m.prompt_tokens.map(|v| v as i64))
        .sum();
    let total_completion: i64 = messages
        .iter()
        .filter_map(|m| m.completion_tokens.map(|v| v as i64))
        .sum();
    let total_cache_read: i64 = messages
        .iter()
        .filter_map(|m| m.cache_read_tokens.map(|v| v as i64))
        .sum();
    let total_cache_write: i64 = messages
        .iter()
        .filter_map(|m| m.cache_write_tokens.map(|v| v as i64))
        .sum();
    let total_tokens: i64 = messages
        .iter()
        .filter_map(|m| m.total_tokens.map(|v| v as i64))
        .sum();
    let total_cost: f64 = messages.iter().filter_map(|m| m.cost_total).sum();

    let first_ts = messages.iter().map(|m| m.timestamp).min();
    let last_ts = messages.iter().map(|m| m.timestamp).max();

    Ok(Json(json!({
        "sessionId": id,
        "messageCount": messages.len(),
        "tokenizedMessageCount": messages.iter().filter(|m| m.total_tokens.is_some()).count(),
        "costedMessageCount": messages.iter().filter(|m| m.cost_total.is_some()).count(),
        "firstTimestamp": first_ts,
        "lastTimestamp": last_ts,
        "promptTokens": total_prompt,
        "completionTokens": total_completion,
        "cacheReadTokens": total_cache_read,
        "cacheWriteTokens": total_cache_write,
        "totalTokens": total_tokens,
        "totalCost": total_cost,
    })))
}

use rocket::response::stream::{Event, EventStream};

#[get("/api/sessions/<id>/stream")]
async fn stream_session(state: &State<AppStateType>, id: String) -> EventStream![Event + '_] {
    let session_id = id.clone();

    EventStream! {
        // Create SSE connection
        let (conn_id, mut receiver) = {
            let mut hub = state.sse_hub.write().await;
            hub.create_connection(Some(session_id.clone())).await
        };

        // Send initial open event
        yield Event::json(&json!({
            "sessionId": &session_id,
            "connected": true,
        })).event("open");

        // Setup keepalive
        let mut keepalive = interval(Duration::from_secs(30));

        loop {
            tokio::select! {
                _ = keepalive.tick() => {
                    yield Event::json(&json!({ "time": Utc::now().timestamp() })).event("ping");
                }
                Some(event) = receiver.recv() => {
                    let event_type = event.event_type.clone();
                    yield Event::json(&event.data).event(event_type);
                }
                else => {
                    break;
                }
            }
        }

        // Cleanup
        let mut hub = state.sse_hub.write().await;
        hub.remove_connection(&conn_id);
    }
}

#[post("/api/pi/sessions/<id>/events", data = "<req>")]
async fn post_session_event(
    state: &State<AppStateType>,
    id: String,
    req: Json<SessionEventRequest>,
) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    let hub = state.sse_hub.read().await;
    let base_url = format!("http://localhost:{}", state.port);

    match req.event_type.as_str() {
        "start" => {
            // Update session status
            let _ = sqlx::query(
                r#"
                UPDATE pi_workflow_sessions 
                SET status = 'active', 
                    process_pid = ?,
                    pi_session_id = ?,
                    pi_session_file = ?,
                    updated_at = ?
                WHERE id = ?
                "#,
            )
            .bind(req.process_pid)
            .bind(&req.pi_session_id)
            .bind(&req.pi_session_file)
            .bind(Utc::now().timestamp())
            .bind(&id)
            .execute(&state.db)
            .await;

            // Update task with session info
            if let Some(ref task_id) = session.task_id {
                let _ = sqlx::query(
                    r#"
                    UPDATE tasks 
                    SET session_id = ?, session_url = ?, updated_at = ?
                    WHERE id = ?
                    "#,
                )
                .bind(&id)
                .bind(format!("{}/sessions/{}?mode=compact", base_url, id))
                .bind(Utc::now().timestamp())
                .bind(task_id)
                .execute(&state.db)
                .await;
            }

            let _ = hub
                .broadcast(&WSMessage {
                    r#type: "session_started".to_string(),
                    payload: serde_json::to_value(&session).unwrap_or_default(),
                })
                .await;

            hub.broadcast_status(&id, "active", None).await;

            Ok(Json(json!({ "ok": true })))
        }

        "message" => {
            let usage = req.usage.clone().unwrap_or_default();
            let cost = usage.get("cost").cloned().unwrap_or_default();

            let message = SessionMessage {
                id: 0,
                seq: 0, // Would need to query max seq
                message_id: req.message_id.clone(),
                session_id: id.clone(),
                task_id: session.task_id.clone(),
                task_run_id: session.task_run_id.clone(),
                timestamp: Utc::now().timestamp(),
                role: req
                    .role
                    .clone()
                    .map(|r| match r.as_str() {
                        "user" => MessageRole::User,
                        "assistant" => MessageRole::Assistant,
                        "system" => MessageRole::System,
                        _ => MessageRole::Assistant,
                    })
                    .unwrap_or(MessageRole::Assistant),
                event_name: req
                    .event_name
                    .clone()
                    .or_else(|| Some(req.event_type.clone())),
                message_type: req
                    .message_type
                    .clone()
                    .map(|t| match t.as_str() {
                        "text" => MessageType::Text,
                        "tool_call" => MessageType::ToolCall,
                        "tool_result" => MessageType::ToolResult,
                        "error" => MessageType::Error,
                        _ => MessageType::Text,
                    })
                    .unwrap_or(MessageType::Text),
                content_json: req
                    .content_json
                    .clone()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| {
                        format!("{{\"text\":\"{}\"}}", req.text.clone().unwrap_or_default())
                    }),
                model_provider: req.model_provider.clone().or_else(|| {
                    usage
                        .get("provider")
                        .and_then(|v| v.as_str().map(String::from))
                }),
                model_id: req.model_id.clone().or_else(|| {
                    usage
                        .get("model")
                        .and_then(|v| v.as_str().map(String::from))
                }),
                agent_name: req.agent_name.clone(),
                prompt_tokens: usage
                    .get("input")
                    .and_then(|v| v.as_i64().map(|n| n as i32)),
                completion_tokens: usage
                    .get("output")
                    .and_then(|v| v.as_i64().map(|n| n as i32)),
                cache_read_tokens: usage
                    .get("cacheRead")
                    .and_then(|v| v.as_i64().map(|n| n as i32)),
                cache_write_tokens: usage
                    .get("cacheWrite")
                    .and_then(|v| v.as_i64().map(|n| n as i32)),
                total_tokens: usage
                    .get("totalTokens")
                    .and_then(|v| v.as_i64().map(|n| n as i32)),
                cost_json: if cost.is_object() {
                    Some(cost.to_string())
                } else {
                    None
                },
                cost_total: cost.get("total").and_then(|v| v.as_f64()),
                tool_call_id: None,
                tool_name: None,
                tool_args_json: None,
                tool_result_json: None,
                tool_status: None,
                edit_diff: None,
                edit_file_path: None,
                session_status: None,
                workflow_phase: None,
                raw_event_json: Some(
                    serde_json::to_value(req.into_inner())
                        .unwrap_or_default()
                        .to_string(),
                ),
            };

            // Store message (simplified)
            let _ = hub
                .broadcast(&WSMessage {
                    r#type: "session_message_created".to_string(),
                    payload: serde_json::to_value(&message).unwrap_or_default(),
                })
                .await;

            hub.broadcast_message(&message).await;

            Ok(Json(json!({ "ok": true, "message": message })))
        }

        "status" => {
            let status_enum = match req.status.as_deref() {
                Some("starting") => PiSessionStatus::Starting,
                Some("active") => PiSessionStatus::Active,
                Some("paused") => PiSessionStatus::Paused,
                Some("completed") => PiSessionStatus::Completed,
                Some("failed") => PiSessionStatus::Failed,
                Some("aborted") => PiSessionStatus::Aborted,
                _ => session.status,
            };

            let _ = sqlx::query(
                r#"
                UPDATE pi_workflow_sessions 
                SET status = ?, error_message = ?, updated_at = ?
                WHERE id = ?
                "#,
            )
            .bind(status_enum)
            .bind(&req.error_message)
            .bind(Utc::now().timestamp())
            .bind(&id)
            .execute(&state.db)
            .await;

            let status_str = format!("{:?}", status_enum).to_lowercase();

            let _ = hub
                .broadcast(&WSMessage {
                    r#type: "session_status_changed".to_string(),
                    payload: json!({
                        "sessionId": id,
                        "status": &status_str,
                        "errorMessage": req.error_message,
                    }),
                })
                .await;

            hub.broadcast_status(&id, &status_str, None).await;

            Ok(Json(json!({ "ok": true })))
        }

        "complete" => {
            let final_status = req
                .status
                .clone()
                .unwrap_or_else(|| "completed".to_string());
            let finished_at = Utc::now().timestamp();

            let status_enum = match final_status.as_str() {
                "starting" => PiSessionStatus::Starting,
                "active" => PiSessionStatus::Active,
                "paused" => PiSessionStatus::Paused,
                "completed" => PiSessionStatus::Completed,
                "failed" => PiSessionStatus::Failed,
                "aborted" => PiSessionStatus::Aborted,
                _ => PiSessionStatus::Completed,
            };

            let _ = sqlx::query(
                r#"
                UPDATE pi_workflow_sessions 
                SET status = ?, 
                    finished_at = ?,
                    exit_code = ?,
                    exit_signal = ?,
                    error_message = ?,
                    updated_at = ?
                WHERE id = ?
                "#,
            )
            .bind(status_enum)
            .bind(finished_at)
            .bind(req.exit_code)
            .bind(&req.exit_signal)
            .bind(&req.error_message)
            .bind(Utc::now().timestamp())
            .bind(&id)
            .execute(&state.db)
            .await;

            let _ = hub
                .broadcast(&WSMessage {
                    r#type: "session_completed".to_string(),
                    payload: json!({
                        "sessionId": id,
                        "status": final_status,
                        "finishedAt": finished_at,
                        "exitCode": req.exit_code,
                        "exitSignal": req.exit_signal,
                        "errorMessage": req.error_message,
                    }),
                })
                .await;

            hub.broadcast_status(&id, &final_status, Some(finished_at))
                .await;

            Ok(Json(json!({ "ok": true })))
        }

        _ => Err(
            ApiError::bad_request(format!("Unsupported event type: {}", req.event_type))
                .with_code(ErrorCode::InvalidRequestBody),
        ),
    }
}

#[get("/api/task-runs/<id>/messages")]
async fn get_task_run_messages(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<SessionMessage>>> {
    // Get messages for this task run
    let messages: Vec<SessionMessage> = sqlx::query_as(
        r#"
        SELECT * FROM session_messages WHERE task_run_id = ? ORDER BY seq ASC
        "#,
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    Ok(Json(messages))
}

pub fn routes() -> Vec<Route> {
    routes![
        get_session,
        get_session_messages,
        get_session_timeline,
        get_session_usage,
        stream_session,
        post_session_event,
        get_task_run_messages,
    ]
}
