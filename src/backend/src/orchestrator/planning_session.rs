use crate::db::queries::create_session_message;
use crate::db::runtime::{
    get_next_session_message_seq, update_workflow_session_record, UpdateWorkflowSessionRecord,
};
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    MessageRole, MessageType, PiSessionStatus, PiWorkflowSession, SessionMessage, ThinkingLevel,
    WSMessage,
};
use crate::orchestrator::pi::ensure_pi_extensions;
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
use tokio::sync::{watch, Mutex, RwLock};
use tokio::time::{timeout, Duration};
use tracing::warn;
use uuid::Uuid;

const PROCESS_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

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
        let extension_paths = ensure_pi_extensions(&self.project_root).await?;

        if let Some(parent) = Path::new(&session_file).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                ApiError::internal(format!("Failed to create pi session directory: {}", error))
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;
        }

        let mut args = vec![
            "--mode".to_string(),
            "rpc".to_string(),
            "--session".to_string(),
            session_file.clone(),
        ];
        for ext_path in &extension_paths {
            args.push("--extension".to_string());
            args.push(ext_path.clone());
        }
        args.push("--system-prompt".to_string());
        args.push(system_prompt.to_string());

        let mut command =
            Command::new(std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string()));
        command
            .args(args)
            .current_dir(&session.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PI_CODING_AGENT", "true")
            .env("TAUROBOROS_PORT", std::env::var("SERVER_PORT").unwrap_or_else(|_| std::env::var("PORT").unwrap_or_else(|_| "3789".to_string())))
            .env("TAUROBOROS_SESSION_ID", &session.id)
            .env("TAUROBOROS_TASK_ID", session.task_id.as_deref().unwrap_or(""))
            .env("TAUROBOROS_TASK_RUN_ID", session.task_run_id.as_deref().unwrap_or(""));

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
        let stderr = child.stderr.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stderr")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                warn!(stderr = %line, "Planning Pi stderr");
            }
        });

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

        let (shutdown_tx, _shutdown_rx) = watch::channel(false);

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

        let session: Option<PiWorkflowSession> =
            sqlx::query_as("SELECT * FROM pi_workflow_sessions WHERE id = ?")
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

        let extension_paths = ensure_pi_extensions(&self.project_root).await?;

        if let Some(parent) = Path::new(&session_file).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                ApiError::internal(format!("Failed to create pi session directory: {}", error))
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;
        }

        let mut args = vec![
            "--mode".to_string(),
            "rpc".to_string(),
            "--session".to_string(),
            session_file,
        ];
        for ext_path in &extension_paths {
            args.push("--extension".to_string());
            args.push(ext_path.clone());
        }
        args.push("--system-prompt".to_string());
        args.push(system_prompt.to_string());

        let mut command =
            Command::new(std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string()));
        command
            .args(args)
            .current_dir(&session.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PI_CODING_AGENT", "true")
            .env("TAUROBOROS_PORT", std::env::var("SERVER_PORT").unwrap_or_else(|_| std::env::var("PORT").unwrap_or_else(|_| "3789".to_string())))
            .env("TAUROBOROS_SESSION_ID", &session.id)
            .env("TAUROBOROS_TASK_ID", session.task_id.as_deref().unwrap_or(""))
            .env("TAUROBOROS_TASK_RUN_ID", session.task_run_id.as_deref().unwrap_or(""));

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
        let stderr = child.stderr.take().ok_or_else(|| {
            ApiError::internal("Failed to capture planning pi stderr during reconnect")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                warn!(stderr = %line, "Planning Pi stderr");
            }
        });

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

        let (shutdown_tx, _shutdown_rx) = watch::channel(false);

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


