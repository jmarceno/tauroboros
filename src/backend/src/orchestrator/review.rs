use crate::error::{ApiError, ErrorCode};
use crate::models::{
    Options, PiSessionKind, RunPhase, RunStatus, Task, TaskStatus, UpdateTaskInput,
};
use crate::orchestrator::git::WorktreeInfo;
use crate::orchestrator::isolation;
use crate::orchestrator::pi::PiSessionExecutor;
use crate::orchestrator::render_prompt_template;
use crate::orchestrator::Orchestrator;
use rocket::serde::json::json;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReviewVerdict {
    Pass,
    GapsFound,
    Blocked,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReviewResult {
    status: ReviewVerdict,
    summary: String,
    #[serde(default)]
    gaps: Vec<String>,
    #[serde(default)]
    recommended_prompt: String,
}

impl ReviewResult {
    fn passed(&self) -> bool {
        matches!(self.status, ReviewVerdict::Pass)
    }

    fn fix_instructions(&self) -> String {
        let recommended = self.recommended_prompt.trim();
        if !recommended.is_empty() {
            return recommended.to_string();
        }

        if !self.gaps.is_empty() {
            return self
                .gaps
                .iter()
                .map(|gap| format!("- {}", gap))
                .collect::<Vec<_>>()
                .join("\n");
        }

        let summary = self.summary.trim();
        if !summary.is_empty() {
            return summary.to_string();
        }

        "Review reported gaps without additional detail.".to_string()
    }
}

impl Orchestrator {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_post_execution_phases(
        &self,
        task: &Task,
        run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        target_branch: &str,
        slot_index: usize,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<PostExecutionPhaseOutcome, ApiError> {
        if task.review {
            let review_passed = self
                .run_review_loop(
                    task,
                    run_id,
                    options,
                    worktree,
                    target_branch,
                    slot_index,
                    stop_rx.clone(),
                )
                .await?;
            if !review_passed {
                return Ok(PostExecutionPhaseOutcome::ReviewFailed);
            }
        }

        if task.code_style_review {
            let code_style_passed = self
                .run_code_style_review(task, options, worktree, stop_rx)
                .await?;
            if !code_style_passed {
                return Ok(PostExecutionPhaseOutcome::CodeStyleFailed);
            }
        }

        Ok(PostExecutionPhaseOutcome::Passed)
    }

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
        if !task.review {
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

            let review_result = self
                .run_single_review(
                    task,
                    run_id,
                    options,
                    worktree,
                    target_branch,
                    current_review_count,
                    stop_rx.clone(),
                )
                .await?;

            if review_result.passed() {
                return Ok(true);
            }

            if matches!(review_result.status, ReviewVerdict::Blocked) {
                crate::db::queries::update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        status: Some(TaskStatus::Stuck),
                        error_message: Some(Some(review_result.summary.clone())),
                        review_activity: Some(Some("idle".to_string())),
                        ..Default::default()
                    },
                )
                .await?;
                if let Some(updated_task) = crate::db::queries::get_task(&self.db, &task.id).await? {
                    self.broadcast_task(&updated_task).await;
                }
                return Ok(false);
            }

            current_review_count += 1;
            crate::db::queries::update_task(
                &self.db,
                &task.id,
                UpdateTaskInput {
                    status: Some(TaskStatus::Backlog),
                    review_count: Some(current_review_count),
                    error_message: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            if let Some(updated_task) = crate::db::queries::get_task(&self.db, &task.id).await? {
                self.broadcast_task(&updated_task).await;
            }

            let fix_passed = self
                .run_review_fix(
                    task,
                    run_id,
                    options,
                    worktree,
                    current_review_count,
                    &review_result,
                    stop_rx.clone(),
                )
                .await?;

            if !fix_passed {
                return Ok(false);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_single_review(
        &self,
        task: &Task,
        _run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        _target_branch: &str,
        review_attempt: i32,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<ReviewResult, ApiError> {
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
        let session_url = self.session_url_for(&session_id);
        let pi_session_file = self.pi_session_file_for(&session_id);

        let task_run = crate::db::runtime::create_task_run_record(
            &self.db,
            crate::db::runtime::CreateTaskRunRecord {
                id: None,
                task_id: task.id.clone(),
                phase: RunPhase::Reviewer,
                slot_index: 0,
                attempt_index: review_attempt,
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

        crate::db::queries::update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                status: Some(TaskStatus::Review),
                review_activity: Some(Some("running".to_string())),
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                error_message: Some(None),
                ..Default::default()
            },
        )
        .await?;
        if let Some(t) = crate::db::queries::get_task(&self.db, &task.id).await? {
            self.broadcast_task(&t).await;
        }

        crate::db::runtime::update_task_run_record(
            &self.db,
            &task_run.id,
            crate::db::runtime::UpdateTaskRunRecord {
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                ..Default::default()
            },
        )
        .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
            self.server_port,
        );

        let result = executor
            .run_prompt_with_events(session.clone(), &review_model, &prompt, stop_rx)
            .await;

        match result {
            Ok(prompt_result) => {
                let review_result = parse_review_result(&prompt_result.response_text, &prompt_result.events)?;
                crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Done),
                        summary: Some(Some(review_result.summary.clone())),
                        metadata_json: Some(Some(prompt_result.events.last().cloned().unwrap_or(Value::Null))),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await?;
                crate::db::queries::update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        review_activity: Some(Some("idle".to_string())),
                        ..Default::default()
                    },
                )
                .await?;
                Ok(review_result)
            }
            Err(error) => {
                crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Failed),
                        error_message: Some(Some(error.to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await?;
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

    #[allow(clippy::too_many_arguments)]
    async fn run_review_fix(
        &self,
        task: &Task,
        _run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        review_attempt: i32,
        review_result: &ReviewResult,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, ApiError> {
        let template = crate::db::runtime::get_prompt_template(&self.db, "review_fix")
            .await?
            .ok_or_else(|| {
                ApiError::internal("Prompt template 'review_fix' is not configured")
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        let review_summary = if review_result.summary.trim().is_empty() {
            "Review found gaps that need fixing".to_string()
        } else {
            review_result.summary.trim().to_string()
        };
        let review_gaps = review_result.fix_instructions();

        let prompt = render_prompt_template(
            &template.template_text,
            &[
                ("task.prompt", &task.prompt),
                ("review_summary", &review_summary),
                ("review_gaps", &review_gaps),
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
                attempt_index: review_attempt + 100,
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
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                error_message: Some(None),
                ..Default::default()
            },
        )
        .await?;
        if let Some(updated_task) = crate::db::queries::get_task(&self.db, &task.id).await? {
            self.broadcast_task(&updated_task).await;
        }

        crate::db::runtime::update_task_run_record(
            &self.db,
            &task_run.id,
            crate::db::runtime::UpdateTaskRunRecord {
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                ..Default::default()
            },
        )
        .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
            self.server_port,
        );

        let result = executor
            .run_prompt(session.clone(), &model, &prompt, stop_rx)
            .await;

        match result {
            Ok(response_text) => {
                crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Done),
                        summary: Some(Some(response_text.trim().to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await?;
                Ok(true)
            }
            Err(error) => {
                crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Failed),
                        error_message: Some(Some(error.to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await?;
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
                if let Some(updated_task) = crate::db::queries::get_task(&self.db, &task.id).await? {
                    self.broadcast_task(&updated_task).await;
                }
                Ok(false)
            }
        }
    }

    async fn run_code_style_review(
        &self,
        task: &Task,
        options: &Options,
        worktree: &WorktreeInfo,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, ApiError> {
        let template = crate::db::runtime::get_prompt_template(&self.db, "code_style")
            .await?
            .ok_or_else(|| {
                ApiError::internal("Prompt template 'code_style' is not configured")
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        let prompt = render_prompt_template(
            &template.template_text,
            &[("task.prompt", &task.prompt), ("task.name", &task.name)],
        );

        let model = self.resolve_code_style_model(task, options)?;
        let session_id = Uuid::new_v4().to_string()[..8].to_string();
        let session_url = self.session_url_for(&session_id);
        let pi_session_file = self.pi_session_file_for(&session_id);

        let task_run = crate::db::runtime::create_task_run_record(
            &self.db,
            crate::db::runtime::CreateTaskRunRecord {
                id: None,
                task_id: task.id.clone(),
                phase: RunPhase::Reviewer,
                slot_index: 0,
                attempt_index: task.review_count + 1_000,
                model: model.clone(),
                task_suffix: Some("code-style".to_string()),
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
            PiSessionKind::Repair,
            &self.project_root,
            options.bubblewrap_enabled,
        )?;
        let session = crate::db::runtime::create_workflow_session_record(
            &self.db,
            crate::db::runtime::CreateWorkflowSessionRecord {
                id: Some(session_id.clone()),
                task_id: Some(task.id.clone()),
                task_run_id: Some(task_run.id.clone()),
                session_kind: PiSessionKind::Repair,
                status: crate::models::PiSessionStatus::Starting,
                cwd: worktree.directory.clone(),
                worktree_dir: Some(worktree.directory.clone()),
                branch: Some(worktree.branch.clone()),
                pi_session_id: None,
                pi_session_file: Some(pi_session_file),
                process_pid: None,
                model: model.clone(),
                thinking_level: options.repair_thinking_level,
                started_at: None,
                finished_at: None,
                exit_code: None,
                exit_signal: None,
                error_message: None,
                name: Some(format!("Code Style {} ({})", task.name, task.id)),
                isolation_mode: isolation_spec.mode,
                path_grants_json: isolation_spec.to_grants_json(),
            },
        )
        .await?;

        crate::db::queries::update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                status: Some(TaskStatus::CodeStyle),
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                error_message: Some(None),
                ..Default::default()
            },
        )
        .await?;
        if let Some(updated_task) = crate::db::queries::get_task(&self.db, &task.id).await? {
            self.broadcast_task(&updated_task).await;
        }

        crate::db::runtime::update_task_run_record(
            &self.db,
            &task_run.id,
            crate::db::runtime::UpdateTaskRunRecord {
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.clone())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                ..Default::default()
            },
        )
        .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
            self.server_port,
        );

        let result = executor
            .run_prompt(session.clone(), &model, &prompt, stop_rx)
            .await;

        match result {
            Ok(response_text) => {
                crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Done),
                        summary: Some(Some(response_text.trim().to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await?;
                Ok(true)
            }
            Err(error) => {
                crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Failed),
                        error_message: Some(Some(error.to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await?;
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
                if let Some(updated_task) = crate::db::queries::get_task(&self.db, &task.id).await? {
                    self.broadcast_task(&updated_task).await;
                }
                Ok(false)
            }
        }
    }

    fn resolve_review_model(&self, task: &Task, options: &Options) -> Result<String, ApiError> {
        let global = options.review_model.trim();
        if !global.is_empty() && global != "default" {
            return Ok(global.to_string());
        }
        if let Some(model) = task
            .execution_model
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && *value != "default")
        {
            return Ok(model.to_string());
        }
        let execution = options.execution_model.trim();
        if !execution.is_empty() && execution != "default" {
            return Ok(execution.to_string());
        }
        Err(ApiError::bad_request(format!(
            "Task '{}' has no review model configured. Global options.reviewModel and options.executionModel are both empty, and the task has no execution_model override.",
            task.name
        ))
        .with_code(ErrorCode::InvalidModel))
    }

    fn resolve_code_style_model(&self, task: &Task, options: &Options) -> Result<String, ApiError> {
        let repair = options.repair_model.trim();
        if !repair.is_empty() && repair != "default" {
            return Ok(repair.to_string());
        }
        if let Some(model) = task
            .execution_model
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && *value != "default")
        {
            return Ok(model.to_string());
        }
        let execution = options.execution_model.trim();
        if !execution.is_empty() && execution != "default" {
            return Ok(execution.to_string());
        }
        Err(ApiError::bad_request(format!(
            "Task '{}' has no code style model configured. Global options.repairModel and options.executionModel are both empty, and the task has no execution_model override.",
            task.name
        ))
        .with_code(ErrorCode::InvalidModel))
    }
}

pub(super) enum PostExecutionPhaseOutcome {
    Passed,
    ReviewFailed,
    CodeStyleFailed,
}

fn parse_review_result(response_text: &str, events: &[Value]) -> Result<ReviewResult, ApiError> {
    if let Some(details) = extract_structured_tool_details(events, "emit_review_result") {
        return review_result_from_value(details);
    }

    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        return Err(
            ApiError::internal("Review session completed without any structured result or text")
                .with_code(ErrorCode::ExecutionOperationFailed),
        );
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        if parsed.get("status").is_some() {
            return review_result_from_value(&parsed);
        }
    }

    if check_review_passed(trimmed) {
        return Ok(ReviewResult {
            status: ReviewVerdict::Pass,
            summary: trimmed.to_string(),
            gaps: vec![],
            recommended_prompt: String::new(),
        });
    }

    Ok(ReviewResult {
        status: ReviewVerdict::GapsFound,
        summary: trimmed
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or(trimmed)
            .to_string(),
        gaps: vec![trimmed.to_string()],
        recommended_prompt: trimmed.to_string(),
    })
}

fn extract_structured_tool_details<'a>(events: &'a [Value], tool_name: &str) -> Option<&'a Value> {
    events.iter().find_map(|event| {
        let event_type = event.get("type").and_then(Value::as_str)?;
        let event_tool_name = event.get("toolName").and_then(Value::as_str)?;
        if event_type == "tool_execution_end" && event_tool_name == tool_name {
            event.get("result").and_then(|result| result.get("details"))
        } else {
            None
        }
    })
}

fn review_result_from_value(value: &Value) -> Result<ReviewResult, ApiError> {
    serde_json::from_value::<ReviewResult>(value.clone()).map_err(|error| {
        ApiError::internal(format!(
            "Review output did not match the expected schema: {}",
            error
        ))
        .with_code(ErrorCode::ExecutionOperationFailed)
    })
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

#[cfg(test)]
mod tests {
    use super::{parse_review_result, ReviewVerdict};
    use serde_json::json;

    #[test]
    fn parse_review_result_prefers_structured_tool_output() {
        let result = parse_review_result(
            "ignored text",
            &[json!({
                "type": "tool_execution_end",
                "toolName": "emit_review_result",
                "result": {
                    "details": {
                        "status": "gaps_found",
                        "summary": "Two gaps found",
                        "gaps": ["Missing test", "Missing validation"],
                        "recommendedPrompt": "Add validation and tests"
                    }
                }
            })],
        )
        .expect("structured review result should parse");

        assert_eq!(result.status, ReviewVerdict::GapsFound);
        assert_eq!(result.summary, "Two gaps found");
        assert_eq!(result.gaps.len(), 2);
        assert_eq!(result.recommended_prompt, "Add validation and tests");
    }

    #[test]
    fn parse_review_result_accepts_legacy_json_payload() {
        let result = parse_review_result(
            r#"{"status":"pass","summary":"Looks good","gaps":[],"bestCandidateIds":["candidate-1"]}"#,
            &[],
        )
        .expect("legacy JSON review result should parse");

        assert_eq!(result.status, ReviewVerdict::Pass);
        assert_eq!(result.summary, "Looks good");
        assert!(result.gaps.is_empty());
    }
}
