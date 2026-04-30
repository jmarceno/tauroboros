use crate::internal_api::MessageWriter;
use crate::orchestrator::planning_session::PlanningSessionManager;
use crate::orchestrator::Orchestrator;
use crate::sse::hub::SseHub;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::RwLock;

pub fn session_url_for(session_id: &str) -> String {
    format!("/#session/{}", session_id)
}

/// Application state shared across all request handlers
pub struct AppState {
    /// Database connection pool
    pub db: SqlitePool,

    /// SSE broadcast hub for real-time updates
    pub sse_hub: Arc<RwLock<SseHub>>,

    /// Server port
    pub port: u16,

    /// Project root directory
    pub project_root: String,

    /// Settings directory (for .tauroboros)
    pub settings_dir: String,

    /// Whether bubblewrap is currently available on this host.
    pub bubblewrap_available: bool,

    /// Startup notice when bubblewrap had to be auto-disabled.
    pub bubblewrap_startup_notice: Option<String>,

    /// Native workflow orchestrator
    pub orchestrator: Orchestrator,

    /// Planning session manager for interactive Pi sessions
    pub planning_session_manager: PlanningSessionManager,

    /// Serialized session message writer (bypasses SQLite multi-writer limitations)
    pub message_writer: MessageWriter,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db: SqlitePool,
        sse_hub: Arc<RwLock<SseHub>>,
        port: u16,
        project_root: String,
        settings_dir: String,
        bubblewrap_available: bool,
        bubblewrap_startup_notice: Option<String>,
        orchestrator: Orchestrator,
        planning_session_manager: PlanningSessionManager,
        message_writer: MessageWriter,
    ) -> Self {
        Self {
            db,
            sse_hub,
            port,
            project_root,
            settings_dir,
            bubblewrap_available,
            bubblewrap_startup_notice,
            orchestrator,
            planning_session_manager,
            message_writer,
        }
    }

    /// Get the base URL for session links
    #[allow(dead_code)]
    pub fn session_url_for(&self, session_id: &str) -> String {
        session_url_for(session_id)
    }
}

// Rocket state type - Arc<AppState> is what we manage
pub type AppStateType = Arc<AppState>;
