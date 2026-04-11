This is a typescript project using Bun.

## Kanban UI Architecture

The kanban UI has been migrated from vanilla JS/Alpine.js/Shoelace to Vue 3 + Tailwind CSS + Vite.

### Location
- **New Vue kanban**: `src/kanban-vue/`
- **Build output**: `src/kanban-vue/dist/`
- **Old kanban**: Removed (was `src/kanban/index.html`)

### Tech Stack
- **Framework**: Vue 3 with Composition API
- **Styling**: Tailwind CSS (custom dark theme with slate/indigo colors)
- **Build Tool**: Vite
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
```bash
# Development
npm run kanban:dev

# Production build
npm run kanban:build

# Build everything (backend + kanban)
npm run build
```

### Tauri Ready
The Vue app is designed to work both in browser and as Tauri desktop app with zero code changes. Future Tauri integration will use a Rust sidecar to auto-start the Bun backend on localhost:3000.
