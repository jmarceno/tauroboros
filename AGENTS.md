This is a TypeScript project using **Bun** for the backend runtime and Vue for frontend.

The "Pi Easy Workflow" project is an AI-powered workflow orchestration system that:
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

Server starts on port 3789 by default. Open http://localhost:3789

### Dynamic Port Configuration

The server supports dynamic port assignment for running multiple instances simultaneously:

**Settings file** (`.pi/settings.json`):
```json
{
  "workflow": {
    "server": {
      "port": 0,  // 0 = auto-assign available port
      "dbPath": ".pi/easy-workflow/tasks.db"
    }
  }
}
```

**Environment variables**:
- `SERVER_PORT` - Override the port from settings (0 for auto-assign)
- `DEV_PORT` - Vite dev server port (default: 5173)

**Running multiple instances**:
```bash
# Terminal 1 - Default port
bun run start

# Terminal 2 - Different port
SERVER_PORT=3790 bun run start

# Terminal 3 - Auto-assign any available port
SERVER_PORT=0 bun run start
# Server will log the actual port: "server started on http://0.0.0.0:xxxxx"
```

**Vite dev mode with dynamic backend port**:
```bash
# Backend on auto-assigned port, Vite dev server will proxy to it
SERVER_PORT=0 bun run dev
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

### Key Features
- 5 kanban columns (template, backlog, executing, review, done)
- Task cards with badges and inline actions
- Drag and drop reordering (backlog only)
- 8 modals: Task, Options, Execution Graph, Approve, Revision, Start Single, Session Viewer, Best-of-N Details
- Keyboard shortcuts: T (template), B (backlog), S (start), D (archive done), Escape (close)
- WebSocket live updates with auto-reconnect
- Mobile responsive design

### Build Commands

**Backend (Bun):**
```bash
# Development with auto-reload
bun run dev

# Production build (backend + kanban)
bun run build

# Start production server
bun run start
```

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
```

### CSS
When dealing with CSS changes, always get the computed CSS with playwright and never trust visual identification.
