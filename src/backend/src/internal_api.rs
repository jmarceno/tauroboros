use crate::db::queries::create_session_message;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::{MessageRole, MessageType, SessionMessage};
use crate::sse::hub::SseHub;
use crate::state::AppStateType;
use rocket::serde::json::{json, Json, Value};
use rocket::{post, routes, Route, State};
use serde::Deserialize;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::warn;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMessage {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    pub payload_type: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub message_id: Option<String>,
    pub role: String,
    pub message_type: String,
    pub event_name: Option<String>,
    pub content: Option<Value>,
    pub text: Option<String>,
    pub timestamp: Option<i64>,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub agent_name: Option<String>,
    pub usage: Option<UsageData>,
    pub cost: Option<CostData>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_args: Option<Value>,
    pub tool_result: Option<Value>,
    pub tool_is_error: Option<bool>,
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub input: Option<i32>,
    pub output: Option<i32>,
    pub cache_read: Option<i32>,
    pub cache_write: Option<i32>,
    pub total_tokens: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostData {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub total: Option<f64>,
}

fn parse_role(s: &str) -> MessageRole {
    match s {
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "system" => MessageRole::System,
        "tool" | "toolResult" => MessageRole::Tool,
        unknown => {
            tracing::warn!(role = %unknown, "Unknown message role received, using System");
            MessageRole::System
        }
    }
}

fn parse_message_type(s: &str) -> MessageType {
    match s {
        "user_prompt" => MessageType::UserPrompt,
        "assistant_response" => MessageType::AssistantResponse,
        "tool_call" => MessageType::ToolCall,
        "tool_result" => MessageType::ToolResult,
        "step_start" => MessageType::StepStart,
        "step_finish" => MessageType::StepFinish,
        "thinking" => MessageType::Thinking,
        "error" | "session_error" => MessageType::SessionError,
        unknown => {
            tracing::warn!(message_type = %unknown, "Unknown message type received, using SessionStatus");
            MessageType::SessionStatus
        }
    }
}

fn convert_incoming(msg: IncomingMessage) -> Result<SessionMessage, ApiError> {
    let now = chrono::Utc::now().timestamp();
    let role = parse_role(&msg.role);
    let message_type = parse_message_type(&msg.message_type);

    // Log when text is missing as this may indicate incomplete message data
    let text = msg.text.unwrap_or_else(|| {
        tracing::debug!(session_id = %msg.session_id, "Incoming message has no text content");
        String::new()
    });
    
    let mut content_map = serde_json::Map::new();
    content_map.insert("text".to_string(), Value::String(text.clone()));
    content_map.insert(
        "messageType".to_string(),
        Value::String(msg.message_type.clone()),
    );
    content_map.insert(
        "eventName".to_string(),
        msg.event_name
            .as_deref()
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
    );
    if let Some(ref content) = msg.content {
        content_map.insert("rawContent".to_string(), content.clone());
    }
    if let Some(ref thinking) = msg.thinking {
        content_map.insert("thinking".to_string(), Value::String(thinking.clone()));
    }

    let (prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, total_tokens) =
        if let Some(ref usage) = msg.usage {
            (
                usage.input,
                usage.output,
                usage.cache_read,
                usage.cache_write,
                usage.total_tokens,
            )
        } else {
            (None, None, None, None, None)
        };

    let (cost_json, cost_total) = if let Some(ref cost) = msg.cost {
        let cost_obj = json!({
            "input": cost.input,
            "output": cost.output,
            "cacheRead": cost.cache_read,
            "cacheWrite": cost.cache_write,
            "total": cost.total,
        });
        (Some(cost_obj.to_string()), cost.total)
    } else {
        (None, None)
    };

    // Generate message_id if not provided or empty
    let message_id = msg.message_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            tracing::debug!(session_id = %msg.session_id, "Generating message_id for incoming message");
            Uuid::new_v4().to_string()
        });
    
    // Use provided timestamp or current time
    let timestamp = msg.timestamp.unwrap_or_else(|| {
        tracing::trace!(session_id = %msg.session_id, "Using current timestamp for incoming message");
        now
    });

    Ok(SessionMessage {
        id: 0,
        seq: 0,
        message_id: Some(message_id),
        session_id: msg.session_id,
        task_id: msg.task_id,
        task_run_id: msg.task_run_id,
        timestamp,
        role,
        event_name: msg.event_name,
        message_type,
        content_json: Value::Object(content_map).to_string(),
        model_provider: msg.model_provider,
        model_id: msg.model_id,
        agent_name: msg.agent_name,
        prompt_tokens,
        completion_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_json,
        cost_total,
        tool_call_id: msg.tool_call_id,
        tool_name: msg.tool_name,
        tool_args_json: msg.tool_args.map(|v| v.to_string()),
        tool_result_json: msg.tool_result.map(|v| v.to_string()),
        tool_status: msg.tool_is_error.map(|e| if e { "error" } else { "success" }.to_string()),
        edit_diff: None,
        edit_file_path: None,
        session_status: Some("active".to_string()),
        workflow_phase: Some("executing".to_string()),
        raw_event_json: None,
    })
}

pub struct MessageWriter {
    pub tx: mpsc::UnboundedSender<SessionMessage>,
}

impl MessageWriter {
    pub fn new(tx: mpsc::UnboundedSender<SessionMessage>) -> Self {
        Self { tx }
    }

    pub fn send(&self, message: SessionMessage) -> Result<(), ApiError> {
        self.tx.send(message).map_err(|_| {
            ApiError::internal("Message writer channel closed")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })
    }
}

pub fn start_message_writer(
    db: SqlitePool,
    sse_hub: Arc<RwLock<SseHub>>,
) -> MessageWriter {
    let (tx, mut rx) = mpsc::unbounded_channel::<SessionMessage>();

    tokio::spawn(async move {
        while let Some(mut message) = rx.recv().await {
            // Fetch next sequence number - this must succeed for message ordering
            let seq: i32 = match sqlx::query_scalar::<_, Option<i32>>(
                "SELECT MAX(seq) FROM session_messages WHERE session_id = ?",
            )
            .bind(&message.session_id)
            .fetch_one(&db)
            .await
            {
                Ok(current) => current.unwrap_or(0) + 1,
                Err(e) => {
                    warn!(
                        session_id = %message.session_id,
                        error = %e,
                        "Failed to fetch max seq for session, defaulting to 1"
                    );
                    1
                }
            };
            message.seq = seq;

            match create_session_message(&db, &message).await {
                Ok(created) => {
                    let hub = sse_hub.read().await;
                    hub.broadcast_message(&created).await;
                }
                Err(e) => {
                    warn!(
                        session_id = %message.session_id,
                        message_id = ?message.message_id,
                        seq = message.seq,
                        error = %e,
                        "Failed to write session message via serialized writer - message may be lost"
                    );
                }
            }
        }
    });

    MessageWriter::new(tx)
}

#[post("/internal/session-messages", data = "<body>")]
async fn receive_session_message(
    state: &State<AppStateType>,
    body: Json<IncomingMessage>,
) -> ApiResult<Json<Value>> {
    let incoming = body.into_inner();

    // User messages are already persisted by the backend's send_message handler.
    // Skip them here to prevent duplicates if the extension sends them.
    let role_lower = incoming.role.to_lowercase();
    if role_lower == "user" {
        return Ok(Json(json!({ "ok": true, "skipped": true })));
    }

    let session_message = convert_incoming(incoming)?;
    state.message_writer.send(session_message)?;
    Ok(Json(json!({ "ok": true })))
}

pub fn routes() -> Vec<Route> {
    routes![receive_session_message]
}
