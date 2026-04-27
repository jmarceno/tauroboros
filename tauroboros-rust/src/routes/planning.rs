use crate::db::queries::*;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::models::*;
use crate::state::AppStateType;
use chrono::Utc;
use rocket::routes;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use rocket::{get, patch, post, put, Route};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePlanningPromptRequest {
    key: Option<String>,
    name: Option<String>,
    description: Option<String>,
    prompt_text: Option<String>,
    is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePlanningSessionRequest {
    cwd: Option<String>,
    model: Option<String>,
    thinking_level: Option<ThinkingLevel>,
    session_kind: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SendMessageRequest {
    content: String,
    context_attachments: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReconnectSessionRequest {
    model: Option<String>,
    thinking_level: Option<ThinkingLevel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeModelRequest {
    model: Option<String>,
    thinking_level: Option<ThinkingLevel>,
}

#[derive(Debug, Deserialize)]
struct CreateTasksRequest {
    tasks: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
struct RenameSessionRequest {
    name: String,
}

#[get("/api/planning/prompt")]
async fn get_planning_prompt(state: &State<AppStateType>) -> ApiResult<Json<PlanningPrompt>> {
    // Get default planning prompt
    let prompt: Option<PlanningPrompt> = sqlx::query_as(
        r#"
        SELECT * FROM planning_prompts WHERE key = 'default' AND is_active = 1 LIMIT 1
        "#,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    prompt.map(Json).ok_or_else(|| {
        ApiError::not_found("Planning prompt not found")
            .with_code(ErrorCode::PlanningPromptNotConfigured)
    })
}

#[get("/api/planning/prompts")]
async fn get_all_planning_prompts(
    state: &State<AppStateType>,
) -> ApiResult<Json<Vec<PlanningPrompt>>> {
    let prompts: Vec<PlanningPrompt> = sqlx::query_as(
        r#"
        SELECT * FROM planning_prompts ORDER BY key, is_active DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    Ok(Json(prompts))
}

#[put("/api/planning/prompt", data = "<req>")]
async fn update_planning_prompt(
    state: &State<AppStateType>,
    req: Json<UpdatePlanningPromptRequest>,
) -> ApiResult<Json<PlanningPrompt>> {
    let key = req.key.as_deref().unwrap_or("default");

    let existing: Option<PlanningPrompt> = sqlx::query_as(
        r#"
        SELECT * FROM planning_prompts WHERE key = ? LIMIT 1
        "#,
    )
    .bind(key)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    let existing_prompt = if let Some(existing_prompt) = existing {
        existing_prompt
    } else {
        return Err(ApiError::not_found("Planning prompt not found")
            .with_code(ErrorCode::PlanningPromptNotConfigured));
    };

    // Build update query
    let now = Utc::now().timestamp();
    let prompt_changed = req
        .prompt_text
        .as_ref()
        .map(|prompt_text| prompt_text != &existing_prompt.prompt_text)
        .unwrap_or(false);

    if let Some(name) = &req.name {
        let _ = sqlx::query("UPDATE planning_prompts SET name = ? WHERE key = ?")
            .bind(name)
            .bind(key)
            .execute(&state.db)
            .await;
    }

    if let Some(description) = &req.description {
        let _ = sqlx::query("UPDATE planning_prompts SET description = ? WHERE key = ?")
            .bind(description)
            .bind(key)
            .execute(&state.db)
            .await;
    }

    if let Some(prompt_text) = &req.prompt_text {
        let _ = sqlx::query("UPDATE planning_prompts SET prompt_text = ? WHERE key = ?")
            .bind(prompt_text)
            .bind(key)
            .execute(&state.db)
            .await;
    }

    if let Some(is_active) = req.is_active {
        let _ = sqlx::query("UPDATE planning_prompts SET is_active = ? WHERE key = ?")
            .bind(is_active)
            .bind(key)
            .execute(&state.db)
            .await;
    }

    let _ = sqlx::query("UPDATE planning_prompts SET updated_at = ? WHERE key = ?")
        .bind(now)
        .bind(key)
        .execute(&state.db)
        .await;

    if let Some(prompt_text) = &req.prompt_text {
        if prompt_changed {
            let next_version: i64 = sqlx::query_scalar(
                r#"
                SELECT COALESCE(MAX(version), 0) + 1
                FROM planning_prompt_versions
                WHERE planning_prompt_id = ?
                "#,
            )
            .bind(existing_prompt.id)
            .fetch_one(&state.db)
            .await
            .map_err(crate::error::ApiError::Database)?;

            sqlx::query(
                r#"
                INSERT INTO planning_prompt_versions (planning_prompt_id, version, prompt_text, created_at)
                VALUES (?, ?, ?, ?)
                "#,
            )
            .bind(existing_prompt.id)
            .bind(next_version)
            .bind(prompt_text)
            .bind(now)
            .execute(&state.db)
            .await
            .map_err(crate::error::ApiError::Database)?;
        }
    }

    let updated: PlanningPrompt = sqlx::query_as("SELECT * FROM planning_prompts WHERE key = ?")
        .bind(key)
        .fetch_one(&state.db)
        .await
        .map_err(crate::error::ApiError::Database)?;

    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "planning_prompt_updated".to_string(),
            payload: serde_json::to_value(&updated).unwrap_or_default(),
        })
        .await;

    Ok(Json(updated))
}

#[get("/api/planning/prompt/<key>/versions")]
async fn get_prompt_versions(
    state: &State<AppStateType>,
    key: String,
) -> ApiResult<Json<Vec<PlanningPromptVersion>>> {
    let versions = get_planning_prompt_versions(&state.db, &key).await?;
    Ok(Json(versions))
}

#[get("/api/planning/sessions")]
async fn list_planning_sessions(state: &State<AppStateType>) -> ApiResult<Json<Vec<Value>>> {
    let sessions: Vec<PiWorkflowSession> = sqlx::query_as(
        r#"
        SELECT * FROM pi_workflow_sessions 
        WHERE session_kind IN ('planning', 'container_config')
        ORDER BY updated_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    let base_url = format!("http://localhost:{}", state.port);
    let with_urls: Vec<Value> = sessions
        .iter()
        .map(|s| {
            let mut json = serde_json::to_value(s).unwrap_or_default();
            json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, s.id));
            json
        })
        .collect();

    Ok(Json(with_urls))
}

#[get("/api/planning/sessions/active")]
async fn list_active_planning_sessions(state: &State<AppStateType>) -> ApiResult<Json<Vec<Value>>> {
    let sessions: Vec<PiWorkflowSession> = sqlx::query_as(
        r#"
        SELECT * FROM pi_workflow_sessions 
        WHERE session_kind IN ('planning', 'container_config')
        AND status IN ('starting', 'active', 'paused')
        ORDER BY updated_at DESC
        "#,
    )
    .fetch_all(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    let base_url = format!("http://localhost:{}", state.port);
    let with_urls: Vec<Value> = sessions
        .iter()
        .map(|s| {
            let mut json = serde_json::to_value(s).unwrap_or_default();
            json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, s.id));
            json
        })
        .collect();

    Ok(Json(with_urls))
}

#[post("/api/planning/sessions", data = "<req>")]
async fn create_planning_session(
    state: &State<AppStateType>,
    req: Json<CreatePlanningSessionRequest>,
) -> ApiResult<Json<Value>> {
    let now = Utc::now().timestamp();
    let id = uuid::Uuid::new_v4().to_string();

    let session_kind = match req.session_kind.as_deref() {
        Some("container_config") => PiSessionKind::ContainerConfig,
        _ => PiSessionKind::Planning,
    };

    let prompt_key = if session_kind == PiSessionKind::ContainerConfig {
        "container_config"
    } else {
        "default"
    };

    // Check prompt exists
    let prompt: Option<PlanningPrompt> =
        sqlx::query_as("SELECT * FROM planning_prompts WHERE key = ? AND is_active = 1 LIMIT 1")
            .bind(prompt_key)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::error::ApiError::Database)?;

    if prompt.is_none() {
        return Err(ApiError::internal("Planning prompt not configured")
            .with_code(ErrorCode::PlanningPromptNotConfigured));
    }

    let session = PiWorkflowSession {
        id: id.clone(),
        task_id: None,
        task_run_id: None,
        session_kind,
        status: PiSessionStatus::Starting,
        cwd: req
            .cwd
            .clone()
            .unwrap_or_else(|| state.project_root.clone()),
        worktree_dir: None,
        branch: None,
        pi_session_id: None,
        pi_session_file: None,
        process_pid: None,
        model: req.model.clone().unwrap_or_else(|| "default".to_string()),
        thinking_level: req.thinking_level.unwrap_or(ThinkingLevel::Default),
        started_at: now,
        updated_at: now,
        finished_at: None,
        exit_code: None,
        exit_signal: None,
        error_message: None,
        name: None,
    };

    sqlx::query(
        r#"
        INSERT INTO pi_workflow_sessions (
            id, session_kind, status, cwd, model, thinking_level, 
            started_at, updated_at, name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&session.id)
    .bind(session.session_kind)
    .bind(session.status)
    .bind(&session.cwd)
    .bind(&session.model)
    .bind(session.thinking_level)
    .bind(session.started_at)
    .bind(session.updated_at)
    .bind(&session.name)
    .execute(&state.db)
    .await
    .map_err(crate::error::ApiError::Database)?;

    let prompt_text = prompt.unwrap().prompt_text;

    let mut session_with_file = session.clone();
    session_with_file.pi_session_file = Some(format!(".pi/sessions/{}.jsonl", id));
    session_with_file.status = PiSessionStatus::Active;

    let _ =
        sqlx::query("UPDATE pi_workflow_sessions SET pi_session_file = ?, status = ? WHERE id = ?")
            .bind(&session_with_file.pi_session_file)
            .bind(PiSessionStatus::Active)
            .bind(&id)
            .execute(&state.db)
            .await;

    if session_kind == PiSessionKind::Planning {
        let model = req.model.as_deref().unwrap_or("default");
        let model_to_use = if model == "default" {
            let opts = crate::db::queries::get_options(&state.db).await?;
            opts.plan_model.clone()
        } else {
            model.to_string()
        };

        if model_to_use != "default" {
            let _ = sqlx::query("UPDATE pi_workflow_sessions SET model = ? WHERE id = ?")
                .bind(&model_to_use)
                .bind(&id)
                .execute(&state.db)
                .await;
        }

        let actual_model = if model_to_use == "default" {
            "openai/gpt-4o".to_string()
        } else {
            model_to_use
        };

        state
            .planning_session_manager
            .create_session(&session_with_file, &prompt_text, &actual_model)
            .await?;
    }

    let hub = state.sse_hub.read().await;
    let base_url = format!("http://localhost:{}", state.port);

    let mut json = serde_json::to_value(&session_with_file).unwrap_or_default();
    json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, id));

    let _ = hub
        .broadcast(&WSMessage {
            r#type: "planning_session_created".to_string(),
            payload: json.clone(),
        })
        .await;

    Ok(Json(json))
}

#[post("/api/planning/sessions/<id>/messages", data = "<req>")]
async fn send_planning_message(
    state: &State<AppStateType>,
    id: String,
    req: Json<SendMessageRequest>,
) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    if session.session_kind == PiSessionKind::Planning
        && state.planning_session_manager.has_active_session(&id).await
    {
        state
            .planning_session_manager
            .send_message(&id, &req.content, req.context_attachments.as_ref())
            .await?;
    } else {
        let seq = crate::db::runtime::get_next_session_message_seq(&state.db, &id).await?;
        let now = Utc::now().timestamp();
        let msg = crate::models::SessionMessage {
            id: 0,
            seq,
            message_id: Some(uuid::Uuid::new_v4().to_string()),
            session_id: id.clone(),
            task_id: None,
            task_run_id: None,
            timestamp: now,
            role: crate::models::MessageRole::User,
            event_name: Some("user_message".to_string()),
            message_type: crate::models::MessageType::UserPrompt,
            content_json: serde_json::json!({ "text": req.content }).to_string(),
            model_provider: None,
            model_id: None,
            agent_name: None,
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            total_tokens: None,
            cost_json: None,
            cost_total: None,
            tool_call_id: None,
            tool_name: None,
            tool_args_json: None,
            tool_result_json: None,
            tool_status: None,
            edit_diff: None,
            edit_file_path: None,
            session_status: Some("active".to_string()),
            workflow_phase: Some("planning".to_string()),
            raw_event_json: None,
        };
        let created = create_session_message(&state.db, &msg).await?;
        let hub = state.sse_hub.read().await;
        let _ = hub
            .broadcast(&WSMessage {
                r#type: "planning_session_message".to_string(),
                payload: json!({
                    "sessionId": id,
                    "message": &created,
                }),
            })
            .await;
    }

    Ok(Json(json!({ "ok": true })))
}

#[post("/api/planning/sessions/<id>/reconnect", data = "<req>")]
async fn reconnect_planning_session(
    state: &State<AppStateType>,
    id: String,
    req: Json<ReconnectSessionRequest>,
) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    if session.status == PiSessionStatus::Active
        || state.planning_session_manager.has_active_session(&id).await
    {
        let base_url = format!("http://localhost:{}", state.port);
        let mut json = serde_json::to_value(&session).unwrap_or_default();
        json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, id));
        return Ok(Json(json));
    }

    // Update session
    let now = Utc::now().timestamp();
    let _ = sqlx::query(
        r#"
        UPDATE pi_workflow_sessions 
        SET status = ?, model = ?, thinking_level = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(PiSessionStatus::Active)
    .bind(req.model.clone().unwrap_or(session.model))
    .bind(req.thinking_level.unwrap_or(session.thinking_level))
    .bind(now)
    .bind(&id)
    .execute(&state.db)
    .await;

    let updated = get_workflow_session(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Session not found"))?;

    let hub = state.sse_hub.read().await;
    let base_url = format!("http://localhost:{}", state.port);

    let mut json = serde_json::to_value(&updated).unwrap_or_default();
    json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, id));

    let _ = hub
        .broadcast(&WSMessage {
            r#type: "planning_session_updated".to_string(),
            payload: json.clone(),
        })
        .await;

    Ok(Json(json))
}

#[post("/api/planning/sessions/<id>/model", data = "<req>")]
async fn change_session_model(
    state: &State<AppStateType>,
    id: String,
    req: Json<ChangeModelRequest>,
) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    if session.status != PiSessionStatus::Active {
        return Err(ApiError::bad_request("Planning session not active")
            .with_code(ErrorCode::PlanningSessionNotActive));
    }

    // Validate thinking level
    if let Some(ref level) = req.thinking_level {
        if !matches!(
            level,
            ThinkingLevel::Default
                | ThinkingLevel::Low
                | ThinkingLevel::Medium
                | ThinkingLevel::High
        ) {
            return Err(ApiError::bad_request(
                "Invalid thinkingLevel. Allowed values: default, low, medium, high",
            )
            .with_code(ErrorCode::InvalidThinkingLevel));
        }
    }

    let now = Utc::now().timestamp();

    if let Some(model) = &req.model {
        let _ = sqlx::query("UPDATE pi_workflow_sessions SET model = ? WHERE id = ?")
            .bind(model)
            .bind(&id)
            .execute(&state.db)
            .await;
    }

    if let Some(thinking_level) = &req.thinking_level {
        let _ = sqlx::query("UPDATE pi_workflow_sessions SET thinking_level = ? WHERE id = ?")
            .bind(thinking_level)
            .bind(&id)
            .execute(&state.db)
            .await;
    }

    let _ = sqlx::query("UPDATE pi_workflow_sessions SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await;

    if state.planning_session_manager.has_active_session(&id).await {
        let _ = state
            .planning_session_manager
            .change_model(&id, req.model.as_deref(), req.thinking_level)
            .await;
    }

    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "planning_session_updated".to_string(),
            payload: json!({ "sessionId": id }),
        })
        .await;

    Ok(Json(json!({
        "ok": true,
        "model": req.model,
        "thinkingLevel": req.thinking_level,
    })))
}

#[post("/api/planning/sessions/<id>/create-tasks", data = "<req>")]
async fn create_tasks_from_planning(
    state: &State<AppStateType>,
    id: String,
    req: Json<CreateTasksRequest>,
) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    let base_url = format!("http://localhost:{}", state.port);
    let hub = state.sse_hub.read().await;

    // Send task setup prompt
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "planning_session_message".to_string(),
            payload: json!({
                "sessionId": id,
                "message": {
                    "content": "Setting up tasks from planning session...",
                    "timestamp": Utc::now().timestamp(),
                }
            }),
        })
        .await;

    if let Some(ref tasks) = req.tasks {
        let mut created = vec![];

        for task_data in tasks {
            // Parse task data and create
            if let (Some(name), Some(prompt)) = (
                task_data.get("name").and_then(|v| v.as_str()),
                task_data.get("prompt").and_then(|v| v.as_str()),
            ) {
                let input = CreateTaskInput {
                    id: Some(uuid::Uuid::new_v4().to_string()[..8].to_string()),
                    name: name.to_string(),
                    prompt: prompt.to_string(),
                    status: Some(TaskStatus::Backlog),
                    branch: None,
                    plan_model: None,
                    execution_model: None,
                    plan_mode: None,
                    auto_approve_plan: None,
                    review: None,
                    code_style_review: None,
                    auto_commit: None,
                    auto_deploy: None,
                    auto_deploy_condition: None,
                    delete_worktree: None,
                    requirements: Some(vec![]),
                    thinking_level: None,
                    plan_thinking_level: None,
                    execution_thinking_level: None,
                    execution_strategy: None,
                    best_of_n_config: None,
                    best_of_n_substage: None,
                    skip_permission_asking: None,
                    max_review_runs_override: None,
                    container_image: None,
                    group_id: None,
                };

                if let Ok(task) = create_task_db(&state.db, input).await {
                    let normalized =
                        crate::routes::tasks::normalize_task_for_client(&task, &base_url);

                    let _ = hub
                        .broadcast(&WSMessage {
                            r#type: "task_created".to_string(),
                            payload: normalized.clone(),
                        })
                        .await;

                    created.push(normalized);
                }
            }
        }

        return Ok(Json(json!({
            "tasks": created,
            "count": created.len(),
            "message": "Tasks created. The AI has also been instructed to review the conversation and create additional tasks if needed.",
        })));
    }

    Ok(Json(json!({
        "message": "Task creation request sent to the AI. The agent will use the workflow-task-setup skill to analyze the conversation and create appropriate kanban tasks.",
    })))
}

#[get("/api/planning/sessions/<id>")]
async fn get_planning_session(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    let base_url = format!("http://localhost:{}", state.port);
    let mut json = serde_json::to_value(&session).unwrap_or_default();
    json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, id));

    Ok(Json(json))
}

#[patch("/api/planning/sessions/<id>", data = "<req>")]
async fn update_planning_session(
    state: &State<AppStateType>,
    id: String,
    req: Json<Value>,
) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    let now = Utc::now().timestamp();

    // Update status if provided
    if let Some(status_str) = req.get("status").and_then(|v| v.as_str()) {
        let status = match status_str {
            "starting" => PiSessionStatus::Starting,
            "active" => PiSessionStatus::Active,
            "paused" => PiSessionStatus::Paused,
            "completed" => PiSessionStatus::Completed,
            "failed" => PiSessionStatus::Failed,
            "aborted" => PiSessionStatus::Aborted,
            _ => session.status,
        };

        let _ = sqlx::query("UPDATE pi_workflow_sessions SET status = ? WHERE id = ?")
            .bind(status)
            .bind(&id)
            .execute(&state.db)
            .await;
    }

    // Update error_message if provided
    if let Some(error_msg) = req.get("errorMessage").and_then(|v| v.as_str()) {
        let _ = sqlx::query("UPDATE pi_workflow_sessions SET error_message = ? WHERE id = ?")
            .bind(error_msg)
            .bind(&id)
            .execute(&state.db)
            .await;
    }

    let _ = sqlx::query("UPDATE pi_workflow_sessions SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await;

    let hub = state.sse_hub.read().await;
    let _ = hub
        .broadcast(&WSMessage {
            r#type: "planning_session_updated".to_string(),
            payload: json!({ "sessionId": id }),
        })
        .await;

    let base_url = format!("http://localhost:{}", state.port);
    let updated = get_workflow_session(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to update session"))?;

    let mut json = serde_json::to_value(&updated).unwrap_or_default();
    json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, id));

    Ok(Json(json))
}

#[post("/api/planning/sessions/<id>/stop")]
async fn stop_planning_session(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    state.planning_session_manager.stop_session(&id).await?;

    Ok(Json(json!({ "ok": true })))
}

#[post("/api/planning/sessions/<id>/close")]
async fn close_planning_session(state: &State<AppStateType>, id: String) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    state.planning_session_manager.close_session(&id).await?;

    let base_url = format!("http://localhost:{}", state.port);
    let updated = get_workflow_session(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to update session"))?;

    let mut json = serde_json::to_value(&updated).unwrap_or_default();
    json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, id));

    Ok(Json(json))
}

#[get("/api/planning/sessions/<id>/messages?<limit>&<offset>")]
async fn get_planning_messages(
    state: &State<AppStateType>,
    id: String,
    limit: Option<i32>,
    offset: Option<i32>,
) -> ApiResult<Json<Vec<SessionMessage>>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    let messages =
        get_session_messages_db(&state.db, &id, limit.unwrap_or(500), offset.unwrap_or(0)).await?;
    Ok(Json(messages))
}

#[get("/api/planning/sessions/<id>/timeline")]
async fn get_planning_timeline(
    state: &State<AppStateType>,
    id: String,
) -> ApiResult<Json<Vec<Value>>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    let messages = get_session_messages_db(&state.db, &id, 1000, 0).await?;

    let timeline: Vec<Value> = messages
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "timestamp": m.timestamp,
                "relativeTime": m.timestamp - session.started_at,
                "role": m.role,
                "messageType": m.message_type,
                "summary": serde_json::from_str::<Value>(&m.content_json).ok()
                    .and_then(|v| v.get("text").or_else(|| v.get("summary")).cloned())
                    .unwrap_or_else(|| json!("")),
                "hasToolCalls": m.tool_call_id.is_some(),
                "hasEdits": m.edit_diff.is_some(),
                "modelProvider": m.model_provider,
                "modelId": m.model_id,
                "agentName": m.agent_name,
            })
        })
        .collect();

    Ok(Json(timeline))
}

#[put("/api/planning/sessions/<id>/name", data = "<req>")]
async fn rename_planning_session(
    state: &State<AppStateType>,
    id: String,
    req: Json<RenameSessionRequest>,
) -> ApiResult<Json<Value>> {
    let session = get_workflow_session(&state.db, &id).await?.ok_or_else(|| {
        ApiError::not_found("Session not found").with_code(ErrorCode::SessionNotFound)
    })?;

    if !matches!(
        session.session_kind,
        PiSessionKind::Planning | PiSessionKind::ContainerConfig
    ) {
        return Err(ApiError::bad_request("Not a planning session")
            .with_code(ErrorCode::NotAPlanningSession));
    }

    if req.name.trim().is_empty() {
        return Err(ApiError::bad_request(
            "Name is required and must be a non-empty string",
        ));
    }

    let now = Utc::now().timestamp();

    let _ = sqlx::query(
        r#"
        UPDATE pi_workflow_sessions 
        SET name = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(req.name.trim())
    .bind(now)
    .bind(&id)
    .execute(&state.db)
    .await;

    let hub = state.sse_hub.read().await;
    let base_url = format!("http://localhost:{}", state.port);

    let updated = get_workflow_session(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("Failed to update session"))?;

    let mut json = serde_json::to_value(&updated).unwrap_or_default();
    json["sessionUrl"] = json!(format!("{}/sessions/{}?mode=compact", base_url, id));

    let _ = hub
        .broadcast(&WSMessage {
            r#type: "planning_session_updated".to_string(),
            payload: json.clone(),
        })
        .await;

    Ok(Json(json))
}

pub fn routes() -> Vec<Route> {
    routes![
        get_planning_prompt,
        get_all_planning_prompts,
        update_planning_prompt,
        get_prompt_versions,
        list_planning_sessions,
        list_active_planning_sessions,
        create_planning_session,
        send_planning_message,
        reconnect_planning_session,
        change_session_model,
        create_tasks_from_planning,
        get_planning_session,
        update_planning_session,
        stop_planning_session,
        close_planning_session,
        get_planning_messages,
        get_planning_timeline,
        rename_planning_session,
    ]
}
