use self::git::{
    auto_commit_worktree, create_task_worktree, merge_and_cleanup_worktree, remove_worktree,
    resolve_target_branch, run_shell_command, worktree_has_changes,
};
use self::pi::PiSessionExecutor;
use crate::audit::{record_audit_event, CreateAuditEvent};
use crate::db::queries::{
    get_options, get_task, get_task_group, get_task_runs, get_tasks, get_workflow_run,
    get_workflow_runs, update_task, update_task_group,
};
use crate::db::runtime::{
    create_task_run_record, create_workflow_run_record, create_workflow_session_record,
    update_task_run_record, update_workflow_run_record, CreateTaskRunRecord,
    CreateWorkflowRunRecord, CreateWorkflowSessionRecord, UpdateTaskRunRecord,
    UpdateWorkflowRunRecord,
};
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    AuditLevel, BestOfNSubstage, CleanRunResult, ExecutionPhase, ExecutionStrategy, Options,
    PiSessionKind, PiSessionStatus, RunPhase, RunStatus, SelfHealStatus, Task, TaskGroupStatus,
    TaskStatus, UpdateTaskInput, WSMessage, WorkflowRun, WorkflowRunKind,
    WorkflowRunStatus,
};
use crate::sse::hub::SseHub;
use rocket::serde::json::json;
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{watch, Mutex, RwLock};
use tracing::error;
use uuid::Uuid;

pub mod best_of_n;
pub mod git;
pub mod isolation;
pub mod pi;
pub mod plan_mode;
pub mod planning_session;
pub mod review;

#[derive(Debug)]
#[allow(dead_code)]
struct SlotAssignment {
    run_id: String,
    task_id: String,
}

#[derive(Debug)]
#[allow(dead_code)]
struct ActiveTaskControl {
    run_id: String,
    slot_index: usize,
    stop_tx: watch::Sender<bool>,
}

#[derive(Debug, Default)]
struct RuntimeState {
    active_run_id: Option<String>,
    slots: Vec<Option<SlotAssignment>>,
    active_tasks: HashMap<String, ActiveTaskControl>,
}

#[derive(Debug, Clone)]
pub struct RunStopResult {
    pub run: WorkflowRun,
    pub killed: i32,
    pub cleaned: i32,
}

const GRACEFUL_STOP_MESSAGE: &str = "Workflow stopped by user";
const DESTRUCTIVE_STOP_MESSAGE: &str = "Workflow stopped by user - all work discarded";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopMode {
    Graceful,
    Destructive,
    Failure,
}

fn stop_mode_for_run(run: &WorkflowRun) -> Option<StopMode> {
    if !run.stop_requested {
        return None;
    }

    match run.error_message.as_deref() {
        Some(GRACEFUL_STOP_MESSAGE) => Some(StopMode::Graceful),
        Some(DESTRUCTIVE_STOP_MESSAGE) => Some(StopMode::Destructive),
        _ => Some(StopMode::Failure),
    }
}

#[derive(Clone)]
pub struct Orchestrator {
    db: SqlitePool,
    sse_hub: Arc<RwLock<SseHub>>,
    project_root: String,
    settings_dir: String,
    runtime: Arc<Mutex<RuntimeState>>,
    schedule_lock: Arc<Mutex<()>>,
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
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn audit_event(
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
    async fn audit_info(
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
    async fn audit_warn(
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
    async fn audit_error(
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

    pub async fn start_all(&self) -> Result<WorkflowRun, ApiError> {
        self.cleanup_stale_runs().await?;
        self.ensure_no_active_run().await?;

        let tasks = get_tasks(&self.db).await?;
        let selected = select_all_runnable_tasks(&tasks)?;
        if selected.is_empty() {
            return Err(ApiError::internal("No tasks in backlog")
                .with_code(ErrorCode::ExecutionOperationFailed));
        }

        self.ensure_supported_tasks(&selected)?;

        let run = self
            .create_run(
                WorkflowRunKind::AllTasks,
                "Workflow run".to_string(),
                &selected,
                None,
                None,
            )
            .await?;
        self.schedule().await?;
        self.reload_run(&run.id).await
    }

    pub async fn start_single(&self, task_id: &str) -> Result<WorkflowRun, ApiError> {
        self.cleanup_stale_runs().await?;
        self.ensure_no_active_run().await?;

        let tasks = get_tasks(&self.db).await?;
        let selected = resolve_single_task_chain(&tasks, task_id)?;
        if selected.is_empty() {
            return Err(ApiError::internal("No tasks in backlog")
                .with_code(ErrorCode::ExecutionOperationFailed));
        }

        self.ensure_supported_tasks(&selected)?;
        let target = selected
            .iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| {
                ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound)
            })?;

        let run = self
            .create_run(
                WorkflowRunKind::SingleTask,
                format!("Single task: {}", target.name),
                &selected,
                Some(target.id.clone()),
                None,
            )
            .await?;
        self.schedule().await?;
        self.reload_run(&run.id).await
    }

    pub async fn start_group(&self, group_id: &str) -> Result<WorkflowRun, ApiError> {
        self.cleanup_stale_runs().await?;
        self.ensure_no_active_run().await?;

        let group = get_task_group(&self.db, group_id).await?.ok_or_else(|| {
            ApiError::not_found("Task group not found").with_code(ErrorCode::TaskGroupNotFound)
        })?;
        if group.task_ids.is_empty() {
            return Err(ApiError::bad_request("Cannot start group with no tasks")
                .with_code(ErrorCode::InvalidRequestBody));
        }

        let all_tasks = get_tasks(&self.db).await?;
        let task_map = all_tasks
            .iter()
            .cloned()
            .map(|task| (task.id.clone(), task))
            .collect::<HashMap<_, _>>();
        let group_tasks = group
            .task_ids
            .iter()
            .map(|task_id| {
                task_map.get(task_id).cloned().ok_or_else(|| {
                    ApiError::internal(format!(
                        "Task '{}' in group '{}' was not found",
                        task_id, group.name
                    ))
                    .with_code(ErrorCode::TaskNotFound)
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        let group_task_ids = group_tasks
            .iter()
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let external_deps = group_tasks
            .iter()
            .flat_map(|task| {
                task.requirements_vec()
                    .into_iter()
                    .filter(|dependency| {
                        task_map.contains_key(dependency) && !group_task_ids.contains(dependency)
                    })
                    .map(move |dependency| (task.name.clone(), dependency))
            })
            .collect::<Vec<_>>();
        if !external_deps.is_empty() {
            let names = external_deps
                .into_iter()
                .map(|(task_name, _)| task_name)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            return Err(
                ApiError::conflict(format!(
                    "Group execution blocked: tasks have external dependencies that must be completed first: {}",
                    names
                ))
                .with_code(ErrorCode::ExternalDependenciesBlocked),
            );
        }

        let runnable = group_tasks
            .into_iter()
            .filter(|task| matches!(task.status, TaskStatus::Backlog | TaskStatus::Template))
            .collect::<Vec<_>>();
        if runnable.is_empty() {
            return Err(
                ApiError::conflict(
                    "No runnable tasks in group (all tasks are already completed or in a non-runnable state)",
                )
                .with_code(ErrorCode::ExecutionOperationFailed),
            );
        }

        self.ensure_supported_tasks(&runnable)?;
        let ordered = order_subset_by_dependencies(&runnable)?;
        let run = self
            .create_run(
                WorkflowRunKind::GroupTasks,
                format!("Task group: {}", group.name),
                &ordered,
                None,
                Some(group.id.clone()),
            )
            .await?;

        self.broadcast(
            "group_execution_started",
            json!({ "groupId": group.id, "runId": run.id }),
        )
        .await;
        self.schedule().await?;
        self.reload_run(&run.id).await
    }

    pub async fn pause_run(&self, run_id: &str) -> Result<WorkflowRun, ApiError> {
        let run = self.reload_run(run_id).await?;
        if !matches!(
            run.status,
            WorkflowRunStatus::Queued | WorkflowRunStatus::Running | WorkflowRunStatus::Stopping
        ) {
            return Err(ApiError::conflict("Run is not active")
                .with_code(ErrorCode::ExecutionOperationFailed));
        }

        let updated = update_workflow_run_record(
            &self.db,
            run_id,
            UpdateWorkflowRunRecord {
                status: Some(WorkflowRunStatus::Paused),
                pause_requested: Some(true),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;
        self.broadcast_run(&updated).await;
        self.broadcast("run_paused", json!({ "runId": run_id }))
            .await;
        Ok(updated)
    }

    pub async fn resume_run(&self, run_id: &str) -> Result<WorkflowRun, ApiError> {
        let run = self.reload_run(run_id).await?;
        if run.status != WorkflowRunStatus::Paused {
            return Err(ApiError::conflict("Run is not paused")
                .with_code(ErrorCode::ExecutionOperationFailed));
        }

        let has_active_task = {
            let runtime = self.runtime.lock().await;
            runtime
                .active_tasks
                .values()
                .any(|control| control.run_id == run_id)
        };

        let updated = update_workflow_run_record(
            &self.db,
            run_id,
            UpdateWorkflowRunRecord {
                status: Some(if has_active_task {
                    WorkflowRunStatus::Running
                } else {
                    WorkflowRunStatus::Queued
                }),
                pause_requested: Some(false),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

        self.broadcast_run(&updated).await;
        self.broadcast("run_resumed", json!({ "runId": run_id }))
            .await;
        if !has_active_task {
            self.schedule().await?;
        }
        self.reload_run(run_id).await
    }

    pub async fn stop_run(
        &self,
        run_id: &str,
        destructive: bool,
    ) -> Result<RunStopResult, ApiError> {
        let run = self.reload_run(run_id).await?;
        if run.status == WorkflowRunStatus::Stopping {
            return Err(ApiError::conflict("Run is already stopping")
                .with_code(ErrorCode::ExecutionOperationFailed));
        }
        if !matches!(
            run.status,
            WorkflowRunStatus::Queued | WorkflowRunStatus::Running | WorkflowRunStatus::Paused
        ) {
            return Err(ApiError::conflict("Run is not active")
                .with_code(ErrorCode::ExecutionOperationFailed));
        }

        let stop_message = if destructive {
            DESTRUCTIVE_STOP_MESSAGE
        } else {
            GRACEFUL_STOP_MESSAGE
        };
        let queued_task_status = if destructive {
            TaskStatus::Failed
        } else {
            TaskStatus::Backlog
        };

        let updated = update_workflow_run_record(
            &self.db,
            run_id,
            UpdateWorkflowRunRecord {
                status: Some(WorkflowRunStatus::Stopping),
                stop_requested: Some(true),
                error_message: Some(Some(stop_message.to_string())),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

        let task_ids = updated.task_order_vec()?;
        for task_id in &task_ids {
            if let Some(task) = get_task(&self.db, task_id).await? {
                if task.status == TaskStatus::Queued {
                    update_task(
                        &self.db,
                        task_id,
                        UpdateTaskInput {
                            status: Some(queued_task_status),
                            error_message: Some(Some(stop_message.to_string())),
                            session_id: Some(None),
                            session_url: Some(None),
                            ..Default::default()
                        },
                    )
                    .await?;
                    if let Some(updated_task) = get_task(&self.db, task_id).await? {
                        self.broadcast_task(&updated_task).await;
                    }
                }
            }
        }

        let killed = self.signal_stop_for_run(run_id).await;
        let cleaned = if destructive && killed == 0 {
            self.cleanup_stopped_run_worktrees(&task_ids).await?
        } else {
            0
        };
        if killed == 0 {
            self.finalize_run_after_stop(run_id, destructive).await?;
        }

        self.broadcast(
            "run_stopped",
            json!({ "runId": run_id, "destructive": destructive }),
        )
        .await;
        self.broadcast("execution_stopped", json!({ "runId": run_id }))
            .await;

        let run = self.reload_run(run_id).await?;
        Ok(RunStopResult {
            run,
            killed,
            cleaned,
        })
    }

    pub async fn clean_run(&self, run_id: &str) -> Result<CleanRunResult, ApiError> {
        let run = self.reload_run(run_id).await?;
        if matches!(
            run.status,
            WorkflowRunStatus::Queued
                | WorkflowRunStatus::Running
                | WorkflowRunStatus::Paused
                | WorkflowRunStatus::Stopping
        ) {
            return Err(ApiError::internal(format!(
                "Cannot clean an active workflow run (status: {}). Stop the run first.",
                serde_json::to_value(run.status)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_else(|| "unknown".to_string())
            ))
            .with_code(ErrorCode::ExecutionOperationFailed));
        }

        let task_ids = run.task_order_vec()?;
        let mut tasks = Vec::with_capacity(task_ids.len());
        for task_id in &task_ids {
            let task = get_task(&self.db, task_id).await?.ok_or_else(|| {
                ApiError::internal(format!("Task {} not found in run {}", task_id, run_id))
                    .with_code(ErrorCode::TaskNotFound)
            })?;
            tasks.push(task);
        }

        for task in &tasks {
            if let Some(worktree_dir) = &task.worktree_dir {
                if Path::new(worktree_dir).exists() {
                    remove_worktree(&self.project_root, worktree_dir).await?;
                }
            }
        }

        let sessions_deleted = if task_ids.is_empty() {
            0
        } else {
            let mut delete_messages = QueryBuilder::<Sqlite>::new(
                "DELETE FROM session_messages WHERE session_id IN (SELECT id FROM pi_workflow_sessions WHERE task_id IN (",
            );
            {
                let mut separated = delete_messages.separated(", ");
                for task_id in &task_ids {
                    separated.push_bind(task_id);
                }
            }
            delete_messages.push(") )");
            delete_messages
                .build()
                .execute(&self.db)
                .await
                .map_err(ApiError::Database)?;

            let mut delete_sessions =
                QueryBuilder::<Sqlite>::new("DELETE FROM pi_workflow_sessions WHERE task_id IN (");
            {
                let mut separated = delete_sessions.separated(", ");
                for task_id in &task_ids {
                    separated.push_bind(task_id);
                }
            }
            delete_sessions.push(")");
            delete_sessions
                .build()
                .execute(&self.db)
                .await
                .map_err(ApiError::Database)?
                .rows_affected() as i32
        };

        let task_runs_deleted = if task_ids.is_empty() {
            0
        } else {
            let mut query = QueryBuilder::<Sqlite>::new("DELETE FROM task_runs WHERE task_id IN (");
            {
                let mut separated = query.separated(", ");
                for task_id in &task_ids {
                    separated.push_bind(task_id);
                }
            }
            query.push(")");
            query
                .build()
                .execute(&self.db)
                .await
                .map_err(ApiError::Database)?
                .rows_affected() as i32
        };

        let candidates_deleted = if task_ids.is_empty() {
            0
        } else {
            let mut query =
                QueryBuilder::<Sqlite>::new("DELETE FROM task_candidates WHERE task_id IN (");
            {
                let mut separated = query.separated(", ");
                for task_id in &task_ids {
                    separated.push_bind(task_id);
                }
            }
            query.push(")");
            query
                .build()
                .execute(&self.db)
                .await
                .map_err(ApiError::Database)?
                .rows_affected() as i32
        };

        let reports_deleted = if task_ids.is_empty() {
            0
        } else {
            let mut query =
                QueryBuilder::<Sqlite>::new("DELETE FROM self_heal_reports WHERE task_id IN (");
            {
                let mut separated = query.separated(", ");
                for task_id in &task_ids {
                    separated.push_bind(task_id);
                }
            }
            query.push(")");
            query
                .build()
                .execute(&self.db)
                .await
                .map_err(ApiError::Database)?
                .rows_affected() as i32
        };

        let mut tasks_reset = 0;
        for task_id in &task_ids {
            update_task(
                &self.db,
                task_id,
                UpdateTaskInput {
                    status: Some(TaskStatus::Backlog),
                    execution_phase: Some(ExecutionPhase::NotStarted),
                    error_message: Some(None),
                    agent_output: Some(Some(String::new())),
                    worktree_dir: Some(None),
                    session_id: Some(None),
                    session_url: Some(None),
                    completed_at: Some(None),
                    self_heal_status: Some(SelfHealStatus::Idle),
                    self_heal_message: Some(None),
                    self_heal_report_id: Some(None),
                    review_count: Some(0),
                    json_parse_retry_count: Some(0),
                    plan_revision_count: Some(0),
                    awaiting_plan_approval: Some(false),
                    review_activity: Some(Some("idle".to_string())),
                    best_of_n_substage: Some(BestOfNSubstage::Idle),
                    ..Default::default()
                },
            )
            .await?;

            if let Some(updated_task) = get_task(&self.db, task_id).await? {
                self.broadcast_task(&updated_task).await;
                tasks_reset += 1;
            }
        }

        let runs_deleted = sqlx::query("DELETE FROM workflow_runs WHERE id = ?")
            .bind(run_id)
            .execute(&self.db)
            .await
            .map_err(ApiError::Database)?
            .rows_affected() as i32;

        self.broadcast("run_cleaned", json!({ "runId": run_id }))
            .await;

        let message = if tasks_reset == 0 {
            "No tasks to clean".to_string()
        } else {
            format!(
                "Reset {} tasks, deleted {} sessions, {} task runs, {} candidates, {} reports. Ready to restart.",
                tasks_reset, sessions_deleted, task_runs_deleted, candidates_deleted, reports_deleted
            )
        };

        Ok(CleanRunResult {
            success: true,
            tasks_reset,
            sessions_deleted,
            task_runs_deleted,
            candidates_deleted,
            reports_deleted,
            runs_deleted,
            message,
        })
    }

    pub async fn get_slot_utilization(&self) -> Result<serde_json::Value, ApiError> {
        let options = get_options(&self.db).await?;
        let runtime = self.runtime.lock().await;
        let tasks = runtime
            .slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| {
                slot.as_ref()
                    .map(|assignment| (index, assignment.task_id.clone()))
            })
            .map(|(index, task_id)| async move {
                let task_name = get_task(&self.db, &task_id)
                    .await
                    .ok()
                    .flatten()
                    .map(|task| task.name)
                    .unwrap_or(task_id.clone());
                json!({ "taskId": task_id, "taskName": task_name, "slotIndex": index })
            })
            .collect::<Vec<_>>();
        drop(runtime);

        let mut serialized_tasks = Vec::with_capacity(tasks.len());
        for task in tasks {
            serialized_tasks.push(task.await);
        }

        Ok(json!({
            "maxSlots": options.parallel_tasks,
            "usedSlots": serialized_tasks.len() as i32,
            "availableSlots": options.parallel_tasks - serialized_tasks.len() as i32,
            "tasks": serialized_tasks,
        }))
    }

    pub async fn get_run_queue_status(&self, run_id: &str) -> Result<serde_json::Value, ApiError> {
        let run = self.reload_run(run_id).await?;
        let mut queued_tasks = 0;
        let mut executing_tasks = 0;
        let mut completed_tasks = 0;
        let task_order = run.task_order_vec()?;

        for task_id in &task_order {
            if let Some(task) = get_task(&self.db, task_id).await? {
                match task.status {
                    TaskStatus::Queued => queued_tasks += 1,
                    TaskStatus::Executing => executing_tasks += 1,
                    TaskStatus::Done | TaskStatus::Failed | TaskStatus::Stuck => {
                        completed_tasks += 1
                    }
                    _ => {}
                }
            }
        }

        Ok(json!({
            "runId": run.id,
            "status": run.status,
            "totalTasks": task_order.len(),
            "queuedTasks": queued_tasks,
            "executingTasks": executing_tasks,
            "completedTasks": completed_tasks,
        }))
    }

    pub async fn active_run(&self) -> Result<Option<WorkflowRun>, ApiError> {
        let active_run_id = { self.runtime.lock().await.active_run_id.clone() };
        match active_run_id {
            Some(run_id) => Ok(Some(self.reload_run(&run_id).await?)),
            None => Ok(None),
        }
    }

    async fn create_run(
        &self,
        kind: WorkflowRunKind,
        display_name: String,
        tasks: &[Task],
        target_task_id: Option<String>,
        group_id: Option<String>,
    ) -> Result<WorkflowRun, ApiError> {
        let task_order = tasks.iter().map(|task| task.id.clone()).collect::<Vec<_>>();
        let run = create_workflow_run_record(
            &self.db,
            CreateWorkflowRunRecord {
                id: None,
                kind,
                status: WorkflowRunStatus::Queued,
                display_name,
                target_task_id,
                task_order: task_order.clone(),
                current_task_id: task_order.first().cloned(),
                current_task_index: 0,
                pause_requested: false,
                stop_requested: false,
                error_message: None,
                started_at: None,
                finished_at: None,
                color: None,
                group_id,
                queued_task_count: Some(task_order.len() as i32),
                executing_task_count: Some(0),
            },
        )
        .await?;

        for task in tasks {
            update_task(
                &self.db,
                &task.id,
                UpdateTaskInput {
                    status: Some(TaskStatus::Queued),
                    error_message: Some(None),
                    completed_at: Some(None),
                    session_id: Some(None),
                    session_url: Some(None),
                    worktree_dir: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            if let Some(updated_task) = get_task(&self.db, &task.id).await? {
                self.broadcast_task(&updated_task).await;
            }
        }

        {
            let mut runtime = self.runtime.lock().await;
            runtime.active_run_id = Some(run.id.clone());
        }

        self.broadcast("run_created", serde_json::to_value(&run)?)
            .await;
        self.broadcast("execution_queued", json!({ "runId": run.id }))
            .await;
        self.audit_info(
            "run.created",
            format!("Created workflow run {}", run.id),
            Some(&run.id),
            run.target_task_id.as_deref(),
            None,
            None,
            json!({
                "kind": run.kind,
                "displayName": run.display_name,
                "taskIds": task_order,
                "targetTaskId": run.target_task_id,
                "groupId": run.group_id
            }),
        )
        .await?;
        Ok(run)
    }

    async fn ensure_no_active_run(&self) -> Result<(), ApiError> {
        if self.active_run().await?.is_some() {
            return Err(
                ApiError::conflict("A workflow is already running. Stop it first.")
                    .with_code(ErrorCode::ExecutionOperationFailed),
            );
        }
        Ok(())
    }

    async fn cleanup_stale_runs(&self) -> Result<(), ApiError> {
        if self.runtime.lock().await.active_run_id.is_some() {
            return Ok(());
        }

        let runs = get_workflow_runs(&self.db).await?;
        for run in runs.into_iter().filter(|run| {
            matches!(
                run.status,
                WorkflowRunStatus::Queued
                    | WorkflowRunStatus::Running
                    | WorkflowRunStatus::Paused
                    | WorkflowRunStatus::Stopping
            )
        }) {
            for task_id in run.task_order_vec()? {
                if let Some(task) = get_task(&self.db, &task_id).await? {
                    if matches!(
                        task.status,
                        TaskStatus::Queued | TaskStatus::Executing | TaskStatus::Review
                    ) {
                        update_task(
                            &self.db,
                            &task.id,
                            UpdateTaskInput {
                                status: Some(TaskStatus::Backlog),
                                error_message: Some(Some(
                                    "Auto-recovered stale workflow run".to_string(),
                                )),
                                session_id: Some(None),
                                session_url: Some(None),
                                ..Default::default()
                            },
                        )
                        .await?;
                    }
                }
            }

            let _ = update_workflow_run_record(
                &self.db,
                &run.id,
                UpdateWorkflowRunRecord {
                    status: Some(WorkflowRunStatus::Failed),
                    error_message: Some(Some("Auto-recovered stale workflow run".to_string())),
                    finished_at: Some(Some(chrono::Utc::now().timestamp())),
                    ..Default::default()
                },
            )
            .await?;

            self.audit_warn(
                "run.auto_recovered_stale",
                format!("Auto-recovered stale workflow run {}", run.id),
                Some(&run.id),
                None,
                None,
                None,
                json!({
                    "previousStatus": run.status,
                    "taskOrder": run.task_order,
                    "errorMessage": "Auto-recovered stale workflow run"
                }),
            )
            .await?;
        }

        Ok(())
    }

    fn ensure_supported_tasks(&self, tasks: &[Task]) -> Result<(), ApiError> {
        for task in tasks {
            if task
                .container_image
                .as_ref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(ApiError::internal(format!(
                    "Task '{}' requires container image execution, but the Rust backend is native-only",
                    task.name
                ))
                .with_code(ErrorCode::ContainerImageNotFound));
            }
        }
        Ok(())
    }

    fn schedule(&self) -> Pin<Box<dyn Future<Output = Result<(), ApiError>> + Send + '_>> {
        Box::pin(async move {
            let _guard = self.schedule_lock.clone().lock_owned().await;
            self.sync_slot_capacity().await?;

            loop {
                let run_id = {
                    let runtime = self.runtime.lock().await;
                    runtime.active_run_id.clone()
                };
                let Some(run_id) = run_id else {
                    return Ok(());
                };
                let run = match get_workflow_run(&self.db, &run_id).await? {
                    Some(run) => run,
                    None => {
                        self.runtime.lock().await.active_run_id = None;
                        return Ok(());
                    }
                };

                if !matches!(
                    run.status,
                    WorkflowRunStatus::Queued | WorkflowRunStatus::Running
                ) {
                    return Ok(());
                }

                if self.available_slot_count().await == 0 {
                    break;
                }

                let Some(task) = self.next_ready_task(&run).await? else {
                    break;
                };

                self.start_task_execution(&run, &task).await?;
            }

            if let Some(run) = self.active_run().await? {
                self.refresh_run_counts(&run.id).await?;
                self.finalize_if_possible(&run.id).await?;
            }

            Ok(())
        })
    }

    async fn sync_slot_capacity(&self) -> Result<(), ApiError> {
        let options = get_options(&self.db).await?;
        let target = options.parallel_tasks.max(1) as usize;
        let mut runtime = self.runtime.lock().await;
        if runtime.slots.len() < target {
            runtime.slots.resize_with(target, || None);
        }
        Ok(())
    }

    async fn available_slot_count(&self) -> usize {
        let runtime = self.runtime.lock().await;
        runtime.slots.iter().filter(|slot| slot.is_none()).count()
    }

    async fn next_ready_task(&self, run: &WorkflowRun) -> Result<Option<Task>, ApiError> {
        let task_ids = run.task_order_vec()?;
        let task_map = get_tasks(&self.db)
            .await?
            .into_iter()
            .map(|task| (task.id.clone(), task))
            .collect::<HashMap<_, _>>();

        for task_id in task_ids {
            let Some(task) = task_map.get(&task_id) else {
                continue;
            };
            if task.status != TaskStatus::Queued {
                continue;
            }

            let dependencies_ready = task.requirements_vec().into_iter().all(|dependency_id| {
                match task_map.get(&dependency_id) {
                    Some(dependency) => dependency.status == TaskStatus::Done,
                    None => true,
                }
            });
            if dependencies_ready {
                return Ok(Some(task.clone()));
            }
        }

        Ok(None)
    }

    async fn start_task_execution(&self, run: &WorkflowRun, task: &Task) -> Result<(), ApiError> {
        let slot_index = {
            let mut runtime = self.runtime.lock().await;
            let slot_index = runtime
                .slots
                .iter()
                .position(|slot| slot.is_none())
                .ok_or_else(|| {
                    ApiError::internal("Scheduler tried to start a task without an available slot")
                        .with_code(ErrorCode::ExecutionOperationFailed)
                })?;
            let (stop_tx, stop_rx) = watch::channel(false);
            runtime.slots[slot_index] = Some(SlotAssignment {
                run_id: run.id.clone(),
                task_id: task.id.clone(),
            });
            runtime.active_tasks.insert(
                task.id.clone(),
                ActiveTaskControl {
                    run_id: run.id.clone(),
                    slot_index,
                    stop_tx,
                },
            );

            let orchestrator = self.clone();
            let run_id = run.id.clone();
            let task_id = task.id.clone();
            tokio::spawn(async move {
                let outcome = orchestrator
                    .execute_task(run_id.clone(), task_id.clone(), slot_index, stop_rx)
                    .await;
                if let Err(error) = orchestrator
                    .handle_task_completion(run_id, task_id, slot_index, outcome)
                    .await
                {
                    error!("failed to finalize task execution: {}", error);
                }
            });

            slot_index
        };

        if run.status == WorkflowRunStatus::Queued {
            let updated = update_workflow_run_record(
                &self.db,
                &run.id,
                UpdateWorkflowRunRecord {
                    status: Some(WorkflowRunStatus::Running),
                    ..Default::default()
                },
            )
            .await?
            .ok_or_else(|| {
                ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound)
            })?;
            self.broadcast_run(&updated).await;
            self.broadcast("execution_started", json!({ "runId": run.id }))
                .await;
        }

        self.refresh_run_counts(&run.id).await?;
        self.broadcast(
            "slot_started",
            json!({ "runId": run.id, "taskId": task.id, "slotIndex": slot_index }),
        )
        .await;
        self.audit_info(
            "task.dispatched",
            format!(
                "Dispatched task {} into execution slot {}",
                task.id, slot_index
            ),
            Some(&run.id),
            Some(&task.id),
            None,
            None,
            json!({
                "slotIndex": slot_index,
                "taskName": task.name,
                "runStatus": run.status
            }),
        )
        .await?;
        Ok(())
    }

    async fn execute_task(
        &self,
        run_id: String,
        task_id: String,
        slot_index: usize,
        stop_rx: watch::Receiver<bool>,
    ) -> TaskOutcome {
        match self
            .execute_task_inner(&run_id, &task_id, slot_index, stop_rx)
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => TaskOutcome {
                status: TaskStatus::Failed,
                error_message: Some(error.to_string()),
            },
        }
    }

    async fn execute_task_inner(
        &self,
        run_id: &str,
        task_id: &str,
        slot_index: usize,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<TaskOutcome, ApiError> {
        let task = get_task(&self.db, task_id).await?.ok_or_else(|| {
            ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound)
        })?;
        let options = get_options(&self.db).await?;
        self.ensure_supported_tasks(std::slice::from_ref(&task))?;

        // Plan mode: skip execution when waiting for approval
        if task.awaiting_plan_approval {
            return Ok(TaskOutcome {
                status: TaskStatus::Review,
                error_message: None,
            });
        }

        // Best-of-N: full lifecycle with its own worktree management
        if task.execution_strategy == ExecutionStrategy::BestOfN {
            return self
                .run_best_of_n(&task, run_id, &options, slot_index, stop_rx)
                .await;
        }

        // Plan mode: planning or implementation phase
        if task.plan_mode
            && matches!(
                task.execution_phase,
                ExecutionPhase::NotStarted
                    | ExecutionPhase::PlanRevisionPending
                    | ExecutionPhase::ImplementationPending
            )
        {
            let _ = update_task(
                &self.db,
                &task.id,
                UpdateTaskInput {
                    status: Some(TaskStatus::Executing),
                    error_message: Some(None),
                    completed_at: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            if let Some(updated_task) = get_task(&self.db, &task.id).await? {
                self.broadcast_task(&updated_task).await;
            }

            let target_branch = resolve_target_branch(
                &self.project_root,
                task.branch.as_deref(),
                Some(options.branch.as_str()),
            )
            .await?;
            let worktree =
                create_task_worktree(&self.project_root, &task.id, &task.name, &target_branch)
                    .await?;
            if !options.command.trim().is_empty() {
                run_shell_command(options.command.trim(), &worktree.directory).await?;
            }
            return self
                .run_plan_mode(&task, run_id, &options, &worktree, slot_index, stop_rx)
                .await;
        }

        self.audit_info(
            "task.execution.preparing",
            format!("Preparing task {} for execution", task.id),
            Some(run_id),
            Some(&task.id),
            None,
            None,
            json!({
                "slotIndex": slot_index,
                "taskName": task.name,
                "taskBranch": task.branch,
                "optionBranch": options.branch,
                "planModel": task.plan_model,
                "executionModel": task.execution_model
            }),
        )
        .await?;

        let target_branch = match resolve_target_branch(
            &self.project_root,
            task.branch.as_deref(),
            Some(options.branch.as_str()),
        )
        .await
        {
            Ok(branch) => {
                self.audit_info(
                    "task.branch_resolved",
                    format!(
                        "Resolved execution branch '{}' for task {}",
                        branch, task.id
                    ),
                    Some(run_id),
                    Some(&task.id),
                    None,
                    None,
                    json!({
                        "taskBranch": task.branch,
                        "optionBranch": options.branch,
                        "resolvedBranch": branch
                    }),
                )
                .await?;
                branch
            }
            Err(error) => {
                self.audit_error(
                    "task.branch_resolution_failed",
                    format!("Failed to resolve target branch for task {}", task.id),
                    Some(run_id),
                    Some(&task.id),
                    None,
                    None,
                    json!({
                        "taskBranch": task.branch,
                        "optionBranch": options.branch,
                        "error": error.to_string()
                    }),
                )
                .await?;
                return Err(error);
            }
        };
        let worktree =
            match create_task_worktree(&self.project_root, &task.id, &task.name, &target_branch)
                .await
            {
                Ok(worktree) => {
                    self.audit_info(
                        "task.worktree_created",
                        format!("Created worktree for task {}", task.id),
                        Some(run_id),
                        Some(&task.id),
                        None,
                        None,
                        json!({
                            "worktreeDir": worktree.directory,
                            "worktreeBranch": worktree.branch,
                            "baseRef": worktree.base_ref
                        }),
                    )
                    .await?;
                    worktree
                }
                Err(error) => {
                    self.audit_error(
                        "task.worktree_create_failed",
                        format!("Failed to create worktree for task {}", task.id),
                        Some(run_id),
                        Some(&task.id),
                        None,
                        None,
                        json!({
                            "targetBranch": target_branch,
                            "error": error.to_string()
                        }),
                    )
                    .await?;
                    return Err(error);
                }
            };

        if !options.command.trim().is_empty() {
            self.audit_info(
                "task.pre_execution_command_started",
                format!("Running pre-execution command for task {}", task.id),
                Some(run_id),
                Some(&task.id),
                None,
                None,
                json!({
                    "command": options.command,
                    "worktreeDir": worktree.directory
                }),
            )
            .await?;

            if let Err(error) = run_shell_command(options.command.trim(), &worktree.directory).await
            {
                self.audit_error(
                    "task.pre_execution_command_failed",
                    format!("Pre-execution command failed for task {}", task.id),
                    Some(run_id),
                    Some(&task.id),
                    None,
                    None,
                    json!({
                        "command": options.command,
                        "worktreeDir": worktree.directory,
                        "error": error.to_string()
                    }),
                )
                .await?;
                return Err(error);
            }

            self.audit_info(
                "task.pre_execution_command_completed",
                format!("Pre-execution command completed for task {}", task.id),
                Some(run_id),
                Some(&task.id),
                None,
                None,
                json!({
                    "command": options.command,
                    "worktreeDir": worktree.directory
                }),
            )
            .await?;
        }

        let model = resolve_execution_model(&task, &options)?;
        let attempt_index = get_task_runs(&self.db, &task.id).await?.len() as i32;
        let task_run = create_task_run_record(
            &self.db,
            CreateTaskRunRecord {
                id: None,
                task_id: task.id.clone(),
                phase: RunPhase::Worker,
                slot_index: slot_index as i32,
                attempt_index,
                model: model.clone(),
                task_suffix: None,
                status: RunStatus::Running,
                session_id: None,
                session_url: None,
                worktree_dir: Some(worktree.directory.clone()),
                summary: None,
                error_message: None,
                candidate_id: None,
                metadata_json: None,
                created_at: None,
                completed_at: None,
            },
        )
        .await?;

        let session_id = Uuid::new_v4().to_string()[..8].to_string();
        let session_url = self.session_url_for(&session_id);
        let pi_session_file = self.pi_session_file_for(&session_id);
        let isolation_spec = isolation::resolve_session_isolation(
            &task,
            PiSessionKind::Task,
            &self.project_root,
            options.bubblewrap_enabled,
        )?;
        let session = create_workflow_session_record(
            &self.db,
            CreateWorkflowSessionRecord {
                id: Some(session_id.clone()),
                task_id: Some(task.id.clone()),
                task_run_id: Some(task_run.id.clone()),
                session_kind: PiSessionKind::Task,
                status: PiSessionStatus::Starting,
                cwd: worktree.directory.clone(),
                worktree_dir: Some(worktree.directory.clone()),
                branch: Some(worktree.branch.clone()),
                pi_session_id: None,
                pi_session_file: Some(pi_session_file),
                process_pid: None,
                model: model.clone(),
                thinking_level: task.execution_thinking_level,
                started_at: None,
                finished_at: None,
                exit_code: None,
                exit_signal: None,
                error_message: None,
                name: Some(format!("Task {}", task.id)),
                isolation_mode: isolation_spec.mode,
                path_grants_json: isolation_spec.to_grants_json(),
            },
        )
        .await?;

        self.audit_info(
            "task.session_isolation",
            format!("Isolation mode {:?} for session {}", isolation_spec.mode, session.id),
            Some(run_id),
            Some(&task.id),
            Some(&task_run.id),
            Some(&session.id),
            json!({
                "isolationMode": isolation_spec.mode,
                "grantCount": isolation_spec.grants.len(),
            }),
        )
        .await?;

        self.audit_info(
            "task.session_created",
            format!("Created Pi session {} for task {}", session.id, task.id),
            Some(run_id),
            Some(&task.id),
            Some(&task_run.id),
            Some(&session.id),
            json!({
                "model": model,
                "worktreeDir": worktree.directory,
                "branch": worktree.branch,
                "sessionFile": session.pi_session_file,
                "taskRunId": task_run.id
            }),
        )
        .await?;

        update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                status: Some(TaskStatus::Executing),
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                error_message: Some(None),
                ..Default::default()
            },
        )
        .await?;
        if let Some(updated_task) = get_task(&self.db, &task.id).await? {
            self.broadcast_task(&updated_task).await;
        }

        update_task_run_record(
            &self.db,
            &task_run.id,
            UpdateTaskRunRecord {
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                ..Default::default()
            },
        )
        .await?;

        let prompt =
            render_execution_prompt(&self.db, &task, &options, &worktree.directory).await?;
        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
        );

        let response = executor
            .run_prompt(session.clone(), &model, &prompt, stop_rx.clone())
            .await;
        match response {
            Ok(response_text) => {
                let has_changes = worktree_has_changes(&worktree.directory).await?;
                if response_text.trim().is_empty() && !has_changes {
                    let message = format!(
                        "Task '{}' completed without agent output or repository changes",
                        task.name
                    );

                    update_task(
                        &self.db,
                        &task.id,
                        UpdateTaskInput {
                            status: Some(TaskStatus::Failed),
                            error_message: Some(Some(message.clone())),
                            worktree_dir: Some(Some(worktree.directory.clone())),
                            ..Default::default()
                        },
                    )
                    .await?;
                    if let Some(updated_task) = get_task(&self.db, &task.id).await? {
                        self.broadcast_task(&updated_task).await;
                    }

                    update_task_run_record(
                        &self.db,
                        &task_run.id,
                        UpdateTaskRunRecord {
                            status: Some(RunStatus::Failed),
                            error_message: Some(Some(message.clone())),
                            completed_at: Some(Some(chrono::Utc::now().timestamp())),
                            worktree_dir: Some(Some(worktree.directory.clone())),
                            ..Default::default()
                        },
                    )
                    .await?;

                    self.audit_error(
                        "task.execution_noop",
                        format!("Task {} finished without visible changes", task.id),
                        Some(run_id),
                        Some(&task.id),
                        Some(&task_run.id),
                        Some(&session.id),
                        json!({
                            "worktreeDir": worktree.directory,
                            "mergedInto": target_branch,
                            "responseLength": 0,
                            "hasChanges": false
                        }),
                    )
                    .await?;

                    return Ok(TaskOutcome {
                        status: TaskStatus::Failed,
                        error_message: Some(message),
                    });
                }

                // Review loop for standard execution
                if task.review || task.code_style_review {
                    let review_passed = self
                        .run_review_loop(
                            &task,
                            run_id,
                            &options,
                            &worktree,
                            &target_branch,
                            slot_index,
                            stop_rx,
                        )
                        .await?;
                    if !review_passed {
                        return Ok(TaskOutcome {
                            status: TaskStatus::Stuck,
                            error_message: Some("Review loop failed".to_string()),
                        });
                    }
                }

                let committed = if task.auto_commit {
                    auto_commit_worktree(&worktree.directory, &task.name, &task.id).await?
                } else {
                    false
                };

                let final_worktree_dir = if task.delete_worktree {
                    merge_and_cleanup_worktree(
                        &self.project_root,
                        &worktree.directory,
                        &worktree.branch,
                        &target_branch,
                        true,
                        &format!("{} ({})", task.name, task.id),
                    )
                    .await?;
                    None
                } else {
                    merge_and_cleanup_worktree(
                        &self.project_root,
                        &worktree.directory,
                        &worktree.branch,
                        &target_branch,
                        false,
                        &format!("{} ({})", task.name, task.id),
                    )
                    .await?;
                    Some(worktree.directory.clone())
                };

                let updated_output = if response_text.trim().is_empty() {
                    task.agent_output.clone()
                } else if task.agent_output.trim().is_empty() {
                    format!("{}\n", response_text.trim())
                } else {
                    format!(
                        "{}\n{}\n",
                        task.agent_output.trim_end(),
                        response_text.trim()
                    )
                };

                update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        status: Some(TaskStatus::Done),
                        agent_output: Some(Some(updated_output)),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        worktree_dir: Some(final_worktree_dir.clone()),
                        ..Default::default()
                    },
                )
                .await?;
                let updated_task = get_task(&self.db, &task.id).await?.ok_or_else(|| {
                    ApiError::internal("Task disappeared after successful execution")
                })?;
                self.broadcast_task(&updated_task).await;

                update_task_run_record(
                    &self.db,
                    &task_run.id,
                    UpdateTaskRunRecord {
                        status: Some(RunStatus::Done),
                        summary: Some(Some(response_text.trim().to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        worktree_dir: Some(final_worktree_dir.clone()),
                        ..Default::default()
                    },
                )
                .await?;

                self.audit_info(
                    "task.execution_succeeded",
                    format!("Task {} completed successfully", task.id),
                    Some(run_id),
                    Some(&task.id),
                    Some(&task_run.id),
                    Some(&session.id),
                    json!({
                        "responseLength": response_text.trim().len(),
                        "worktreeDir": worktree.directory,
                        "mergedInto": target_branch,
                        "autoCommitEnabled": task.auto_commit,
                        "autoCommitCreated": committed,
                        "deleteWorktree": task.delete_worktree,
                        "finalWorktreeDir": final_worktree_dir
                    }),
                )
                .await?;

                Ok(TaskOutcome {
                    status: TaskStatus::Done,
                    error_message: None,
                })
            }
            Err(error) => {
                update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        status: Some(TaskStatus::Failed),
                        error_message: Some(Some(error.to_string())),
                        worktree_dir: Some(Some(worktree.directory.clone())),
                        ..Default::default()
                    },
                )
                .await?;
                if let Some(updated_task) = get_task(&self.db, &task.id).await? {
                    self.broadcast_task(&updated_task).await;
                }

                update_task_run_record(
                    &self.db,
                    &task_run.id,
                    UpdateTaskRunRecord {
                        status: Some(RunStatus::Failed),
                        error_message: Some(Some(error.to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        worktree_dir: Some(Some(worktree.directory.clone())),
                        ..Default::default()
                    },
                )
                .await?;

                self.audit_error(
                    "task.execution_failed",
                    format!("Task {} failed during execution", task.id),
                    Some(run_id),
                    Some(&task.id),
                    Some(&task_run.id),
                    Some(&session.id),
                    json!({
                        "worktreeDir": worktree.directory,
                        "targetBranch": target_branch,
                        "error": error.to_string()
                    }),
                )
                .await?;

                Ok(TaskOutcome {
                    status: TaskStatus::Failed,
                    error_message: Some(error.to_string()),
                })
            }
        }
    }

    async fn handle_task_completion(
        &self,
        run_id: String,
        task_id: String,
        slot_index: usize,
        outcome: TaskOutcome,
    ) -> Result<(), ApiError> {
        let remaining_active = {
            let mut runtime = self.runtime.lock().await;
            runtime.active_tasks.remove(&task_id);
            if let Some(slot) = runtime.slots.get_mut(slot_index) {
                *slot = None;
            }
            runtime
                .active_tasks
                .values()
                .filter(|control| control.run_id == run_id)
                .count()
        };

        self.refresh_run_counts(&run_id).await?;

        let run = self.reload_run(&run_id).await?;
        let stop_mode = stop_mode_for_run(&run);

        if outcome.status == TaskStatus::Failed {
            if let Some(mode) = stop_mode {
                let (task_status, message) = match mode {
                    StopMode::Graceful => (TaskStatus::Backlog, GRACEFUL_STOP_MESSAGE),
                    StopMode::Destructive => (TaskStatus::Failed, DESTRUCTIVE_STOP_MESSAGE),
                    StopMode::Failure => (
                        TaskStatus::Failed,
                        run.error_message
                            .as_deref()
                            .unwrap_or("Workflow halted after task failure"),
                    ),
                };

                update_task(
                    &self.db,
                    &task_id,
                    UpdateTaskInput {
                        status: Some(task_status),
                        error_message: Some(Some(message.to_string())),
                        session_id: Some(None),
                        session_url: Some(None),
                        completed_at: Some(None),
                        ..Default::default()
                    },
                )
                .await?;

                if let Some(updated_task) = get_task(&self.db, &task_id).await? {
                    self.broadcast_task(&updated_task).await;
                }
            }
        }

        match outcome.status {
            TaskStatus::Done => {
                self.audit_info(
                    "task.completion_recorded",
                    format!("Recorded successful completion for task {}", task_id),
                    Some(&run_id),
                    Some(&task_id),
                    None,
                    None,
                    json!({
                        "slotIndex": slot_index,
                        "remainingActiveTasks": remaining_active
                    }),
                )
                .await?;
            }
            TaskStatus::Failed | TaskStatus::Stuck if stop_mode.is_none() => {
                self.audit_warn(
                    "task.completion_recorded_with_failure",
                    format!("Recorded failed completion for task {}", task_id),
                    Some(&run_id),
                    Some(&task_id),
                    None,
                    None,
                    json!({
                        "slotIndex": slot_index,
                        "remainingActiveTasks": remaining_active,
                        "error": outcome.error_message
                    }),
                )
                .await?;
            }
            _ => {}
        }

        if outcome.status == TaskStatus::Failed {
            self.mark_remaining_tasks_blocked(&run_id, &task_id, outcome.error_message.as_deref())
                .await?;
            if remaining_active > 0 {
                let _ = self.signal_stop_for_run(&run_id).await;
            }
        }

        self.finalize_if_possible(&run_id).await?;
        if self.active_run().await?.is_some() {
            self.schedule().await?;
        }

        Ok(())
    }

    async fn mark_remaining_tasks_blocked(
        &self,
        run_id: &str,
        failed_task_id: &str,
        reason: Option<&str>,
    ) -> Result<(), ApiError> {
        let run = self.reload_run(run_id).await?;
        let message = format!(
            "Workflow halted after task '{}' failed{}",
            failed_task_id,
            reason
                .map(|value| format!(": {}", value))
                .unwrap_or_default()
        );

        for task_id in run.task_order_vec()? {
            if task_id == failed_task_id {
                continue;
            }
            if let Some(task) = get_task(&self.db, &task_id).await? {
                if task.status == TaskStatus::Queued {
                    update_task(
                        &self.db,
                        &task.id,
                        UpdateTaskInput {
                            status: Some(TaskStatus::Backlog),
                            error_message: Some(Some(message.clone())),
                            ..Default::default()
                        },
                    )
                    .await?;
                    if let Some(updated_task) = get_task(&self.db, &task.id).await? {
                        self.broadcast_task(&updated_task).await;
                    }
                }
            }
        }

        let updated = update_workflow_run_record(
            &self.db,
            run_id,
            UpdateWorkflowRunRecord {
                status: Some(WorkflowRunStatus::Stopping),
                stop_requested: Some(true),
                error_message: Some(Some(message)),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;
        self.broadcast_run(&updated).await;
        self.audit_warn(
            "run.blocked_after_task_failure",
            format!(
                "Workflow run {} halted after task {} failed",
                run_id, failed_task_id
            ),
            Some(run_id),
            Some(failed_task_id),
            None,
            None,
            json!({
                "reason": reason,
                "runStatus": updated.status,
                "stopRequested": updated.stop_requested
            }),
        )
        .await?;
        Ok(())
    }

    async fn finalize_if_possible(&self, run_id: &str) -> Result<(), ApiError> {
        let run = self.reload_run(run_id).await?;
        let task_ids = run.task_order_vec()?;
        let tasks = task_ids
            .iter()
            .map(|task_id| get_task(&self.db, task_id))
            .collect::<Vec<_>>();

        let mut loaded = Vec::with_capacity(tasks.len());
        for future in tasks {
            if let Some(task) = future.await? {
                loaded.push(task);
            }
        }

        let all_terminal = loaded.iter().all(|task| {
            matches!(
                task.status,
                TaskStatus::Done | TaskStatus::Failed | TaskStatus::Stuck
            )
        });
        let all_stopped = loaded.iter().all(|task| {
            matches!(
                task.status,
                TaskStatus::Done
                    | TaskStatus::Failed
                    | TaskStatus::Stuck
                    | TaskStatus::Backlog
                    | TaskStatus::Template
            )
        });
        let has_active_tasks = {
            let runtime = self.runtime.lock().await;
            runtime
                .active_tasks
                .values()
                .any(|control| control.run_id == run_id)
        };

        if has_active_tasks {
            return Ok(());
        }

        if run.status == WorkflowRunStatus::Paused && !all_terminal {
            self.refresh_run_counts(run_id).await?;
            return Ok(());
        }

        let stop_mode = stop_mode_for_run(&run);
        if stop_mode.is_some() {
            if !all_stopped {
                self.refresh_run_counts(run_id).await?;
                return Ok(());
            }
        } else if !all_terminal {
            self.refresh_run_counts(run_id).await?;
            return Ok(());
        }

        let any_failed = loaded
            .iter()
            .any(|task| matches!(task.status, TaskStatus::Failed | TaskStatus::Stuck));
        let final_status = match stop_mode {
            Some(StopMode::Graceful) => WorkflowRunStatus::Completed,
            Some(StopMode::Destructive) | Some(StopMode::Failure) => WorkflowRunStatus::Failed,
            None => {
                if any_failed {
                    WorkflowRunStatus::Failed
                } else {
                    WorkflowRunStatus::Completed
                }
            }
        };
        let updated = update_workflow_run_record(
            &self.db,
            run_id,
            UpdateWorkflowRunRecord {
                status: Some(final_status),
                current_task_id: Some(None),
                current_task_index: Some(task_ids.len() as i32),
                finished_at: Some(Some(chrono::Utc::now().timestamp())),
                queued_task_count: Some(Some(0)),
                executing_task_count: Some(Some(0)),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;

        if final_status == WorkflowRunStatus::Completed {
            if let Some(group_id) = updated.group_id.clone() {
                let _ = update_task_group(
                    &self.db,
                    &group_id,
                    None,
                    None,
                    Some(TaskGroupStatus::Completed),
                )
                .await?;
                self.broadcast(
                    "group_execution_complete",
                    json!({ "groupId": group_id, "runId": updated.id }),
                )
                .await;
            }
        }

        self.runtime.lock().await.active_run_id = None;
        self.broadcast_run(&updated).await;
        self.broadcast(
            if final_status == WorkflowRunStatus::Completed {
                "execution_complete"
            } else {
                "execution_failed"
            },
            json!({ "runId": updated.id }),
        )
        .await;

        self.audit_event(
            if final_status == WorkflowRunStatus::Completed {
                AuditLevel::Info
            } else {
                AuditLevel::Warn
            },
            "run.finalized",
            format!(
                "Workflow run {} finalized with status {:?}",
                updated.id, final_status
            ),
            Some(&updated.id),
            updated.current_task_id.as_deref(),
            None,
            None,
            json!({
                "status": final_status,
                "currentTaskIndex": updated.current_task_index,
                "stopRequested": updated.stop_requested,
                "errorMessage": updated.error_message,
                "queuedTaskCount": updated.queued_task_count,
                "executingTaskCount": updated.executing_task_count
            }),
        )
        .await?;

        Ok(())
    }

    async fn finalize_run_after_stop(
        &self,
        run_id: &str,
        destructive: bool,
    ) -> Result<(), ApiError> {
        let run = self.reload_run(run_id).await?;
        let task_count = run.task_order_vec()?.len() as i32;
        let updated = update_workflow_run_record(
            &self.db,
            run_id,
            UpdateWorkflowRunRecord {
                status: Some(if destructive {
                    WorkflowRunStatus::Failed
                } else {
                    WorkflowRunStatus::Completed
                }),
                current_task_id: Some(None),
                current_task_index: Some(task_count),
                finished_at: Some(Some(chrono::Utc::now().timestamp())),
                queued_task_count: Some(Some(0)),
                executing_task_count: Some(Some(0)),
                ..Default::default()
            },
        )
        .await?
        .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))?;
        self.runtime.lock().await.active_run_id = None;
        self.broadcast_run(&updated).await;
        Ok(())
    }

    async fn cleanup_stopped_run_worktrees(&self, task_ids: &[String]) -> Result<i32, ApiError> {
        let mut cleaned = 0;

        for task_id in task_ids {
            let Some(task) = get_task(&self.db, task_id).await? else {
                continue;
            };

            let Some(worktree_dir) = task.worktree_dir.clone() else {
                continue;
            };

            if !Path::new(&worktree_dir).exists() {
                continue;
            }

            remove_worktree(&self.project_root, &worktree_dir).await?;
            update_task(
                &self.db,
                task_id,
                UpdateTaskInput {
                    worktree_dir: Some(None),
                    ..Default::default()
                },
            )
            .await?;

            if let Some(updated_task) = get_task(&self.db, task_id).await? {
                self.broadcast_task(&updated_task).await;
            }

            cleaned += 1;
        }

        Ok(cleaned)
    }

    async fn signal_stop_for_run(&self, run_id: &str) -> i32 {
        let mut stop_senders = Vec::new();
        {
            let runtime = self.runtime.lock().await;
            for control in runtime.active_tasks.values() {
                if control.run_id == run_id {
                    stop_senders.push(control.stop_tx.clone());
                }
            }
        }

        for sender in &stop_senders {
            let _ = sender.send(true);
        }

        stop_senders.len() as i32
    }

    async fn refresh_run_counts(&self, run_id: &str) -> Result<(), ApiError> {
        let run = self.reload_run(run_id).await?;
        let task_ids = run.task_order_vec()?;
        let mut queued = 0;
        let mut executing = 0;
        let mut current_task_id = None;
        let mut completed = 0;

        for task_id in &task_ids {
            if let Some(task) = get_task(&self.db, task_id).await? {
                match task.status {
                    TaskStatus::Queued => {
                        queued += 1;
                        if current_task_id.is_none() {
                            current_task_id = Some(task.id.clone());
                        }
                    }
                    TaskStatus::Executing => {
                        executing += 1;
                        if current_task_id.is_none() {
                            current_task_id = Some(task.id.clone());
                        }
                    }
                    TaskStatus::Done | TaskStatus::Failed | TaskStatus::Stuck => completed += 1,
                    _ => {}
                }
            }
        }

        let _ = update_workflow_run_record(
            &self.db,
            run_id,
            UpdateWorkflowRunRecord {
                current_task_id: Some(current_task_id),
                current_task_index: Some(completed),
                queued_task_count: Some(Some(queued)),
                executing_task_count: Some(Some(executing)),
                ..Default::default()
            },
        )
        .await?;
        Ok(())
    }

    async fn reload_run(&self, run_id: &str) -> Result<WorkflowRun, ApiError> {
        get_workflow_run(&self.db, run_id)
            .await?
            .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))
    }

    fn session_url_for(&self, session_id: &str) -> String {
        crate::state::session_url_for(session_id)
    }

    fn pi_session_file_for(&self, session_id: &str) -> String {
        Path::new(&self.settings_dir)
            .join("pi-sessions")
            .join(format!("{}.json", session_id))
            .to_string_lossy()
            .to_string()
    }

    async fn broadcast(&self, event_type: &str, payload: serde_json::Value) {
        let hub = self.sse_hub.read().await;
        hub.broadcast(&WSMessage {
            r#type: event_type.to_string(),
            payload,
        })
        .await;
    }

    async fn broadcast_task(&self, task: &Task) {
        let payload = serde_json::to_value(task).unwrap_or_else(|_| json!({ "id": task.id }));
        self.broadcast("task_updated", payload).await;
    }

    async fn broadcast_run(&self, run: &WorkflowRun) {
        let payload = serde_json::to_value(run).unwrap_or_else(|_| json!({ "id": run.id }));
        self.broadcast("run_updated", payload).await;
    }
}

#[derive(Debug, Clone)]
pub(super) struct TaskOutcome {
    pub(super) status: TaskStatus,
    pub(super) error_message: Option<String>,
}

fn select_all_runnable_tasks(tasks: &[Task]) -> Result<Vec<Task>, ApiError> {
    let task_map = tasks
        .iter()
        .cloned()
        .map(|task| (task.id.clone(), task))
        .collect::<HashMap<_, _>>();
    let pending = tasks
        .iter()
        .filter(|task| matches!(task.status, TaskStatus::Backlog | TaskStatus::Template))
        .cloned()
        .collect::<Vec<_>>();
    let mut selected_ids = HashSet::new();
    let mut made_progress = true;

    while made_progress {
        made_progress = false;
        for task in &pending {
            if selected_ids.contains(&task.id) {
                continue;
            }

            let dependencies_ready = task.requirements_vec().into_iter().all(|dependency_id| {
                match task_map.get(&dependency_id) {
                    Some(dependency) => {
                        dependency.status == TaskStatus::Done
                            || selected_ids.contains(&dependency_id)
                    }
                    None => true,
                }
            });

            if dependencies_ready {
                selected_ids.insert(task.id.clone());
                made_progress = true;
            }
        }
    }

    let mut ordered = pending
        .into_iter()
        .filter(|task| selected_ids.contains(&task.id))
        .collect::<Vec<_>>();
    ordered.sort_by_key(|task| task.idx);
    Ok(ordered)
}

fn resolve_single_task_chain(tasks: &[Task], task_id: &str) -> Result<Vec<Task>, ApiError> {
    let task_map = tasks
        .iter()
        .cloned()
        .map(|task| (task.id.clone(), task))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::new();
    let mut visited = HashSet::new();
    let mut visiting = HashSet::new();

    fn visit(
        task_id: &str,
        task_map: &HashMap<String, Task>,
        visited: &mut HashSet<String>,
        visiting: &mut HashSet<String>,
        ordered: &mut Vec<Task>,
        is_target: bool,
    ) -> Result<(), ApiError> {
        if visited.contains(task_id) {
            return Ok(());
        }
        if !visiting.insert(task_id.to_string()) {
            return Err(ApiError::internal(format!(
                "Circular dependency detected while resolving {}",
                task_id
            ))
            .with_code(ErrorCode::ExecutionOperationFailed));
        }

        let task = task_map.get(task_id).cloned().ok_or_else(|| {
            ApiError::not_found("Task not found").with_code(ErrorCode::TaskNotFound)
        })?;

        for dependency_id in task.requirements_vec() {
            let Some(dependency) = task_map.get(&dependency_id) else {
                continue;
            };
            if dependency.status == TaskStatus::Done {
                continue;
            }
            if !matches!(
                dependency.status,
                TaskStatus::Backlog | TaskStatus::Template
            ) {
                let message = if is_target {
                    format!(
                        "Task '{}' is blocked by dependency '{}' in status '{:?}'",
                        task.name, dependency.name, dependency.status
                    )
                } else {
                    format!(
                        "Dependency '{}' is not runnable from status '{:?}'",
                        dependency.name, dependency.status
                    )
                };
                return Err(
                    ApiError::conflict(message).with_code(ErrorCode::ExecutionOperationFailed)
                );
            }
            visit(&dependency.id, task_map, visited, visiting, ordered, false)?;
        }

        visiting.remove(task_id);
        visited.insert(task_id.to_string());
        if task.status != TaskStatus::Done {
            if !matches!(task.status, TaskStatus::Backlog | TaskStatus::Template) {
                return Err(ApiError::conflict(format!(
                    "Task '{}' is not runnable from status '{:?}'",
                    task.name, task.status
                ))
                .with_code(ErrorCode::ExecutionOperationFailed));
            }
            ordered.push(task);
        }

        Ok(())
    }

    visit(
        task_id,
        &task_map,
        &mut visited,
        &mut visiting,
        &mut ordered,
        true,
    )?;
    Ok(ordered)
}

fn order_subset_by_dependencies(tasks: &[Task]) -> Result<Vec<Task>, ApiError> {
    let task_map = tasks
        .iter()
        .cloned()
        .map(|task| (task.id.clone(), task))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::new();
    let mut visited = HashSet::new();
    let mut visiting = HashSet::new();

    fn visit(
        task: &Task,
        task_map: &HashMap<String, Task>,
        visited: &mut HashSet<String>,
        visiting: &mut HashSet<String>,
        ordered: &mut Vec<Task>,
    ) -> Result<(), ApiError> {
        if visited.contains(&task.id) {
            return Ok(());
        }
        if !visiting.insert(task.id.clone()) {
            return Err(ApiError::internal(format!(
                "Circular dependency detected in group at task '{}'",
                task.name
            ))
            .with_code(ErrorCode::ExecutionOperationFailed));
        }

        for dependency_id in task.requirements_vec() {
            if let Some(dependency) = task_map.get(&dependency_id) {
                visit(dependency, task_map, visited, visiting, ordered)?;
            }
        }

        visiting.remove(&task.id);
        visited.insert(task.id.clone());
        ordered.push(task.clone());
        Ok(())
    }

    let mut sorted = tasks.to_vec();
    sorted.sort_by_key(|task| task.idx);
    for task in &sorted {
        visit(task, &task_map, &mut visited, &mut visiting, &mut ordered)?;
    }
    Ok(ordered)
}

pub(super) fn resolve_execution_model(task: &Task, options: &Options) -> Result<String, ApiError> {
    if let Some(model) = task
        .execution_model
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "default")
    {
        return Ok(model.to_string());
    }
    let global = options.execution_model.trim();
    if !global.is_empty() && global != "default" {
        return Ok(global.to_string());
    }
    Err(ApiError::bad_request(format!(
        "Task '{}' has no execution model configured and options.executionModel is empty",
        task.name
    ))
    .with_code(ErrorCode::InvalidModel))
}

pub fn render_prompt_template(template: &str, variables: &[(&str, &str)]) -> String {
    let mut result = template.to_string();
    for (key, value) in variables {
        let placeholder = format!("{{{{{}}}}}", key);
        result = result.replace(&placeholder, value);
    }
    result
}

async fn render_execution_prompt(
    db: &SqlitePool,
    task: &Task,
    options: &Options,
    worktree_dir: &str,
) -> Result<String, ApiError> {
    let template = crate::db::runtime::get_prompt_template(db, "execution")
        .await?
        .ok_or_else(|| {
            ApiError::internal("Prompt template 'execution' is not configured")
                .with_code(ErrorCode::ExecutionOperationFailed)
        })?;

    let additional_context = if options.extra_prompt.trim().is_empty() {
        String::new()
    } else {
        format!("Additional context:\n{}", options.extra_prompt.trim())
    };

    Ok(template
        .template_text
        .replace(
            "{{execution_intro}}",
            &format!(
                "Implement the task directly from the task prompt. Work inside this worktree: {}",
                worktree_dir
            ),
        )
        .replace("{{task.prompt}}", &task.prompt)
        .replace("{{approved_plan_block}}", "")
        .replace("{{user_guidance_block}}", "")
        .replace("{{additional_context_block}}", &additional_context))
}

trait TaskJsonExt {
    fn requirements_vec(&self) -> Vec<String>;
}

impl TaskJsonExt for Task {
    fn requirements_vec(&self) -> Vec<String> {
        match self.requirements.as_deref() {
            Some(raw) => serde_json::from_str::<Vec<String>>(raw).unwrap_or_default(),
            None => Vec::new(),
        }
    }
}

trait RunJsonExt {
    fn task_order_vec(&self) -> Result<Vec<String>, ApiError>;
}

impl RunJsonExt for WorkflowRun {
    fn task_order_vec(&self) -> Result<Vec<String>, ApiError> {
        match self.task_order.as_deref() {
            Some(raw) => serde_json::from_str::<Vec<String>>(raw).map_err(ApiError::Serialization),
            None => Ok(Vec::new()),
        }
    }
}
