use crate::error::{ApiError, ErrorCode};
use crate::models::{
    Options, PiSessionKind, RunPhase, RunStatus, Task, TaskStatus,
    UpdateTaskInput,
};
use crate::orchestrator::git::WorktreeInfo;
use crate::orchestrator::isolation;
use crate::orchestrator::pi::PiSessionExecutor;
use crate::orchestrator::render_prompt_template;
use crate::orchestrator::Orchestrator;
use rocket::serde::json::json;
use tokio::sync::watch;
use uuid::Uuid;

impl Orchestrator {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_review_loop(
        &self,
        task: &Task,
        run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        target_branch: &str,
        _slot_index: usize,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, ApiError> {
        if !task.review && !task.code_style_review {
            return Ok(true);
        }

        let max_runs = task.max_review_runs_override.unwrap_or(options.max_reviews);
        let mut current_review_count = task.review_count;

        loop {
            if current_review_count >= max_runs {
                crate::db::queries::update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        status: Some(TaskStatus::Stuck),
                        error_message: Some(Some(format!(
                            "Max reviews ({}) reached without passing review",
                            max_runs
                        ))),
                        ..Default::default()
                    },
                )
                .await?;
                self.broadcast(
                    "error",
                    json!({ "taskId": task.id, "message": format!("Max reviews ({}) reached", max_runs) }),
                )
                .await;
                return Ok(false);
            }

            let passed = self
                .run_single_review(
                    task,
                    run_id,
                    options,
                    worktree,
                    target_branch,
                    stop_rx.clone(),
                )
                .await?;

            if passed {
                return Ok(true);
            }

            current_review_count += 1;
            crate::db::queries::update_task(
                &self.db,
                &task.id,
                UpdateTaskInput {
                    status: Some(TaskStatus::Backlog),
                    review_count: Some(current_review_count),
                    ..Default::default()
                },
            )
            .await?;

            let fix_passed = self
                .run_review_fix(task, run_id, options, worktree, stop_rx.clone())
                .await?;

            if !fix_passed {
                return Ok(false);
            }
        }
    }

    async fn run_single_review(
        &self,
        task: &Task,
        _run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        _target_branch: &str,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, ApiError> {
        crate::db::queries::update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                status: Some(TaskStatus::Review),
                review_activity: Some(Some("running".to_string())),
                ..Default::default()
            },
        )
        .await?;
        if let Some(t) = crate::db::queries::get_task(&self.db, &task.id).await? {
            self.broadcast_task(&t).await;
        }

        let review_file_path = worktree.directory.clone();

        let template = crate::db::runtime::get_prompt_template(&self.db, "review")
            .await?
            .ok_or_else(|| {
                ApiError::internal("Prompt template 'review' is not configured")
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        let prompt = render_prompt_template(
            &template.template_text,
            &[
                ("task.id", &task.id),
                ("task.name", &task.name),
                ("review_file_path", &review_file_path),
            ],
        );

        let review_model = self.resolve_review_model(task, options)?;
        let session_id = Uuid::new_v4().to_string()[..8].to_string();
        let _session_url = self.session_url_for(&session_id);
        let pi_session_file = self.pi_session_file_for(&session_id);

        let task_run = crate::db::runtime::create_task_run_record(
            &self.db,
            crate::db::runtime::CreateTaskRunRecord {
                id: None,
                task_id: task.id.clone(),
                phase: RunPhase::Reviewer,
                slot_index: 0,
                attempt_index: task.review_count,
                model: review_model.clone(),
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

        let isolation_spec = isolation::resolve_session_isolation(
            task,
            PiSessionKind::ReviewScratch,
            &self.project_root,
            options.bubblewrap_enabled,
        )?;
        let session = crate::db::runtime::create_workflow_session_record(
            &self.db,
            crate::db::runtime::CreateWorkflowSessionRecord {
                id: Some(session_id.clone()),
                task_id: Some(task.id.clone()),
                task_run_id: Some(task_run.id.clone()),
                session_kind: PiSessionKind::ReviewScratch,
                status: crate::models::PiSessionStatus::Starting,
                cwd: worktree.directory.clone(),
                worktree_dir: Some(worktree.directory.clone()),
                branch: Some(worktree.branch.clone()),
                pi_session_id: None,
                pi_session_file: Some(pi_session_file),
                process_pid: None,
                model: review_model.clone(),
                thinking_level: options.review_thinking_level,
                started_at: None,
                finished_at: None,
                exit_code: None,
                exit_signal: None,
                error_message: None,
                name: Some(format!("Review {} ({})", task.name, task.id)),
                isolation_mode: isolation_spec.mode,
                path_grants_json: isolation_spec.to_grants_json(),
            },
        )
        .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
        );

        let result = executor
            .run_prompt(session.clone(), &review_model, &prompt, stop_rx)
            .await;

        match result {
            Ok(_response_text) => {
                let review_passed = check_review_passed(&_response_text);
                if review_passed {
                    crate::db::queries::update_task(
                        &self.db,
                        &task.id,
                        UpdateTaskInput {
                            review_activity: Some(Some("idle".to_string())),
                            ..Default::default()
                        },
                    )
                    .await?;
                    Ok(true)
                } else {
                    Ok(false)
                }
            }
            Err(error) => {
                crate::db::queries::update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        review_activity: Some(Some("idle".to_string())),
                        ..Default::default()
                    },
                )
                .await?;
                Err(error)
            }
        }
    }

    async fn run_review_fix(
        &self,
        task: &Task,
        _run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, ApiError> {
        let template = crate::db::runtime::get_prompt_template(&self.db, "review_fix")
            .await?
            .ok_or_else(|| {
                ApiError::internal("Prompt template 'review_fix' is not configured")
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        let prompt = render_prompt_template(
            &template.template_text,
            &[
                ("task.prompt", &task.prompt),
                ("review_summary", "Review found gaps that need fixing"),
                (
                    "review_gaps",
                    "Check the review comments above for specific gaps",
                ),
            ],
        );

        let model = crate::orchestrator::resolve_execution_model(task, options)?;

        let session_id = Uuid::new_v4().to_string()[..8].to_string();
        let session_url = self.session_url_for(&session_id);
        let pi_session_file = self.pi_session_file_for(&session_id);

        let task_run = crate::db::runtime::create_task_run_record(
            &self.db,
            crate::db::runtime::CreateTaskRunRecord {
                id: None,
                task_id: task.id.clone(),
                phase: RunPhase::Worker,
                slot_index: 0,
                attempt_index: task.review_count + 100,
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

        let isolation_spec = isolation::resolve_session_isolation(
            task,
            PiSessionKind::Task,
            &self.project_root,
            options.bubblewrap_enabled,
        )?;
        let session = crate::db::runtime::create_workflow_session_record(
            &self.db,
            crate::db::runtime::CreateWorkflowSessionRecord {
                id: Some(session_id.clone()),
                task_id: Some(task.id.clone()),
                task_run_id: Some(task_run.id.clone()),
                session_kind: PiSessionKind::Task,
                status: crate::models::PiSessionStatus::Starting,
                cwd: worktree.directory.clone(),
                worktree_dir: Some(worktree.directory.clone()),
                branch: Some(worktree.branch.clone()),
                pi_session_id: None,
                pi_session_file: Some(pi_session_file),
                process_pid: None,
                model: model.clone(),
                thinking_level: options.execution_thinking_level,
                started_at: None,
                finished_at: None,
                exit_code: None,
                exit_signal: None,
                error_message: None,
                name: Some(format!("Review Fix {} ({})", task.name, task.id)),
                isolation_mode: isolation_spec.mode,
                path_grants_json: isolation_spec.to_grants_json(),
            },
        )
        .await?;

        crate::db::queries::update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                status: Some(TaskStatus::Executing),
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.to_string())),
                ..Default::default()
            },
        )
        .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
        );

        let result = executor
            .run_prompt(session.clone(), &model, &prompt, stop_rx)
            .await;

        match result {
            Ok(_response_text) => Ok(true),
            Err(error) => {
                crate::db::queries::update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        status: Some(TaskStatus::Failed),
                        error_message: Some(Some(error.to_string())),
                        ..Default::default()
                    },
                )
                .await?;
                Ok(false)
            }
        }
    }

    fn resolve_review_model(&self, task: &Task, options: &Options) -> Result<String, ApiError> {
        let global = options.review_model.trim();
        if !global.is_empty() && global != "default" {
            return Ok(global.to_string());
        }
        let execution = options.execution_model.trim();
        if !execution.is_empty() && execution != "default" {
            return Ok(execution.to_string());
        }
        Err(ApiError::bad_request(format!(
            "Task '{}' has no review model configured. Set options.reviewModel or options.executionModel.",
            task.name
        ))
        .with_code(ErrorCode::InvalidModel))
    }
}

fn check_review_passed(response_text: &str) -> bool {
    if response_text.contains("\"pass\"") || response_text.contains("'pass'") {
        return true;
    }
    if response_text.contains("status") && response_text.contains("pass") {
        let lower = response_text.to_lowercase();
        return lower.contains("\"status\": \"pass\"")
            || lower.contains("\"status\":\"pass\"")
            || lower.contains("'status': 'pass'");
    }
    false
}
