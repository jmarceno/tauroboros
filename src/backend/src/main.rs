//! TaurOboros Server - Rust/Rocket Implementation
//!
//! This is a Rust implementation of the TaurOboros workflow orchestration system,
//! providing API compatibility with the TypeScript/Bun frontend.

mod audit;
mod cors;
mod db;
mod error;
mod models;
mod orchestrator;
mod routes;
mod settings;
mod sse;
mod state;

use crate::cors::Cors;
use crate::db::{create_pool, run_migrations};
use crate::orchestrator::pi::ensure_structured_output_extension;
use crate::orchestrator::planning_session::PlanningSessionManager;
use crate::orchestrator::Orchestrator;
use crate::settings::load_startup_settings;
use crate::sse::hub::SseHub;
use crate::state::{AppState, AppStateType};
use rocket::{launch, Build, Rocket};
use std::sync::Arc;
use tracing::{info, warn};

/// Build and launch the Rocket server
#[launch]
async fn rocket() -> Rocket<Build> {
    // Initialize tracing/logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
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

    match ensure_structured_output_extension(&project_root).await {
        Ok(path) => info!("Prepared Pi structured output extension at {}", path),
        Err(error) => panic!(
            "Failed to prepare Pi structured output extension: {}",
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

    // Create app state wrapped in Arc
    let app_state: AppStateType = Arc::new(AppState::new(
        db_pool,
        sse_hub_lock,
        port,
        project_root,
        settings_dir,
        orchestrator,
        planning_session_manager,
    ));

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
