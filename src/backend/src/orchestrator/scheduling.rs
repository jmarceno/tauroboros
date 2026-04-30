use super::extensions::{RunJsonExt, TaskJsonExt};
use super::types::{ActiveTaskControl, SlotAssignment};
use super::Orchestrator;
use crate::db::queries::{get_options, get_task, get_tasks, get_workflow_run, update_task};
use crate::db::runtime::{
    update_workflow_run_record, UpdateWorkflowRunRecord,
};
use crate::error::{ApiError, ErrorCode};
use crate::models::{
    Task, TaskStatus, UpdateTaskInput, WorkflowRun, WorkflowRunStatus,
};
use rocket::serde::json::json;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::watch;

impl Orchestrator {
    pub(crate) fn schedule(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), ApiError>> + Send + '_>> {
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

    async fn start_task_execution(
        &self,
        run: &WorkflowRun,
        task: &Task,
    ) -> Result<(), ApiError> {
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
                    tracing::error!("failed to finalize task execution: {}", error);
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

    pub(crate) async fn signal_stop_for_run(&self, run_id: &str) -> i32 {
        let mut stop_senders = Vec::new();
        {
            let runtime = self.runtime.lock().await;
            for control in runtime.active_tasks.values() {
                if control.run_id == run_id {
                    stop_senders.push(control.stop_tx.clone());
                }
            }
        }

        let mut failed_sends = 0;
        for sender in &stop_senders {
            if let Err(e) = sender.send(true) {
                failed_sends += 1;
                tracing::warn!(
                    run_id = %run_id,
                    error = %e,
                    "Failed to send stop signal to task"
                );
            }
        }

        if failed_sends > 0 {
            tracing::warn!(
                run_id = %run_id,
                failed = failed_sends,
                total = stop_senders.len(),
                "Some stop signals failed to send"
            );
        }

        stop_senders.len() as i32
    }

    pub(crate) async fn refresh_run_counts(&self, run_id: &str) -> Result<(), ApiError> {
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

    pub(crate) async fn cleanup_stopped_run_worktrees(&self, task_ids: &[String]) -> Result<i32, ApiError> {
        let mut cleaned = 0;

        for task_id in task_ids {
            let Some(task) = get_task(&self.db, task_id).await? else {
                continue;
            };

            let Some(worktree_dir) = task.worktree_dir.clone() else {
                continue;
            };

            if !std::path::Path::new(&worktree_dir).exists() {
                continue;
            }

            self::git::remove_worktree(&self.project_root, &worktree_dir).await?;
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
}

// Re-export git functions needed by scheduling
use super::git;
