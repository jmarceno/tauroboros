# Rust Architecture Guide

This document describes the Rust-based architecture patterns used in TaurOboros.

## Overview

TaurOboros uses a Rust-first architecture with the Rocket web framework. This guide documents the patterns and rules for maintaining consistency.

## Core Principles

### 1. ApiResult Pattern

All route handlers return `ApiResult<T>` — never implicitly swallow errors:

```rust
pub type ApiResult<T> = Result<T, ApiError>;

pub enum ApiError {
    BadRequest { message: String, code: ErrorCode },
    NotFound { message: String, code: ErrorCode },
    Conflict { message: String, code: ErrorCode },
    InternalError { message: String, code: ErrorCode, cause: Option<Box<dyn std::error::Error>> },
    ServiceUnavailable { message: String, code: ErrorCode },
    Database(sqlx::Error),
    Serialization(serde_json::Error),
}
```

**Rule**: Every handler returns `ApiResult<T>`. Never use `Result<Json<T>, String>` or similar loose types.

### 2. Error Code Pattern

Every error variant carries an explicit `ErrorCode`:

```rust
let task = get_task(&state.db, &id)
    .await?
    .ok_or_else(|| ApiError::not_found("Task not found")
        .with_code(ErrorCode::TaskNotFound))?;
```

**Rule**: Every `ApiError` must specify a code. Use the helper constructors (`.not_found()`, `.bad_request()`, `.conflict()`, `.internal()`) combined with `.with_code()` for precision.

### 3. Managed State Pattern

Shared state is passed via Rocket's `State<AppStateType>`:

```rust
// State is Arc<AppState> for thread safety
pub type AppStateType = Arc<AppState>;

pub struct AppState {
    pub db: SqlitePool,
    pub sse_hub: Arc<RwLock<SseHub>>,
    pub port: u16,
    pub project_root: String,
    pub settings_dir: String,
    pub orchestrator: Orchestrator,
    pub planning_session_manager: PlanningSessionManager,
}

// In a handler:
#[get("/api/tasks")]
async fn list_tasks(state: &State<AppStateType>) -> ApiResult<Json<Vec<Value>>> {
    let tasks = get_tasks(&state.db).await?;
    // ...
}
```

**Rule**: Never store state outside of the managed `AppState`. Use `State<AppStateType>` in all handlers that need shared state.

### 4. Database Pattern

All database access uses `sqlx` typed queries:

```rust
use sqlx::SqlitePool;

pub async fn get_tasks(pool: &SqlitePool) -> Result<Vec<Task>, sqlx::Error> {
    sqlx::query_as::<_, Task>("SELECT * FROM tasks WHERE is_archived = 0 ORDER BY idx")
        .fetch_all(pool)
        .await
}
```

**Rule**: No raw string building for SQL queries. Use `sqlx::query` / `sqlx::query_as` with bind parameters (`?`).

### 5. SSE Broadcast Pattern

Real-time updates use the `SseHub` broadcast hub:

```rust
let hub = state.sse_hub.read().await;
let _ = hub
    .broadcast(&WSMessage {
        r#type: "task_updated".to_string(),
        payload: normalized,
    })
    .await;
```

**Rule**: Always broadcast after state mutations. Use typed `WSMessage` structs — never raw JSON strings.

### 6. Orchestrator Pattern

Workflow orchestration is handled by the `Orchestrator` struct:

```rust
pub struct Orchestrator { /* ... */ }

impl Orchestrator {
    pub fn new(db: SqlitePool, sse_hub: ..., project_root: ..., settings_dir: ...) -> Self { }
    pub async fn start_single(&self, task_id: &str) -> ApiResult<WorkflowRun> { }
    pub async fn stop_run(&self, run_id: &str, pause: bool) -> ApiResult<StopResult> { }
}
```

**Rule**: All orchestration logic lives in `src/backend/src/orchestrator/`. Keep route handlers thin — delegate to the orchestrator for business logic.

### 7. Serialization Pattern

Use `serde` derive macros for all data models:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub status: TaskStatus,
    // ...
}
```

**Rule**: Use `#[serde(rename_all = "camelCase")]` for API-facing types to keep the JavaScript JSON contract. Use snake_case for Rust-internal types.

## Module Organization

### Route Modules

- `src/backend/src/routes/mod.rs` — Route aggregation
- `src/backend/src/routes/tasks/` — Task CRUD + sub-resources (split by function)
- `src/backend/src/routes/sessions.rs` — Session endpoints
- `src/backend/src/routes/frontend.rs` — Static file serving (SPA fallback)

Each route module exports a `pub fn routes() -> Vec<Route>` function.

### Database Modules

- `src/backend/src/db/mod.rs` — Pool creation, migrations
- `src/backend/src/db/queries.rs` — SQL query functions
- `src/backend/src/db/runtime.rs` — Runtime operations
- `src/backend/src/db/models.rs` — DB-specific model re-exports

### Orchestrator Modules

- `src/backend/src/orchestrator/mod.rs` — Orchestrator struct + startup sequence
- `src/backend/src/orchestrator/pi.rs` — Pi AI agent RPC integration
- `src/backend/src/orchestrator/plan_mode.rs` — Plan mode execution
- `src/backend/src/orchestrator/review.rs` — Review loop execution
- `src/backend/src/orchestrator/best_of_n.rs` — Best-of-N execution
- `src/backend/src/orchestrator/planning_session.rs` — Interactive planning sessions
- `src/backend/src/orchestrator/git.rs` — Git worktree operations

## Code Standards

When adding new features or modifying existing code:

- [ ] Return `ApiResult<T>` from all route handlers
- [ ] Use explicit `ErrorCode` on every error
- [ ] Use `serde::Deserialize` for request bodies, `serde::Serialize` for responses
- [ ] Use `sqlx::query_as::<_, T>` for typed queries
- [ ] Use `#[serde(rename_all = "camelCase")]` on API-facing types
- [ ] Broadcast SSE events after state mutations
- [ ] Keep route handlers thin; delegate to orchestrator for business logic
- [ ] Never add fallbacks — every condition must be explicitly handled
- [ ] Never use `unwrap()` or `expect()` in route handlers — return `ApiError` instead

## Verification

Run the Rust test suite:

```bash
cd src/backend && cargo test
```

Run clippy for linting:

```bash
cd src/backend && cargo clippy
```

Verify format:

```bash
cd src/backend && cargo fmt --check
```

## Resources

- Rocket Documentation: https://rocket.rs
- SQLite/sqlx: https://github.com/launchbadge/sqlx
- Serde: https://serde.rs
- Thiserror: https://docs.rs/thiserror
