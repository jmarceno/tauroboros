use crate::error::{ApiError, ErrorCode};
use crate::models::{
    BestOfNConfig, BestOfNSubstage, Options, PiSessionKind, RunPhase, RunStatus, SelectionMode,
    Task, TaskStatus, UpdateTaskInput,
};
use crate::orchestrator::git::{
    create_task_worktree, merge_and_cleanup_worktree, resolve_target_branch, WorktreeInfo,
};
use crate::orchestrator::pi::PiSessionExecutor;
use crate::orchestrator::Orchestrator;
use crate::orchestrator::{render_prompt_template, TaskOutcome};
use tokio::sync::watch;
use uuid::Uuid;

impl Orchestrator {
    pub(super) async fn run_best_of_n(
        &self,
        task: &Task,
        run_id: &str,
        options: &Options,
        _slot_index: usize,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<TaskOutcome, ApiError> {
        let config = task
            .best_of_n_config
            .as_ref()
            .and_then(|raw| serde_json::from_str::<BestOfNConfig>(raw).ok())
            .ok_or_else(|| {
                ApiError::internal("Task is best_of_n but has no valid config")
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        crate::db::queries::update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                status: Some(TaskStatus::Executing),
                best_of_n_substage: Some(BestOfNSubstage::WorkersRunning),
                ..Default::default()
            },
        )
        .await?;

        // Phase 1: Workers
        let worker_results = self
            .run_best_of_n_workers(task, run_id, options, &config, stop_rx.clone())
            .await?;

        let successful_workers: Vec<&WorkerResult> =
            worker_results.iter().filter(|r| r.success).collect();

        if (successful_workers.len() as i32) < config.min_successful_workers {
            crate::db::queries::update_task(
                &self.db,
                &task.id,
                UpdateTaskInput {
                    status: Some(TaskStatus::Failed),
                    best_of_n_substage: Some(BestOfNSubstage::Completed),
                    error_message: Some(Some(format!(
                        "Best-of-n failed: only {} of {} minimum required workers succeeded",
                        successful_workers.len(),
                        config.min_successful_workers
                    ))),
                    ..Default::default()
                },
            )
            .await?;
            return Ok(TaskOutcome {
                status: TaskStatus::Failed,
                error_message: Some("Insufficient successful workers".to_string()),
            });
        }

        // Create candidates
        for result in &worker_results {
            if result.success {
                crate::db::queries::create_task_candidate(
                    &self.db,
                    &task.id,
                    &result.task_run_id,
                    result.summary.as_deref(),
                    None,
                    None,
                    None,
                )
                .await?;
            }
        }

        let candidates = crate::db::queries::get_task_candidates(&self.db, &task.id).await?;

        let hub = self.sse_hub.read().await;
        for candidate in &candidates {
            hub.broadcast(&crate::models::WSMessage {
                r#type: "task_candidate_created".to_string(),
                payload: serde_json::to_value(candidate).unwrap_or_default(),
            })
            .await;
        }
        drop(hub);

        // Phase 2: Reviewers
        if !config.reviewers.is_empty() {
            crate::db::queries::update_task(
                &self.db,
                &task.id,
                UpdateTaskInput {
                    best_of_n_substage: Some(BestOfNSubstage::ReviewersRunning),
                    ..Default::default()
                },
            )
            .await?;

            let _reviewer_results = self
                .run_best_of_n_reviewers(
                    task,
                    options,
                    &config,
                    &successful_workers,
                    stop_rx.clone(),
                )
                .await?;
        }

        // Phase 3: Final Applier
        crate::db::queries::update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                best_of_n_substage: Some(BestOfNSubstage::FinalApplyRunning),
                ..Default::default()
            },
        )
        .await?;

        let target_branch = resolve_target_branch(
            &self.project_root,
            task.branch.as_deref(),
            Some(options.branch.as_str()),
        )
        .await?;

        let applier_worktree =
            create_task_worktree(&self.project_root, &task.id, &task.name, &target_branch).await?;

        let final_result = self
            .run_best_of_n_final_applier(
                task,
                options,
                &config,
                &candidates,
                &applier_worktree,
                stop_rx.clone(),
            )
            .await;

        // Clean up applier worktree
        let _ = merge_and_cleanup_worktree(
            &self.project_root,
            &applier_worktree.directory,
            &applier_worktree.branch,
            &target_branch,
            true,
            &format!("Best-of-n {} ({})", task.name, task.id),
        )
        .await;

        match final_result {
            Ok(_) => {
                // Mark selected candidate
                if let Some(best) = candidates.first() {
                    let _ =
                        crate::db::queries::update_task_candidate(&self.db, &best.id, "selected")
                            .await;
                    for candidate in &candidates[1..] {
                        let _ = crate::db::queries::update_task_candidate(
                            &self.db,
                            &candidate.id,
                            "rejected",
                        )
                        .await;
                    }
                }

                crate::db::queries::update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        status: Some(TaskStatus::Done),
                        best_of_n_substage: Some(BestOfNSubstage::Completed),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await?;

                Ok(TaskOutcome {
                    status: TaskStatus::Done,
                    error_message: None,
                })
            }
            Err(error) => Ok(TaskOutcome {
                status: TaskStatus::Failed,
                error_message: Some(error.to_string()),
            }),
        }
    }

    async fn run_best_of_n_workers(
        &self,
        task: &Task,
        _run_id: &str,
        options: &Options,
        config: &BestOfNConfig,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<Vec<WorkerResult>, ApiError> {
        let expanded = expand_slots(&config.workers);
        let mut results = Vec::with_capacity(expanded.len());

        let target_branch = resolve_target_branch(
            &self.project_root,
            task.branch.as_deref(),
            Some(options.branch.as_str()),
        )
        .await?;

        for (i, slot) in expanded.iter().enumerate() {
            if *stop_rx.borrow() {
                break;
            }

            let worktree = create_task_worktree(
                &self.project_root,
                &task.id,
                &format!("{} worker {}", task.name, i),
                &target_branch,
            )
            .await?;

            let additional_context = if options.extra_prompt.trim().is_empty() {
                String::new()
            } else {
                format!("Additional context:\n{}", options.extra_prompt.trim())
            };

            let template = crate::db::runtime::get_prompt_template(&self.db, "best_of_n_worker")
                .await?
                .ok_or_else(|| {
                    ApiError::internal("Prompt template 'best_of_n_worker' is not configured")
                        .with_code(ErrorCode::ExecutionOperationFailed)
                })?;

            let prompt = render_prompt_template(
                &template.template_text,
                &[
                    ("task.prompt", &task.prompt),
                    ("slot_index", &i.to_string()),
                    ("model", &slot.model),
                    ("task_suffix", slot.task_suffix.as_deref().unwrap_or("")),
                    ("additional_context_block", &additional_context),
                ],
            );

            let task_run = crate::db::runtime::create_task_run_record(
                &self.db,
                crate::db::runtime::CreateTaskRunRecord {
                    id: None,
                    task_id: task.id.clone(),
                    phase: RunPhase::Worker,
                    slot_index: i as i32,
                    attempt_index: i as i32,
                    model: slot.model.clone(),
                    task_suffix: slot.task_suffix.clone(),
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
            let _session_url = self.session_url_for(&session_id);
            let pi_session_file = self.pi_session_file_for(&session_id);

            let session = crate::db::runtime::create_workflow_session_record(
                &self.db,
                crate::db::runtime::CreateWorkflowSessionRecord {
                    id: Some(session_id.clone()),
                    task_id: Some(task.id.clone()),
                    task_run_id: Some(task_run.id.clone()),
                    session_kind: PiSessionKind::TaskRunWorker,
                    status: crate::models::PiSessionStatus::Starting,
                    cwd: worktree.directory.clone(),
                    worktree_dir: Some(worktree.directory.clone()),
                    branch: Some(worktree.branch.clone()),
                    pi_session_id: None,
                    pi_session_file: Some(pi_session_file),
                    process_pid: None,
                    model: slot.model.clone(),
                    thinking_level: options.execution_thinking_level,
                    started_at: None,
                    finished_at: None,
                    exit_code: None,
                    exit_signal: None,
                    error_message: None,
                    name: Some(format!("Bon Worker {} ({})", i, task.id)),
                },
            )
            .await?;

            let executor = PiSessionExecutor::new(
                self.db.clone(),
                self.sse_hub.clone(),
                self.project_root.clone(),
            );

            let run_result = executor
                .run_prompt(session.clone(), &slot.model, &prompt, stop_rx.clone())
                .await;

            let worker_result = match run_result {
                Ok(response_text) => {
                    let _ = crate::db::runtime::update_task_run_record(
                        &self.db,
                        &task_run.id,
                        crate::db::runtime::UpdateTaskRunRecord {
                            status: Some(RunStatus::Done),
                            summary: Some(Some(response_text.trim().to_string())),
                            completed_at: Some(Some(chrono::Utc::now().timestamp())),
                            ..Default::default()
                        },
                    )
                    .await;

                    let _ = merge_and_cleanup_worktree(
                        &self.project_root,
                        &worktree.directory,
                        &worktree.branch,
                        &target_branch,
                        false,
                        &format!("Bon worker {} ({})", i, task.id),
                    )
                    .await;

                    WorkerResult {
                        success: true,
                        task_run_id: task_run.id.clone(),
                        summary: Some(response_text.trim().to_string()),
                    }
                }
                Err(error) => {
                    let _ = crate::db::runtime::update_task_run_record(
                        &self.db,
                        &task_run.id,
                        crate::db::runtime::UpdateTaskRunRecord {
                            status: Some(RunStatus::Failed),
                            error_message: Some(Some(error.to_string())),
                            completed_at: Some(Some(chrono::Utc::now().timestamp())),
                            ..Default::default()
                        },
                    )
                    .await;

                    WorkerResult {
                        success: false,
                        task_run_id: task_run.id.clone(),
                        summary: None,
                    }
                }
            };

            results.push(worker_result);
        }

        Ok(results)
    }

    async fn run_best_of_n_reviewers(
        &self,
        task: &Task,
        options: &Options,
        config: &BestOfNConfig,
        workers: &[&WorkerResult],
        stop_rx: watch::Receiver<bool>,
    ) -> Result<Vec<ReviewerResult>, ApiError> {
        let expanded = expand_slots(&config.reviewers);
        let candidate_summaries: Vec<String> = workers
            .iter()
            .enumerate()
            .map(|(i, w)| {
                format!(
                    "Candidate {}: {}",
                    i,
                    w.summary.as_deref().unwrap_or("no summary")
                )
            })
            .collect();
        let candidate_summaries_str = candidate_summaries.join("\n---\n");

        let mut results = Vec::new();

        for (i, slot) in expanded.iter().enumerate() {
            let additional_context = if options.extra_prompt.trim().is_empty() {
                String::new()
            } else {
                format!("Additional context:\n{}", options.extra_prompt.trim())
            };

            let template = crate::db::runtime::get_prompt_template(&self.db, "best_of_n_reviewer")
                .await?
                .ok_or_else(|| {
                    ApiError::internal("Prompt template 'best_of_n_reviewer' is not configured")
                        .with_code(ErrorCode::ExecutionOperationFailed)
                })?;

            let prompt = render_prompt_template(
                &template.template_text,
                &[
                    ("task.prompt", &task.prompt),
                    ("candidate_summaries", &candidate_summaries_str),
                    ("task_suffix", slot.task_suffix.as_deref().unwrap_or("")),
                    ("additional_context_block", &additional_context),
                ],
            );

            let task_run = crate::db::runtime::create_task_run_record(
                &self.db,
                crate::db::runtime::CreateTaskRunRecord {
                    id: None,
                    task_id: task.id.clone(),
                    phase: RunPhase::Reviewer,
                    slot_index: i as i32,
                    attempt_index: i as i32,
                    model: slot.model.clone(),
                    task_suffix: slot.task_suffix.clone(),
                    status: RunStatus::Running,
                    session_id: None,
                    session_url: None,
                    worktree_dir: None,
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
            let _session_url = self.session_url_for(&session_id);
            let pi_session_file = self.pi_session_file_for(&session_id);

            let session = crate::db::runtime::create_workflow_session_record(
                &self.db,
                crate::db::runtime::CreateWorkflowSessionRecord {
                    id: Some(session_id.clone()),
                    task_id: Some(task.id.clone()),
                    task_run_id: Some(task_run.id.clone()),
                    session_kind: PiSessionKind::TaskRunReviewer,
                    status: crate::models::PiSessionStatus::Starting,
                    cwd: self.project_root.clone(),
                    worktree_dir: None,
                    branch: None,
                    pi_session_id: None,
                    pi_session_file: Some(pi_session_file),
                    process_pid: None,
                    model: slot.model.clone(),
                    thinking_level: options.review_thinking_level,
                    started_at: None,
                    finished_at: None,
                    exit_code: None,
                    exit_signal: None,
                    error_message: None,
                    name: Some(format!("Bon Reviewer {} ({})", i, task.id)),
                },
            )
            .await?;

            let executor = PiSessionExecutor::new(
                self.db.clone(),
                self.sse_hub.clone(),
                self.project_root.clone(),
            );

            let result = executor
                .run_prompt(session.clone(), &slot.model, &prompt, stop_rx.clone())
                .await;

            match result {
                Ok(response_text) => {
                    let _ = crate::db::runtime::update_task_run_record(
                        &self.db,
                        &task_run.id,
                        crate::db::runtime::UpdateTaskRunRecord {
                            status: Some(RunStatus::Done),
                            summary: Some(Some(response_text.trim().to_string())),
                            completed_at: Some(Some(chrono::Utc::now().timestamp())),
                            ..Default::default()
                        },
                    )
                    .await;
                    results.push(ReviewerResult { success: true });
                }
                Err(error) => {
                    let _ = crate::db::runtime::update_task_run_record(
                        &self.db,
                        &task_run.id,
                        crate::db::runtime::UpdateTaskRunRecord {
                            status: Some(RunStatus::Failed),
                            error_message: Some(Some(error.to_string())),
                            completed_at: Some(Some(chrono::Utc::now().timestamp())),
                            ..Default::default()
                        },
                    )
                    .await;
                    results.push(ReviewerResult { success: false });
                }
            }
        }

        Ok(results)
    }

    async fn run_best_of_n_final_applier(
        &self,
        task: &Task,
        options: &Options,
        config: &BestOfNConfig,
        candidates: &[crate::db::models::TaskCandidate],
        worktree: &WorktreeInfo,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<(), ApiError> {
        let additional_context = if options.extra_prompt.trim().is_empty() {
            String::new()
        } else {
            format!("Additional context:\n{}", options.extra_prompt.trim())
        };

        let candidate_summaries: Vec<String> = candidates
            .iter()
            .map(|c| {
                format!(
                    "Candidate {}: {}",
                    c.id.get(..6).unwrap_or(&c.id),
                    c.summary.as_deref().unwrap_or("no summary")
                )
            })
            .collect();
        let candidate_guidance = candidate_summaries.join("\n---\n");

        let selection_mode_str = match config.selection_mode {
            SelectionMode::PickBest => "pick_best",
            SelectionMode::Synthesize => "synthesize",
            SelectionMode::PickOrSynthesize => "pick_or_synthesize",
        };

        let template = crate::db::runtime::get_prompt_template(&self.db, "best_of_n_final_applier")
            .await?
            .ok_or_else(|| {
                ApiError::internal("Prompt template 'best_of_n_final_applier' is not configured")
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        let prompt = render_prompt_template(
            &template.template_text,
            &[
                ("task.prompt", &task.prompt),
                ("selection_mode", selection_mode_str),
                ("candidate_guidance", &candidate_guidance),
                ("recurring_gaps", ""),
                ("reviewer_recommended_prompts", ""),
                ("consensus_reached", "true"),
                ("task_suffix", ""),
                ("additional_context_block", &additional_context),
            ],
        );

        let task_run = crate::db::runtime::create_task_run_record(
            &self.db,
            crate::db::runtime::CreateTaskRunRecord {
                id: None,
                task_id: task.id.clone(),
                phase: RunPhase::FinalApplier,
                slot_index: 0,
                attempt_index: 0,
                model: config.final_applier.model.clone(),
                task_suffix: config.final_applier.task_suffix.clone(),
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
        let _session_url = self.session_url_for(&session_id);
        let pi_session_file = self.pi_session_file_for(&session_id);

        let session = crate::db::runtime::create_workflow_session_record(
            &self.db,
            crate::db::runtime::CreateWorkflowSessionRecord {
                id: Some(session_id.clone()),
                task_id: Some(task.id.clone()),
                task_run_id: Some(task_run.id.clone()),
                session_kind: PiSessionKind::TaskRunFinalApplier,
                status: crate::models::PiSessionStatus::Starting,
                cwd: worktree.directory.clone(),
                worktree_dir: Some(worktree.directory.clone()),
                branch: Some(worktree.branch.clone()),
                pi_session_id: None,
                pi_session_file: Some(pi_session_file),
                process_pid: None,
                model: config.final_applier.model.clone(),
                thinking_level: options.execution_thinking_level,
                started_at: None,
                finished_at: None,
                exit_code: None,
                exit_signal: None,
                error_message: None,
                name: Some(format!("Bon Final Applier {} ({})", task.name, task.id)),
            },
        )
        .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
        );

        let result = executor
            .run_prompt(
                session.clone(),
                &config.final_applier.model.clone(),
                &prompt,
                stop_rx,
            )
            .await;

        match result {
            Ok(response_text) => {
                let _ = crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Done),
                        summary: Some(Some(response_text.trim().to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await;
                Ok(())
            }
            Err(error) => {
                let _ = crate::db::runtime::update_task_run_record(
                    &self.db,
                    &task_run.id,
                    crate::db::runtime::UpdateTaskRunRecord {
                        status: Some(RunStatus::Failed),
                        error_message: Some(Some(error.to_string())),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        ..Default::default()
                    },
                )
                .await;
                Err(error)
            }
        }
    }
}

#[allow(dead_code)]
struct WorkerResult {
    success: bool,
    task_run_id: String,
    summary: Option<String>,
}

#[allow(dead_code)]
struct ReviewerResult {
    success: bool,
}

fn expand_slots(slots: &[crate::models::BestOfNSlot]) -> Vec<crate::models::BestOfNSlot> {
    let mut expanded = Vec::new();
    for slot in slots {
        for _ in 0..slot.count.max(1) {
            expanded.push(crate::models::BestOfNSlot {
                model: slot.model.clone(),
                count: 1,
                task_suffix: slot.task_suffix.clone(),
            });
        }
    }
    expanded
}

#[allow(dead_code)]
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}
