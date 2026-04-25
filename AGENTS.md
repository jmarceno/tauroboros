This is a TypeScript project using **Bun** for the backend runtime and Solid JS for frontend.

This codebase is pure Effect and everything must follow Effects best practices.

The "TaurOboros" project is an AI-powered workflow orchestration system that:
- Uses Pi AI agents via RPC protocol for task execution
- Features a kanban-style task board (template, backlog, executing, review, done)
- Implements advanced AI execution modes (Plan Mode, Review Loops, Best-of-N)
- Provides isolation through Git Worktree and optional container isolation
- Offers real-time updates, session logging, and execution graph visualization
- Combines Bun backend with Solid JS + Tailwind CSS kanban frontend

## Quick Start

```bash
# Install dependencies (Bun)
bun install

# Setup skills and verify
bun run setup

# Start the server (backend + kanban UI)
bun run start

# Or start in development mode with auto-reload
bun run dev
```

### Generated Files (DO NOT COMMIT)

Two files are auto-generated and in `.gitignore`:
- `src/server/generated-assets.ts` — embeds kanban UI, skills, config, and docker files
- `src/server/version.ts` — git commit hash and version info

They are regenerated automatically via `predev`/`pretest` hooks:
```bash
bun run dev        # predev regenerates both
bun test           # pretest regenerates both
bun run compile    # compile regenerates both explicitly
```

Never commit these files — they are always generated before the commands that need them.

Server auto-assigns an available port on first start. The assigned port is saved to `.tauroboros/settings.json` and reused for subsequent runs.

### Port Configuration

The server uses **dynamic port assignment by default** (port 0), which allows running multiple projects simultaneously without port conflicts.

**How it works:**
1. First start: Server auto-assigns an available port (e.g., 49234)
2. Port is saved to `.tauroboros/settings.json` for persistence
3. Subsequent starts: Uses the saved port from settings

**Settings file** (`.tauroboros/settings.json`):
```json
{
  "workflow": {
    "server": {
      "port": 49234,
      "dbPath": ".tauroboros/tasks.db"
    }
  }
}
```

**Environment variables**:
- `SERVER_PORT` - Override the port from settings (0 for auto-assign)
- `DEV_PORT` - Vite dev server port (default: 5173)

**Running multiple projects:**
```bash
# Terminal 1 - Project A (auto-assigns port 49234)
bun run start

# Terminal 2 - Project B (auto-assigns port 49235)
cd /path/to/project-b && bun run start

# Both projects run simultaneously on different ports!
```

**Development mode:**
```bash
# Dev mode requires explicit backend port (dynamic port not supported)
SERVER_PORT=3789 bun run dev
```

## Kanban UI Architecture

The kanban UI has been migrated from vanilla JS/Alpine.js/Shoelace to Solid JS + Tailwind CSS + Vite.


### Tech Stack
- **Framework**: Solid JS with Composition API
- **Styling**: Tailwind CSS (custom dark theme with slate/indigo colors)
- **Build Tool**: Vite
- **Package Manager**: npm (for kanban-Solid JS subdirectory)
- **Search**: Fuse.js for fuzzy model search
- **UI Components**: Custom components (no heavy UI library)


**Kanban Frontend (handled automatically by root scripts):**
```bash
# The root scripts handle kanban building internally using npm
bun run kanban:dev      # Dev mode with hot reload
bun run kanban:build    # Production build
```

### Testing
```bash
# Unit tests
bun test

# E2E tests (requires server running)
bun run test:e2e

# E2E with UI mode
bun run test:e2e:ui

# Compile binary validation
bun run compile:test      # Runs comprehensive tests on compiled binary
```


## Binary Compilation

The application can be compiled into a single executable binary using Bun's `--compile` feature.

### Usage

```bash
# Compile (generates binary + validates)
bun run compile

# Manual compilation steps
bun run scripts/compile.ts

# Just validate an existing binary
bun run scripts/test-binary.ts

# Run the binary
./tauroboros
SERVER_PORT=3790 ./tauroboros
```

### Install Script

One-command compile and install:

```bash
# Compile and install to ~/.local/bin (user-local, default)
./scripts/install.sh

# Compile and install to /usr/local/bin (system-wide, requires sudo)
./scripts/install.sh --global

# Skip compilation (install existing binary)
./scripts/install.sh --skip-compile

# Remove installed binary
./scripts/install.sh --remove

# Remove from global location
./scripts/install.sh --global --remove
```

The install script will:
1. Build the kanban-solid frontend (refreshing all assets)
2. Generate embedded assets
3. Compile the Bun binary
4. Install to the target directory

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
When migrating something to Effect, completely replace the old way, do not leave code paths or legacy support.

### Effect Architecture Reference

See `docs/EFFECT_ARCHITECTURE.md` for:
- Service definition patterns (`Context.GenericTag`)
- Error handling (`Schema.TaggedError`)
- Resource management (`Effect.acquireRelease`)
- Layer composition
- Logging patterns
- Migration examples

### Effect Migration Status

Current migration progress is tracked in:
- `plans/effect-full-migration-plan.md` - Full migration plan
- `scripts/verify-migration.ts` - Verification script

Run verification:
```bash
bun run scripts/verify-migration.ts
```
<!-- effect-solutions:end -->

# How you must behave
## CSS
  When dealing with CSS changes, always get the computed CSS with playwright and never trust visual identification.
## Storage
  This project always prioritize storing data on the database, loose json files are rare exceptions that MUST have manual user approval.

## Test and Errors
  Errors must be fixed, even if your changes did not cause them, you must fix any errors you find.

## Fallbacks
  NEVER add fallbacks, all conditions and cases must be explicitly.
  If a condition or case is not explicit, it must not exist and it must return an explicit Effect failure using Schema.TaggedError.

## Pre-existing errors
  You must always fix errors you find, it does not matter if were introduced by your changes or not. We are a team and we work on all the issues together.

## Effect
Always follow effect best practices