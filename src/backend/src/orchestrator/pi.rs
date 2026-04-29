use crate::audit::{record_audit_event, CreateAuditEvent};
use crate::db::runtime::{
    update_workflow_session_record, UpdateWorkflowSessionRecord,
};
use crate::embedded_resources::ensure_embedded_pi_resources;
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    AuditLevel, PiSessionStatus, PiWorkflowSession, ThinkingLevel,
};
use crate::orchestrator::isolation::{self, ResolvedIsolationSpec};
use crate::sse::hub::SseHub;
use rocket::serde::json::json;
use serde_json::Value;
use std::io::ErrorKind;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch, RwLock};
use tokio::time::{timeout, Duration};
use tracing::warn;

const STRUCTURED_OUTPUT_EXTENSION_RELATIVE_PATH: [&str; 4] =
    [".pi", "extensions", "pi-tools", "structured-output.ts"];
const SESSION_LOGGER_EXTENSION_RELATIVE_PATH: [&str; 4] =
    [".pi", "extensions", "pi-tools", "session-logger.ts"];
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

#[derive(Debug, Clone)]
pub struct PiPromptResult {
    pub response_text: String,
    pub events: Vec<Value>,
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
        let result = self
            .run_prompt_with_events(session, model, prompt_text, stop_rx)
            .await?;
        Ok(result.response_text)
    }

    pub async fn run_prompt_with_events(
        &self,
        session: PiWorkflowSession,
        model: &str,
        prompt_text: &str,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<PiPromptResult, ApiError> {
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
                "isolationMode": session.isolation_mode,
                "pathGrants": session.path_grants_json
            }),
        )
        .await?;

        let (mut child, mut stdin, mut rx) = match spawn_process(&session, &self.project_root).await
        {
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

        let result: Result<PiPromptResult, ApiError> = async {
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
        hub.broadcast_status(&completed.id, session_status_label, completed.finished_at)
            .await;

        self.audit_event(
            if result.is_ok() {
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
                "responseLength": result.as_ref().map(|response| response.response_text.trim().len()).unwrap_or(0),
                "error": session_error_message
            }),
        )
        .await?;

        match result {
            Ok(mut prompt_result) => {
                prompt_result.response_text = prompt_result.response_text.trim().to_string();
                Ok(prompt_result)
            }
            Err(error) => Err(error),
        }
    }

}

pub async fn ensure_pi_extensions(project_root: &str) -> Result<Vec<String>, ApiError> {
    ensure_embedded_pi_resources(project_root).await?;

    let structured_output = structured_output_extension_path(project_root);
    let session_logger = session_logger_extension_path(project_root);

    let structured_exists = tokio::fs::try_exists(&structured_output).await.map_err(|e| {
        ApiError::internal(format!(
            "Failed to verify structured output extension at {}: {}",
            structured_output.display(),
            e
        ))
        .with_code(ErrorCode::ExecutionOperationFailed)
    })?;

    let session_logger_exists = tokio::fs::try_exists(&session_logger).await.map_err(|e| {
        ApiError::internal(format!(
            "Failed to verify session-logger extension at {}: {}",
            session_logger.display(),
            e
        ))
        .with_code(ErrorCode::ExecutionOperationFailed)
    })?;

    if !structured_exists {
        return Err(ApiError::internal(format!(
            "Structured output extension was not embedded at {}",
            structured_output.display()
        ))
        .with_code(ErrorCode::ExecutionOperationFailed));
    }

    if !session_logger_exists {
        return Err(ApiError::internal(format!(
            "Session-logger extension was not embedded at {}",
            session_logger.display()
        ))
        .with_code(ErrorCode::ExecutionOperationFailed));
    }

    Ok(vec![
        structured_output.to_string_lossy().to_string(),
        session_logger.to_string_lossy().to_string(),
    ])
}

fn structured_output_extension_path(project_root: &str) -> PathBuf {
    let mut path = PathBuf::from(project_root);
    for segment in STRUCTURED_OUTPUT_EXTENSION_RELATIVE_PATH {
        path.push(segment);
    }
    path
}

fn session_logger_extension_path(project_root: &str) -> PathBuf {
    let mut path = PathBuf::from(project_root);
    for segment in SESSION_LOGGER_EXTENSION_RELATIVE_PATH {
        path.push(segment);
    }
    path
}

fn build_pi_args(session_file: &str, extension_paths: &[String]) -> Vec<String> {
    let mut args = vec![
        "--mode".to_string(),
        "rpc".to_string(),
        "--session".to_string(),
        session_file.to_string(),
    ];
    for ext_path in extension_paths {
        args.push("--extension".to_string());
        args.push(ext_path.clone());
    }
    args
}

impl PiSessionExecutor {
    /// Build a detailed error message from a crashed Pi process by
    /// collecting its exit status and any stderr output. The caller
    /// provides accumulated stderr lines and a descriptive context.
    fn process_crash_error(
        child: &mut Child,
        stderr_lines: &[String],
        context: &str,
    ) -> String {
        let exit_desc = match child.try_wait() {
            Ok(Some(status)) => {
                if let Some(code) = status.code() {
                    format!("exit code {}", code)
                } else {
                    "terminated by signal".to_string()
                }
            }
            Ok(None) => "still running (stream ended prematurely)".to_string(),
            Err(_) => "unknown process state".to_string(),
        };

        let stderr_summary = if stderr_lines.is_empty() {
            String::new()
        } else {
            let joined: String = stderr_lines.join(" | ");
            format!(": {}", joined.trim())
        };

        format!(
            "Pi process crashed ({}){}. Context: {}",
            exit_desc, stderr_summary, context
        )
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
        let mut stderr_buf: Vec<String> = Vec::new();
        loop {
            tokio::select! {
                _ = &mut response_timeout => {
                    let stderr_summary = stderr_buf.join(" | ");
                    let mut msg = format!(
                        "Timed out waiting for Pi RPC response {} for session {}",
                        expected_id, session.id
                    );
                    if !stderr_summary.is_empty() {
                        msg.push_str(&format!(" (stderr: {})", stderr_summary));
                    }
                    return Err(
                        ApiError::internal(msg)
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
                    let line = match maybe_line {
                        Some(line) => line,
                        None => {
                            let detail = Self::process_crash_error(
                                child,
                                &stderr_buf,
                                &format!("waiting for RPC response '{}' (session {})", expected_id, session.id),
                            );
                            return Err(
                                ApiError::internal(detail)
                                    .with_code(ErrorCode::ExecutionOperationFailed)
                            );
                        }
                    };

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

                            }
                        }
                        ProcessLine::Stderr(content) => {
                            stderr_buf.push(content.clone());
                            warn!(
                                session_id = %session.id,
                                task_id = ?session.task_id,
                                task_run_id = ?session.task_run_id,
                                stderr = %content,
                                "Pi stderr"
                            );
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
    ) -> Result<PiPromptResult, ApiError> {
        let mut response_text = String::new();
        let mut events = Vec::new();
        let mut stderr_buf: Vec<String> = Vec::new();
        let idle_timeout = tokio::time::sleep(PROMPT_IDLE_TIMEOUT);
        tokio::pin!(idle_timeout);

        loop {
            tokio::select! {
                _ = &mut idle_timeout => {
                    let stderr_summary = stderr_buf.join(" | ");
                    let mut msg = format!(
                        "Timed out waiting for agent_end for session {}", session.id
                    );
                    if !stderr_summary.is_empty() {
                        msg.push_str(&format!(" (stderr: {})", stderr_summary));
                    }
                    return Err(
                        ApiError::internal(msg)
                            .with_code(ErrorCode::ExecutionOperationFailed)
                    );
                }
                changed = stop_rx.changed() => {
                    if changed.is_ok() && *stop_rx.borrow() {
                        let response_text = interrupt_session(&self.db, session, child).await?;
                        return Ok(PiPromptResult {
                            response_text,
                            events,
                        });
                    }
                }
                maybe_line = rx.recv() => {
                    let line = match maybe_line {
                        Some(line) => line,
                        None => {
                            let detail = Self::process_crash_error(
                                child,
                                &stderr_buf,
                                &format!("waiting for agent_end (session {})", session.id),
                            );
                            return Err(
                                ApiError::internal(detail)
                                    .with_code(ErrorCode::ExecutionOperationFailed)
                            );
                        }
                    };

                    match line {
                        ProcessLine::Stdout(content) => {
                            let parsed = match serde_json::from_str::<Value>(&content) {
                                Ok(value) => value,
                                Err(_) => {
                                    warn!(
                                        session_id = %session.id,
                                        task_id = ?session.task_id,
                                        task_run_id = ?session.task_run_id,
                                        stderr = %content,
                                        "Pi unparseable stdout as stderr"
                                    );
                                    continue;
                                }
                            };

                            if let Some(fragment) = extract_text_fragment(&parsed) {
                                response_text.push_str(&fragment);
                            }

                            let event_type = parsed.get("type").and_then(Value::as_str);
                            events.push(parsed.clone());
                            if event_type == Some("agent_end") {
                                return Ok(PiPromptResult {
                                    response_text,
                                    events,
                                });
                            }
                        }
                        ProcessLine::Stderr(content) => {
                            stderr_buf.push(content.clone());
                            warn!(
                                session_id = %session.id,
                                task_id = ?session.task_id,
                                task_run_id = ?session.task_run_id,
                                stderr = %content,
                                "Pi stderr"
                            );
                        }
                    }
                }
            }
        }
    }

}

async fn spawn_process(
    session: &PiWorkflowSession,
    project_root: &str,
) -> Result<
    (
        Child,
        tokio::process::ChildStdin,
        mpsc::UnboundedReceiver<ProcessLine>,
    ),
    ApiError,
> {
    let session_file = session.pi_session_file.clone().ok_or_else(|| {
        ApiError::internal("Workflow session is missing piSessionFile")
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    let extension_paths = ensure_pi_extensions(project_root).await?;

    if let Some(parent) = Path::new(&session_file).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            ApiError::internal(format!("Failed to create pi session directory: {}", error))
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;
    }

    let pi_bin = std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string());
    let pi_args = build_pi_args(&session_file, &extension_paths);

    let isolation_spec = reconstruct_isolation_spec(session, project_root)?;

    let (executable, args) = isolation_spec.spawn_plan(&pi_bin, &pi_args);

    let mut command = Command::new(&executable);
    command
        .args(&args)
        .current_dir(&session.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PI_CODING_AGENT", "true")
        .env("TAUROBOROS_PORT", std::env::var("SERVER_PORT").unwrap_or_else(|_| std::env::var("PORT").unwrap_or_else(|_| "3789".to_string())))
        .env("TAUROBOROS_SESSION_ID", &session.id)
        .env(
            "TAUROBOROS_TASK_ID",
            session.task_id.as_deref().unwrap_or(""),
        )
        .env(
            "TAUROBOROS_TASK_RUN_ID",
            session.task_run_id.as_deref().unwrap_or(""),
        );

    let mut child = command.spawn().map_err(|error| {
        if executable == "bwrap" && error.kind() == ErrorKind::NotFound {
            return ApiError::internal("Bubblewrap executable 'bwrap' is not available")
                .with_code(ErrorCode::BubblewrapNotAvailable);
        }

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

fn reconstruct_isolation_spec(
    session: &PiWorkflowSession,
    _project_root: &str,
) -> Result<ResolvedIsolationSpec, ApiError> {
    match session.isolation_mode {
        crate::models::SessionIsolationMode::None => Ok(ResolvedIsolationSpec {
            mode: crate::models::SessionIsolationMode::None,
            grants: vec![],
        }),
        crate::models::SessionIsolationMode::Bubblewrap => {
            let grants: Vec<isolation::PathGrant> =
                serde_json::from_str(&session.path_grants_json)
                    .map_err(|e| {
                        ApiError::internal(format!(
                            "Failed to deserialize path grants for session {}: {}",
                            session.id, e
                        ))
                        .with_code(ErrorCode::ExecutionOperationFailed)
                    })?;
            Ok(ResolvedIsolationSpec {
                mode: crate::models::SessionIsolationMode::Bubblewrap,
                grants,
            })
        }
    }
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

async fn send_request(
    stdin: &mut tokio::process::ChildStdin,
    payload: &Value,
) -> Result<(), ApiError> {
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
            error_message: Some(Some(
                "Task execution interrupted by stop request".to_string(),
            )),
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
        return Err(ApiError::bad_request(format!(
            "Invalid model format '{}'. Expected 'provider/modelId'.",
            trimmed
        ))
        .with_code(ErrorCode::InvalidModel));
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

#[cfg(test)]
mod tests {
    use super::{build_pi_args, ensure_pi_extensions};
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    fn unique_temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("tauroboros-rust-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn build_pi_args_includes_rpc_session_and_extensions() {
        let args = build_pi_args(
            "/tmp/session.jsonl",
            &[
                "/tmp/project/.pi/extensions/pi-tools/structured-output.ts".to_string(),
                "/tmp/project/.pi/extensions/pi-tools/session-logger.ts".to_string(),
            ],
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
                "--extension",
                "/tmp/project/.pi/extensions/pi-tools/session-logger.ts",
            ]
        );
    }

    #[tokio::test]
    async fn ensure_pi_extensions_writes_expected_files() {
        let project_root = unique_temp_dir("pi-extensions");
        fs::create_dir_all(&project_root).expect("create temp project root");

        let extension_paths = ensure_pi_extensions(
            project_root.to_str().expect("project root to str"),
        )
        .await
        .expect("extract pi extensions");

        assert_eq!(extension_paths.len(), 2);

        let structured_path = &extension_paths[0];
        let logger_path = &extension_paths[1];

        assert!(Path::new(structured_path).exists());
        assert!(Path::new(logger_path).exists());

        let structured_written = fs::read_to_string(structured_path).expect("read structured output extension");
        let structured_expected = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../extensions/pi-tools/structured-output.ts"),
        )
        .expect("read embedded structured output source");
        assert_eq!(structured_written, structured_expected);

        let logger_written = fs::read_to_string(logger_path).expect("read session-logger extension");
        let logger_expected = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../extensions/pi-tools/session-logger.ts"),
        )
        .expect("read embedded session-logger source");
        assert_eq!(logger_written, logger_expected);

        fs::write(structured_path, "custom extension").expect("override structured output extension");
        fs::write(logger_path, "custom logger").expect("override session-logger extension");

        let second_paths = ensure_pi_extensions(
            project_root.to_str().expect("project root to str"),
        )
        .await
        .expect("reuse extracted pi extensions");

        assert_eq!(second_paths[0], *structured_path);
        assert_eq!(second_paths[1], *logger_path);
        let preserved_structured = fs::read_to_string(structured_path).expect("read preserved structured output");
        assert_eq!(preserved_structured, "custom extension");
        let preserved_logger = fs::read_to_string(logger_path).expect("read preserved session-logger");
        assert_eq!(preserved_logger, "custom logger");

        fs::remove_dir_all(&project_root).expect("remove temp project root");
    }
}
