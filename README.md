# Pi Easy Workflow

Pi Easy Workflow is an AI-powered workflow orchestration system that helps you manage and execute complex software development tasks using AI agents. It combines a kanban-style task board with sophisticated execution strategies to deliver high-quality, automated code generation and modification.


## Features

### Task Management
- **Kanban Board** – Visual task management with columns for templates, backlog, executing, review, done, and failed states
- **Task Dependencies** – Define requirements between tasks to ensure proper execution order
- **Drag-and-Drop Reordering** – Prioritize tasks with simple reordering
- **Archiving** – Clean up completed work while preserving history

### AI Execution Modes
- **Standard Execution** – Direct AI agent execution with full access to tools and file system
- **Plan Mode** – AI creates an implementation plan that you can review and approve before execution
- **Review Loops** – Automatic code review with iterative fixes until quality criteria are met
- **Best-of-N Strategy** – Run multiple AI workers in parallel, have reviewers evaluate results, and automatically select or synthesize the best implementation

### Quality Assurance
- **Automated Reviews** – AI-powered code review that checks for bugs, security issues, and completeness
- **Configurable Review Cycles** – Set how many review iterations each task should undergo
- **Smart Repair** – Automatic detection and recovery from failed or stuck task states

### Isolation & Security
- **Git Worktree Isolation** – Each task runs in its own git worktree for clean separation
- **Container Isolation (Optional)** – Run AI agents inside Podman containers for filesystem and port isolation
- **Automatic Cleanup** – Worktrees and resources are cleaned up after task completion

### Monitoring & Observability
- **Real-time WebSocket Updates** – Live task status updates in the kanban UI
- **Session Logging** – Full capture of all AI interactions with token usage and cost tracking
- **Execution Graph Visualization** – See task dependencies and parallelization opportunities
- **Telegram Notifications** – Get notified when tasks complete or fail

### Integration
- **Pi RPC Integration** – Works with Pi AI agents via RPC protocol
- **Model Discovery** – Automatic detection of available AI models
- **Branch Management** – Flexible git branch selection per task or globally
- **Auto-commit** – Optional automatic commit and merge of changes

## Screenshots

![Kanban Board Overview](images/screenhot1.png)

![Task Details and Execution](images/screenhot2.png)

## Quick Start

### Prerequisites
- [Bun](https://bun.sh/) runtime
- Git repository (project must be in a git repo)
- Pi AI agent binary (for AI execution)

### Installation

```bash
# Clone or navigate to your project
cd your-project

# Install dependencies
bun install

# Setup skills and verify installation
bun run setup
```

### Start the Server

```bash
# Start the kanban server
bun run src/index.ts
```

The server will start on port `3000` by default (or the port specified in `PI_EASY_WORKFLOW_PORT` environment variable). Open `http://localhost:3000` in your browser.

### Basic Usage

1. **Create a Task** – Click "New Task" in the kanban board
2. **Configure Options** – Set execution model, branch, and enable/disable features like plan mode, review, auto-commit
3. **Add to Backlog** – Task appears in the backlog column
4. **Start Execution** – Click the play button or "Start All" to execute all backlog tasks
5. **Monitor Progress** – Watch real-time updates as the AI works through your tasks

### Container Isolation (Optional)

For enhanced security and isolation, run AI agents inside Podman containers:

```bash
# 1. Install prerequisites (Podman required)
./scripts/setup-e2e-tests.sh

# 2. Verify setup
bun run container:verify

# 3. Enable container mode
cp env.example .env
# Edit .env and set: PI_EASY_WORKFLOW_RUNTIME=container

# 4. Run as normal - agents now run in isolated containers
bun run src/index.ts
```

## Available Commands

```bash
# Start server
bun run start

# Development mode with auto-reload
bun run dev

# Run tests
bun test

# Run tests with coverage
bun test --coverage

# Run E2E container tests (requires Podman)
bun run test:e2e

# Sync project-local skills to .pi/skills
bun run skills:install

# Verify local Pi setup files
bun run skills:verify

# Container setup and verification
bun run container:setup      # Install Podman and build image
bun run container:verify     # Check container runtime setup
bun run container:build      # Build pi-agent container image
bun run container:cleanup    # Remove container configuration
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_EASY_WORKFLOW_PORT` | HTTP server port | `3000` |
| `PI_EASY_WORKFLOW_DB_PATH` | SQLite database path | `.pi/easy-workflow/db.sqlite` |
| `PI_EASY_WORKFLOW_RUNTIME` | Runtime mode: `native` or `container` | `native` |
| `PI_EASY_WORKFLOW_CONTAINER_IMAGE` | Container image for agents | `pi-agent:alpine` |
| `PI_EASY_WORKFLOW_CONTAINER_MEMORY_MB` | Memory limit per container | `512` |
| `PI_EASY_WORKFLOW_CONTAINER_CPU_COUNT` | CPU limit per container | `1` |

### Task Configuration

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

### Database Schema
The system uses SQLite with tables for:
- `tasks` – Task definitions and state
- `workflow_runs` – Execution run tracking
- `task_runs` – Individual task execution instances (for Best-of-N)
- `task_candidates` – Candidate implementations from workers
- `workflow_sessions` – AI session metadata
- `session_messages` – Structured message logs
- `session_io` – Raw I/O capture
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
- WebSocket at `/ws` for real-time updates

### Project Structure

```
src/
├── index.ts              # Entry point
├── server.ts             # HTTP server setup
├── orchestrator.ts       # Workflow execution orchestration
├── db.ts                 # Database layer
├── types.ts              # TypeScript type definitions
├── execution-plan.ts     # Dependency resolution
├── task-state.ts         # Task state machine
├── kanban/               # Web UI (single HTML file)
├── server/               # HTTP server implementation
│   ├── router.ts         # URL routing
│   ├── server.ts         # Route handlers
│   ├── websocket.ts      # WebSocket hub
│   └── types.ts          # Server types
├── runtime/              # Execution runtime
│   ├── session-manager.ts
│   ├── pi-process.ts
│   ├── container-manager.ts
│   ├── worktree.ts
│   ├── best-of-n.ts      # Best-of-N strategy
│   └── review-session.ts
├── prompts/              # Prompt templates
├── db/                   # Database migrations and types
└── recovery/             # Startup recovery logic
```
