# Kanban UI Migration Plan: Vanilla → Vue + Tailwind + Vite

## Executive Summary

**Objective:** Migrate `src/kanban/index.html` (~4000 lines) from vanilla JS/Alpine/Shoelace to Vue 3 + Tailwind CSS + Vite while maintaining exact feature parity and ensuring seamless Tauri/Electron integration.

**Complexity Strategy:** Minimal incremental changes. The existing Bun backend remains untouched. The new frontend will be a drop-in replacement that works both in browser (current mode) and as a Tauri/Electron desktop app (future mode).

**Status:** Planning phase - implementation pending approval

---

## 1. Architecture Strategy

### Current State
```
┌─────────────────────────────────────────┐
│  Browser                                │
│  ┌─────────────────────────────────┐    │
│  │  Single HTML file (vanilla JS)  │    │
│  │  - Alpine.js for model picker   │    │
│  │  - Shoelace CDN components      │    │
│  │  - Fuse.js for fuzzy search     │    │
│  └─────────────────────────────────┘    │
└─────────────────┬───────────────────────┘
                  │ HTTP / WebSocket
┌─────────────────┴───────────────────────┐
│  Bun Backend (unchanged)                │
│  - REST API                             │
│  - WebSocket broadcasting               │
│  - SQLite database                      │
└─────────────────────────────────────────┘
```

### Proposed State (Phase 1: Web)
```
┌─────────────────────────────────────────┐
│  Browser                                │
│  ┌─────────────────────────────────┐    │
│  │  Vue 3 SPA (Vite-built)         │    │
│  │  - Tailwind CSS for styling     │    │
│  │  - Radix Vue for components     │    │
│  │  - Fuse.js for fuzzy search     │    │
│  └─────────────────────────────────┘    │
└─────────────────┬───────────────────────┘
                  │ HTTP / WebSocket
┌─────────────────┴───────────────────────┐
│  Bun Backend (unchanged)                │
│  - Serves built static files            │
│  - Same REST API                        │
│  - Same WebSocket                       │
└─────────────────────────────────────────┘
```

### Future State (Phase 2: Tauri)
```
┌─────────────────────────────────────────────────────────┐
│  Tauri Desktop App                                      │
│  ┌─────────────────────────────────────────────────┐    │
│  │  WebView (Vue 3 SPA - same as Phase 1)         │    │
│  │  - No code changes from web version             │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────┬───────────────────────────────────────┘
                  │ Tauri HTTP API (transparent proxy)
┌─────────────────┴───────────────────────────────────────┐
│  Sidecar: Bun Backend (auto-started)                    │
│  - Same REST API                                        │
│  - Same WebSocket (via localhost bridge)                │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Tech Stack

### Core Framework: Vue 3 (Composition API)
- **Rationale:** Familiar reactivity patterns (similar to Alpine.js), full TypeScript support, component-based architecture
- **Bundle impact:** ~40KB gzipped (tree-shakeable)

### Styling: Tailwind CSS
- **Rationale:** Utility-first, purges unused styles, built-in dark mode, easy GitHub-like aesthetic
- **Configuration:** Custom color palette for modern dark theme
- **Note:** Not restricted to exact current colors - modern refresh acceptable

### UI Components: Radix Vue
- **Rationale:** Headless UI discontinued Vue support. Radix Vue is actively maintained, unstyled, accessible, Tauri-compatible
- **Alternative:** Reka UI (also excellent, consider if Radix Vue has gaps)
- **Components needed:** Dialog (modals), Listbox (selects), Checkbox, Tooltip, Tabs (best-of-n details), Collapsible

### Build Tool: Vite
- **Rationale:** Fast HMR, optimized production builds, first-class Tauri integration, Bun-compatible
- **Dev server:** Port 5173 (configurable)

### Search: Fuse.js
- **Rationale:** Already used in current implementation, keep same fuzzy search logic
- **Usage:** Model picker with fuzzy matching across model names and providers

---

## 3. Project Structure

```
pi-easy-workflow/
├── src/
│   ├── kanban/                    # NEW: Vue frontend
│   │   ├── index.html              # Entry HTML (replaces current)
│   │   ├── src/
│   │   │   ├── main.ts             # App entry
│   │   │   ├── App.vue             # Root component
│   │   │   ├── components/
│   │   │   │   ├── board/
│   │   │   │   │   ├── KanbanBoard.vue
│   │   │   │   │   ├── KanbanColumn.vue
│   │   │   │   │   └── TaskCard.vue
│   │   │   │   ├── modals/
│   │   │   │   │   ├── TaskModal.vue
│   │   │   │   │   ├── OptionsModal.vue
│   │   │   │   │   ├── ExecutionGraphModal.vue
│   │   │   │   │   ├── ApproveModal.vue
│   │   │   │   │   ├── RevisionModal.vue
│   │   │   │   │   ├── StartSingleModal.vue
│   │   │   │   │   ├── SessionModal.vue
│   │   │   │   │   └── BestOfNDetailModal.vue
│   │   │   │   ├── common/
│   │   │   │   │   ├── ModelPicker.vue       # Fuse.js fuzzy search
│   │   │   │   │   ├── Badge.vue
│   │   │   │   │   ├── Toast.vue
│   │   │   │   │   └── CollapsiblePanel.vue
│   │   │   │   └── runs/
│   │   │   │       ├── RunPanel.vue
│   │   │   │       └── RunItem.vue
│   │   │   ├── composables/        # Logic reuse
│   │   │   │   ├── useApi.ts       # HTTP client
│   │   │   │   ├── useWebSocket.ts # WS connection
│   │   │   │   ├── useModelSearch.ts # Fuse.js wrapper
│   │   │   │   ├── useTasks.ts     # Task state
│   │   │   │   ├── useRuns.ts      # Run state
│   │   │   │   ├── useOptions.ts   # Options state
│   │   │   │   ├── useSession.ts   # Session viewer
│   │   │   │   ├── useToasts.ts    # Toast notifications
│   │   │   │   ├── useKeyboard.ts  # Keyboard shortcuts
│   │   │   │   └── useDragDrop.ts  # HTML5 DnD
│   │   │   ├── stores/             # Pinia (only if needed)
│   │   │   │   └── kanban.ts
│   │   │   ├── types/              # TypeScript types
│   │   │   │   └── api.ts
│   │   │   ├── utils/
│   │   │   │   ├── formatters.ts
│   │   │   │   └── validators.ts
│   │   │   └── styles/
│   │   │       └── theme.css       # Modern dark theme
│   │   ├── vite.config.ts
│   │   └── tailwind.config.js
│   ├── server/server.ts            # MODIFIED: Serve built files
│   └── ... (rest unchanged)
├── tauri/                          # Phase 2: Tauri
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       └── main.rs
└── package.json                    # MODIFIED: Add scripts
```

---

## 4. Feature Mapping (Complete 1-to-1 Parity)

### 4.1 UI Components

| Current Feature | Current Implementation | Vue Implementation | Notes |
|----------------|------------------------|-------------------|-------|
| **Topbar** | HTML + CSS | `TopBar.vue` | Start button, title, shortcuts help |
| **Kanban Columns** | HTML + CSS | `KanbanBoard.vue` + `KanbanColumn.vue` | 5 columns: template, backlog, executing, review, done |
| **Task Cards** | JS-rendered DOM | `TaskCard.vue` | Props: task, runColor, dragEnabled |
| **Card Badges** | DOM elements | `Badge.vue` | plan, review, deps, stuck, best-of-n, template, workers, reviewers |
| **Inline Actions** | Conditional buttons | `TaskInlineActions.vue` | Approve, Request Changes, Send to Exec, Repair, Smart Repair, Mark Done, Continue Reviews |
| **Collapsible Output** | CSS + JS | `CollapsibleOutput.vue` | Agent output toggle with 5000 char limit |
| **Modals** | DOM overlay | Radix Vue `Dialog` | 8 modals total |
| **Model Search** | Alpine + datalist | `ModelPicker.vue` | Fuse.js + custom combobox dropdown |
| **Run Panel** | HTML details element | `RunPanel.vue` | Collapsible workflow runs panel |
| **Event Log** | Fixed panel | `LogPanel.vue` | Scrollable, clear button, position-aware toasts |
| **Toasts** | DOM injection | `ToastContainer.vue` | Animated notifications, auto-dismiss |
| **Tooltips** | sl-tooltip | Radix Vue `Tooltip` | Help buttons throughout |
| **Selects** | sl-select | Radix Vue `Select` or `Combobox` | Branch selection, model selection |
| **Checkboxes** | sl-checkbox | Radix Vue `Checkbox` | Form controls |
| **Tabs** | Custom HTML | Radix Vue `Tabs` | Best-of-n detail modal tabs |

### 4.2 State Management (Composables)

| Current Global Var | Composable | Responsibility |
|-------------------|-----------|----------------|
| `allTasks` | `useTasks.ts` | CRUD operations, sorting by status, drag reorder |
| `allRuns` | `useRuns.ts` | Run list, control actions (pause/resume/stop/archive) |
| `allOptions` | `useOptions.ts` | Settings, persistence, default values |
| `modelCatalog` | `useModelSearch.ts` | Fuse.js index building, suggestions, normalization |
| `activeSessionId` + `activeSessionMessages` | `useSession.ts` | Session viewer, live message streaming, aggregation |
| `eventLogs` | `useToasts.ts` | Toast notifications + log panel entries |
| `ws` | `useWebSocket.ts` | Connection, auto-reconnect, message routing |
| `bonWorkers` + `bonReviewers` | `useTaskModal.ts` | Best-of-N slot CRUD |
| `dragTaskId` | `useDragDrop.ts` | HTML5 drag and drop state |

### 4.3 Event Handling

| Current | Vue Implementation |
|---------|-------------------|
| `document.addEventListener('keydown')` | `useKeyboard.ts` composable with Escape-to-close-modals, T/B/S/D shortcuts |
| HTML5 DnD API | `useDragDrop.ts` + Vue `@dragstart/@drop/@dragover/@dragleave` |
| Native `WebSocket` | `useWebSocket.ts` with exponential backoff reconnect |
| `hashchange` for sessions | `watch(() => window.location.hash)` or window event listener |
| `mousedown` on modal overlay | Radix Vue Dialog built-in overlay click handling |
| `sl-change` events | Native `@change` with v-model |

---

## 5. Modern Dark Theme Strategy

### Approach
Replace exact GitHub Dark colors with a modern dark palette while maintaining the same **structure** (surface layers, borders, accents). Suggestion: modern slate/indigo palette.

### Proposed Color Palette (Tailwind)

```javascript
// tailwind.config.js
colors: {
  // Base dark theme (modern slate-based)
  dark: {
    bg: '#0f172a',           // slate-900 - main background
    surface: '#1e293b',     // slate-800 - cards, panels
    surface2: '#334155',    // slate-700 - hover states, inputs
    surface3: '#475569',    // slate-600 - borders, dividers
    border: '#475569',      // slate-600
    text: '#f1f5f9',        // slate-100 - primary text
    'text-muted': '#94a3b8', // slate-400 - secondary text
    'text-dim': '#64748b',   // slate-500 - disabled text
  },
  
  // Accent colors
  accent: {
    primary: '#6366f1',     // indigo-500 - primary actions
    'primary-hover': '#4f46e5', // indigo-600
    success: '#22c55e',     // green-500
    'success-hover': '#16a34a', // green-600
    warning: '#f59e0b',     // amber-500
    danger: '#ef4444',      // red-500
    info: '#3b82f6',        // blue-500
  },
  
  // Column header colors (modern glass effect)
  column: {
    template: { 
      bg: 'rgba(99, 102, 241, 0.15)',  // indigo
      text: '#818cf8',                  // indigo-400
      border: '#6366f1'                 // indigo-500
    },
    backlog: { 
      bg: 'rgba(245, 158, 11, 0.15)',  // amber
      text: '#fbbf24',                  // amber-400
      border: '#f59e0b'                 // amber-500
    },
    executing: { 
      bg: 'rgba(34, 197, 94, 0.15)',   // green
      text: '#4ade80',                  // green-400
      border: '#22c55e'                 // green-500
    },
    review: { 
      bg: 'rgba(168, 85, 247, 0.15)',  // purple
      text: '#c084fc',                  // purple-400
      border: '#a855f7'                 // purple-500
    },
    done: { 
      bg: 'rgba(6, 182, 212, 0.15)',   // cyan
      text: '#22d3ee',                  // cyan-400
      border: '#06b6d4'                 // cyan-500
    },
  }
}
```

### Badge Color Mapping

| Badge Type | Current Color | Proposed Color |
|-----------|---------------|----------------|
| plan | Blue accent | `accent.info` |
| review | Yellow | `accent.warning` |
| review-warn (near limit) | Red tint | `accent.danger` with opacity |
| stuck | Red | `accent.danger` |
| deps | Blue tint | `accent.primary` with opacity |
| template | Blue | `accent.info` |
| best-of-n | Orange | `accent.warning` |
| workers | Cyan | `accent.success` |
| reviewers | Purple | `#a855f7` |
| final | Green | `accent.success` |

---

## 6. Responsive Design (Desktop First + Mobile)

### Breakpoints
```javascript
// tailwind.config.js
screens: {
  'sm': '640px',   // Mobile landscape
  'md': '768px',   // Tablet
  'lg': '1024px',  // Desktop
  'xl': '1280px',  // Large desktop
}
```

### Layout Strategy

**Desktop (lg+):** Current 5-column grid
```css
.board { grid-template-columns: repeat(5, minmax(240px, 1fr)); }
```

**Tablet (md-lg):** 2-row layout or horizontal scroll
```css
.board { 
  grid-template-columns: repeat(5, 280px); 
  overflow-x: auto;
}
```

**Mobile (<md):** Vertical stack with collapsible columns
```css
.board { 
  grid-template-columns: 1fr;
  grid-template-rows: auto;
}
/* Columns become collapsible cards */
```

### Mobile Adaptations

| Feature | Desktop | Mobile |
|---------|---------|--------|
| Board | 5 columns side-by-side | Vertical stack or swipeable columns |
| Cards | Full interactions | Tap to expand actions |
| Drag & Drop | Enabled | Disabled (use buttons) |
| Modals | Centered, max-width | Full-screen or bottom sheet |
| Run Panel | Collapsible details element | Bottom sheet or modal |
| Log Panel | Fixed bottom panel | Floating toggle or modal |

---

## 7. API Client Design

### Environment Detection
```typescript
// composables/useApi.ts
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window
const API_BASE = isTauri 
  ? 'http://localhost:3000'  // Tauri sidecar backend
  : import.meta.env.VITE_API_URL || location.origin
```

### Typed API Client
```typescript
export function useApi() {
  const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Request failed (${res.status})`)
    }
    return res.status === 204 ? undefined as T : res.json()
  }
  
  return {
    // Tasks
    getTasks: () => request<Task[]>('/api/tasks'),
    getTask: (id: string) => request<Task>(`/api/tasks/${id}`),
    createTask: (data: CreateTaskDTO) => request<Task>('/api/tasks', { 
      method: 'POST', 
      body: JSON.stringify(data) 
    }),
    updateTask: (id: string, data: Partial<Task>) => 
      request<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteTask: (id: string) => request<{ id: string; archived?: boolean }>(`/api/tasks/${id}`, { 
      method: 'DELETE' 
    }),
    reorderTask: (id: string, newIdx: number) => 
      request('/api/tasks/reorder', { 
        method: 'PUT', 
        body: JSON.stringify({ id, newIdx }) 
      }),
    startSingleTask: (id: string) => request(`/api/tasks/${id}/start`, { method: 'POST' }),
    approvePlan: (id: string, message?: string) => 
      request(`/api/tasks/${id}/approve-plan`, { 
        method: 'POST', 
        body: message ? JSON.stringify({ message }) : undefined 
      }),
    requestRevision: (id: string, feedback: string) => 
      request(`/api/tasks/${id}/request-plan-revision`, { 
        method: 'POST', 
        body: JSON.stringify({ feedback }) 
      }),
    repairTask: (id: string, action: string, options?: object) => 
      request(`/api/tasks/${id}/repair-state`, { 
        method: 'POST', 
        body: JSON.stringify({ action, ...options }) 
      }),
    resetTask: (id: string) => 
      request(`/api/tasks/${id}/reset`, { method: 'POST' }),
    archiveAllDone: () => request('/api/tasks/done/all', { method: 'DELETE' }),
    
    // Task metadata
    getTaskRuns: (id: string) => request<TaskRun[]>(`/api/tasks/${id}/runs`),
    getTaskCandidates: (id: string) => request<Candidate[]>(`/api/tasks/${id}/candidates`),
    getBestOfNSummary: (id: string) => request<BestOfNSummary>(`/api/tasks/${id}/best-of-n-summary`),
    getReviewStatus: (id: string) => request<ReviewStatus>(`/api/tasks/${id}/review-status`),
    
    // Workflow runs
    getRuns: () => request<WorkflowRun[]>('/api/runs'),
    pauseRun: (id: string) => request(`/api/runs/${id}/pause`, { method: 'POST' }),
    resumeRun: (id: string) => request(`/api/runs/${id}/resume`, { method: 'POST' }),
    stopRun: (id: string) => request(`/api/runs/${id}/stop`, { method: 'POST' }),
    archiveRun: (id: string) => request(`/api/runs/${id}`, { method: 'DELETE' }),
    
    // Options
    getOptions: () => request<Options>('/api/options'),
    updateOptions: (data: Partial<Options>) => 
      request<Options>('/api/options', { method: 'PUT', body: JSON.stringify(data) }),
    
    // Reference data
    getBranches: () => request<BranchList>('/api/branches'),
    getModels: () => request<ModelCatalog>('/api/models'),
    
    // Execution
    startExecution: () => request('/api/start', { method: 'POST' }),
    stopExecution: () => request('/api/stop', { method: 'POST' }),
    getExecutionGraph: () => request<ExecutionGraph>('/api/execution-graph'),
    
    // Sessions
    getSession: (id: string) => request<Session>(`/api/sessions/${id}`),
    getSessionMessages: (id: string, limit?: number) => 
      request<SessionMessage[]>(`/api/sessions/${id}/messages${limit ? `?limit=${limit}` : ''}`),
  }
}
```

---

## 8. WebSocket Strategy

### Unified Approach for Web + Tauri
Use the same WebSocket protocol for both environments. In Tauri, the sidecar backend runs on localhost:3000 and exposes the same WebSocket endpoint.

```typescript
// composables/useWebSocket.ts
export function useWebSocket() {
  const ws = ref<WebSocket | null>(null)
  const isConnected = ref(false)
  const reconnectAttempts = ref(0)
  const MAX_RECONNECT_ATTEMPTS = 5
  const RECONNECT_DELAY = 2000
  
  const connect = () => {
    const isTauri = typeof window !== 'undefined' && '__TAURI__' in window
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = isTauri
      ? 'ws://localhost:3000/ws'
      : `${proto}//${location.host}/ws`
    
    ws.value = new WebSocket(wsUrl)
    
    ws.value.onopen = () => {
      isConnected.value = true
      reconnectAttempts.value = 0
      // Could emit connection status event
    }
    
    ws.value.onclose = () => {
      isConnected.value = false
      if (reconnectAttempts.value < MAX_RECONNECT_ATTEMPTS) {
        setTimeout(() => {
          reconnectAttempts.value++
          connect()
        }, RECONNECT_DELAY)
      }
    }
    
    ws.value.onmessage = (event) => {
      const message: WSMessage = JSON.parse(event.data)
      handleMessage(message)
    }
  }
  
  const handleMessage = (message: WSMessage) => {
    // Route to appropriate composable/store
    switch (message.type) {
      case 'task_created':
      case 'task_updated':
      case 'task_deleted':
      case 'task_archived':
      case 'task_reordered':
        // Emit to task store
        break
      case 'run_created':
      case 'run_updated':
      case 'run_archived':
        // Emit to run store
        break
      case 'session_message_created':
      case 'session_started':
      case 'session_status_changed':
      case 'session_completed':
        // Emit to session store
        break
      case 'options_updated':
        // Emit to options store
        break
      case 'image_status':
      case 'error':
        // Emit to toast/notification system
        break
    }
  }
  
  return { ws, isConnected, connect }
}
```

---

## 9. Tauri Compatibility Design

### Principle: Zero Frontend Code Changes

The Vue app should work identically in browser and Tauri without any `#ifdef` or conditional compilation. Achieve this through:

1. **Environment Detection:** Runtime detection of `window.__TAURI__`
2. **URL Abstraction:** `useApi.ts` and `useWebSocket.ts` handle different base URLs
3. **Standard Web APIs:** Only use `fetch`, `WebSocket`, `localStorage` - no Tauri-specific APIs in frontend

### Tauri Sidecar Architecture

```
Tauri Desktop App
  ├─ WebView (loads index.html from dist/)
  │  └─ Vue app
  │     └─ HTTP requests to localhost:3000
  │     └─ WebSocket to ws://localhost:3000/ws
  │
  └─ Sidecar: Bun Backend (auto-started)
     └─ HTTP server on localhost:3000
     └─ WebSocket server on localhost:3000
     └─ SQLite database
```

### Tauri Configuration (Future Phase)

```json
// tauri/tauri.conf.json
{
  "build": {
    "beforeBuildCommand": "cd src/kanban && npm run build",
    "beforeDevCommand": "cd src/kanban && npm run dev",
    "frontendDist": "../src/kanban/dist",
    "devUrl": "http://localhost:5173"
  },
  "bundle": {
    "externalBin": ["bin/pi-easy-workflow"],
    "resources": []
  },
  "app": {
    "windows": [
      {
        "title": "Pi Easy Workflow",
        "width": 1400,
        "height": 900,
        "minWidth": 1000,
        "minHeight": 700
      }
    ]
  }
}
```

```rust
// tauri/src/main.rs
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Start Bun backend as sidecar
            let sidecar = app.shell().sidecar("pi-easy-workflow")?;
            let (mut rx, _child) = sidecar.spawn()?;
            
            // Wait for "Server ready" message
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let tauri::api::process::CommandEvent::Stdout(line) = event {
                        if line.contains("Server ready") {
                            // Backend is ready, WebView can now load
                            println!("Backend ready on localhost:3000");
                        }
                    }
                }
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## 10. Implementation Phases

### Phase 1: Project Setup
- [ ] Create `src/kanban/` directory structure
- [ ] Initialize Vite + Vue + TypeScript project
- [ ] Install and configure Tailwind CSS with modern dark theme
- [ ] Install Radix Vue components
- [ ] Setup Fuse.js
- [ ] Create `vite.config.ts` with proper build output
- [ ] Create base `App.vue` with layout structure
- [ ] Test dev server: `npm run dev` shows empty app with correct theme

### Phase 2: Core UI Components
- [ ] `KanbanBoard.vue` - 5 columns layout
- [ ] `KanbanColumn.vue` - Individual column with header colors
- [ ] `TaskCard.vue` - Complete card with all states
- [ ] `CardHeader.vue` - Title, index, spinner, attention icon
- [ ] `CardBadges.vue` - All badge variants
- [ ] `CardActions.vue` - Edit, deploy, reset, archive, mark done
- [ ] `InlineActions.vue` - Conditional action buttons
- [ ] `CollapsibleOutput.vue` - Agent output toggle
- [ ] `TopBar.vue` - Start button, title, connection status
- [ ] `RunPanel.vue` - Collapsible runs list
- [ ] `LogPanel.vue` - Collapsible event log

### Phase 3: API & State Integration
- [ ] `types/api.ts` - All TypeScript interfaces
- [ ] `useApi.ts` - Complete typed API client
- [ ] `useTasks.ts` - Task CRUD, sorting, filtering
- [ ] `useRuns.ts` - Run state and control actions
- [ ] `useOptions.ts` - Settings management
- [ ] `useWebSocket.ts` - Live updates with auto-reconnect
- [ ] `useModelSearch.ts` - Fuse.js integration
- [ ] Wire up all components to real data
- [ ] Test: Full task lifecycle works

### Phase 4: Modals
- [ ] `TaskModal.vue` - Create, edit, view, deploy modes
  - [ ] Best-of-N configuration section
  - [ ] Model pickers for all model fields
  - [ ] Requirements multi-select
  - [ ] All checkboxes and inputs
- [ ] `OptionsModal.vue` - Global settings
- [ ] `SessionModal.vue` - Live session viewer with streaming
- [ ] `ExecutionGraphModal.vue` - Execution preview
- [ ] `ApproveModal.vue` - Plan approval
- [ ] `RevisionModal.vue` - Request changes
- [ ] `StartSingleModal.vue` - Start single task
- [ ] `BestOfNDetailModal.vue` - Best-of-N runs detail

### Phase 5: Interactions & Polish
- [ ] `useKeyboard.ts` - Keyboard shortcuts (T, B, S, D, Escape)
- [ ] `useToasts.ts` - Toast notifications
- [ ] `useDragDrop.ts` - Task reordering
- [ ] `ModelPicker.vue` - Fuzzy search implementation
- [ ] `Tooltip` components for all help buttons
- [ ] Custom scrollbar styling
- [ ] Loading states and skeletons
- [ ] Error handling and retry logic

### Phase 6: Mobile Responsiveness
- [ ] Responsive board layout (vertical on mobile)
- [ ] Touch-friendly card interactions
- [ ] Mobile modal adaptations
- [ ] Collapsible panels for mobile
- [ ] Test on mobile viewport

### Phase 7: Backend Integration & Production
- [ ] Modify `src/server/server.ts` to serve built files
- [ ] Update root `package.json` with build scripts
- [ ] Create production build
- [ ] Test production build thoroughly
- [ ] Remove old `src/kanban/index.html`
- [ ] Update documentation

### Phase 8: Cleanup
- [ ] Code review and refactoring
- [ ] Performance optimization (lazy loading if needed)
- [ ] Final testing on different viewports
- [ ] Documentation updates

---

## 11. Dependencies

### package.json
```json
{
  "name": "pi-easy-workflow-kanban",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.4.0",
    "fuse.js": "^7.0.0",
    "radix-vue": "^1.9.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "vite": "^5.0.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0",
    "typescript": "^5.3.0",
    "vue-tsc": "^1.8.0"
  }
}
```

---

## 12. Key Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **UI Library** | Radix Vue | Headless UI discontinued Vue. Radix Vue is actively maintained, accessible, unstyled |
| **State Management** | Composables only | Provide/inject + composables sufficient. Pinia only if complexity demands it |
| **Theme** | Modern dark (slate/indigo) | Cleaner than GitHub dark, still professional, requested by user |
| **Responsive** | Desktop first + mobile | Primary use is desktop, but mobile should be usable |
| **Tauri Strategy** | Sidecar with WebSocket | Zero frontend code changes, transparent to Vue app |
| **Build Output** | `dist/` in `src/kanban/` | Server.ts serves static files from this directory |
| **Router** | None | Single page, hash-based session routing only |

---

## 13. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Radix Vue component gaps | Low | Medium | Fallback to custom components or switch to Reka UI |
| Mobile drag & drop issues | Medium | Low | Disable DnD on mobile, use buttons instead |
| WebSocket reconnection edge cases | Medium | Medium | Exponential backoff, max retry limit, user notification |
| Bundle size bloat | Low | Low | Tree-shaking, code splitting if needed |
| TypeScript complexity | Low | Low | Good type inference, clear interfaces |
| Visual regression | Medium | Low | Screenshot testing, user acceptance review |

---

## 14. Success Criteria

- [ ] All 4000+ lines of current functionality ported
- [ ] Feature parity: 1-to-1 with current kanban
- [ ] Modern dark theme applied
- [ ] Mobile responsive (usable on phone/tablet)
- [ ] Keyboard shortcuts preserved (T, B, S, D, Escape)
- [ ] Drag & Drop task reordering works
- [ ] All 8 modals functional
- [ ] Session viewer with live streaming works
- [ ] Fuse.js model search works
- [ ] WebSocket live updates work
- [ ] Production build < 200KB gzipped
- [ ] No backend changes required
- [ ] Tauri-ready architecture

---

## 15. Post-Migration: Tauri Phase

After the Vue migration is complete and stable:

1. **Create `tauri/` directory** with Rust project
2. **Configure sidecar** to auto-start Bun backend
3. **Test desktop build** on Windows, macOS, Linux
4. **Package and distribute** as native desktop app

**Key advantage:** The Tauri phase requires no Vue code changes - only Rust/Cargo configuration for the sidecar.

---

**Plan Status:** Ready for implementation
**Approver:** [Pending user confirmation]