use crate::error::{ApiError, ErrorCode};
use crate::models::Task;
use crate::models::TaskStatus;
use crate::orchestrator::extensions::TaskJsonExt;
use std::collections::{HashMap, HashSet};

/// Select all runnable tasks from the backlog/template state, respecting dependencies.
pub fn select_all_runnable_tasks(tasks: &[Task]) -> Result<Vec<Task>, ApiError> {
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

/// Resolve a single task and all its transitive dependencies that need to run.
pub fn resolve_single_task_chain(tasks: &[Task], task_id: &str) -> Result<Vec<Task>, ApiError> {
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

/// Order a subset of tasks by their dependencies.
pub fn order_subset_by_dependencies(tasks: &[Task]) -> Result<Vec<Task>, ApiError> {
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
