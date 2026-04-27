use crate::error::{ApiError, ApiResult};
use crate::models::{AuditEvent, AuditLevel};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{Pool, Sqlite};
use tracing::{debug, error, info, trace, warn};

#[derive(Debug, Clone)]
pub struct CreateAuditEvent {
    pub level: AuditLevel,
    pub source: &'static str,
    pub event_type: &'static str,
    pub message: String,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub task_run_id: Option<String>,
    pub session_id: Option<String>,
    pub details: Option<Value>,
}

pub async fn record_audit_event(
    pool: &Pool<Sqlite>,
    event: CreateAuditEvent,
) -> ApiResult<AuditEvent> {
    log_to_console(&event);

    let created_at = Utc::now().timestamp();
    let details = event.details.unwrap_or_else(|| json!({}));
    let details_json = serde_json::to_string(&details)?;

    let inserted = sqlx::query_as::<_, AuditEvent>(
        r#"
        INSERT INTO audit_events (
            created_at, level, source, event_type, message,
            run_id, task_id, task_run_id, session_id, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
        "#,
    )
    .bind(created_at)
    .bind(event.level)
    .bind(event.source)
    .bind(event.event_type)
    .bind(&event.message)
    .bind(&event.run_id)
    .bind(&event.task_id)
    .bind(&event.task_run_id)
    .bind(&event.session_id)
    .bind(&details_json)
    .fetch_one(pool)
    .await
    .map_err(ApiError::Database)?;

    Ok(inserted)
}

fn log_to_console(event: &CreateAuditEvent) {
    let details = event.details.clone().unwrap_or_else(|| json!({})).to_string();

    match event.level {
        AuditLevel::Trace => trace!(
            source = event.source,
            event_type = event.event_type,
            run_id = ?event.run_id,
            task_id = ?event.task_id,
            task_run_id = ?event.task_run_id,
            session_id = ?event.session_id,
            details = %details,
            "{}",
            event.message
        ),
        AuditLevel::Debug => debug!(
            source = event.source,
            event_type = event.event_type,
            run_id = ?event.run_id,
            task_id = ?event.task_id,
            task_run_id = ?event.task_run_id,
            session_id = ?event.session_id,
            details = %details,
            "{}",
            event.message
        ),
        AuditLevel::Info => info!(
            source = event.source,
            event_type = event.event_type,
            run_id = ?event.run_id,
            task_id = ?event.task_id,
            task_run_id = ?event.task_run_id,
            session_id = ?event.session_id,
            details = %details,
            "{}",
            event.message
        ),
        AuditLevel::Warn => warn!(
            source = event.source,
            event_type = event.event_type,
            run_id = ?event.run_id,
            task_id = ?event.task_id,
            task_run_id = ?event.task_run_id,
            session_id = ?event.session_id,
            details = %details,
            "{}",
            event.message
        ),
        AuditLevel::Error => error!(
            source = event.source,
            event_type = event.event_type,
            run_id = ?event.run_id,
            task_id = ?event.task_id,
            task_run_id = ?event.task_run_id,
            session_id = ?event.session_id,
            details = %details,
            "{}",
            event.message
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{record_audit_event, CreateAuditEvent};
    use crate::db::{create_pool, run_migrations};
    use crate::models::AuditLevel;
    use serde_json::json;
    use uuid::Uuid;

    #[tokio::test]
    async fn record_audit_event_persists_context() {
        let db_path = std::env::temp_dir().join(format!(
            "tauroboros-audit-{}.db",
            Uuid::new_v4()
        ));
        let db_path_str = db_path.to_string_lossy().to_string();
        let pool = create_pool(&db_path_str).await.expect("create pool");
        run_migrations(&pool).await.expect("run migrations");

        let created = record_audit_event(
            &pool,
            CreateAuditEvent {
                level: AuditLevel::Error,
                source: "test",
                event_type: "audit.test",
                message: "persist audit context".to_string(),
                run_id: Some("run-1".to_string()),
                task_id: Some("task-1".to_string()),
                task_run_id: Some("task-run-1".to_string()),
                session_id: Some("session-1".to_string()),
                details: Some(json!({ "reason": "unit-test" })),
            },
        )
        .await
        .expect("record audit event");

        assert_eq!(created.level, AuditLevel::Error);
        assert_eq!(created.source, "test");
        assert_eq!(created.event_type, "audit.test");
        assert_eq!(created.run_id.as_deref(), Some("run-1"));
        assert_eq!(created.task_id.as_deref(), Some("task-1"));
        assert_eq!(created.task_run_id.as_deref(), Some("task-run-1"));
        assert_eq!(created.session_id.as_deref(), Some("session-1"));
        assert!(created.details_json.contains("unit-test"));

        drop(pool);
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(format!("{}-wal", db_path_str));
        let _ = std::fs::remove_file(format!("{}-shm", db_path_str));
    }
}