# Pi Easy Workflow (MVP)

Pi-based Easy Workflow runtime and kanban server, migrated from the OpenCode execution model.

This project is intentionally isolated under `pi-easy-workflow/` and does not replace the legacy implementation in-place.

## Quick start

```bash
bun install
bun run setup
bun run src/index.ts
```

The server starts on `PI_EASY_WORKFLOW_PORT` when set, or an automatic/default port otherwise.

## Quick start with container isolation (optional)

Run Pi agents inside Podman containers for filesystem and port isolation:

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

**Benefits:**
- Filesystem isolation: Agents can only access their worktree
- Port isolation: Multiple agents can use port 3000 simultaneously
- Security: Container sandboxing without special kernel requirements
- Fast startup: Standard containers start quickly
- Daemonless: Podman doesn't require a running daemon

**Requirements:** Podman is required for container mode. If setup fails, use native mode instead:
```bash
PI_EASY_WORKFLOW_RUNTIME=native  # Fallback if containers unavailable
```

See [docs/container-isolation.md](docs/container-isolation.md) for full documentation.

## Main commands

```bash
# Start server
bun run start

# Dev mode
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

## Environment variables

### Core
- `PI_EASY_WORKFLOW_PORT` - HTTP server port (`0` allowed for random free port)
- `PI_EASY_WORKFLOW_DB_PATH` - Override SQLite DB path
- `PI_EASY_WORKFLOW_PI_BIN` - Override Pi binary path (used heavily by tests/mocks)
- `PI_EASY_WORKFLOW_PI_ARGS` - Override Pi runtime args (default is `--rpc --no-extensions`)

### Container isolation (Podman)
- `PI_EASY_WORKFLOW_RUNTIME` - Runtime mode: `native` (default) or `container`
- `PI_EASY_WORKFLOW_CONTAINER_IMAGE` - Container image for agents (default: `pi-agent:alpine`)
- `PI_EASY_WORKFLOW_CONTAINER_MEMORY_MB` - Memory limit per container (default: `512`)
- `PI_EASY_WORKFLOW_CONTAINER_CPU_COUNT` - CPU limit per container (default: `1`)
- `PI_EASY_WORKFLOW_PORT_RANGE_START` - Host port allocation start (default: `30000`)
- `PI_EASY_WORKFLOW_PORT_RANGE_END` - Host port allocation end (default: `40000`)

## Runtime model (MVP)

- One Pi RPC process per workflow-owned session
- Full raw capture to DB (`session_io`) for stdin/stdout/stderr/lifecycle/snapshots/prompts
- Normalized projection in `session_messages`
- Prompt templates are DB-backed (`prompt_templates`)
- Skills are file-based and synced into `.pi/skills/`

## Verification and migration status

- MVP verification report: `./MVP_VERIFICATION.md`
- Explicit known gaps and next steps: `./MVP_GAPS.md`
