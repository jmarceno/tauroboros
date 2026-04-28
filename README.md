# TaurOboros

TaurOboros is an agent orchestration system, that uses a Kanban style board to visualize, organize and manage tasks that can them be delegate to agents.

[Features](#features) • [Screenshots](#screenshots) • [Quick Start](#quick-start) • [Commands](#available-commands) • [Configuration](#configuration) • [Architecture](#technical-architecture)

![Kanban Board Overview](images/screenhot1.png)

> [!NOTE]
> If you use OpenCode and don't want to change, you can try [opencode-easy-workflow](https://github.com/jmarceno/opencode-easy-workflow), altough if does not support all features of TaurOboros, it is still the same tool at its core.

## Features

### Task Management
- **Kanban Board** – Visual task management with columns for templates, backlog, executing, review, done, and failed states
- **Task Dependencies** – Define requirements between tasks to ensure proper execution order

### AI Execution Modes
- **Plannin Chat** – Discuss with to AI create an implementation plan that you can them ask the AI to transform in boards tasks for execution.
- **Standard Execution** – Direct AI agent execution with full access to tools and file system
- **Best-of-N Strategy** – Run multiple AI workers in parallel, have reviewers evaluate results, and automatically select or synthesize the best implementation

### Quality Assurance
- **Automated Reviews** – AI-powered code review that checks for bugs, security issues, and completeness
- **Code Style Review** – Describe the code style you want to enforced in the code, an agent validades and apply those rules after Review phase is done.
- **Smart Repair** – Automatic detection and recovery from failed or stuck task states
- **Self Healing** – When in Dev mode, Tauroboros use an AI agent to diagnostics task failures, analyzes root causes, and proposes permanent source-code fixes

### Isolation & Security
- **Git Worktree Isolation** – Each task runs in its own git worktree for clean separation
- **Bubblewrap Sandbox** – All non-planning agent sessions run inside a bubblewrap sandbox with full repository access, read-only access to `~/.pi`, and read-write access to `/tmp` (default: on, can be disabled globally)
- **Automatic Cleanup** – Worktrees and resources are cleaned up after successful task completion

### Monitoring & Observability
- **Execution Graph Visualization** – See task dependencies and parallelization opportunities
- **Session Logging** – Full capture of all AI interactions with token usage and cost tracking
- **Telegram Notifications** – Get notified when tasks complete or fail

## Quick Start

### Prerequisites
- [Rust](https://rustup.rs/) toolchain (stable, for backend compilation)
- [npm](https://nodejs.org/) (for building the Solid JS frontend)
- Git repository (project must be in a git repo)
- Pi AI agent binary (for AI execution)

### Installation

#### Option 1 - Download Binary from release
Download the Rust-compiled binary from the releases page and run it from inside your project directory. (It must be a initialized Git repo for workflows to be able to start)

```bash
./path/to/tauroboros
```

#### Option 2 - Clone, Build from source

```bash
# Clone the repo
git clone https://github.com/jmarceno/tauroboros.git

# Build frontend
cd src/frontend && npm ci && npm run build && cd ../..

# Build Rust backend with embedded frontend
cd src/backend && cargo build --release --features embedded-frontend

# The binary is at src/backend/target/release/tauroboros
```
## Running

### Running the Binary

With the TaurOboros on your path, just `cd` into your project directory and run it `./tauroboros`, it will print the port you need to access.

If you prefer just copy the binary to the project directory and execute directly from there.

### Running the Dev server from project repo

```bash
# Recommended: starts both Rust backend and Solid frontend with hot reload
./start-rust-dev.sh

# Or with explicit port
SERVER_PORT=3789 ./start-rust-dev.sh
```

The server will start on port `3789` by default (configurable in `.tauroboros/settings.json`). Open `http://localhost:5173` in your browser (Vite dev server proxies API requests to the Rust backend).

**Note:** The kanban frontend (Solid JS app in `src/frontend/`) has its own `package.json` and uses npm. The `start-rust-dev.sh` script automatically handles building and running both the Rust backend and the Solid frontend dev server.

### How to Build for Production (Standalone Distribution)

You can build the entire application into a single embedded binary:

```bash
# Build frontend
cd src/frontend && npm ci && npm run build && cd ../..

# Build Rust backend with embedded frontend
cd src/backend && cargo build --release --features embedded-frontend

# The binary is at src/backend/target/release/tauroboros
./src/backend/target/release/tauroboros

# Run on a custom port
SERVER_PORT=3790 ./src/backend/target/release/tauroboros
```

### Basic Usage

1. **Create a Task** – Click "New Task" in the kanban board
2. **Configure Options** – Set execution model, branch, and enable/disable features like plan mode, review, auto-commit
3. **Add to Backlog** – Task appears in the backlog column
4. **Start Execution** – Click the play button or "Start All" to execute all backlog tasks
5. **Monitor Progress** – Watch real-time updates as the AI works through your tasks

### Container Isolation (Default)

For enhanced security and isolation, run AI agents inside Podman containers:

```bash
# 1. Install prerequisites (Podman required)
./scripts/setup-e2e-tests.sh

# 2. Verify setup
./scripts/setup-e2e-tests.sh  # also builds the pi-agent image

# 3. Enable container mode by editing .tauroboros/settings.json:
# Set workflow.container.enabled to true

# 4. Run as normal - agents now run in isolated containers
./start-rust-dev.sh  # or run the compiled binary directly
```

This process will be done automatically to you if you have Podman installed the first time you run Tauroboros in project directory.

#### Docker Compose Support

To run `docker-compose` inside task containers (e.g., for databases), enable podman socket mounting:

```bash
# 1. Enable podman socket on host
systemctl --user enable podman.socket
systemctl --user start podman.socket

# 2. Add to .tauroboros/settings.json:
# "workflow.container.mountPodmanSocket": true

# 3. Now docker-compose works inside task containers
```

**Note:** This reduces container isolation—task containers can see/start any host container.

## Available Commands

The Rust backend is built with **Cargo** and the Solid JS frontend uses **npm**:

```bash
# Development mode (Rust backend + Solid frontend with hot reload)
./start-rust-dev.sh

# Development mode with explicit port
SERVER_PORT=3789 ./start-rust-dev.sh

# Build production binary with embedded frontend
cd src/backend && cargo build --release --features embedded-frontend

# Run the compiled binary
./src/backend/target/release/tauroboros

# Run unit tests (Rust)
cd src/backend && cargo test

# Build frontend only (for dev without embedded-frontend)
cd src/frontend && npm run build

# Run frontend dev server separately (proxy to Rust backend on port 3789)
cd src/frontend && npm run dev

# Skills management (requires Bun for scripts)
bun run skills:install    # Sync skills to .pi/skills
bun run skills:verify     # Verify Pi setup
bun run setup             # Install + verify

# Container setup (optional Podman isolation)
./scripts/setup-e2e-tests.sh      # Install Podman and build image
bun run container:build           # Build pi-agent container image
```

## Configuration

All infrastructure-level configuration is stored in `.tauroboros/settings.json`. The Rust backend loads this file at startup, falling back to sensible defaults if it doesn't exist.

### Settings.json Structure

```json
{
  "skills": {
    "localPath": "./skills",
    "autoLoad": true,
    "allowGlobal": false
  },
  "project": {
    "name": "your-project-name",
    "type": "workflow"
  },
  "workflow": {
    "server": {
      "port": 3789,
      "dbPath": ".tauroboros/tasks.db"
    },
    "container": {
      "enabled": true,
      "piBin": "pi",
      "piArgs": "--mode rpc",
      "image": "pi-agent:alpine",
      "imageSource": "dockerfile",
      "dockerfilePath": "docker/pi-agent/Dockerfile",
      "registryUrl": null,
      "autoPrepare": true,
      "memoryMb": 512,
      "cpuCount": 1,
      "portRangeStart": 30000,
      "portRangeEnd": 40000
    }
  }
}
```

### Configuration Sections

| Section | Description |
|---------|-------------|
| `workflow.server.port` | HTTP server port (default: 3789) |
| `workflow.server.dbPath` | SQLite database path relative to project root |
| `workflow.container.enabled` | Enable container isolation |
| `workflow.container.piBin` | Path to Pi binary (default: "pi") |
| `workflow.container.piArgs` | Additional arguments for Pi CLI |
| `workflow.container.image` | Container image for agents |
| `workflow.container.memoryMb` | Memory limit per container |
| `workflow.container.cpuCount` | CPU limit per container |
| `workflow.container.portRangeStart` | Host port allocation range start |
| `workflow.container.portRangeEnd` | Host port allocation range end |
| `workflow.container.mountPodmanSocket` | Mount podman socket for docker-compose support |

### Task-Level Configuration

Task execution settings (models, prompts, review settings, etc.) are stored in the database and can be configured via the web UI or API at `/api/options`. These include:
- **Models** – Plan, execution, review, and repair models
- **Telegram Notifications** – Bot token, chat ID, and enable/disable
- **Execution Settings** – Max reviews, parallel tasks, thinking level
- **Prompts** – Commit prompt template, extra prompt

Each task can also be individually configured with:

Each task can be configured with:
- **Plan Mode** – AI creates a plan before implementation
- **Auto-approve Plan** – Skip manual plan approval
- **Review** – Enable automated code review
- **Auto-commit** – Automatically commit changes after completion
- **Delete Worktree** – Clean up worktree after task completes
- **Thinking Level** – Control AI reasoning depth: `low`, `medium`, `high`
- **Execution Strategy** – `standard` or `best_of_n`

---

## Technical Architecture

### Runtime Model
- One Pi RPC process per workflow-owned session
- Full raw capture to database (`session_io`) for stdin/stdout/stderr/lifecycle/snapshots/prompts
- Normalized projection in `session_messages` for structured querying
- Prompt templates are database-backed (`prompt_templates`)
- Skills are file-based and synced into `.pi/skills/`

### Architecture Pattern
The application uses a **Rust-first** architecture:

- **Rocket Web Framework**: All HTTP serving uses Rocket's typed request handlers and managed state
- **ApiResult Pattern**: All handlers return `ApiResult<T> = Result<T, ApiError>` with explicit error variants
- **Typed Errors**: Domain errors use the `ApiError` enum with `thiserror` derive, ensuring every failure path is explicit
- **Managed State**: Shared application state (`AppState`) is passed via Rocket's `State` managed state
- **Structured Logging**: All logging uses the `tracing` crate with env-filter support
- **SSE Real-time Updates**: Server-Sent Events via a broadcast hub (`SseHub`) for real-time UI updates

**Runtime Boundaries**: Rocket manages the async runtime via tokio:
- Backend entrypoint (`src/backend/src/main.rs`)
- Rocket route handlers (`src/backend/src/routes/`)
- Orchestrator services (`src/backend/src/orchestrator/`)
- Test harness

### Database Schema
The system uses SQLite with tables for:
- `tasks` – Task definitions and state
- `workflow_runs` – Execution run tracking
- `task_runs` – Individual task execution instances (for Best-of-N)
- `task_candidates` – Candidate implementations from workers
- `pi_workflow_sessions` – AI session metadata
- `session_messages` – Structured message logs
- `options` – Global configuration
- `prompt_templates` – Database-backed prompt templates

### API Endpoints

The server exposes a comprehensive REST API:
- `GET/POST/PUT/DELETE /api/tasks` – Task CRUD operations
- `GET/PUT /api/options` – Global configuration
- `GET /api/branches` – Git branch listing
- `GET /api/models` – Available AI models
- `POST /api/start` – Start workflow execution
- `POST /api/stop` – Stop execution
- `GET /api/execution-graph` – Dependency visualization
- `GET /api/sessions/:id/messages` – Session message logs
- `GET /sse` – Server-Sent Events for real-time updates

### Project Structure

```
src/
├── backend/              # Rust backend (PRIMARY - Rocket + SQLite)
│   ├── Cargo.toml
│   ├── build.rs          # Builds frontend when embedded-frontend feature is on
│   ├── src/
│   │   ├── main.rs       # Entry point - Rocket server setup
│   │   ├── error.rs      # ApiError enum + ApiResult<T> type
│   │   ├── models.rs     # Data models (Task, TaskRun, etc.)
│   │   ├── state.rs      # AppState shared via Rocket managed state
│   │   ├── settings.rs   # Settings loading from .tauroboros/settings.json
│   │   ├── cors.rs       # CORS fairing
│   │   ├── audit.rs      # Audit logging
│   │   ├── embedded_resources.rs # Embeds skills/extensions via include_dir
│   │   ├── db/           # Pool creation, migrations, schema
│   │   ├── routes/       # HTTP route handlers
│   │   └── orchestrator/ # Workflow orchestration (Pi RPC, git worktree)
│   └── sse/              # SSE broadcast hub for real-time updates
├── backend-ts/           # DEPRECATED - TypeScript/Bun backend
└── frontend/             # Solid JS frontend (Vite + Tailwind)
    ├── package.json      # Frontend dependencies (npm)
    ├── vite.config.ts    # Proxies /api and /sse to Rust backend
    └── src/
        ├── index.tsx
        ├── App.tsx
        ├── api/          # REST API client
        ├── stores/       # State management
        └── components/   # Kanban board, chat, modals, etc.
```

# Acknowledgements

- [cline](https://github.com/cline/cline "Cline") for Inspiring me. Pay them a visit and test their solution Kanban solution too.
- [coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent "pi") for being a pretty cool and flexible piece of software to build around.