# TaurOboros Server (Rust/Rocket)

This is a Rust implementation of the TaurOboros workflow orchestration system backend, using the Rocket web framework. It provides API compatibility with the existing Solid JS frontend.

## Features

- **100% API Compatible**: Drop-in replacement for the TypeScript/Bun backend
- **SQLite Database**: Uses the same database schema as the original
- **Real-time Updates**: SSE (Server-Sent Events) for live frontend updates
- **Bubblewrap Sandbox**: All non-planning agent sessions run inside a bubblewrap sandbox by default
- **Native Only**: No container support (native execution mode)

## Prerequisites

- Rust 1.75+ (install via [rustup](https://rustup.rs/))
- SQLite3 (usually pre-installed on most systems)

## Quick Start (Recommended)

Use the provided startup script to run both backend and frontend:

```bash
# From the project root directory (parent of tauroboros-rust/)
./start-dev.sh
```

This will:
1. Build the Rust backend (if needed)
2. Start the backend on port 3789
3. Start the Solid frontend on port 5173
4. Handle Ctrl+C gracefully to stop both services

```bash
# Force rebuild of Rust backend
./start-dev.sh --rebuild

# Custom ports
SERVER_PORT=4000 DEV_PORT=3000 ./start-dev.sh

# Show help
./start-dev.sh --help
```

## Manual Setup

### 1. Install Dependencies

```bash
cd tauroboros-rust
cargo build --release
```

### 2. Environment Configuration (Optional)

Copy `.env.example` to `.env` and adjust settings:

```bash
cp .env.example .env
```

### 3. Run the Server

```bash
# Development
cargo run

# Production
cargo run --release

# With custom port
SERVER_PORT=3789 cargo run
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3789` | HTTP server port |
| `DATABASE_PATH` | `.tauroboros/tasks.db` | SQLite database file |
| `PROJECT_ROOT` | Current directory | Project root path |
| `RUST_LOG` | `info` | Logging level (error, warn, info, debug, trace) |

## API Endpoints

The server implements all the same endpoints as the TypeScript version:

### Tasks
- `GET /api/tasks` - List all tasks
- `POST /api/tasks` - Create task
- `GET /api/tasks/:id` - Get task details
- `PATCH /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete/archive task
- `POST /api/tasks/:id/approve-plan` - Approve plan
- `POST /api/tasks/:id/request-plan-revision` - Request plan revision
- `POST /api/tasks/:id/reset` - Reset task
- `POST /api/tasks/:id/reset-to-group` - Reset and return to group
- `POST /api/tasks/:id/move-to-group` - Move task to group
- `POST /api/tasks/:id/repair-state` - Smart repair
- And more...

### Sessions
- `GET /api/sessions/:id` - Get session
- `GET /api/sessions/:id/messages` - Get session messages
- `GET /api/sessions/:id/timeline` - Get timeline
- `GET /api/sessions/:id/usage` - Get usage stats
- `GET /api/sessions/:id/stream` - SSE stream
- `POST /api/pi/sessions/:id/events` - Post session events

### Task Groups
- `GET /api/task-groups` - List groups
- `POST /api/task-groups` - Create group
- `GET /api/task-groups/:id` - Get group with tasks
- `PATCH /api/task-groups/:id` - Update group
- `DELETE /api/task-groups/:id` - Delete group
- `POST /api/task-groups/:id/tasks` - Add tasks to group
- `DELETE /api/task-groups/:id/tasks` - Remove tasks from group
- `POST /api/task-groups/:id/start` - Start group execution

### Planning
- `GET /api/planning/sessions` - List planning sessions
- `POST /api/planning/sessions` - Create planning session
- `POST /api/planning/sessions/:id/messages` - Send message
- `POST /api/planning/sessions/:id/close` - Close session
- And more...

### Workflow
- `GET /api/workflow/status` - Get workflow status
- `POST /api/workflow/start` - Start workflow
- `POST /api/workflow/start-single` - Start single task
- `POST /api/workflow/stop` - Stop workflow
- `POST /api/workflow/pause` - Pause workflow
- `POST /api/workflow/resume` - Resume workflow

### Real-time
- `GET /ws` - WebSocket/SSE endpoint for real-time updates

## Architecture

```
src/
├── main.rs           # Entry point
├── cors.rs           # CORS fairing
├── error.rs          # Error handling
├── models.rs         # Data models (types, enums, structs)
├── state.rs          # Application state
├── db/
│   ├── mod.rs        # Database setup and migrations
│   ├── models.rs     # Database model re-exports
│   └── queries.rs    # SQL queries
├── routes/
│   ├── mod.rs        # Route aggregation
│   ├── tasks.rs      # Task endpoints
│   ├── sessions.rs   # Session endpoints
│   ├── task_groups.rs # Task group endpoints
│   ├── planning.rs   # Planning endpoints
│   ├── workflow.rs   # Workflow endpoints
│   ├── options.rs    # Settings endpoints
│   ├── runs.rs       # Run management
│   ├── stats.rs      # Statistics
│   ├── prompts.rs    # Prompt templates
│   └── sse.rs        # SSE endpoints
└── sse/
    ├── mod.rs        # SSE module
    └── hub.rs        # Broadcast hub
```

## Database Compatibility

The Rust server uses the **exact same SQLite schema** as the TypeScript version. You can:

- Use an existing `.tauroboros/tasks.db` file
- Switch between TypeScript and Rust backends without data migration
- Share databases between different TaurOboros instances

## Differences from TypeScript Version

### Bubblewrap Sandbox Isolation
- All non-planning agent sessions sandboxed via bubblewrap by default
- Planning sessions (chat, plan, plan-revision) are exempt
- Global on/off toggle via Options UI
- Per-task extra filesystem grants supported
- Explicit failure if `bwrap` is unavailable (no silent fallback)
- See [`docs/bubblewrap-isolation.md`](../docs/bubblewrap-isolation.md) for details

### Not Implemented (Container Support)
- Container image management
- Dockerfile building
- Podman/Docker integration
- Container profiles

### Implementation Notes
- Real-time updates use SSE instead of WebSocket (frontend-compatible)
- Same JSON request/response formats
- Same error codes and HTTP status codes
- Same Unix timestamp format for dates

## Development

### Run Tests

```bash
cargo test
```

### Check Code

```bash
cargo clippy
cargo fmt
```

### Build for Release

```bash
cargo build --release
```

The compiled binary will be at `target/release/tauroboros-server`.

## Single-Binary Build

The Rust backend can package the Solid frontend into the same distributable binary.

```bash
# From tauroboros-rust/
cargo build --release --features embedded-frontend
```

This build mode will:
1. Run `bun run build` in `../src/kanban-solid`
2. Embed the generated frontend assets into the Rust binary
3. Serve the UI from `/` and `/assets/*` directly from the Rust process

For normal development builds without embedded assets, the Rust server will serve files from `../src/kanban-solid/dist` if they already exist.

## Migration from TypeScript Backend

1. Stop the TypeScript/Bun server
2. Ensure `.tauroboros/tasks.db` exists
3. Start the Rust server with the same port
4. The frontend should work without any changes

## License

Same as the original TaurOboros project.
