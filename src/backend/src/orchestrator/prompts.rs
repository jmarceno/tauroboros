use crate::db::queries::get_options;
use crate::db::runtime::get_prompt_template;
use crate::error::{ApiError, ErrorCode};
use crate::models::{Options, Task};
use sqlx::SqlitePool;

pub fn render_prompt_template(template: &str, variables: &[(&str, &str)]) -> String {
    let mut result = template.to_string();
    for (key, value) in variables {
        let placeholder = format!("{{{{{}}}}}" , key);
        result = result.replace(&placeholder, value);
    }
    result
}

pub async fn render_execution_prompt(
    db: &SqlitePool,
    task: &Task,
    options: &Options,
    worktree_dir: &str,
) -> Result<String, ApiError> {
    let template = get_prompt_template(db, "execution")
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

pub fn resolve_execution_model(task: &Task, options: &Options) -> Result<String, ApiError> {
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
