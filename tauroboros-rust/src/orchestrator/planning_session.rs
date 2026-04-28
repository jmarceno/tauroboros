use crate::db::queries::create_session_message;
use crate::db::runtime::{
    get_next_session_message_seq, update_workflow_session_record, UpdateWorkflowSessionRecord,
};
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    MessageRole, MessageType, PiSessionStatus, PiWorkflowSession, SessionMessage, ThinkingLevel,
    WSMessage,
};
use crate::orchestrator::pi::ensure_structured_output_extension;
use crate::sse::hub::SseHub;
use rocket::serde::json::json;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch, Mutex, RwLock};
use tokio::time::{timeout, Duration};
use tracing::warn;
use uuid::Uuid;

const PROCESS_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
enum ProcessLine {
    Stdout(String),
    Stderr(String),
}

#[derive(Clone)]
pub struct ActivePlanningSession {
    #[allow(dead_code)]
    pub session_id: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    shutdown_tx: watch::Sender<bool>,
}

pub struct PlanningSessionManager {
    db: SqlitePool,
    sse_hub: Arc<RwLock<SseHub>>,
    project_root: String,
    sessions: Arc<Mutex<HashMap<String, Arc<ActivePlanningSession>>>>,
}

impl PlanningSessionManager {
    pub fn new(db: SqlitePool, sse_hub: Arc<RwLock<SseHub>>, project_root: String) -> Self {
        Self {
            db,
            sse_hub,
            project_root,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create_session(
        &self,
        session: &PiWorkflowSession,
        system_prompt: &str,
        model: &str,
    ) -> Result<(), ApiError> {
        let session_file = session.pi_session_file.clone().ok_or_else(|| {
            ApiError::internal("Workflow session is missing piSessionFile")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;
        let extension_path = ensure_structured_output_extension(&self.project_root).await?;

        if let Some(parent) = Path::new(&session_file).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                ApiError::internal(format!("Failed to create pi session directory: {}", error))
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;
        }

        let mut command =
            Command::new(std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string()));
        command
            .args(vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--session".to_string(),
                session_file.clone(),
                "--extension".to_string(),
                extension_path,
                "--system-prompt".to_string(),
                system_prompt.to_string(),
            ])
            .current_dir(&session.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PI_CODING_AGENT", "true");

        let mut child = command.spawn().map_err(|error| {
            ApiError::internal(format!("Failed to start planning pi process: {}", error))
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        let pid = child.id().map(|pid| pid as i32);
        let _ = update_workflow_session_record(
            &self.db,
            &session.id,
            UpdateWorkflowSessionRecord {
                status: Some(PiSessionStatus::Active),
                process_pid: Some(pid),
                ..Default::default()
            },
        )
        .await?;

        let mut stdin = child.stdin.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stdin")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stdout")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stderr")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        let (tx, rx) = mpsc::unbounded_channel();
        spawn_reader(stdout, tx.clone(), true);
        spawn_reader(stderr, tx, false);

        let (provider, model_id) = parse_model(model)?;
        send_rpc(
            &mut stdin,
            &json!({
                "type": "set_model",
                "id": "req_set_model",
                "provider": provider,
                "modelId": model_id,
            }),
        )
        .await?;

        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        tokio::spawn(event_processor(
            self.db.clone(),
            self.sse_hub.clone(),
            session.id.clone(),
            rx,
            shutdown_rx,
        ));

        let active = Arc::new(ActivePlanningSession {
            session_id: session.id.clone(),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            shutdown_tx: shutdown_tx.clone(),
        });

        self.sessions
            .lock()
            .await
            .insert(session.id.clone(), active);

        let hub = self.sse_hub.read().await;
        let _ = hub
            .broadcast(&WSMessage {
                r#type: "planning_session_updated".to_string(),
                payload: json!({ "sessionId": session.id, "status": "active" }),
            })
            .await;

        Ok(())
    }

    pub async fn send_message(
        &self,
        session_id: &str,
        content: &str,
        context_attachments: Option<&Vec<Value>>,
    ) -> Result<(), ApiError> {
        let active = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                ApiError::conflict("Planning session is not active")
                    .with_code(ErrorCode::PlanningSessionNotActive)
            })?;

        let seq = get_next_session_message_seq(&self.db, session_id).await?;
        let now = chrono::Utc::now().timestamp();

        let mut attachments = Vec::new();
        if let Some(attachments_list) = context_attachments {
            for attachment in attachments_list {
                attachments.push(attachment.clone());
            }
        }

        let mut content_obj = serde_json::Map::new();
        content_obj.insert("text".to_string(), Value::String(content.to_string()));
        if !attachments.is_empty() {
            content_obj.insert("attachments".to_string(), Value::Array(attachments.clone()));
        }

        let user_msg = SessionMessage {
            id: 0,
            seq,
            message_id: Some(Uuid::new_v4().to_string()),
            session_id: session_id.to_string(),
            task_id: None,
            task_run_id: None,
            timestamp: now,
            role: MessageRole::User,
            event_name: Some("user_message".to_string()),
            message_type: MessageType::UserPrompt,
            content_json: Value::Object(content_obj).to_string(),
            model_provider: None,
            model_id: None,
            agent_name: None,
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            total_tokens: None,
            cost_json: None,
            cost_total: None,
            tool_call_id: None,
            tool_name: None,
            tool_args_json: None,
            tool_result_json: None,
            tool_status: None,
            edit_diff: None,
            edit_file_path: None,
            session_status: Some("active".to_string()),
            workflow_phase: Some("planning".to_string()),
            raw_event_json: None,
        };

        let created = create_session_message(&self.db, &user_msg).await?;
        {
            let hub = self.sse_hub.read().await;
            hub.broadcast(&WSMessage {
                r#type: "planning_session_message".to_string(),
                payload: json!({
                    "sessionId": session_id,
                    "message": &created,
                }),
            })
            .await;
        }

        let mut full_content = content.to_string();
        if !attachments.is_empty() {
            full_content.push_str("\n\n---\n\n**Context Attachments:**\n");
            for attachment in &attachments {
                let name = attachment
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let atype = attachment
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                full_content.push_str(&format!("\n[{}: {}]\n", atype.to_uppercase(), name));
                if let Some(image_data) = attachment.get("imageData").and_then(Value::as_str) {
                    full_content.push_str(&format!("[Image: {}]\n{}\n", name, image_data));
                } else if let Some(attachment_content) =
                    attachment.get("content").and_then(Value::as_str)
                {
                    full_content.push_str(&format!("```\n{}\n```\n", attachment_content));
                }
            }
        }

        let mut stdin = active.stdin.lock().await;
        send_rpc(
            &mut stdin,
            &json!({
                "type": "prompt",
                "id": format!("req_prompt_{}", seq),
                "message": full_content,
            }),
        )
        .await?;

        Ok(())
    }

    pub async fn stop_session(&self, session_id: &str) -> Result<(), ApiError> {
        let active = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                ApiError::conflict("Planning session not found or already closed")
                    .with_code(ErrorCode::SessionNotFound)
            })?;

        active.shutdown_tx.send(true).ok();

        let mut child = active.child.lock().await;
        let _ = child.kill().await;

        let now = chrono::Utc::now().timestamp();
        let _ = update_workflow_session_record(
            &self.db,
            session_id,
            UpdateWorkflowSessionRecord {
                status: Some(PiSessionStatus::Aborted),
                finished_at: Some(Some(now)),
                exit_signal: Some(Some("SIGKILL".to_string())),
                ..Default::default()
            },
        )
        .await?;

        self.sessions.lock().await.remove(session_id);

        let hub = self.sse_hub.read().await;
        let _ = hub
            .broadcast(&WSMessage {
                r#type: "planning_session_stopped".to_string(),
                payload: json!({ "id": session_id }),
            })
            .await;

        Ok(())
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), ApiError> {
        if let Some(active) = self.sessions.lock().await.remove(session_id) {
            active.shutdown_tx.send(true).ok();

            {
                let mut stdin = active.stdin.lock().await;
                let _ = stdin.shutdown().await;
            }

            let mut child = active.child.lock().await;
            match timeout(PROCESS_SHUTDOWN_TIMEOUT, child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    warn!(session_id = %session_id, error = %error, "Failed waiting for planning Pi process exit");
                }
                Err(_) => {
                    warn!(session_id = %session_id, "Planning Pi process did not exit gracefully; killing");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }

        let now = chrono::Utc::now().timestamp();
        let _ = update_workflow_session_record(
            &self.db,
            session_id,
            UpdateWorkflowSessionRecord {
                status: Some(PiSessionStatus::Completed),
                finished_at: Some(Some(now)),
                ..Default::default()
            },
        )
        .await?;

        let hub = self.sse_hub.read().await;
        let _ = hub
            .broadcast(&WSMessage {
                r#type: "planning_session_closed".to_string(),
                payload: json!({ "id": session_id }),
            })
            .await;

        Ok(())
    }

    pub async fn change_model(
        &self,
        session_id: &str,
        model: Option<&str>,
        thinking_level: Option<ThinkingLevel>,
    ) -> Result<(), ApiError> {
        let active = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                ApiError::conflict("Planning session is not active")
                    .with_code(ErrorCode::PlanningSessionNotActive)
            })?;

        let mut stdin = active.stdin.lock().await;

        if let Some(model_str) = model {
            let (provider, model_id) = parse_model(model_str)?;
            send_rpc(
                &mut stdin,
                &json!({
                    "type": "set_model",
                    "id": "req_set_model",
                    "provider": provider,
                    "modelId": model_id,
                }),
            )
            .await?;
        }

        if let Some(level) = thinking_level {
            if level != ThinkingLevel::Default {
                send_rpc(
                    &mut stdin,
                    &json!({
                        "type": "set_thinking_level",
                        "id": "req_set_thinking",
                        "level": match level {
                            ThinkingLevel::Default => "default",
                            ThinkingLevel::Low => "low",
                            ThinkingLevel::Medium => "medium",
                            ThinkingLevel::High => "high",
                        },
                    }),
                )
                .await?;
            }
        }

        Ok(())
    }

    pub async fn reconnect_session(
        &self,
        session_id: &str,
        system_prompt: &str,
        model: &str,
    ) -> Result<(), ApiError> {
        if self.sessions.lock().await.contains_key(session_id) {
            return Ok(());
        }

        let session: Option<PiWorkflowSession> = sqlx::query_as(
            "SELECT * FROM pi_workflow_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(&self.db)
        .await
        .map_err(|e| {
            ApiError::internal(format!("Failed to fetch session for reconnect: {}", e))
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        let session = session.ok_or_else(|| {
            ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
        })?;

        let session_file = session.pi_session_file.clone().ok_or_else(|| {
            ApiError::internal("Workflow session is missing piSessionFile")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        let extension_path = ensure_structured_output_extension(&self.project_root).await?;

        if let Some(parent) = Path::new(&session_file).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                ApiError::internal(format!(
                    "Failed to create pi session directory: {}",
                    error
                ))
                .with_code(ErrorCode::ExecutionOperationFailed)
            })?;
        }

        let mut command =
            Command::new(std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string()));
        command
            .args(vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--session".to_string(),
                session_file,
                "--extension".to_string(),
                extension_path,
                "--system-prompt".to_string(),
                system_prompt.to_string(),
            ])
            .current_dir(&session.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PI_CODING_AGENT", "true");

        let mut child = command.spawn().map_err(|error| {
            ApiError::internal(format!(
                "Failed to start planning pi process during reconnect: {}",
                error
            ))
            .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        let pid = child.id().map(|pid| pid as i32);
        let _ = update_workflow_session_record(
            &self.db,
            session_id,
            UpdateWorkflowSessionRecord {
                status: Some(PiSessionStatus::Active),
                process_pid: Some(pid),
                ..Default::default()
            },
        )
        .await?;

        let mut stdin = child.stdin.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stdin during reconnect")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stdout during reconnect")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stderr during reconnect")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        let (tx, rx) = mpsc::unbounded_channel();
        spawn_reader(stdout, tx.clone(), true);
        spawn_reader(stderr, tx, false);

        let (provider, model_id) = parse_model(model)?;
        send_rpc(
            &mut stdin,
            &json!({
                "type": "set_model",
                "id": "req_set_model",
                "provider": provider,
                "modelId": model_id,
            }),
        )
        .await?;

        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        tokio::spawn(event_processor(
            self.db.clone(),
            self.sse_hub.clone(),
            session_id.to_string(),
            rx,
            shutdown_rx,
        ));

        let active = Arc::new(ActivePlanningSession {
            session_id: session_id.to_string(),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            shutdown_tx,
        });

        self.sessions
            .lock()
            .await
            .insert(session_id.to_string(), active);

        let hub = self.sse_hub.read().await;
        let _ = hub
            .broadcast(&WSMessage {
                r#type: "planning_session_updated".to_string(),
                payload: json!({ "sessionId": session_id, "status": "active" }),
            })
            .await;

        Ok(())
    }

    pub async fn has_active_session(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }

    #[allow(dead_code)]
    pub async fn cleanup_all(&self) {
        let session_ids: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        for id in session_ids {
            let _ = self.stop_session(&id).await;
        }
    }
}

async fn event_processor(
    db: SqlitePool,
    sse_hub: Arc<RwLock<SseHub>>,
    session_id: String,
    mut rx: mpsc::UnboundedReceiver<ProcessLine>,
    shutdown_rx: watch::Receiver<bool>,
) {
    let mut shutdown_rx = shutdown_rx;
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
            }
            maybe_line = rx.recv() => {
                let line = match maybe_line {
                    Some(line) => line,
                    None => break,
                };

                match line {
                    ProcessLine::Stdout(content) => {
                        if let Ok(event) = serde_json::from_str::<Value>(&content) {
                            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                            if event_type == "response" {
                                continue;
                            }
                            let seq = match get_next_session_message_seq(&db, &session_id).await {
                                Ok(s) => s,
                                Err(_) => continue,
                            };
                            let session = get_session_lightweight(&db, &session_id).await;
                            let msg = match session {
                                Some(ref session) => project_event_to_planning_message(session, seq, &event),
                                None => continue,
                            };
                            if let Ok(msg) = msg {
                                let created = create_session_message(&db, &msg).await;
                                if let Ok(ref message) = created {
                                    let hub = sse_hub.read().await;
                                    let _ = hub.broadcast(&WSMessage {
                                        r#type: "planning_session_message".to_string(),
                                        payload: json!({
                                            "sessionId": session_id,
                                            "message": message,
                                        }),
                                    }).await;
                                }
                            }
                        }
                    }
                    ProcessLine::Stderr(content) => {
                        warn!(session_id = %session_id, stderr = %content, "Planning Pi stderr");
                    }
                }
            }
        }
    }
}

async fn get_session_lightweight(
    db: &SqlitePool,
    session_id: &str,
) -> Option<crate::models::PiWorkflowSession> {
    sqlx::query_as("SELECT * FROM pi_workflow_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(db)
        .await
        .ok()?
}

fn project_event_to_planning_message(
    session: &PiWorkflowSession,
    seq: i32,
    event: &Value,
) -> Result<SessionMessage, ApiError> {
    let event_obj = event.as_object().cloned().unwrap_or_default();
    let assistant_event = event_obj
        .get("assistantMessageEvent")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let message_obj = event_obj
        .get("message")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let event_type = event_obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("session_status");
    let assistant_type = assistant_event.get("type").and_then(Value::as_str);
    let raw_role = message_obj
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| event_obj.get("role").and_then(Value::as_str));

    let role = match raw_role {
        Some("user") => MessageRole::User,
        Some("assistant") => MessageRole::Assistant,
        Some("tool") | Some("toolResult") => MessageRole::Tool,
        Some("system") => MessageRole::System,
        _ if event_type.starts_with("tool_execution") => MessageRole::Tool,
        _ if event_type == "message_update" => MessageRole::Assistant,
        _ => MessageRole::System,
    };

    let message_type = if let Some(assistant_type) = assistant_type {
        if assistant_type.starts_with("thinking") {
            MessageType::Thinking
        } else if assistant_type.starts_with("toolcall") {
            MessageType::ToolCall
        } else if assistant_type.ends_with("_delta") || assistant_type.ends_with("_start") {
            MessageType::MessagePart
        } else if assistant_type == "text_complete" || assistant_type == "text" {
            MessageType::AssistantResponse
        } else {
            MessageType::SessionStatus
        }
    } else {
        match event_type {
            "tool_execution_start" => MessageType::ToolCall,
            "tool_execution_end" => MessageType::ToolResult,
            "extension_ui_request" => MessageType::PermissionAsked,
            "extension_ui_response" => MessageType::PermissionReplied,
            "agent_start" | "turn_start" => MessageType::StepStart,
            "agent_end" | "turn_end" => MessageType::StepFinish,
            value if value.contains("error") => MessageType::SessionError,
            _ => MessageType::SessionStatus,
        }
    };

    let message_id = event_obj
        .get("messageId")
        .and_then(Value::as_str)
        .or_else(|| assistant_event.get("messageId").and_then(Value::as_str))
        .or_else(|| message_obj.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let text = extract_text_fragment(event)
        .or_else(|| {
            event_obj
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    let mut content = serde_json::Map::new();
    content.insert("text".to_string(), Value::String(text));
    content.insert(
        "eventType".to_string(),
        Value::String(event_type.to_string()),
    );
    content.insert(
        "assistantEventType".to_string(),
        assistant_type
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
    );
    content.insert("rawEvent".to_string(), event.clone());

    Ok(SessionMessage {
        id: 0,
        seq,
        message_id: Some(message_id),
        session_id: session.id.clone(),
        task_id: session.task_id.clone(),
        task_run_id: session.task_run_id.clone(),
        timestamp: normalize_timestamp(event_obj.get("timestamp")),
        role,
        event_name: Some(match assistant_type {
            Some(assistant_type) if event_type == "message_update" => {
                format!("{}:{}", event_type, assistant_type)
            }
            _ => event_type.to_string(),
        }),
        message_type,
        content_json: Value::Object(content).to_string(),
        model_provider: event_obj
            .get("provider")
            .and_then(Value::as_str)
            .map(str::to_string),
        model_id: event_obj
            .get("modelId")
            .or_else(|| event_obj.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string),
        agent_name: event_obj
            .get("agentName")
            .and_then(Value::as_str)
            .map(str::to_string),
        prompt_tokens: None,
        completion_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        total_tokens: None,
        cost_json: None,
        cost_total: None,
        tool_call_id: event_obj
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name: event_obj
            .get("toolName")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_args_json: event_obj.get("args").cloned().map(|v| v.to_string()),
        tool_result_json: event_obj.get("result").cloned().map(|v| v.to_string()),
        tool_status: None,
        edit_diff: None,
        edit_file_path: None,
        session_status: Some("active".to_string()),
        workflow_phase: Some("planning".to_string()),
        raw_event_json: Some(event.to_string()),
    })
}

fn extract_text_fragment(event: &Value) -> Option<String> {
    let assistant = event.get("assistantMessageEvent")?;
    if let Some(delta) = assistant.get("delta").and_then(Value::as_str) {
        return Some(delta.to_string());
    }
    if let Some(text) = assistant.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    None
}

fn normalize_timestamp(value: Option<&Value>) -> i64 {
    match value.and_then(Value::as_i64) {
        Some(timestamp) if timestamp > 1_000_000_000_000 => timestamp / 1000,
        Some(timestamp) => timestamp,
        None => chrono::Utc::now().timestamp(),
    }
}

fn parse_model(model: &str) -> Result<(String, String), ApiError> {
    let trimmed = model.trim();
    let (provider, model_id) = trimmed.split_once('/').ok_or_else(|| {
        ApiError::bad_request(format!(
            "Invalid model format '{}'. Expected 'provider/modelId'.",
            trimmed
        ))
        .with_code(ErrorCode::InvalidModel)
    })?;

    if provider.trim().is_empty() || model_id.trim().is_empty() {
        return Err(ApiError::bad_request(format!(
            "Invalid model format '{}'. Expected 'provider/modelId'.",
            trimmed
        ))
        .with_code(ErrorCode::InvalidModel));
    }

    Ok((provider.to_string(), model_id.to_string()))
}

async fn send_rpc(stdin: &mut tokio::process::ChildStdin, payload: &Value) -> Result<(), ApiError> {
    let line = format!(
        "{}\n",
        serde_json::to_string(payload).map_err(|e| {
            ApiError::internal(format!("Failed to serialize RPC payload: {}", e))
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?
    );
    stdin.write_all(line.as_bytes()).await.map_err(|error| {
        ApiError::internal(format!("Failed to write to planning pi stdin: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    stdin.flush().await.map_err(|error| {
        ApiError::internal(format!("Failed to flush planning pi stdin: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    Ok(())
}

fn spawn_reader<T>(stream: T, tx: mpsc::UnboundedSender<ProcessLine>, is_stdout: bool)
where
    T: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let _ = if is_stdout {
                        tx.send(ProcessLine::Stdout(line))
                    } else {
                        tx.send(ProcessLine::Stderr(line))
                    };
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    });
}
