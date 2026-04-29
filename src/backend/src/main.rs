//! TaurOboros Server - Rust/Rocket Implementation
//!
//! This is a Rust implementation of the TaurOboros workflow orchestration system,
//! providing API compatibility with the TypeScript/Bun frontend.

mod audit;
mod cors;
mod db;
mod embedded_resources;
mod error;
mod internal_api;
mod models;
mod orchestrator;
mod prompt_catalog;
mod routes;
mod settings;
mod sse;
mod state;

use crate::audit::{record_audit_event, CreateAuditEvent};
use crate::cors::Cors;
use crate::db::queries::{fix_stale_workflow_runs, get_options};
use crate::db::{create_pool, run_migrations};
use crate::embedded_resources::ensure_embedded_pi_resources;
use crate::internal_api::start_message_writer;
use crate::models::AuditLevel;
use crate::orchestrator::planning_session::PlanningSessionManager;
use crate::orchestrator::isolation::bubblewrap_available;
use crate::orchestrator::Orchestrator;
use crate::settings::load_startup_settings;
use crate::sse::hub::SseHub;
use crate::state::{AppState, AppStateType};
use rocket::{launch, Build, Rocket};
use serde_json::json;
use std::sync::Arc;
use tracing::{info, warn};

/// Build and launch the Rocket server
#[launch]
async fn rocket() -> Rocket<Build> {
    // Initialize tracing/logging (simplified, no env-filter for faster compile)
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    info!("Starting TaurOboros Rust server...");

    // Load environment variables
    dotenvy::dotenv().ok();

    let startup_settings = load_startup_settings()
        .unwrap_or_else(|error| panic!("Failed to load startup settings: {error}"));

    let port = startup_settings.port;
    let project_root = startup_settings.project_root;
    let settings_dir = startup_settings.settings_dir;
    let db_path = startup_settings.db_path;

    info!("Database path: {}", db_path);
    info!("Server port: {}", port);
    info!("Project root: {}", project_root);

    match ensure_embedded_pi_resources(&project_root).await {
        Ok(summary) => info!(
            "Prepared embedded Pi resources at startup ({} skills, {} extensions extracted)",
            summary.skills_extracted,
            summary.extensions_extracted
        ),
        Err(error) => panic!(
            "Failed to prepare embedded Pi resources: {}",
            error
        ),
    }

    // Create database pool
    let db_pool = match create_pool(&db_path).await {
        Ok(pool) => {
            info!("Database connection established");
            pool
        }
        Err(e) => {
            panic!("Failed to connect to database: {}", e);
        }
    };

    // Run migrations
    if let Err(e) = run_migrations(&db_pool).await {
        warn!("Migration warning (may already exist): {}", e);
    }

    // Fix stale workflow runs that were left in a non-terminal state
    if let Err(e) = fix_stale_workflow_runs(&db_pool).await {
        warn!("Failed to fix stale workflow runs on startup: {}", e);
    }

    let bubblewrap_is_available = bubblewrap_available();
    let mut bubblewrap_startup_notice: Option<String> = None;

    if !bubblewrap_is_available {
        let options = get_options(&db_pool)
            .await
            .unwrap_or_else(|error| panic!("Failed to load options during startup: {error}"));

        if options.bubblewrap_enabled {
            sqlx::query("UPDATE options SET bubblewrap_enabled = 0 WHERE id = 1")
                .execute(&db_pool)
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "Failed to auto-disable bubblewrap option when binary is unavailable: {error}"
                    )
                });

            let notice = "Bubblewrap sandbox was automatically disabled at startup because 'bwrap' is not installed while it was enabled in Options. Install bubblewrap and re-enable 'Bubblewrap sandbox isolation' in Options to turn it back on.".to_string();
            bubblewrap_startup_notice = Some(notice.clone());
            warn!("{}", notice);

            if let Err(error) = record_audit_event(
                &db_pool,
                CreateAuditEvent {
                    level: AuditLevel::Warn,
                    source: "startup",
                    event_type: "bubblewrap_auto_disabled",
                    message: notice,
                    run_id: None,
                    task_id: None,
                    task_run_id: None,
                    session_id: None,
                    details: Some(json!({
                        "bubblewrapAvailable": false,
                        "bubblewrapEnabledAtStartup": true,
                    })),
                },
            )
            .await
            {
                warn!("Failed to write startup audit event for bubblewrap auto-disable: {}", error);
            }
        }
    }

    // Create SSE hub
    let sse_hub = SseHub::new();
    let sse_hub_lock = std::sync::Arc::new(tokio::sync::RwLock::new(sse_hub));

    let orchestrator = Orchestrator::new(
        db_pool.clone(),
        sse_hub_lock.clone(),
        project_root.clone(),
        settings_dir.clone(),
    );

    let planning_session_manager =
        PlanningSessionManager::new(db_pool.clone(), sse_hub_lock.clone(), project_root.clone());

    // Start serialized message writer (single consumer to bypass SQLite multi-writer limitations)
    let message_writer = start_message_writer(db_pool.clone(), sse_hub_lock.clone());

    // Create app state wrapped in Arc
    let app_state: AppStateType = Arc::new(AppState::new(
        db_pool,
        sse_hub_lock,
        port,
        project_root,
        settings_dir,
        bubblewrap_is_available,
        bubblewrap_startup_notice,
        orchestrator,
        planning_session_manager,
        message_writer,
    ));

    // Disable ANSI colors in Rocket's internal log output to prevent
    // raw escape sequences (e.g. \x1b[34m) from appearing in log messages.
    std::env::set_var("ROCKET_CLI_COLORS", "0");

    // Build Rocket instance
    let figment = rocket::Config::figment()
        .merge(("port", port))
        .merge(("address", "0.0.0.0"));

    let rocket = rocket::custom(figment)
        .manage(app_state)
        .attach(Cors)
        .mount("/", routes::routes());

    info!("Rocket server configured and ready to launch");

    rocket
}
