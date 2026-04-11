# Kanban UI

The kanban UI has been migrated to Vue 3 + Tailwind CSS + Vite.

## Architecture

- **Location**: `src/kanban-vue/`
- **Framework**: Vue 3 (Composition API)
- **Styling**: Tailwind CSS with custom dark theme
- **Build Tool**: Vite
- **State Management**: Vue composables with provide/inject
- **Search**: Fuse.js for model fuzzy search
- **WebSocket**: Native WebSocket with auto-reconnect

## Key Features

- 5 Kanban columns (template, backlog, executing, review, done)
- Task cards with color-coded run highlighting
- Drag and drop task reordering (backlog only)
- 8 modals:
  1. Task Modal (create, edit, view, deploy modes)
  2. Options Modal
  3. Execution Graph Modal
  4. Approve Modal
  5. Revision Modal
  6. Start Single Modal
  7. Session Modal (live session viewer with streaming)
  8. Best-of-N Detail Modal
- Keyboard shortcuts (T, B, S, D, Escape)
- Toast notifications
- Real-time WebSocket updates
- Best-of-N task configuration
- Model picker with Fuse.js fuzzy search
- Mobile responsive design

## Development

```bash
# Install dependencies and start dev server
npm run kanban:dev

# Build for production
npm run kanban:build
```

## Production

The built files are in `src/kanban-vue/dist/` and are served by the Bun backend server. The Vue kanban is the only UI - there is no fallback to any legacy system.

## Tauri Compatibility

The Vue app is designed to work both in the browser and as a Tauri desktop app with zero code changes. The Tauri integration (Phase 2) will add a Rust sidecar to auto-start the Bun backend on localhost:3000.
