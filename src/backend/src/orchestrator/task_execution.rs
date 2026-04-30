use super::extensions::RunJsonExt;
use super::types::{StopMode, TaskOutcome, GRACEFUL_STOP_MESSAGE, DESTRUCTIVE_STOP_MESSAGE};
use super::Orchestrator;
use crate::db::queries::{get_options, get_task, get_task_runs, insert_task_diffs, update_task, update_task_group};
use crate::db::runtime::{
    create_task_run_record, create_workflow_session_record, update_task_run_record, update_workflow_run_record,
    CreateTaskRunRecord, CreateWorkflowSessionRecord, UpdateTaskRunRecord, UpdateWorkflowRunRecord,
};
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    AuditLevel, ExecutionPhase, ExecutionStrategy, PiSessionKind, PiSessionStatus,
    RunPhase, RunStatus, TaskGroupStatus, TaskStatus, UpdateTaskInput, WorkflowRunStatus,
};
use crate::orchestrator::git::{
    auto_commit_worktree, capture_worktree_diff, capture_worktree_diff_from_head,
    create_task_worktree, merge_and_cleanup_worktree,
    resolve_target_branch, run_shell_command, worktree_has_changes,
};
use crate::orchestrator::pi::{PiSessionExecutor};
use crate::orchestrator::prompts::{render_execution_prompt, resolve_execution_model};
use rocket::serde::json::json;
use tokio::sync::watch;
use uuid::Uuid;

impl Orchestrator {
    pub(crate) async fn execute_task(
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
        let isolation_spec = super::isolation::resolve_session_isolation(
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
            self.server_port,
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

                match self
                    .run_post_execution_phases(
                        &task,
                        run_id,
                        &options,
                        &worktree,
                        &target_branch,
                        slot_index,
                        stop_rx,
                    )
                    .await?
                {
                    super::review::PostExecutionPhaseOutcome::Passed => {}
                    super::review::PostExecutionPhaseOutcome::ReviewFailed => {
                        return Ok(TaskOutcome {
                            status: TaskStatus::Stuck,
                            error_message: Some("Review loop failed".to_string()),
                        });
                    }
                    super::review::PostExecutionPhaseOutcome::CodeStyleFailed => {
                        return Ok(TaskOutcome {
                            status: TaskStatus::Failed,
                            error_message: Some("Code style review failed".to_string()),
                        });
                    }
                }

                // Capture diffs BEFORE auto-commit so working tree changes are visible
                let captured_diffs_before_commit = capture_worktree_diff(&self.project_root, &worktree.directory).await?;

                let committed = if task.auto_commit {
                    auto_commit_worktree(&worktree.directory, &task.name, &task.id).await?
                } else {
                    false
                };

                // If there were no uncommitted changes (because the review loop already
                // committed everything), capture the diff from HEAD~1..HEAD instead.
                let captured_diffs = if captured_diffs_before_commit.is_empty() && committed {
                    capture_worktree_diff_from_head(&self.project_root, &worktree.directory).await?
                } else {
                    captured_diffs_before_commit
                };

                if !captured_diffs.is_empty() {
                    insert_task_diffs(
                        &self.db,
                        &task.id,
                        Some(run_id),
                        "execution",
                        &captured_diffs,
                    )
                    .await?;
                }

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

    pub(crate) async fn handle_task_completion(
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
        let active_run_id = { self.runtime.lock().await.active_run_id.clone() };
        if matches!(run.status, WorkflowRunStatus::Completed | WorkflowRunStatus::Failed)
            && active_run_id.as_deref() != Some(run_id.as_str())
        {
            self.audit_warn(
                "task.completion_ignored_after_finalization",
                format!(
                    "Ignored stale completion for task {} after run {} was already finalized",
                    task_id, run_id
                ),
                Some(&run_id),
                Some(&task_id),
                None,
                None,
                json!({
                    "slotIndex": slot_index,
                    "remainingActiveTasks": remaining_active,
                    "outcomeStatus": outcome.status,
                    "outcomeError": outcome.error_message,
                    "runStatus": run.status
                }),
            )
            .await?;
            return Ok(());
        }
        let stop_mode = super::types::stop_mode_for_run(&run);

        if outcome.status == TaskStatus::Failed {
            let (task_status, message) = match stop_mode {
                Some(StopMode::Graceful) => (TaskStatus::Backlog, GRACEFUL_STOP_MESSAGE),
                Some(StopMode::Destructive) => (TaskStatus::Failed, DESTRUCTIVE_STOP_MESSAGE),
                Some(StopMode::Failure) => (
                    TaskStatus::Failed,
                    run.error_message
                        .as_deref()
                        .unwrap_or("Workflow halted after task failure"),
                ),
                None => (
                    TaskStatus::Failed,
                    outcome
                        .error_message
                        .as_deref()
                        .unwrap_or("Task execution failed"),
                ),
            };

            let mut task_update = UpdateTaskInput {
                status: Some(task_status),
                error_message: Some(Some(message.to_string())),
                ..Default::default()
            };

            // Preserve session links on autonomous failures so the
            // user can view session logs to debug what went wrong.
            // Only clear session links for user-initiated stops.
            if stop_mode.is_some() {
                task_update.session_id = Some(None);
                task_update.session_url = Some(None);
            }

            update_task(&self.db, &task_id, task_update).await?;

            if let Some(updated_task) = get_task(&self.db, &task_id).await? {
                self.broadcast_task(&updated_task).await;

                // Broadcast a dedicated task_error event so the UI can show
                // a toast notification and log entry for every task failure.
                if stop_mode.is_none() {
                    self.broadcast(
                        "task_error",
                        json!({
                            "taskId": updated_task.id,
                            "taskName": updated_task.name,
                            "error": message,
                            "runId": run_id,
                        }),
                    )
                    .await;
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
                let signaled = self.signal_stop_for_run(&run_id).await;
                if signaled == 0 {
                    tracing::warn!(
                        run_id = %run_id,
                        "No active tasks found to signal stop after task failure"
                    );
                }
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

    pub(crate) async fn finalize_if_possible(&self, run_id: &str) -> Result<(), ApiError> {
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

        let stop_mode = super::types::stop_mode_for_run(&run);
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
                error_message: Some(if final_status == WorkflowRunStatus::Completed && stop_mode.is_none() {
                    None
                } else {
                    run.error_message.clone()
                }),
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
}
