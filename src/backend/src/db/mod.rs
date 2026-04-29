use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::path::Path;
use std::str::FromStr;

pub mod models;
pub mod queries;
pub mod runtime;

pub use models::*;

/// Create a database connection pool
pub async fn create_pool(db_path: &str) -> Result<Pool<Sqlite>, sqlx::Error> {
    // Ensure directory exists
    if let Some(parent) = Path::new(db_path).parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }

    let options = SqliteConnectOptions::from_str(&format!("sqlite:{}", db_path))?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(30));

    SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await
}

/// Run database migrations
pub async fn run_migrations(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    // Canonical schema bootstrap only.
    // Older schemas are not migrated and are not supported.

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            idx INTEGER NOT NULL DEFAULT 0,
            prompt TEXT NOT NULL,
            branch TEXT,
            plan_model TEXT,
            execution_model TEXT,
            planmode INTEGER NOT NULL DEFAULT 0,
            auto_approve_plan INTEGER NOT NULL DEFAULT 0,
            review INTEGER NOT NULL DEFAULT 0,
            auto_commit INTEGER NOT NULL DEFAULT 0,
            auto_deploy INTEGER NOT NULL DEFAULT 0,
            auto_deploy_condition TEXT,
            delete_worktree INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'backlog',
            requirements TEXT,
            agent_output TEXT NOT NULL DEFAULT '',
            review_count INTEGER NOT NULL DEFAULT 0,
            json_parse_retry_count INTEGER NOT NULL DEFAULT 0,
            session_id TEXT,
            session_url TEXT,
            worktree_dir TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            thinking_level TEXT NOT NULL DEFAULT 'default',
            plan_thinking_level TEXT NOT NULL DEFAULT 'default',
            execution_thinking_level TEXT NOT NULL DEFAULT 'default',
            execution_phase TEXT NOT NULL DEFAULT 'not_started',
            awaiting_plan_approval INTEGER NOT NULL DEFAULT 0,
            plan_revision_count INTEGER NOT NULL DEFAULT 0,
            execution_strategy TEXT NOT NULL DEFAULT 'standard',
            best_of_n_config TEXT,
            best_of_n_substage TEXT NOT NULL DEFAULT 'idle',
            skip_permission_asking INTEGER NOT NULL DEFAULT 0,
            max_review_runs_override INTEGER,
            smart_repair_hints TEXT,
            review_activity TEXT NOT NULL DEFAULT 'idle',
            is_archived INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            additional_agent_access TEXT,
            code_style_review INTEGER NOT NULL DEFAULT 0,
            group_id TEXT,
            self_heal_status TEXT NOT NULL DEFAULT 'idle',
            self_heal_message TEXT,
            self_heal_report_id TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS workflow_runs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            display_name TEXT NOT NULL,
            target_task_id TEXT,
            task_order TEXT,
            current_task_id TEXT,
            current_task_index INTEGER NOT NULL DEFAULT 0,
            pause_requested INTEGER NOT NULL DEFAULT 0,
            stop_requested INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            finished_at INTEGER,
            is_archived INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            color TEXT NOT NULL,
            group_id TEXT,
            queued_task_count INTEGER,
            executing_task_count INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_runs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            phase TEXT NOT NULL,
            slot_index INTEGER NOT NULL,
            attempt_index INTEGER NOT NULL,
            model TEXT NOT NULL,
            task_suffix TEXT,
            status TEXT NOT NULL,
            session_id TEXT,
            session_url TEXT,
            worktree_dir TEXT,
            summary TEXT,
            error_message TEXT,
            candidate_id TEXT,
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_candidates (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            worker_run_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'available',
            changed_files_json TEXT,
            diff_stats_json TEXT,
            verification_json TEXT,
            summary TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            idx INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            UNIQUE(group_id, task_id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS pi_workflow_sessions (
            id TEXT PRIMARY KEY,
            task_id TEXT,
            task_run_id TEXT,
            session_kind TEXT NOT NULL,
            status TEXT NOT NULL,
            cwd TEXT NOT NULL,
            worktree_dir TEXT,
            branch TEXT,
            pi_session_id TEXT,
            pi_session_file TEXT,
            process_pid INTEGER,
            model TEXT NOT NULL,
            thinking_level TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            finished_at INTEGER,
            exit_code INTEGER,
            exit_signal TEXT,
            error_message TEXT,
            name TEXT,
            isolation_mode TEXT NOT NULL DEFAULT 'none',
            path_grants_json TEXT NOT NULL DEFAULT '[]'
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS session_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seq INTEGER NOT NULL,
            message_id TEXT,
            session_id TEXT NOT NULL,
            task_id TEXT,
            task_run_id TEXT,
            timestamp INTEGER NOT NULL,
            role TEXT NOT NULL,
            event_name TEXT,
            message_type TEXT NOT NULL,
            content_json TEXT NOT NULL,
            model_provider TEXT,
            model_id TEXT,
            agent_name TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            cache_read_tokens INTEGER,
            cache_write_tokens INTEGER,
            total_tokens INTEGER,
            cost_json TEXT,
            cost_total REAL,
            tool_call_id TEXT,
            tool_name TEXT,
            tool_args_json TEXT,
            tool_result_json TEXT,
            tool_status TEXT,
            edit_diff TEXT,
            edit_file_path TEXT,
            session_status TEXT,
            workflow_phase TEXT,
            raw_event_json TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            level TEXT NOT NULL,
            source TEXT NOT NULL,
            event_type TEXT NOT NULL,
            message TEXT NOT NULL,
            run_id TEXT,
            task_id TEXT,
            task_run_id TEXT,
            session_id TEXT,
            details_json TEXT NOT NULL DEFAULT '{}'
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS options (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            commit_prompt TEXT NOT NULL DEFAULT '',
            extra_prompt TEXT NOT NULL DEFAULT '',
            branch TEXT NOT NULL DEFAULT '',
            plan_model TEXT NOT NULL DEFAULT '',
            execution_model TEXT NOT NULL DEFAULT '',
            review_model TEXT NOT NULL DEFAULT '',
            repair_model TEXT NOT NULL DEFAULT '',
            command TEXT NOT NULL DEFAULT '',
            parallel_tasks INTEGER NOT NULL DEFAULT 1,
            auto_delete_normal_sessions INTEGER NOT NULL DEFAULT 0,
            auto_delete_review_sessions INTEGER NOT NULL DEFAULT 0,
            show_execution_graph INTEGER NOT NULL DEFAULT 1,
            port INTEGER NOT NULL DEFAULT 3789,
            thinking_level TEXT NOT NULL DEFAULT 'default',
            plan_thinking_level TEXT NOT NULL DEFAULT 'default',
            execution_thinking_level TEXT NOT NULL DEFAULT 'default',
            review_thinking_level TEXT NOT NULL DEFAULT 'default',
            repair_thinking_level TEXT NOT NULL DEFAULT 'default',
            code_style_prompt TEXT NOT NULL DEFAULT '',
            telegram_bot_token TEXT NOT NULL DEFAULT '',
            telegram_chat_id TEXT NOT NULL DEFAULT '',
            telegram_notification_level TEXT NOT NULL DEFAULT 'all',
            max_reviews INTEGER NOT NULL DEFAULT 2,
            max_json_parse_retries INTEGER NOT NULL DEFAULT 5,
            bubblewrap_enabled INTEGER NOT NULL DEFAULT 1,
            column_sorts TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Insert default options if not exists
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO options (id) VALUES (1)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS planning_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            prompt_text TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS planning_prompt_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            planning_prompt_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            prompt_text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(planning_prompt_id) REFERENCES planning_prompts(id) ON DELETE CASCADE,
            UNIQUE(planning_prompt_id, version)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO planning_prompt_versions (planning_prompt_id, version, prompt_text, created_at)
        SELECT p.id, 1, p.prompt_text, p.created_at
        FROM planning_prompts p
        WHERE NOT EXISTS (
            SELECT 1 FROM planning_prompt_versions v WHERE v.planning_prompt_id = p.id
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS prompt_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            template_text TEXT NOT NULL,
            variables_json TEXT NOT NULL DEFAULT '[]',
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    let now = chrono::Utc::now().timestamp();

    // ======================================================================
    // Seed prompt data from the shared prompt-catalog.json (single source of truth)
    // ======================================================================

    let system_prompts = crate::prompt_catalog::get_all_system_prompts();
    for sp in &system_prompts {
        let prompt_text = sp.prompt_text.join("\n");
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO planning_prompts (key, name, description, prompt_text, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            "#,
        )
        .bind(&sp.key)
        .bind(&sp.name)
        .bind(&sp.description)
        .bind(&prompt_text)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
    }

    let templates = crate::prompt_catalog::get_all_templates();
    for (key, name, description, template_text, variables_json) in &templates {
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO prompt_templates (
                key, name, description, template_text, variables_json, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            "#,
        )
        .bind(key)
        .bind(name)
        .bind(description)
        .bind(template_text)
        .bind(variables_json)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
    }

    // ======================================================================
    // End of prompt seed section — all prompts come from prompt-catalog.json
    // ======================================================================
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS self_heal_reports (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            task_status TEXT NOT NULL,
            error_message TEXT,
            diagnostics_summary TEXT NOT NULL,
            is_tauroboros_bug INTEGER NOT NULL DEFAULT 0,
            root_cause_json TEXT NOT NULL DEFAULT '{}',
            proposed_solution TEXT NOT NULL,
            implementation_plan_json TEXT NOT NULL DEFAULT '[]',
            confidence TEXT NOT NULL DEFAULT 'low',
            external_factors_json TEXT NOT NULL DEFAULT '[]',
            source_mode TEXT NOT NULL,
            source_path TEXT,
            github_url TEXT NOT NULL,
            tauroboros_version TEXT NOT NULL,
            db_path TEXT NOT NULL,
            db_schema_json TEXT NOT NULL,
            raw_response TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
            FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_planning_prompt_versions_prompt_id ON planning_prompt_versions(planning_prompt_id)")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_self_heal_reports_run_id ON self_heal_reports(run_id)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_self_heal_reports_task_id ON self_heal_reports(task_id)",
    )
    .execute(pool)
    .await?;

    Ok(())
}
