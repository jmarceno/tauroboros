This is a TypeScript project using **Bun** for the backend runtime.

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
