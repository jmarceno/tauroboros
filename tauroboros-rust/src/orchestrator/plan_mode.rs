use crate::error::{ApiError, ErrorCode};
use crate::models::{
    ExecutionPhase, Options, PiSessionKind, PiWorkflowSession, Task, TaskStatus,
    UpdateTaskInput,
};
use crate::orchestrator::git::WorktreeInfo;
use crate::orchestrator::pi::PiSessionExecutor;
use crate::orchestrator::Orchestrator;
use crate::orchestrator::{render_prompt_template, TaskOutcome};
use rocket::serde::json::json;
use tokio::sync::watch;
use uuid::Uuid;

impl Orchestrator {
    pub(super) async fn run_plan_mode(
        &self,
        task: &Task,
        run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        _slot_index: usize,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<TaskOutcome, ApiError> {
        match task.execution_phase {
            ExecutionPhase::NotStarted | ExecutionPhase::PlanRevisionPending => {
                self.run_planning_phase(task, run_id, options, worktree, stop_rx)
                    .await
            }
            ExecutionPhase::ImplementationPending => {
                self.run_approved_implementation(task, run_id, options, worktree, stop_rx)
                    .await
            }
            _ => Ok(TaskOutcome {
                status: TaskStatus::Failed,
                error_message: Some(format!(
                    "Unsupported plan execution phase: {:?}",
                    task.execution_phase
                )),
            }),
        }
    }

    async fn run_planning_phase(
        &self,
        task: &Task,
        run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<TaskOutcome, ApiError> {
        let is_revision = task.execution_phase == ExecutionPhase::PlanRevisionPending;
        let plan_model = self.resolve_plan_model(task, options)?;

        let additional_context = if options.extra_prompt.trim().is_empty() {
            String::new()
        } else {
            format!("Additional context:\n{}", options.extra_prompt.trim())
        };

        let prompt = if is_revision {
            let current_plan = get_latest_tagged_output(&task.agent_output, "plan")
                .unwrap_or_default();
            let revision_feedback =
                get_latest_tagged_output(&task.agent_output, "user-revision-request")
                    .or_else(|| get_latest_tagged_output(&task.agent_output, "user-revision"))
                    .unwrap_or_default();
            let template = crate::db::runtime::get_prompt_template(&self.db, "plan_revision")
                .await?
                .ok_or_else(|| {
                    ApiError::internal("Prompt template 'plan_revision' is not configured")
                        .with_code(ErrorCode::ExecutionOperationFailed)
                })?;
            render_prompt_template(
                &template.template_text,
                &[
                    ("task.prompt", &task.prompt),
                    ("current_plan", &current_plan),
                    ("revision_feedback", &revision_feedback),
                    ("additional_context_block", &additional_context),
                ],
            )
        } else {
            let template = crate::db::runtime::get_prompt_template(&self.db, "planning")
                .await?
                .ok_or_else(|| {
                    ApiError::internal("Prompt template 'planning' is not configured")
                        .with_code(ErrorCode::ExecutionOperationFailed)
                })?;
            render_prompt_template(
                &template.template_text,
                &[
                    ("task.prompt", &task.prompt),
                    ("additional_context_block", &additional_context),
                ],
            )
        };

        let session_id = Uuid::new_v4().to_string()[..8].to_string();
        let session_url = self.session_url_for(&session_id);
        let session = self
            .create_plan_session(
                task,
                run_id,
                &session_id,
                &session_url,
                &plan_model,
                worktree,
                PiSessionKind::Plan,
            )
            .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
        );

        match executor.run_prompt(session.clone(), &plan_model, &prompt, stop_rx).await {
            Ok(response_text) => {
                let plan_output = format!("[plan]\n{}\n", response_text.trim());
                let new_output = if task.agent_output.trim().is_empty() {
                    plan_output
                } else {
                    format!("{}\n{}", task.agent_output.trim_end(), plan_output)
                };

                if task.auto_approve_plan {
                    let update = UpdateTaskInput {
                        status: Some(TaskStatus::Backlog),
                        execution_phase: Some(ExecutionPhase::ImplementationPending),
                        awaiting_plan_approval: Some(false),
                        agent_output: Some(Some(new_output)),
                        ..Default::default()
                    };
                    crate::db::queries::update_task(&self.db, &task.id, update).await?;
                    Ok(TaskOutcome {
                        status: TaskStatus::Backlog,
                        error_message: None,
                    })
                } else {
                    let update = UpdateTaskInput {
                        status: Some(TaskStatus::Review),
                        execution_phase: Some(ExecutionPhase::PlanCompleteWaitingApproval),
                        awaiting_plan_approval: Some(true),
                        agent_output: Some(Some(new_output)),
                        worktree_dir: Some(Some(worktree.directory.clone())),
                        ..Default::default()
                    };
                    crate::db::queries::update_task(&self.db, &task.id, update).await?;
                    let updated = crate::db::queries::get_task(&self.db, &task.id)
                        .await?
                        .ok_or_else(|| ApiError::not_found("Task not found"))?;
                    self.broadcast_task(&updated).await;
                    self.broadcast("plan_revision_requested", json!({ "taskId": task.id }))
                        .await;
                    Ok(TaskOutcome {
                        status: TaskStatus::Review,
                        error_message: None,
                    })
                }
            }
            Err(error) => {
                crate::db::queries::update_task(
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
                Ok(TaskOutcome {
                    status: TaskStatus::Failed,
                    error_message: Some(error.to_string()),
                })
            }
        }
    }

    async fn run_approved_implementation(
        &self,
        task: &Task,
        run_id: &str,
        options: &Options,
        worktree: &WorktreeInfo,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<TaskOutcome, ApiError> {
        let approved_plan =
            get_latest_tagged_output(&task.agent_output, "plan").unwrap_or_default();
        let user_guidance = get_latest_tagged_output(&task.agent_output, "user-revision-request")
            .or_else(|| get_latest_tagged_output(&task.agent_output, "user-approval-note"))
            .unwrap_or_default();

        let approved_plan_block = if approved_plan.is_empty() {
            String::new()
        } else {
            format!("Approved plan:\n{}", approved_plan)
        };
        let user_guidance_block = if user_guidance.is_empty() {
            String::new()
        } else {
            format!("User guidance:\n{}", user_guidance)
        };

        let execution_intro = format!(
            "The user has approved the plan below. Implement it now. Work inside this worktree: {}",
            worktree.directory
        );

        let additional_context = if options.extra_prompt.trim().is_empty() {
            String::new()
        } else {
            format!("Additional context:\n{}", options.extra_prompt.trim())
        };

        let template = crate::db::runtime::get_prompt_template(&self.db, "execution")
            .await?
            .ok_or_else(|| {
                ApiError::internal("Prompt template 'execution' is not configured")
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        let prompt = render_prompt_template(
            &template.template_text,
            &[
                ("execution_intro", &execution_intro),
                ("task.prompt", &task.prompt),
                ("approved_plan_block", &approved_plan_block),
                ("user_guidance_block", &user_guidance_block),
                ("additional_context_block", &additional_context),
            ],
        );

        let session_id = Uuid::new_v4().to_string()[..8].to_string();
        let session_url = self.session_url_for(&session_id);
        let model = self.resolve_plan_model(task, options)?;

        let session = self
            .create_plan_session(
                task,
                run_id,
                &session_id,
                &session_url,
                &model,
                worktree,
                PiSessionKind::Task,
            )
            .await?;

        let executor = PiSessionExecutor::new(
            self.db.clone(),
            self.sse_hub.clone(),
            self.project_root.clone(),
        );

        let result = executor.run_prompt(session.clone(), &model, &prompt, stop_rx).await;

        match result {
            Ok(response_text) => {
                let final_output = if task.agent_output.trim().is_empty() {
                    format!("{}\n", response_text.trim())
                } else {
                    format!("{}\n{}\n", task.agent_output.trim_end(), response_text.trim())
                };

                crate::db::queries::update_task(
                    &self.db,
                    &task.id,
                    UpdateTaskInput {
                        status: Some(TaskStatus::Done),
                        agent_output: Some(Some(final_output)),
                        completed_at: Some(Some(chrono::Utc::now().timestamp())),
                        execution_phase: Some(ExecutionPhase::ImplementationDone),
                        ..Default::default()
                    },
                )
                .await?;

                Ok(TaskOutcome {
                    status: TaskStatus::Done,
                    error_message: None,
                })
            }
            Err(error) => {
                crate::db::queries::update_task(
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
                Ok(TaskOutcome {
                    status: TaskStatus::Failed,
                    error_message: Some(error.to_string()),
                })
            }
        }
    }

    fn resolve_plan_model(&self, task: &Task, options: &Options) -> Result<String, ApiError> {
        if let Some(model) = task
            .plan_model
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && *value != "default")
        {
            return Ok(model.to_string());
        }
        let global = options.plan_model.trim();
        if !global.is_empty() && global != "default" {
            return Ok(global.to_string());
        }
        let execution = options.execution_model.trim();
        if !execution.is_empty() && execution != "default" {
            return Ok(execution.to_string());
        }
        Err(ApiError::bad_request(format!(
            "Task '{}' has no plan model configured and no fallback model is available",
            task.name
        ))
        .with_code(ErrorCode::InvalidModel))
    }

    async fn create_plan_session(
        &self,
        task: &Task,
        _run_id: &str,
        session_id: &str,
        session_url: &str,
        model: &str,
        worktree: &WorktreeInfo,
        session_kind: PiSessionKind,
    ) -> Result<PiWorkflowSession, ApiError> {
        let pi_session_file = self.pi_session_file_for(session_id);
        let session = crate::db::runtime::create_workflow_session_record(
            &self.db,
            crate::db::runtime::CreateWorkflowSessionRecord {
                id: Some(session_id.to_string()),
                task_id: Some(task.id.clone()),
                task_run_id: None,
                session_kind,
                status: crate::models::PiSessionStatus::Starting,
                cwd: worktree.directory.clone(),
                worktree_dir: Some(worktree.directory.clone()),
                branch: Some(worktree.branch.clone()),
                pi_session_id: None,
                pi_session_file: Some(pi_session_file),
                process_pid: None,
                model: model.to_string(),
                thinking_level: task.plan_thinking_level,
                started_at: None,
                finished_at: None,
                exit_code: None,
                exit_signal: None,
                error_message: None,
                name: Some(format!("Plan {} ({})", task.name, task.id)),
            },
        )
        .await?;

        crate::db::queries::update_task(
            &self.db,
            &task.id,
            UpdateTaskInput {
                session_id: Some(Some(session.id.clone())),
                session_url: Some(Some(session_url.to_string())),
                worktree_dir: Some(Some(worktree.directory.clone())),
                ..Default::default()
            },
        )
        .await?;

        Ok(session)
    }
}

pub(super) fn get_latest_tagged_output(agent_output: &str, tag: &str) -> Option<String> {
    let tag_open = format!("[{}]", tag);
    let mut results: Vec<String> = Vec::new();
    let mut search_start = 0;

    while let Some(tag_pos) = agent_output[search_start..].find(&tag_open) {
        let absolute_pos = search_start + tag_pos;
        let content_start = absolute_pos + tag_open.len();
        let content_after_tag = &agent_output[content_start..];

        let end_pos = content_after_tag
            .char_indices()
            .find(|(_, c)| *c == '\n')
            .map(|(i, _)| i)
            .unwrap_or(0);

        let after_newline = &content_after_tag[end_pos.saturating_add(1)..];
        let next_tag_pos = after_newline.find("\n[");
        let content = match next_tag_pos {
            Some(pos) => after_newline[..pos].trim().to_string(),
            None => after_newline.trim().to_string(),
        };

        if !content.is_empty() {
            results.push(content);
        }

        search_start = if let Some(next_tag) = agent_output[content_start..].find("\n[") {
            content_start + next_tag + 1
        } else {
            agent_output.len()
        };
    }

    results.into_iter().last()
}
