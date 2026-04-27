use crate::orchestrator::Orchestrator;
use crate::sse::hub::SseHub;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::RwLock;

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

    /// Native workflow orchestrator
    pub orchestrator: Orchestrator,
}

impl AppState {
    pub fn new(
        db: SqlitePool,
        sse_hub: Arc<RwLock<SseHub>>,
        port: u16,
        project_root: String,
        settings_dir: String,
        orchestrator: Orchestrator,
    ) -> Self {
        Self {
            db,
            sse_hub,
            port,
            project_root,
            settings_dir,
            orchestrator,
        }
    }
    
    /// Get the base URL for session links
    pub fn session_url_for(&self, session_id: &str) -> String {
        format!("http://localhost:{}/sessions/{}?mode=compact", self.port, session_id)
    }
}

// Rocket state type - Arc<AppState> is what we manage
pub type AppStateType = Arc<AppState>;
