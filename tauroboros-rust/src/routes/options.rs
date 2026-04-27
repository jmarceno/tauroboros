use crate::db::queries::*;
use rocket::routes;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::sse::hub::SseHub;
use crate::state::AppStateType;
use rocket::State;
use chrono::Utc;
use rocket::serde::json::{json, Json, Value};
use rocket::{get, put, Route};
use serde::Deserialize;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateOptionsRequest {
    commit_prompt: Option<String>,
    extra_prompt: Option<String>,
    branch: Option<String>,
    plan_model: Option<String>,
    execution_model: Option<String>,
    review_model: Option<String>,
    repair_model: Option<String>,
    command: Option<String>,
    parallel_tasks: Option<i32>,
    auto_delete_normal_sessions: Option<bool>,
    auto_delete_review_sessions: Option<bool>,
    show_execution_graph: Option<bool>,
    port: Option<i32>,
    thinking_level: Option<ThinkingLevel>,
    plan_thinking_level: Option<ThinkingLevel>,
    execution_thinking_level: Option<ThinkingLevel>,
    review_thinking_level: Option<ThinkingLevel>,
    repair_thinking_level: Option<ThinkingLevel>,
    code_style_prompt: Option<String>,
    telegram_bot_token: Option<String>,
    telegram_chat_id: Option<String>,
    telegram_notification_level: Option<TelegramNotificationLevel>,
    max_reviews: Option<i32>,
    max_json_parse_retries: Option<i32>,
    column_sorts: Option<Value>,
}

#[get("/api/options")]
async fn get_options_route(state: &State<AppStateType>) -> ApiResult<Json<Options>> {
    let options = get_options(&state.db).await?;
    Ok(Json(options))
}

#[put("/api/options", data = "<req>")]
async fn update_options(state: &State<AppStateType>, req: Json<UpdateOptionsRequest>) -> ApiResult<Json<Options>> {
    // Build update query dynamically
    let mut sets = vec![];
    
    macro_rules! add_option {
        ($field:ident) => {
            if let Some(ref val) = req.$field {
                sets.push(format!("{} = ?", stringify!($field).replace("_", "_")));
            }
        };
    }
    
    add_option!(commit_prompt);
    add_option!(extra_prompt);
    add_option!(branch);
    add_option!(plan_model);
    add_option!(execution_model);
    add_option!(review_model);
    add_option!(repair_model);
    add_option!(command);
    add_option!(parallel_tasks);
    add_option!(auto_delete_normal_sessions);
    add_option!(auto_delete_review_sessions);
    add_option!(show_execution_graph);
    add_option!(port);
    add_option!(thinking_level);
    add_option!(plan_thinking_level);
    add_option!(execution_thinking_level);
    add_option!(review_thinking_level);
    add_option!(repair_thinking_level);
    add_option!(code_style_prompt);
    add_option!(telegram_bot_token);
    add_option!(telegram_chat_id);
    add_option!(telegram_notification_level);
    add_option!(max_reviews);
    add_option!(max_json_parse_retries);
    
    if req.column_sorts.is_some() {
        sets.push("column_sorts = ?".to_string());
    }
    
    if sets.is_empty() {
        // Nothing to update, return current options
        return get_options_route(state).await;
    }
    
    let query = format!("UPDATE options SET {} WHERE id = 1", sets.join(", "));
    
    let mut sql = sqlx::query(&query);
    
    // Bind values in same order as sets
    if req.commit_prompt.is_some() { sql = sql.bind(&req.commit_prompt); }
    if req.extra_prompt.is_some() { sql = sql.bind(&req.extra_prompt); }
    if req.branch.is_some() { sql = sql.bind(&req.branch); }
    if req.plan_model.is_some() { sql = sql.bind(&req.plan_model); }
    if req.execution_model.is_some() { sql = sql.bind(&req.execution_model); }
    if req.review_model.is_some() { sql = sql.bind(&req.review_model); }
    if req.repair_model.is_some() { sql = sql.bind(&req.repair_model); }
    if req.command.is_some() { sql = sql.bind(&req.command); }
    if req.parallel_tasks.is_some() { sql = sql.bind(req.parallel_tasks); }
    if req.auto_delete_normal_sessions.is_some() { sql = sql.bind(req.auto_delete_normal_sessions); }
    if req.auto_delete_review_sessions.is_some() { sql = sql.bind(req.auto_delete_review_sessions); }
    if req.show_execution_graph.is_some() { sql = sql.bind(req.show_execution_graph); }
    if req.port.is_some() { sql = sql.bind(req.port); }
    if req.thinking_level.is_some() { sql = sql.bind(&req.thinking_level); }
    if req.plan_thinking_level.is_some() { sql = sql.bind(&req.plan_thinking_level); }
    if req.execution_thinking_level.is_some() { sql = sql.bind(&req.execution_thinking_level); }
    if req.review_thinking_level.is_some() { sql = sql.bind(&req.review_thinking_level); }
    if req.repair_thinking_level.is_some() { sql = sql.bind(&req.repair_thinking_level); }
    if req.code_style_prompt.is_some() { sql = sql.bind(&req.code_style_prompt); }
    if req.telegram_bot_token.is_some() { sql = sql.bind(&req.telegram_bot_token); }
    if req.telegram_chat_id.is_some() { sql = sql.bind(&req.telegram_chat_id); }
    if req.telegram_notification_level.is_some() { sql = sql.bind(&req.telegram_notification_level); }
    if req.max_reviews.is_some() { sql = sql.bind(req.max_reviews); }
    if req.max_json_parse_retries.is_some() { sql = sql.bind(req.max_json_parse_retries); }
    if let Some(ref sorts) = req.column_sorts { 
        sql = sql.bind(sorts.to_string()); 
    }
    
    sql.execute(&state.db).await.map_err(ApiError::Database)?;
    
    let hub = state.sse_hub.read().await;
    let _ = hub.broadcast(&WSMessage {
        r#type: "options_updated".to_string(),
        payload: json!({}),
    }).await;
    
    let updated = get_options(&state.db).await?;
    Ok(Json(updated))
}

pub fn routes() -> Vec<Route> {
    routes![
        get_options_route,
        update_options,
    ]
}
