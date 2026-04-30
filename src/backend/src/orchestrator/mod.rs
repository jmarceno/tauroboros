use crate::audit::{record_audit_event, CreateAuditEvent};
use crate::error::{ApiError, ErrorCode};
use crate::models::{AuditLevel, WorkflowRun};
use crate::sse::hub::SseHub;
use rocket::serde::json::json;
use serde_json::Value;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

// Sub-modules
pub mod best_of_n;
pub mod extensions;
pub mod git;
pub mod isolation;
pub mod pi;
pub mod plan_mode;
pub mod planning_session;
pub mod prompts;
pub mod review;
pub mod run_lifecycle;
pub mod scheduling;
pub mod task_execution;
pub mod task_selection;
pub mod types;

// Re-export commonly used types and functions
pub use prompts::{render_prompt_template, resolve_execution_model};
pub use types::TaskOutcome;

use types::RuntimeState;

#[derive(Clone)]
pub struct Orchestrator {
    pub(crate) db: SqlitePool,
    pub(crate) sse_hub: Arc<RwLock<SseHub>>,
    pub(crate) project_root: String,
    pub(crate) settings_dir: String,
    pub(crate) runtime: Arc<Mutex<RuntimeState>>,
    pub(crate) schedule_lock: Arc<Mutex<()>>,
    pub(crate) server_port: u16,
}

impl Orchestrator {
    pub fn new(
        db: SqlitePool,
        sse_hub: Arc<RwLock<SseHub>>,
        project_root: String,
        settings_dir: String,
    ) -> Self {
        Self {
            db,
            sse_hub,
            project_root,
            settings_dir,
            runtime: Arc::new(Mutex::new(RuntimeState::default())),
            schedule_lock: Arc::new(Mutex::new(())),
            server_port: 3789,
        }
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.server_port = port;
        self
    }

    pub async fn active_run(&self) -> Result<Option<WorkflowRun>, ApiError> {
        let active_run_id = { self.runtime.lock().await.active_run_id.clone() };
        match active_run_id {
            Some(run_id) => {
                let run = crate::db::queries::get_workflow_run(&self.db, &run_id)
                    .await?
                    .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;
                Ok(Some(run))
            }
            None => Ok(None),
        }
    }

    // Audit helpers
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn audit_event(
        &self,
        level: AuditLevel,
        event_type: &'static str,
        message: impl Into<String>,
        run_id: Option<&str>,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        session_id: Option<&str>,
        details: Value,
    ) -> Result<(), ApiError> {
        record_audit_event(
            &self.db,
            CreateAuditEvent {
                level,
                source: "orchestrator",
                event_type,
                message: message.into(),
                run_id: run_id.map(str::to_string),
                task_id: task_id.map(str::to_string),
                task_run_id: task_run_id.map(str::to_string),
                session_id: session_id.map(str::to_string),
                details: Some(details),
            },
        )
        .await
        .map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn audit_info(
        &self,
        event_type: &'static str,
        message: impl Into<String>,
        run_id: Option<&str>,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        session_id: Option<&str>,
        details: Value,
    ) -> Result<(), ApiError> {
        self.audit_event(
            AuditLevel::Info,
            event_type,
            message,
            run_id,
            task_id,
            task_run_id,
            session_id,
            details,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn audit_warn(
        &self,
        event_type: &'static str,
        message: impl Into<String>,
        run_id: Option<&str>,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        session_id: Option<&str>,
        details: Value,
    ) -> Result<(), ApiError> {
        self.audit_event(
            AuditLevel::Warn,
            event_type,
            message,
            run_id,
            task_id,
            task_run_id,
            session_id,
            details,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn audit_error(
        &self,
        event_type: &'static str,
        message: impl Into<String>,
        run_id: Option<&str>,
        task_id: Option<&str>,
        task_run_id: Option<&str>,
        session_id: Option<&str>,
        details: Value,
    ) -> Result<(), ApiError> {
        self.audit_event(
            AuditLevel::Error,
            event_type,
            message,
            run_id,
            task_id,
            task_run_id,
            session_id,
            details,
        )
        .await
    }

    // Broadcasting helpers
    pub(crate) async fn broadcast(&self, event_type: &str, payload: serde_json::Value) {
        let hub = self.sse_hub.read().await;
        hub.broadcast(&crate::models::WSMessage {
            r#type: event_type.to_string(),
            payload,
        })
        .await;
    }

    pub(crate) async fn broadcast_task(&self, task: &crate::models::Task) {
        match serde_json::to_value(task) {
            Ok(payload) => self.broadcast("task_updated", payload).await,
            Err(e) => {
                tracing::error!(
                    task_id = %task.id,
                    error = %e,
                    "Failed to serialize task for broadcast - this is a bug"
                );
                self.broadcast("task_updated", json!({ "id": task.id, "error": "serialization_failed" })).await;
            }
        }
    }

    pub(crate) async fn broadcast_run(&self, run: &WorkflowRun) {
        match serde_json::to_value(run) {
            Ok(payload) => self.broadcast("run_updated", payload).await,
            Err(e) => {
                tracing::error!(
                    run_id = %run.id,
                    error = %e,
                    "Failed to serialize run for broadcast - this is a bug"
                );
                self.broadcast("run_updated", json!({ "id": run.id, "error": "serialization_failed" })).await;
            }
        }
    }

    // Session helpers
    pub(crate) fn session_url_for(&self, session_id: &str) -> String {
        crate::state::session_url_for(session_id)
    }

    pub(crate) fn pi_session_file_for(&self, session_id: &str) -> String {
        std::path::Path::new(&self.settings_dir)
            .join("pi-sessions")
            .join(format!("{}.json", session_id))
            .to_string_lossy()
            .to_string()
    }
}


