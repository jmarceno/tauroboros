use rocket::routes;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::PromptTemplate;
use crate::state::AppStateType;
use rocket::State;
use rocket::serde::json::{json, Json, Value};
use rocket::{get, post, Route};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct RenderTemplateRequest {
    variables: Option<Value>,
}

#[get("/api/prompts")]
async fn list_prompts(state: &State<AppStateType>) -> ApiResult<Json<Vec<PromptTemplate>>> {
    let prompts: Vec<PromptTemplate> = sqlx::query_as(
        r#"
        SELECT * FROM prompt_templates ORDER BY key
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::Database)?;
    
    Ok(Json(prompts))
}

#[get("/api/prompts/<key>")]
async fn get_prompt(state: &State<AppStateType>, key: String) -> ApiResult<Json<PromptTemplate>> {
    let prompt: PromptTemplate = sqlx::query_as(
        r#"
        SELECT * FROM prompt_templates WHERE key = ? LIMIT 1
        "#,
    )
    .bind(&key)
    .fetch_one(&state.db)
    .await
    .map_err(|_| ApiError::not_found("Prompt template not found").with_code(ErrorCode::TaskNotFound))?;
    
    Ok(Json(prompt))
}

#[post("/api/prompts/<key>/render", data = "<req>")]
async fn render_prompt(state: &State<AppStateType>, key: String, req: Json<RenderTemplateRequest>) -> ApiResult<Json<Value>> {
    let prompt: PromptTemplate = sqlx::query_as(
        r#"
        SELECT * FROM prompt_templates WHERE key = ? LIMIT 1
        "#,
    )
    .bind(&key)
    .fetch_one(&state.db)
    .await
    .map_err(|_| ApiError::not_found("Prompt template not found").with_code(ErrorCode::TaskNotFound))?;
    
    // Simple template rendering - replace {{variable}} with values
    let mut rendered = prompt.template_text.clone();
    
    if let Some(vars) = &req.variables {
        if let Some(obj) = vars.as_object() {
            for (key, value) in obj {
                let placeholder = format!("{{{{{}}}}}", key);
                let value_string = value.to_string();
                let replacement = value.as_str().unwrap_or(&value_string);
                rendered = rendered.replace(&placeholder, replacement);
            }
        }
    }
    
    Ok(Json(json!({
        "template": prompt,
        "renderedText": rendered,
        "variables": req.variables,
    })))
}

pub fn routes() -> Vec<Route> {
    routes![
        list_prompts,
        get_prompt,
        render_prompt,
    ]
}
