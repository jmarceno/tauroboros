This is a **Rust** project using the **Rocket** web framework for the backend and **Solid JS** for the frontend.

The Rust backend is the **primary** implementation. The TypeScript/Bun backend (`src/backend-ts/`) is **deprecated** and will be removed in a future release. Do not write new code for it.

This codebase uses Rust idioms throughout: `thiserror` for error types, `serde` for serialization, `sqlx` for database access, and `rocket` for HTTP serving.

The "TaurOboros" project is an AI-powered workflow orchestration system that:
- Uses Pi AI agents via RPC protocol for task execution
- Features a kanban-style task board (template, backlog, executing, review, done)
- Implements advanced AI execution modes (Plan Mode, Review Loops, Best-of-N)
- Provides isolation through Git Worktree and optional container isolation
- Offers real-time updates (SSE), session logging, and execution graph visualization
- Combines Rust Rocket backend with Solid JS + Tailwind CSS kanban frontend

## Quick Start

```bash
# Build and run in development mode (Rust backend + Solid JS frontend)
./start-rust-dev.sh

# Or with explicit port
SERVER_PORT=3789 ./start-rust-dev.sh

# Force rebuild
./start-rust-dev.sh --rebuild
```

## Project Layout

```
tauroboros/
├── src/
│   ├── backend/                  # Rust backend (PRIMARY)
│   │   ├── Cargo.toml
│   │   ├── build.rs              # Builds frontend when embedded-frontend feature is on
│   │   ├── rust-toolchain.toml   # Rust stable, rustfmt + clippy
│   │   └── src/
│   │       ├── main.rs           # Entry point - Rocket server setup
│   │       ├── error.rs          # ApiError enum + ApiResult<T> type
│   │       ├── models.rs         # Data models (Task, TaskRun, etc.)
│   │       ├── state.rs          # AppState shared via Rocket managed state
│   │       ├── settings.rs       # Settings loading from .tauroboros/settings.json
│   │       ├── cors.rs           # CORS fairing
│   │       ├── audit.rs          # Audit logging
│   │       ├── embedded_resources.rs # Embeds skills/extensions via include_dir
│   │       ├── db/
│   │       │   ├── mod.rs        # Pool creation, migrations, schema
│   │       │   ├── queries.rs    # SQL query functions
│   │       │   └── runtime.rs    # Runtime DB operations
│   │       ├── routes/           # API route handlers
│   │       │   ├── mod.rs        # Route aggregation
│   │       │   ├── tasks/        # Task CRUD + sub-resources
│   │       │   ├── sessions.rs
│   │       │   ├── task_groups.rs
│   │       │   ├── planning.rs
│   │       │   ├── workflow.rs
│   │       │   ├── execution.rs
│   │       │   ├── options.rs
│   │       │   ├── runs.rs
│   │       │   ├── stats.rs
│   │       │   ├── prompts.rs
│   │       │   ├── containers.rs
│   │       │   ├── archived.rs
│   │       │   ├── reference.rs  # Models, version, branches
│   │       │   ├── sse.rs        # SSE endpoint
│   │       │   └── frontend.rs   # Static file serving (SPA fallback)
│   │       ├── orchestrator/     # Workflow orchestration
│   │       │   ├── mod.rs
│   │       │   ├── pi.rs         # Pi AI agent integration
│   │       │   ├── plan_mode.rs
│   │       │   ├── review.rs
│   │       │   ├── best_of_n.rs
│   │       │   ├── planning_session.rs
│   │       │   └── git.rs        # Git worktree operations
│   │       └── sse/
│   │           ├── mod.rs
│   │           └── hub.rs        # Broadcast hub for real-time SSE updates
│   ├── frontend/                 # Solid JS kanban UI
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── index.tsx
│   │       ├── App.tsx
│   │       ├── api/              # API client functions
│   │       ├── components/       # UI components (board, chat, modals, etc.)
│   │       ├── stores/           # Solid JS state management
│   │       ├── styles/
│   │       └── utils/
│   └── backend-ts/               # DEPRECATED - TypeScript/Bun backend
├── skills/                        # Pi agent skills
├── extensions/                    # Pi agent extensions
├── .tauroboros/                   # Local settings & DB
├── start-rust-dev.sh              # Development launcher (recommended)
└── scripts/                       # Utility scripts
```

## Architecture

- **Rust (Rocket) backend** serves the REST API on a configurable port (default 3789)
- **Solid JS frontend** is served either embedded in the binary (`embedded-frontend` feature) or from `dist/` during development
- **SQLite database** via `sqlx` with WAL mode at `.tauroboros/tasks.db`
- **SSE** (Server-Sent Events) for real-time UI updates
- **Pi AI agents** communicate via RPC protocol through the orchestrator

## Development

### Running in dev mode

```bash
# Recommended: uses start-rust-dev.sh which handles both Rust + frontend
./start-rust-dev.sh

# Manual split terminal approach:
# Terminal 1: Rust backend
cd src/backend && cargo build --release && ./target/release/tauroboros

# Terminal 2: Solid JS frontend dev server
cd src/frontend && npm run dev
```

The Vite dev server proxies `/api` and `/sse` requests to the Rust backend.

### Building for production

```bash
# Build frontend
cd src/frontend && npm ci && npm run build

# Build Rust backend with embedded frontend
cd src/backend && cargo build --release --features embedded-frontend

# Run the standalone binary
./src/backend/target/release/tauroboros
```

### Frontend Tech Stack
- **Framework**: Solid JS
- **Styling**: Tailwind CSS (custom dark theme with slate/indigo colors)
- **Build Tool**: Vite
- **Package Manager**: npm
- **Search**: Fuse.js for fuzzy model search
- **Diagrams**: Mermaid for execution graph visualization

### Settings & Port Configuration

Settings are loaded from `.tauroboros/settings.json`:

```json
{
  "workflow": {
    "server": {
      "port": 3789,
      "dbPath": ".tauroboros/tasks.db"
    }
  }
}
```

**Environment variables**:
- `SERVER_PORT` - Override port (default: 3789)
- `DATABASE_PATH` - Override database path
- `DEV_PORT` - Vite dev server port (default: 5173/5174)

### Testing

```bash
# Rust unit tests
cd src/backend && cargo test

# E2E tests (requires server running)
bun run test:e2e

# E2E with UI mode
bun run test:e2e:ui
```

## Error Handling

This project uses strict, explicit error handling:

```rust
// All handlers return ApiResult<T>
pub type ApiResult<T> = Result<T, ApiError>;

// ApiError variants cover all cases - no fallbacks
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

### Code Conventions

- **NEVER add fallbacks** - all conditions and cases must be explicit
- If a condition or case is not handled, return an explicit `ApiError` with the appropriate `ErrorCode`
- Every route handler returns `ApiResult<T>` - no implicit error swallowing
- Use `thiserror` derive macros for all error types
- Use `serde` for all serialization/deserialization
- Use `sqlx` typed queries for database access

## Pre-existing errors

You must always fix errors you find, it does not matter if they were introduced by your changes or not. We are a team and we work on all the issues together.

## CSS

When dealing with CSS changes, always get the computed CSS with Playwright and never trust visual identification.

## Storage

This project always prioritizes storing data on the database. Loose JSON files are rare exceptions that MUST have manual user approval.

## Test and Errors
  Errors must be fixed, even if your changes did not cause them, you must fix any errors you find.

## Fallbacks
  NEVER add fallbacks, all conditions and cases must be explicitly.
  If a condition or case is not explicit, it must not exist and it must return an explicit Effect failure using Schema.TaggedError.

## Pre-existing errors
  You must always fix errors you find, it does not matter if were introduced by your changes or not. We are a team and we work on all the issues together.
