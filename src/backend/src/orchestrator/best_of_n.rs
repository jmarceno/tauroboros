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
use rocket::serde::json::Value;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewerOutput {
    status: ReviewerStatus,
    summary: String,
    best_candidate_ids: Vec<String>,
    gaps: Vec<String>,
    recommended_final_strategy: SelectionMode,
    recommended_prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReviewerStatus {
    Pass,
    NeedsManualReview,
}

#[derive(Debug, Clone)]
struct AggregatedReviewResult {
    candidate_vote_counts: HashMap<String, usize>,
    recurring_gaps: Vec<String>,
    consensus_reached: bool,
    recommended_final_strategy: SelectionMode,
    usable_results: Vec<ReviewerOutput>,
}

impl AggregatedReviewResult {
    fn default_for(config: &BestOfNConfig) -> Self {
        Self {
            candidate_vote_counts: HashMap::new(),
            recurring_gaps: Vec::new(),
            consensus_reached: false,
            recommended_final_strategy: config.selection_mode,
            usable_results: Vec::new(),
        }
    }
}

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
        self.broadcast_task_by_id(&task.id).await?;

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
            self.broadcast_task_by_id(&task.id).await?;
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
        let mut aggregated_review = AggregatedReviewResult::default_for(&config);

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
                self.broadcast_task_by_id(&task.id).await?;

                let reviewer_results = self
                .run_best_of_n_reviewers(
                    task,
                    options,
                    &config,
                    &successful_workers,
                    stop_rx.clone(),
                )
                .await?;

                if reviewer_results.is_empty() {
                    crate::db::queries::update_task(
                        &self.db,
                        &task.id,
                        UpdateTaskInput {
                            status: Some(TaskStatus::Review),
                            best_of_n_substage: Some(BestOfNSubstage::BlockedForManualReview),
                            error_message: Some(Some(
                                "No usable reviewer results available".to_string(),
                            )),
                            ..Default::default()
                        },
                    )
                    .await?;
                    self.broadcast_task_by_id(&task.id).await?;
                    return Ok(TaskOutcome {
                        status: TaskStatus::Review,
                        error_message: None,
                    });
                }

                aggregated_review = aggregate_reviewer_outputs(reviewer_results);

                let reviewer_requested_manual = aggregated_review
                    .usable_results
                    .iter()
                    .any(|result| result.status == ReviewerStatus::NeedsManualReview);
                if reviewer_requested_manual
                    || (!aggregated_review.consensus_reached
                        && config.selection_mode == SelectionMode::PickBest)
                {
                    let message = if reviewer_requested_manual {
                        "One or more reviewers requested manual review".to_string()
                    } else {
                        "Reviewer consensus missing for pick_best mode".to_string()
                    };

                    crate::db::queries::update_task(
                        &self.db,
                        &task.id,
                        UpdateTaskInput {
                            status: Some(TaskStatus::Review),
                            best_of_n_substage: Some(BestOfNSubstage::BlockedForManualReview),
                            error_message: Some(Some(message)),
                            ..Default::default()
                        },
                    )
                    .await?;
                    self.broadcast_task_by_id(&task.id).await?;
                    return Ok(TaskOutcome {
                        status: TaskStatus::Review,
                        error_message: None,
                    });
                }
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
        self.broadcast_task_by_id(&task.id).await?;

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
                &aggregated_review,
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
                self.apply_candidate_selection(&candidates, &aggregated_review)
                    .await?;

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
                self.broadcast_task_by_id(&task.id).await?;

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
    ) -> Result<Vec<ReviewerOutput>, ApiError> {
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
                .run_prompt_with_events(session.clone(), &slot.model, &prompt, stop_rx.clone())
                .await;

            match result {
                Ok(prompt_result) => {
                    let reviewer_output = parse_reviewer_output(
                        &prompt_result.response_text,
                        &prompt_result.events,
                    )?;
                    let _ = crate::db::runtime::update_task_run_record(
                        &self.db,
                        &task_run.id,
                        crate::db::runtime::UpdateTaskRunRecord {
                            status: Some(RunStatus::Done),
                            summary: Some(Some(reviewer_output.summary.clone())),
                            metadata_json: Some(Some(
                                serde_json::to_value(&reviewer_output).map_err(|error| {
                                    ApiError::internal(format!(
                                        "Failed to serialize reviewer output: {}",
                                        error
                                    ))
                                    .with_code(ErrorCode::ExecutionOperationFailed)
                                })?,
                            )),
                            completed_at: Some(Some(chrono::Utc::now().timestamp())),
                            ..Default::default()
                        },
                    )
                    .await;
                    results.push(reviewer_output);
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
        aggregated_review: &AggregatedReviewResult,
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
                    "Candidate {} (status: {}, votes: {}): {}",
                    c.id.get(..6).unwrap_or(&c.id),
                    c.status,
                    aggregated_review
                        .candidate_vote_counts
                        .get(&c.id)
                        .copied()
                        .unwrap_or(0),
                    c.summary.as_deref().unwrap_or("no summary")
                )
            })
            .collect();
        let candidate_guidance = candidate_summaries.join("\n---\n");

        let selection_mode_str = match config.selection_mode {
            SelectionMode::PickBest => "pick_best",
            SelectionMode::Synthesize => "synthesize",
            SelectionMode::PickOrSynthesize => {
                selection_mode_label(aggregated_review.recommended_final_strategy)
            }
        };

        let recurring_gaps = if aggregated_review.recurring_gaps.is_empty() {
            "none".to_string()
        } else {
            aggregated_review.recurring_gaps.join("\n")
        };
        let reviewer_recommended_prompts = aggregated_review
            .usable_results
            .iter()
            .filter_map(|result| result.recommended_prompt.as_deref())
            .filter(|prompt| !prompt.trim().is_empty())
            .map(|prompt| prompt.trim().to_string())
            .collect::<Vec<_>>()
            .join("\n---\n");

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
                ("recurring_gaps", &recurring_gaps),
                ("reviewer_recommended_prompts", &reviewer_recommended_prompts),
                (
                    "consensus_reached",
                    if aggregated_review.consensus_reached {
                        "true"
                    } else {
                        "false"
                    },
                ),
                (
                    "task_suffix",
                    config.final_applier.task_suffix.as_deref().unwrap_or(""),
                ),
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

fn parse_reviewer_output(response_text: &str, events: &[Value]) -> Result<ReviewerOutput, ApiError> {
    if let Some(details) = extract_structured_tool_details(events, "emit_best_of_n_vote") {
        return reviewer_output_from_value(details);
    }

    let trimmed = response_text.trim();
    let parsed: Value = serde_json::from_str(trimmed).map_err(|error| {
        ApiError::internal(format!(
            "Best-of-n reviewer response was not valid JSON and no structured tool output was found: {}",
            error
        ))
        .with_code(ErrorCode::ExecutionOperationFailed)
    })?;
    reviewer_output_from_value(&parsed)
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

fn reviewer_output_from_value(value: &Value) -> Result<ReviewerOutput, ApiError> {
    serde_json::from_value::<ReviewerOutput>(value.clone()).map_err(|error| {
        ApiError::internal(format!(
            "Best-of-n reviewer output did not match the expected schema: {}",
            error
        ))
        .with_code(ErrorCode::ExecutionOperationFailed)
    })
}

fn aggregate_reviewer_outputs(outputs: Vec<ReviewerOutput>) -> AggregatedReviewResult {
    let mut candidate_vote_counts = HashMap::new();
    let mut recurring_gaps = Vec::new();
    let mut strategy_votes = [
        (SelectionMode::PickBest, 0usize),
        (SelectionMode::Synthesize, 0usize),
        (SelectionMode::PickOrSynthesize, 0usize),
    ];

    for output in &outputs {
        for (mode, count) in &mut strategy_votes {
            if *mode == output.recommended_final_strategy {
                *count += 1;
            }
        }

        for candidate_id in &output.best_candidate_ids {
            *candidate_vote_counts.entry(candidate_id.clone()).or_insert(0) += 1;
        }

        for gap in &output.gaps {
            if !recurring_gaps.iter().any(|existing| existing == gap) {
                recurring_gaps.push(gap.clone());
            }
        }
    }

    let top_vote_count = candidate_vote_counts.values().copied().max().unwrap_or(0);
    let consensus_reached = !outputs.is_empty() && top_vote_count == outputs.len();
    let recommended_final_strategy = strategy_votes
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(mode, _)| mode)
        .unwrap_or(SelectionMode::Synthesize);

    AggregatedReviewResult {
        candidate_vote_counts,
        recurring_gaps,
        consensus_reached,
        recommended_final_strategy,
        usable_results: outputs,
    }
}

fn selection_mode_label(mode: SelectionMode) -> &'static str {
    match mode {
        SelectionMode::PickBest => "pick_best",
        SelectionMode::Synthesize => "synthesize",
        SelectionMode::PickOrSynthesize => "pick_or_synthesize",
    }
}

impl Orchestrator {
    async fn broadcast_task_by_id(&self, task_id: &str) -> Result<(), ApiError> {
        if let Some(task) = crate::db::queries::get_task(&self.db, task_id).await? {
            self.broadcast_task(&task).await;
        }
        Ok(())
    }

    async fn apply_candidate_selection(
        &self,
        candidates: &[crate::db::models::TaskCandidate],
        aggregated_review: &AggregatedReviewResult,
    ) -> Result<(), ApiError> {
        let Some((candidate_id, _)) = aggregated_review
            .candidate_vote_counts
            .iter()
            .max_by_key(|(_, count)| *count)
        else {
            return Ok(());
        };

        let selected_candidate_id = if candidates.iter().any(|candidate| candidate.id == *candidate_id) {
            candidate_id.clone()
        } else if let Some(candidate) = candidates.first() {
            candidate.id.clone()
        } else {
            return Ok(());
        };

        for candidate in candidates {
            let next_status = if candidate.id == selected_candidate_id {
                "selected"
            } else {
                "rejected"
            };

            if let Some(updated) = crate::db::queries::update_task_candidate(
                &self.db,
                &candidate.id,
                next_status,
            )
            .await?
            {
                let hub = self.sse_hub.read().await;
                hub.broadcast(&crate::models::WSMessage {
                    r#type: "task_candidate_updated".to_string(),
                    payload: serde_json::to_value(updated).unwrap_or_default(),
                })
                .await;
            }
        }

        Ok(())
    }
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
