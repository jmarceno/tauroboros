use super::extensions::{RunJsonExt, TaskJsonExt};
use super::task_selection::{order_subset_by_dependencies, resolve_single_task_chain, select_all_runnable_tasks};
use super::types::{RunStopResult, StopMode, GRACEFUL_STOP_MESSAGE, DESTRUCTIVE_STOP_MESSAGE};
use super::Orchestrator;
use crate::audit::{record_audit_event, CreateAuditEvent};
use crate::db::queries::{get_task, get_task_group, get_tasks, get_workflow_run, update_task, update_task_group};
use crate::db::runtime::{
    create_workflow_run_record, update_workflow_run_record, CreateWorkflowRunRecord,
    UpdateWorkflowRunRecord,
};
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    AuditLevel, Task, TaskGroupStatus, TaskStatus, UpdateTaskInput, WorkflowRun, WorkflowRunKind,
    WorkflowRunStatus,
};
use crate::sse::hub::SseHub;
use rocket::serde::json::json;
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

impl Orchestrator {
    pub async fn start_all(&self) -> Result<WorkflowRun, ApiError> {
        self.cleanup_stale_runs().await?;
        self.ensure_no_active_run().await?;

        let tasks = get_tasks(&self.db).await?;
        let selected = select_all_runnable_tasks(&tasks)?;
        if selected.is_empty() {
            return Err(ApiError::internal("No tasks in backlog")
                .with_code(ErrorCode::ExecutionOperationFailed));
        }

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

    pub async fn clean_run(&self, run_id: &str) -> Result<crate::models::CleanRunResult, ApiError> {
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
                    super::git::remove_worktree(&self.project_root, worktree_dir).await?;
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
                    execution_phase: Some(crate::models::ExecutionPhase::NotStarted),
                    error_message: Some(None),
                    agent_output: Some(Some(String::new())),
                    worktree_dir: Some(None),
                    session_id: Some(None),
                    session_url: Some(None),
                    completed_at: Some(None),
                    self_heal_status: Some(crate::models::SelfHealStatus::Idle),
                    self_heal_message: Some(None),
                    self_heal_report_id: Some(None),
                    review_count: Some(0),
                    json_parse_retry_count: Some(0),
                    plan_revision_count: Some(0),
                    awaiting_plan_approval: Some(false),
                    review_activity: Some(Some("idle".to_string())),
                    best_of_n_substage: Some(crate::models::BestOfNSubstage::Idle),
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

        Ok(crate::models::CleanRunResult {
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

        let runs = crate::db::queries::get_workflow_runs(&self.db).await?;
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

    pub(super) async fn finalize_run_after_stop(
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

    pub(crate) async fn reload_run(&self, run_id: &str) -> Result<WorkflowRun, ApiError> {
        get_workflow_run(&self.db, run_id)
            .await?
            .ok_or_else(|| ApiError::not_found("Run not found").with_code(ErrorCode::RunNotFound))
    }
}
