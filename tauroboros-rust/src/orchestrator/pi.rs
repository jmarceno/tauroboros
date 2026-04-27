use crate::audit::{record_audit_event, CreateAuditEvent};
use crate::db::queries::create_session_message;
use crate::db::runtime::{
    get_next_session_message_seq, update_workflow_session_record, UpdateWorkflowSessionRecord,
};
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    AuditLevel, MessageRole, MessageType, PiSessionStatus, PiWorkflowSession, SessionMessage,
    ThinkingLevel,
};
use crate::sse::hub::SseHub;
use rocket::serde::json::json;
use serde_json::{Map, Value};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch, RwLock};
use tokio::time::{timeout, Duration};
use tracing::warn;
use uuid::Uuid;

const STRUCTURED_OUTPUT_EXTENSION_SOURCE: &str =
    include_str!("../../../extensions/pi-tools/structured-output.ts");
const STRUCTURED_OUTPUT_EXTENSION_RELATIVE_PATH: [&str; 4] = [
    ".pi",
    "extensions",
    "pi-tools",
    "structured-output.ts",
];
const MODEL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
const THINKING_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
const PROMPT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
const PROMPT_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const PROCESS_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
enum ProcessLine {
    Stdout(String),
    Stderr(String),
}

#[derive(Debug, Default)]
struct ProcessExitMetadata {
    exit_code: Option<i32>,
    exit_signal: Option<String>,
}

#[derive(Clone)]
pub struct PiSessionExecutor {
    db: SqlitePool,
    sse_hub: Arc<RwLock<SseHub>>,
    project_root: String,
}

impl PiSessionExecutor {
    pub fn new(db: SqlitePool, sse_hub: Arc<RwLock<SseHub>>, project_root: String) -> Self {
        Self {
            db,
            sse_hub,
            project_root,
        }
    }

    async fn audit_event(
        &self,
        level: AuditLevel,
        event_type: &'static str,
        message: impl Into<String>,
        session: &PiWorkflowSession,
        details: Value,
    ) -> Result<(), ApiError> {
        record_audit_event(
            &self.db,
            CreateAuditEvent {
                level,
                source: "pi",
                event_type,
                message: message.into(),
                run_id: None,
                task_id: session.task_id.clone(),
                task_run_id: session.task_run_id.clone(),
                session_id: Some(session.id.clone()),
                details: Some(details),
            },
        )
        .await
        .map(|_| ())
    }

    async fn audit_info(
        &self,
        event_type: &'static str,
        message: impl Into<String>,
        session: &PiWorkflowSession,
        details: Value,
    ) -> Result<(), ApiError> {
        self.audit_event(AuditLevel::Info, event_type, message, session, details)
            .await
    }

    async fn audit_error(
        &self,
        event_type: &'static str,
        message: impl Into<String>,
        session: &PiWorkflowSession,
        details: Value,
    ) -> Result<(), ApiError> {
        self.audit_event(AuditLevel::Error, event_type, message, session, details)
            .await
    }

    pub async fn run_prompt(
        &self,
        session: PiWorkflowSession,
        model: &str,
        prompt_text: &str,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<String, ApiError> {
        let (provider, model_id) = parse_model(model)?;
        self.audit_info(
            "session.run_requested",
            format!("Starting Pi session {}", session.id),
            &session,
            json!({
                "cwd": session.cwd,
                "branch": session.branch,
                "model": model,
                "sessionFile": session.pi_session_file,
                "extensionPath": structured_output_extension_path(&self.project_root).to_string_lossy().to_string()
            }),
        )
        .await?;

        let (mut child, mut stdin, mut rx) = match spawn_process(&session, &self.project_root).await {
            Ok(process) => process,
            Err(error) => {
                self.audit_error(
                    "session.process_spawn_failed",
                    format!("Failed to start Pi process for session {}", session.id),
                    &session,
                    json!({
                        "cwd": session.cwd,
                        "sessionFile": session.pi_session_file,
                        "error": error.to_string()
                    }),
                )
                .await?;
                return Err(error);
            }
        };

        let pid = child.id().map(|pid| pid as i32);
        let updated_session = update_workflow_session_record(
            &self.db,
            &session.id,
            UpdateWorkflowSessionRecord {
                status: Some(PiSessionStatus::Active),
                process_pid: Some(pid),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::internal("Failed to update session after starting pi process"))?;

        let hub = self.sse_hub.read().await;
        hub.broadcast_status(&updated_session.id, "active", updated_session.finished_at)
            .await;
        drop(hub);

        self.audit_info(
            "session.process_spawned",
            format!("Pi process started for session {}", updated_session.id),
            &updated_session,
            json!({
                "pid": pid,
                "cwd": updated_session.cwd,
                "branch": updated_session.branch,
                "sessionFile": updated_session.pi_session_file,
                "model": updated_session.model
            }),
        )
        .await?;

        let result: Result<String, ApiError> = async {
            send_request(
                &mut stdin,
                &json!({
                    "type": "set_model",
                    "id": "req_set_model",
                    "provider": provider,
                    "modelId": model_id,
                }),
            )
            .await?;
            self.wait_for_response(
                &updated_session,
                &mut child,
                &mut rx,
                stop_rx.clone(),
                "req_set_model",
                MODEL_RESPONSE_TIMEOUT,
            )
            .await?;

            if updated_session.thinking_level != ThinkingLevel::Default {
                send_request(
                    &mut stdin,
                    &json!({
                        "type": "set_thinking_level",
                        "id": "req_set_thinking",
                        "level": format_thinking_level(updated_session.thinking_level),
                    }),
                )
                .await?;
                self.wait_for_response(
                    &updated_session,
                    &mut child,
                    &mut rx,
                    stop_rx.clone(),
                    "req_set_thinking",
                    THINKING_RESPONSE_TIMEOUT,
                )
                .await?;
            }

            send_request(
                &mut stdin,
                &json!({
                    "type": "prompt",
                    "id": "req_prompt",
                    "message": prompt_text,
                }),
            )
            .await?;
            self.wait_for_response(
                &updated_session,
                &mut child,
                &mut rx,
                stop_rx.clone(),
                "req_prompt",
                PROMPT_RESPONSE_TIMEOUT,
            )
            .await?;

            self.collect_until_idle(&updated_session, &mut child, &mut rx, stop_rx)
                .await
        }
        .await;

        let exit_metadata = shutdown_process(&updated_session, &mut child, stdin).await;
        let finished_at = chrono::Utc::now().timestamp();
        let (session_status, session_status_label, session_error_message) = match &result {
            Ok(_) => (PiSessionStatus::Completed, "completed", None),
            Err(error) => (PiSessionStatus::Failed, "failed", Some(error.to_string())),
        };

        let completed = update_workflow_session_record(
            &self.db,
            &updated_session.id,
            UpdateWorkflowSessionRecord {
                status: Some(session_status),
                process_pid: Some(None),
                finished_at: Some(Some(finished_at)),
                exit_code: Some(exit_metadata.exit_code),
                exit_signal: Some(exit_metadata.exit_signal.clone()),
                error_message: Some(session_error_message.clone()),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::internal("Failed to finalize session record"))?;

        let hub = self.sse_hub.read().await;
        hub.broadcast_status(
            &completed.id,
            session_status_label,
            completed.finished_at,
        )
        .await;

        self.audit_event(
            if matches!(result, Ok(_)) {
                AuditLevel::Info
            } else {
                AuditLevel::Error
            },
            "session.process_exited",
            format!(
                "Pi process finished for session {} with code {:?}",
                completed.id,
                completed.exit_code
            ),
            &completed,
            json!({
                "status": completed.status,
                "exitCode": completed.exit_code,
                "exitSignal": completed.exit_signal,
                "responseLength": result.as_ref().map(|response| response.trim().len()).unwrap_or(0),
                "error": session_error_message
            }),
        )
        .await?;

        match result {
            Ok(response_text) => Ok(response_text.trim().to_string()),
            Err(error) => Err(error),
        }
    }

    async fn wait_for_response(
        &self,
        session: &PiWorkflowSession,
        child: &mut Child,
        rx: &mut mpsc::UnboundedReceiver<ProcessLine>,
        mut stop_rx: watch::Receiver<bool>,
        expected_id: &str,
        timeout_duration: Duration,
    ) -> Result<Value, ApiError> {
        let response_timeout = tokio::time::sleep(timeout_duration);
        tokio::pin!(response_timeout);
        loop {
            tokio::select! {
                _ = &mut response_timeout => {
                    return Err(
                        ApiError::internal(format!(
                            "Timed out waiting for Pi RPC response {} for session {}",
                            expected_id,
                            session.id
                        ))
                        .with_code(ErrorCode::ExecutionOperationFailed)
                    );
                }
                changed = stop_rx.changed() => {
                    if changed.is_ok() && *stop_rx.borrow() {
                        return interrupt_session(&self.db, session, child)
                            .await
                            .map(|_| Value::Null);
                    }
                }
                maybe_line = rx.recv() => {
                    let line = maybe_line.ok_or_else(|| {
                        ApiError::internal(format!("pi process stream ended before response {}", expected_id))
                            .with_code(ErrorCode::ExecutionOperationFailed)
                    })?;

                    match line {
                        ProcessLine::Stdout(content) => {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
                                if parsed.get("type").and_then(Value::as_str) == Some("response")
                                    && parsed.get("id").and_then(Value::as_str) == Some(expected_id)
                                {
                                    if parsed.get("success").and_then(Value::as_bool) == Some(false) {
                                        let message = parsed
                                            .get("error")
                                            .map(Value::to_string)
                                            .unwrap_or_else(|| "pi rpc call failed".to_string());
                                        self.audit_error(
                                            "session.rpc_request_failed",
                                            format!("Pi RPC request {} failed for session {}", expected_id, session.id),
                                            session,
                                            json!({
                                                "requestId": expected_id,
                                                "response": parsed,
                                                "error": message
                                            }),
                                        )
                                        .await?;
                                        return Err(ApiError::internal(message).with_code(ErrorCode::ExecutionOperationFailed));
                                    }
                                    return Ok(parsed.get("data").cloned().unwrap_or(Value::Null));
                                }

                                self.persist_event_message(session, parsed).await?;
                            }
                        }
                        ProcessLine::Stderr(content) => {
                            self.persist_stderr_message(session, &content).await?;
                        }
                    }
                }
            }
        }
    }

    async fn collect_until_idle(
        &self,
        session: &PiWorkflowSession,
        child: &mut Child,
        rx: &mut mpsc::UnboundedReceiver<ProcessLine>,
        mut stop_rx: watch::Receiver<bool>,
    ) -> Result<String, ApiError> {
        let mut response_text = String::new();
        let idle_timeout = tokio::time::sleep(PROMPT_IDLE_TIMEOUT);
        tokio::pin!(idle_timeout);

        loop {
            tokio::select! {
                _ = &mut idle_timeout => {
                    return Err(
                        ApiError::internal(format!(
                            "Timed out waiting for agent_end for session {}",
                            session.id
                        ))
                        .with_code(ErrorCode::ExecutionOperationFailed)
                    );
                }
                changed = stop_rx.changed() => {
                    if changed.is_ok() && *stop_rx.borrow() {
                        return interrupt_session(&self.db, session, child).await;
                    }
                }
                maybe_line = rx.recv() => {
                    let line = maybe_line.ok_or_else(|| {
                        ApiError::internal("pi process stream ended before agent_end")
                            .with_code(ErrorCode::ExecutionOperationFailed)
                    })?;

                    match line {
                        ProcessLine::Stdout(content) => {
                            let parsed = match serde_json::from_str::<Value>(&content) {
                                Ok(value) => value,
                                Err(_) => {
                                    self.persist_stderr_message(session, &content).await?;
                                    continue;
                                }
                            };

                            if let Some(fragment) = extract_text_fragment(&parsed) {
                                response_text.push_str(&fragment);
                            }

                            let event_type = parsed.get("type").and_then(Value::as_str);
                            self.persist_event_message(session, parsed.clone()).await?;
                            if event_type == Some("agent_end") {
                                return Ok(response_text);
                            }
                        }
                        ProcessLine::Stderr(content) => {
                            self.persist_stderr_message(session, &content).await?;
                        }
                    }
                }
            }
        }
    }

    async fn persist_event_message(&self, session: &PiWorkflowSession, event: Value) -> Result<(), ApiError> {
        let seq = get_next_session_message_seq(&self.db, &session.id).await?;
        let message = project_event_to_message(session, seq, event)?;
        let created = create_session_message(&self.db, &message).await?;

        let hub = self.sse_hub.read().await;
        hub.broadcast_message(&created).await;

        Ok(())
    }

    async fn persist_stderr_message(&self, session: &PiWorkflowSession, content: &str) -> Result<(), ApiError> {
        warn!(
            session_id = %session.id,
            task_id = ?session.task_id,
            task_run_id = ?session.task_run_id,
            stderr = %content,
            "Pi stderr"
        );

        let seq = get_next_session_message_seq(&self.db, &session.id).await?;
        let now = chrono::Utc::now().timestamp();
        let message = SessionMessage {
            id: 0,
            seq,
            message_id: Some(Uuid::new_v4().to_string()),
            session_id: session.id.clone(),
            task_id: session.task_id.clone(),
            task_run_id: session.task_run_id.clone(),
            timestamp: now,
            role: MessageRole::System,
            event_name: Some("stderr".to_string()),
            message_type: MessageType::SessionError,
            content_json: json!({ "text": content, "stream": "stderr" }).to_string(),
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
            workflow_phase: Some("executing".to_string()),
            raw_event_json: None,
        };
        let created = create_session_message(&self.db, &message).await?;
        let hub = self.sse_hub.read().await;
        hub.broadcast_message(&created).await;
        Ok(())
    }
}

async fn spawn_process(
    session: &PiWorkflowSession,
    project_root: &str,
) -> Result<(Child, tokio::process::ChildStdin, mpsc::UnboundedReceiver<ProcessLine>), ApiError> {
    let session_file = session.pi_session_file.clone().ok_or_else(|| {
        ApiError::internal("Workflow session is missing piSessionFile")
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    let extension_path = ensure_structured_output_extension(project_root).await?;

    if let Some(parent) = Path::new(&session_file).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            ApiError::internal(format!("Failed to create pi session directory: {}", error))
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;
    }

    let mut command = Command::new(std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string()));
    command
        .args(build_pi_args(&session_file, &extension_path))
        .current_dir(&session.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PI_CODING_AGENT", "true");

    let mut child = command.spawn().map_err(|error| {
        ApiError::internal(format!("Failed to start pi process: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;

    let stdin = child.stdin.take().ok_or_else(|| {
        ApiError::internal("Failed to capture pi stdin")
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ApiError::internal("Failed to capture pi stdout")
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ApiError::internal("Failed to capture pi stderr")
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;

    let (tx, rx) = mpsc::unbounded_channel();
    spawn_reader(stdout, tx.clone(), true);
    spawn_reader(stderr, tx, false);

    Ok((child, stdin, rx))
}

pub async fn ensure_structured_output_extension(project_root: &str) -> Result<String, ApiError> {
    let extension_path = structured_output_extension_path(project_root);
    let extension_dir = extension_path.parent().ok_or_else(|| {
        ApiError::internal(format!(
            "Failed to resolve directory for structured output extension at {}",
            extension_path.display()
        ))
        .with_code(ErrorCode::ExecutionOperationFailed)
    })?;

    tokio::fs::create_dir_all(extension_dir)
        .await
        .map_err(|error| {
            ApiError::internal(format!(
                "Failed to create structured output extension directory {}: {}",
                extension_dir.display(),
                error
            ))
            .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

    tokio::fs::write(&extension_path, STRUCTURED_OUTPUT_EXTENSION_SOURCE)
        .await
        .map_err(|error| {
            ApiError::internal(format!(
                "Failed to write structured output extension to {}: {}",
                extension_path.display(),
                error
            ))
            .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

    Ok(extension_path.to_string_lossy().to_string())
}

fn structured_output_extension_path(project_root: &str) -> PathBuf {
    let mut path = PathBuf::from(project_root);
    for segment in STRUCTURED_OUTPUT_EXTENSION_RELATIVE_PATH {
        path.push(segment);
    }
    path
}

fn build_pi_args(session_file: &str, extension_path: &str) -> Vec<String> {
    vec![
        "--mode".to_string(),
        "rpc".to_string(),
        "--session".to_string(),
        session_file.to_string(),
        "--extension".to_string(),
        extension_path.to_string(),
    ]
}

fn spawn_reader<T>(stream: T, tx: mpsc::UnboundedSender<ProcessLine>, stdout: bool)
where
    T: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let _ = if stdout {
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

async fn send_request(stdin: &mut tokio::process::ChildStdin, payload: &Value) -> Result<(), ApiError> {
    let line = format!("{}\n", payload);
    stdin.write_all(line.as_bytes()).await.map_err(|error| {
        ApiError::internal(format!("Failed to write to pi stdin: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    stdin.flush().await.map_err(|error| {
        ApiError::internal(format!("Failed to flush pi stdin: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    Ok(())
}

async fn shutdown_process(
    session: &PiWorkflowSession,
    child: &mut Child,
    stdin: tokio::process::ChildStdin,
) -> ProcessExitMetadata {
    drop(stdin);

    match timeout(PROCESS_SHUTDOWN_TIMEOUT, child.wait()).await {
        Ok(Ok(exit_status)) => ProcessExitMetadata {
            exit_code: exit_status.code(),
            exit_signal: None,
        },
        Ok(Err(error)) => {
            warn!(session_id = %session.id, error = %error, "Failed waiting for Pi process exit");
            ProcessExitMetadata::default()
        }
        Err(_) => {
            warn!(session_id = %session.id, "Pi process did not exit after agent_end; killing process");
            if let Err(error) = child.kill().await {
                warn!(session_id = %session.id, error = %error, "Failed to kill Pi process after timeout");
                return ProcessExitMetadata::default();
            }

            match child.wait().await {
                Ok(exit_status) => ProcessExitMetadata {
                    exit_code: exit_status.code(),
                    exit_signal: Some("SIGKILL".to_string()),
                },
                Err(error) => {
                    warn!(session_id = %session.id, error = %error, "Failed waiting for killed Pi process");
                    ProcessExitMetadata {
                        exit_code: None,
                        exit_signal: Some("SIGKILL".to_string()),
                    }
                }
            }
        }
    }
}

async fn interrupt_session(
    db: &SqlitePool,
    session: &PiWorkflowSession,
    child: &mut Child,
) -> Result<String, ApiError> {
    child.kill().await.map_err(|error| {
        ApiError::internal(format!("Failed to kill pi process: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;

    update_workflow_session_record(
        db,
        &session.id,
        UpdateWorkflowSessionRecord {
            status: Some(PiSessionStatus::Aborted),
            finished_at: Some(Some(chrono::Utc::now().timestamp())),
            exit_signal: Some(Some("SIGKILL".to_string())),
            error_message: Some(Some("Task execution interrupted by stop request".to_string())),
            ..Default::default()
        },
    )
    .await?;

    Err(
        ApiError::conflict("Task execution interrupted by stop request")
            .with_code(ErrorCode::ExecutionOperationFailed),
    )
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
        return Err(
            ApiError::bad_request(format!(
                "Invalid model format '{}'. Expected 'provider/modelId'.",
                trimmed
            ))
            .with_code(ErrorCode::InvalidModel),
        );
    }

    Ok((provider.to_string(), model_id.to_string()))
}

fn format_thinking_level(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Default => "default",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
    }
}

fn normalize_timestamp(value: Option<&Value>) -> i64 {
    match value.and_then(Value::as_i64) {
        Some(timestamp) if timestamp > 1_000_000_000_000 => timestamp / 1000,
        Some(timestamp) => timestamp,
        None => chrono::Utc::now().timestamp(),
    }
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

fn project_event_to_message(session: &PiWorkflowSession, seq: i32, event: Value) -> Result<SessionMessage, ApiError> {
    let event_object = event.as_object().cloned().unwrap_or_default();
    let assistant_event = event_object
        .get("assistantMessageEvent")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let message_object = event_object
        .get("message")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let event_type = event_object.get("type").and_then(Value::as_str).unwrap_or("session_status");
    let assistant_type = assistant_event.get("type").and_then(Value::as_str);
    let raw_role = message_object
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| event_object.get("role").and_then(Value::as_str));

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

    let message_id = event_object
        .get("messageId")
        .and_then(Value::as_str)
        .or_else(|| assistant_event.get("messageId").and_then(Value::as_str))
        .or_else(|| message_object.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let text = extract_text_fragment(&event).or_else(|| {
        event_object
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
    }).unwrap_or_default();

    let mut content = Map::new();
    content.insert("text".to_string(), Value::String(text));
    content.insert("eventType".to_string(), Value::String(event_type.to_string()));
    content.insert(
        "assistantEventType".to_string(),
        assistant_type
            .map(|value| Value::String(value.to_string()))
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
        timestamp: normalize_timestamp(event_object.get("timestamp")),
        role,
        event_name: Some(match assistant_type {
            Some(assistant_type) if event_type == "message_update" => {
                format!("{}:{}", event_type, assistant_type)
            }
            _ => event_type.to_string(),
        }),
        message_type,
        content_json: Value::Object(content).to_string(),
        model_provider: event_object
            .get("provider")
            .and_then(Value::as_str)
            .map(str::to_string),
        model_id: event_object
            .get("modelId")
            .or_else(|| event_object.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string),
        agent_name: event_object
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
        tool_call_id: event_object
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name: event_object
            .get("toolName")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_args_json: event_object.get("args").cloned().map(|value| value.to_string()),
        tool_result_json: event_object.get("result").cloned().map(|value| value.to_string()),
        tool_status: None,
        edit_diff: None,
        edit_file_path: None,
        session_status: Some("active".to_string()),
        workflow_phase: Some("executing".to_string()),
        raw_event_json: Some(event.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::{build_pi_args, ensure_structured_output_extension, STRUCTURED_OUTPUT_EXTENSION_SOURCE};
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    fn unique_temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("tauroboros-rust-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn build_pi_args_includes_rpc_session_and_extension() {
        let args = build_pi_args(
            "/tmp/session.jsonl",
            "/tmp/project/.pi/extensions/pi-tools/structured-output.ts",
        );

        assert_eq!(
            args,
            vec![
                "--mode",
                "rpc",
                "--session",
                "/tmp/session.jsonl",
                "--extension",
                "/tmp/project/.pi/extensions/pi-tools/structured-output.ts",
            ]
        );
    }

    #[tokio::test]
    async fn ensure_structured_output_extension_writes_expected_file() {
        let project_root = unique_temp_dir("pi-extension");
        fs::create_dir_all(&project_root).expect("create temp project root");

        let extension_path = ensure_structured_output_extension(
            project_root.to_str().expect("project root to str"),
        )
        .await
        .expect("extract structured output extension");

        assert!(Path::new(&extension_path).exists());

        let written = fs::read_to_string(&extension_path).expect("read written extension");
        assert_eq!(written, STRUCTURED_OUTPUT_EXTENSION_SOURCE);

        fs::remove_dir_all(&project_root).expect("remove temp project root");
    }
}