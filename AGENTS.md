This is a TypeScript project using **Bun** for the backend runtime and Vue for frontend.

The "TaurOboros" project is an AI-powered workflow orchestration system that:
- Uses Pi AI agents via RPC protocol for task execution
- Features a kanban-style task board (template, backlog, executing, review, done)
- Implements advanced AI execution modes (Plan Mode, Review Loops, Best-of-N)
- Provides isolation through Git Worktree and optional container isolation
- Offers real-time updates, session logging, and execution graph visualization
- Combines Bun backend with Vue 3 + Tailwind CSS kanban frontend

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

Server auto-assigns an available port on first start. The assigned port is saved to `.pi/settings.json` and reused for subsequent runs.

### Port Configuration

The server uses **dynamic port assignment by default** (port 0), which allows running multiple projects simultaneously without port conflicts.

**How it works:**
1. First start: Server auto-assigns an available port (e.g., 49234)
2. Port is saved to `.pi/settings.json` for persistence
3. Subsequent starts: Uses the saved port from settings

**Settings file** (`.pi/settings.json`):
```json
{
  "workflow": {
    "server": {
      "port": 49234,
      "dbPath": ".pi/tauroboros/tasks.db"
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

The kanban UI has been migrated from vanilla JS/Alpine.js/Shoelace to Vue 3 + Tailwind CSS + Vite.

### Location
- **Vue kanban source**: `src/kanban-vue/`
- **Build output**: `src/kanban-vue/dist/`

### Tech Stack
- **Framework**: Vue 3 with Composition API
- **Styling**: Tailwind CSS (custom dark theme with slate/indigo colors)
- **Build Tool**: Vite
- **Package Manager**: npm (for kanban-vue subdirectory)
- **Search**: Fuse.js for fuzzy model search
- **UI Components**: Custom components (no heavy UI library)
- **State Management**: Vue composables with provide/inject pattern

**Kanban Frontend (handled automatically by root scripts):**
```bash
# The root scripts handle kanban building internally using npm
bun run kanban:dev      # Dev mode with hot reload
bun run kanban:build    # Production build
```

Note: The kanban frontend has its own package.json in `src/kanban-vue/` and uses npm. The root Bun scripts automatically handle this for you.

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

### Compile Scripts

**`scripts/compile.ts`** - Main compilation orchestrator:
- Builds kanban-vue frontend (if needed)
- Runs `scripts/generate-embedded-assets.ts` to inline static files
- Executes `bun build --compile` to create the binary
- Outputs to `./tauroboros` (~66 MB ELF executable)

**`scripts/generate-embedded-assets.ts`** - Asset embedding:
- Scans `src/kanban-vue/dist/` recursively
- Generates `src/server/generated-assets.ts` with all files inlined as strings/base64
- Supports both text files (JS, CSS, HTML) and binary files (fonts, images)
- Creates a Map-based lookup system for runtime asset access

**`scripts/test-binary.ts`** - Validation suite:
- Tests binary existence and executable permissions
- Verifies server starts and health endpoint responds
- Validates static assets are served correctly
- Checks API endpoints work
- Tests custom port via SERVER_PORT environment variable

### Embedded Asset Architecture

**`src/server/embedded-files.ts`** - Dual-mode file serving:
- Detects presence of `generated-assets.ts` (only exists during/after compilation)
- Uses embedded assets when available (compiled binary mode)
- Falls back to filesystem access when not available (development mode)
- `extractAssetKey()` function normalizes paths: `/path/to/kanban-vue/dist/assets/file.js` → `/assets/file.js`
- Supports both text and binary content with proper encoding

**`src/server/server.ts`** - Updated static file handlers:
- `GET /` route uses `getIndexHtml()` for embedded/fallback index.html
- `GET /assets/:file` uses async `readEmbeddedFile()` with embedded/fallback
- All routes properly await async file operations

### Generated Assets Module

The generated file (`src/server/generated-assets.ts`) contains:
```typescript
export const embeddedAssets = new Map([
  ["/assets/index-CnuU_D5s.js", { contentType: "...", isText: true, data: "..." }],
  ["/index.html", { contentType: "text/html", isText: true, data: "..." }],
  // ... 60+ files
])
```

- Total embedded size: ~4.5 MB (compressed JS/CSS)
- Keys use `/assets/` prefix for assets, `/index.html` for main page
- Binary files (woff2, png) are base64 encoded
- Text files are escaped for template literal safety

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

### Maintenance Notes

When modifying kanban-vue:
1. Always run `bun run kanban:build` before compiling
2. The compile script auto-builds if `dist/` is missing/outdated
3. Embedded assets are regenerated fresh on every compile
4. `generated-assets.ts` is set to a placeholder after compilation (keeps imports valid)

When modifying server static file handling:
- Use `embeddedFileExists()`, `readEmbeddedFile()`, `readEmbeddedText()` from `embedded-files.ts`
- These functions handle both development and compiled modes automatically
- Never use direct `readFileSync` for static assets (breaks compiled binary)

# How you must behave
## CSS
  When dealing with CSS changes, always get the computed CSS with playwright and never trust visual identification.
## Storage
  This project always prioritize storing data on the database, loose json files are rare exceptions that MUST have manual user approval.

## Test and Errors
  Errors must be fixed, even if your changes did not cause them, you must fix any errors you find.

## Fallbacks
  NEVER add fallbacks, all conditions and cases must be explicitly.
  If a condition or case is not explicit, it must not exist and it must just throw an error.

## Pre-existing errors
  You must always fix errors you find, it does not matter if were introduced by your changes or not. We are a team and we work on all the issues together.