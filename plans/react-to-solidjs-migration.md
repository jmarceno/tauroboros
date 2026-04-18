# React to SolidJS Migration Plan

## Overview
This document provides a comprehensive specification for migrating the TaurOboros kanban UI from React to SolidJS, using [solid-chartjs](https://github.com/s0ftik3/solid-chartjs) for chart visualization (replacing recharts).

---

## Current Tech Stack (React)

| Category | Technology |
|----------|------------|
| Framework | React 19.2.0 |
| Build Tool | Vite 8.0.8 |
| Styling | Tailwind CSS 3.4.0 |
| State Management | React Context + Custom Hooks |
| Data Fetching | TanStack Query (React Query) |
| Charts | Recharts 3.8.1 |
| Search | Fuse.js 7.0.0 |
| Icons | Inline SVG |

---

## Target Tech Stack (SolidJS)

| Category | Technology |
|----------|------------|
| Framework | SolidJS |
| Build Tool | Vite (keep existing) |
| Styling | Tailwind CSS (keep existing) |
| State Management | SolidJS Stores / Context |
| Data Fetching | @tanstack/solid-query |
| Charts | solid-chartjs (Chart.js wrapper) |
| Search | Fuse.js (keep existing) |
| Icons | Inline SVG (keep existing) |

---

## Layout Architecture

### Overall Layout Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  app-layout (grid: sidebar + main-content)                                   │
│  ┌─────────────────┬─────────────────────────────────────────────────────┐ │
│  │                 │  main-content (flex column)                         │ │
│  │   sidebar       │  ┌─────────────────────────────────────────────────┐ │ │
│  │   (240px)       │  │  top-bar (56px height)                          │ │ │
│  │                 │  └─────────────────────────────────────────────────┘ │ │
│  │  - Logo         │  ┌─────────────────────────────────────────────────┐ │ │
│  │  - Stats        │  │  tab-bar (horizontal tabs)                        │ │ │
│  │  - Actions      │  └─────────────────────────────────────────────────┘ │ │
│  │  - Workflow     │  ┌─────────────────────────────────────────────────┐ │ │
│  │    Control      │  │                                                 │ │ │
│  │  - Status       │  │  kanban-wrapper (flex-1)                        │ │ │
│  │  - Version      │  │  ┌───────────────────────────────────────────┐ │ │ │
│  │                 │  │  │  kanban-scroll (overflow-x-auto)          │ │ │ │
│  │                 │  │  │  ┌──────────────────────────────────────┐ │ │ │ │
│  │                 │  │  │  │  kanban-container (flex, gap-4)      │ │ │ │ │
│  │                 │  │  │  │  ┌─────┬─────┬─────┬─────┬─────┬─────┐ │ │ │ │ │
│  │                 │  │  │  │  │Temp │Back │Exec │ Rev │ CS  │ Done│ │ │ │ │ │
│  │                 │  │  │  │  │     │log  │     │     │     │     │ │ │ │ │ │
│  │                 │  │  │  │  │     │+    │     │     │     │     │ │ │ │ │ │
│  │                 │  │  │  │  │     │Virt │     │     │     │     │ │ │ │ │ │
│  │                 │  │  │  │  └─────┴─────┴─────┴─────┴─────┴─────┘ │ │ │ │ │
│  │                 │  │  │  └──────────────────────────────────────┘ │ │ │ │
│  │                 │  │  └───────────────────────────────────────────┘ │ │ │
│  │                 │  └─────────────────────────────────────────────────┘ │ │
│  │                 │  ┌─────────────────────────────────────────────────┐ │ │
│  │                 │  │  tabbed-log-panel (resizable height, bottom)    │ │ │
│  │                 │  └─────────────────────────────────────────────────┘ │ │
│  └─────────────────┴─────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  chat-panel (slide-in from right, resizable width, z-40)                 ││
│  │  ┌───────────────────────────────────────────────────────────────────┐ ││
│  │  │  chat-tabs-container                                               │ ││
│  │  │  ┌──────────────────────────────────────────────────────────────┐  │ ││
│  │  │  │  chat-tabs-primary (session tabs)                              │  │ ││
│  │  │  ├──────────────────────────────────────────────────────────────┤  │ ││
│  │  │  │  chat-tabs-secondary (New Session, Chat, History, actions)     │  │ ││
│  │  │  └──────────────────────────────────────────────────────────────┘  │ ││
│  │  │  ┌─────────────────────────────────────────────────────────────────┐ ││
│  │  │  │  chat-messages OR sessions-list                                  │ ││
│  │  │  │  ┌────────────────────────────────────────────────────────────┐│ ││
│  │  │  │  │  chat-message (repeated)                                    │ │ ││
│  │  │  │  └────────────────────────────────────────────────────────────┘│ ││
│  │  │  └─────────────────────────────────────────────────────────────────┘ ││
│  │  │  ┌─────────────────────────────────────────────────────────────────┐ ││
│  │  │  │  chat-input-container                                            │ ││
│  │  │  │  ┌───────────────────────────────────────────────────────────┐  │ ││
│  │  │  │  │  chat-toolbar (attachment buttons)                         │  │ ││
│  │  │  │  ├───────────────────────────────────────────────────────────┤  │ ││
│  │  │  │  │  chat-input-box (textarea)                                   │  │ ││
│  │  │  │  ├───────────────────────────────────────────────────────────┤  │ ││
│  │  │  │  │  chat-send-btn                                               │  │ ││
│  │  │  │  └───────────────────────────────────────────────────────────┘  │ ││
│  │  │  └─────────────────────────────────────────────────────────────────┘ ││
│  │  └───────────────────────────────────────────────────────────────────┘ ││
│  └────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  minimized-dock (fixed position, when sessions minimized)               ││
│  │  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  │  minimized-session (repeated for each minimized session)             ││
│  │  └─────────────────────────────────────────────────────────────────────┘│
│  └─────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  Modals (modal-overlay with z-50)                                      ││
│  │  - TaskModal, OptionsModal, ExecutionGraphModal, etc.                  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  ToastContainer (fixed bottom-right, z-50)                             ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Color Palette (EXACT VALUES - Must Preserve)

### Dark Theme Background Colors

```css
--dark-bg: #0c0c14;           /* Deep dark background - body/app background */
--dark-surface: #151520;      /* Panels, cards, secondary surfaces */
--dark-surface2: #1e1e2d;     /* Cards, form backgrounds, elevated surfaces */
--dark-surface3: #252536;     /* Hover states, active elements */
--dark-border: #2a2a3e;       /* Subtle borders */
--dark-border-hover: #3a3a52; /* Hover borders */
--dark-input: #0a0a12;        /* Input backgrounds */
```

### Text Colors

```css
--dark-text: #f0f0f5;              /* Primary text */
--dark-text-secondary: #a0a0b0;  /* Secondary text, labels */
--dark-text-muted: #6a6a80;      /* Muted text, placeholders, disabled */
```

### Neon Accent Colors (High Contrast)

```css
--accent-primary: #00d4ff;       /* Cyan - primary actions, links */
--accent-secondary: #ff00a0;     /* Magenta - secondary accents */
--accent-success: #00ff88;       /* Neon green - success states */
--accent-warning: #ffcc00;       /* Yellow - warnings, paused */
--accent-danger: #ff3366;          /* Red - errors, delete */
--accent-info: #4488ff;          /* Blue - info, executing */
```

### Column-Specific Colors (Kanban Columns)

```css
--column-template: #b388ff;      /* Purple */
--column-backlog: #ffab40;       /* Orange */
--column-executing: #69f0ae;     /* Green */
--column-review: #ff4081;        /* Pink */
--column-code-style: #ffd740;    /* Amber/Yellow */
--column-codestyle: #8b5cf6;     /* Violet/Purple */
--column-done: #18ffff;          /* Cyan */
```

### Syntax Highlighting (for code blocks)

```css
.hljs-comment: #8b949e italic;
.hljs-keyword: #ff7b72;
.hljs-number: #79c0ff;
.hljs-string: #a5d6ff;
.hljs-title: #d2a8ff;
.hljs-type: #ffa657;
.hljs-tag: #7ee787;
```

---

## Component Inventory

### Board Components

| Component | File | Description | Props |
|-----------|------|-------------|-------|
| **KanbanBoard** | `components/board/KanbanBoard.tsx` | Main board with 6 columns | tasks, bonSummaries, dragDrop, groups, activeGroupId, handlers |
| **KanbanColumn** | `components/board/KanbanColumn.tsx` | Individual column | status, title, icon, tasks, handlers, sort options |
| **TaskCard** | `components/board/TaskCard.tsx` | Individual task card | task, runColor, isLocked, canDrag, dragDrop, handlers |
| **VirtualCard** | `components/board/VirtualCard.tsx` | Group virtual card | group, taskCount, onClick, onDelete, onStart |
| **GroupPanel** | `components/board/GroupPanel.tsx` | Slide-out group panel | group, tasks, isOpen, onClose, handlers |
| **GroupActionBar** | `components/board/GroupActionBar.tsx` | Multi-select action bar | selectedCount, onCreateGroup, onBatchEdit, onClear |
| **Sidebar** | `components/board/Sidebar.tsx` | Left sidebar | stats, workflow control, actions |
| **TopBar** | `components/board/TopBar.tsx` | Top header with shortcuts | (no props) |

### Tab Components

| Component | File | Description | Props |
|-----------|------|-------------|-------|
| **TabBar** | `components/tabs/TabBar.tsx` | Main navigation tabs | activeTab, onTabChange |
| **OptionsTab** | `components/tabs/OptionsTab.tsx` | Configuration form | (uses context) |
| **ContainersTab** | `components/tabs/ContainersTab.tsx` | Container image builder | (uses API) |
| **ArchivedTasksTab** | `components/tabs/ArchivedTasksTab.tsx` | Archived tasks list | onOpenTaskSessions |
| **StatsTab** | `components/tabs/StatsTab.tsx` | Statistics & charts | (uses useStats hook) |

### Chat Components

| Component | File | Description | Props |
|-----------|------|-------------|-------|
| **ChatContainer** | `components/chat/ChatContainer.tsx` | Main chat panel | (uses context) |
| **ChatPanel** | `components/chat/ChatPanel.tsx` | Individual chat session | session, onSendMessage, handlers |
| **ChatMessage** | `components/chat/ChatMessage.tsx` | Single message | message, isStreaming |

### Modal Components

| Component | File | Description | Props |
|-----------|------|-------------|-------|
| **TaskModal** | `components/modals/TaskModal.tsx` | Create/edit/deploy task | mode, taskId, createStatus, seedTaskId, onClose |
| **OptionsModal** | `components/modals/OptionsModal.tsx` | Quick options modal | onClose |
| **ExecutionGraphModal** | `components/modals/ExecutionGraphModal.tsx` | Workflow preview | onClose |
| **ApproveModal** | `components/modals/ApproveModal.tsx` | Plan approval | taskId, onClose |
| **RevisionModal** | `components/modals/RevisionModal.tsx` | Request revision | taskId, onClose |
| **StartSingleModal** | `components/modals/StartSingleModal.tsx` | Start single task | taskId, onClose |
| **SessionModal** | `components/modals/SessionModal.tsx` | Session viewer | sessionId, onClose |
| **TaskSessionsModal** | `components/modals/TaskSessionsModal.tsx` | Task sessions list | taskId, onClose |
| **BestOfNDetailModal** | `components/modals/BestOfNDetailModal.tsx` | Best-of-N runs | taskId, onClose |
| **BatchEditModal** | `components/modals/BatchEditModal.tsx` | Batch edit tasks | taskIds, onClose |
| **ConfirmModal** | `components/modals/ConfirmModal.tsx` | Generic confirmation | isOpen, action, taskName, onConfirm, onClose |
| **StopConfirmModal** | `components/modals/StopConfirmModal.tsx` | Stop workflow confirm | isOpen, runName, onConfirmGraceful, onConfirmDestructive |
| **ContainerConfigModal** | `components/modals/ContainerConfigModal.tsx` | Container settings | isOpen, onClose |
| **GroupCreateModal** | `components/modals/GroupCreateModal.tsx` | Create group | taskCount, defaultName, onConfirm, onClose |
| **RestoreToGroupModal** | `components/modals/RestoreToGroupModal.tsx` | Restore choice | isOpen, task, group, onRestoreToGroup, onMoveToBacklog |
| **PlanningPromptModal** | `components/modals/PlanningPromptModal.tsx` | Edit planning prompt | onClose |

### Common Components

| Component | File | Description | Props |
|-----------|------|-------------|-------|
| **ModalWrapper** | `components/common/ModalWrapper.tsx` | Modal container | title, onClose, size, children |
| **ModelPicker** | `components/common/ModelPicker.tsx` | Model selector with search | modelValue, label, help, onUpdate, disabled |
| **ThinkingLevelSelect** | `components/common/ThinkingLevelSelect.tsx` | Thinking level dropdown | modelValue, label, help, onUpdate, disabled |
| **MarkdownEditor** | `components/common/MarkdownEditor.tsx` | TipTap markdown editor | modelValue, onUpdate, placeholder, disabled |
| **HelpButton** | `components/common/HelpButton.tsx` | Tooltip help icon | tooltip |
| **TabbedLogPanel** | `components/common/TabbedLogPanel.tsx` | Bottom log/runs panel | logs, runs, staleRuns, onClear, onArchiveRun |
| **ToastContainer** | `components/common/ToastContainer.tsx` | Toast notifications | toasts, onRemove, bottomOffset |

---

## State Management (Contexts)

All contexts are defined in `contexts/AppContext.tsx`:

```typescript
// Core Data Contexts
TasksContext        // tasks, loading, CRUD operations, groupedTasks
RunsContext         // runs, activeRuns, staleRuns, run operations
OptionsContext      // options, save/load
TaskGroupsContext   // groups, activeGroupId, CRUD

// UI/Feature Contexts
ToastContext        // toasts, showToast, addLog
ModelSearchContext  // models, search, normalize
SessionContext      // session management
WebSocketContext    // ws connection, send, isConnected
PlanningChatContext // chat sessions, messages, send

// Control Contexts
WorkflowControlContext  // controlState, pause, resume, stop
MultiSelectContext      // selection state, toggle, clear
SessionUsageContext     // session usage tracking
TaskLastUpdateContext   // last update timestamps
ModalContext            // activeModal, openModal, closeModal
ContainerStatusContext  // container status
```

### Migration to SolidJS:

Replace React Context with SolidJS equivalents:
- Use `createContext` from `solid-js` for simple cases
- Use SolidJS Stores for complex shared state
- Consider `@tanstack/solid-query` for server state

---

## Hooks Inventory

| Hook | File | Purpose |
|------|------|---------|
| **useTasks** | `hooks/useTasks.ts` | Task CRUD, filtering, grouping |
| **useRuns** | `hooks/useRuns.ts` | Workflow run management |
| **useOptions** | `hooks/useOptions.ts` | Options load/save |
| **useTaskGroups** | `hooks/useTaskGroups.ts` | Group CRUD |
| **useDragDrop** | `hooks/useDragDrop.ts` | Drag & drop state |
| **useWebSocket** | `hooks/useWebSocket.ts` | WebSocket connection |
| **useWebSocketHandlers** | `hooks/useWebSocketHandlers.ts` | WS message handlers |
| **useWorkflowControl** | `hooks/useWorkflowControl.ts` | Pause/resume/stop |
| **useMultiSelect** | `hooks/useMultiSelect.ts` | Multi-selection |
| **usePlanningChat** | `hooks/usePlanningChat.ts` | Chat sessions |
| **useSession** | `hooks/useSession.ts` | Session management |
| **useSessionUsage** | `hooks/useSessionUsage.ts` | Usage tracking |
| **useTaskLastUpdate** | `hooks/useTaskLastUpdate.ts` | Update timestamps |
| **useStats** | `hooks/useStats.ts` | Statistics loading |
| **useModelSearch** | `hooks/useModelSearch.ts` | Model search/filter |
| **useToasts** | `hooks/useToasts.ts` | Toast notifications |
| **useKeyboard** | `hooks/useKeyboard.ts` | Keyboard shortcuts |
| **useFocusTrap** | `hooks/useFocusTrap.ts` | Modal focus trap |
| **useApi** | `hooks/useApi.ts` | API client |
| **useVersion** | `hooks/useVersion.ts` | Version display |

### Migration to SolidJS:

- Convert `useState` → `createSignal`
- Convert `useEffect` → `createEffect`
- Convert `useMemo` → `createMemo`
- Convert `useCallback` → regular functions (no need in Solid)
- Convert custom hooks to regular functions returning signals

---

## Drag & Drop System

### Current Implementation (React)

Uses HTML5 Drag and Drop API with custom hook:

```typescript
// Key features:
- TaskCard has draggable attribute
- Columns accept drops via onDragOver/onDrop
- Virtual cards and group panel have drop zones
- Validation before allowing drops
- Visual feedback during drag (opacity, border colors)
```

### Migration to SolidJS:

- Keep HTML5 DnD API (framework agnostic)
- Move drag state to reactive signals
- Update event handlers to Solid patterns

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `T` | Create new Template |
| `B` | Create new Backlog task |
| `P` | Toggle Planning Chat |
| `Ctrl+G` | Create Group from selection |
| `Ctrl+1-5` | Switch tabs |
| `Esc` | Close modals / clear selection |
| `Ctrl+click` | Multi-select toggle |
| `Ctrl+click` (delete) | Skip confirmation |

---

## API Integration

Base API client in `api/client.ts` with endpoints:

```typescript
// Tasks
GET    /api/tasks
POST   /api/tasks
PUT    /api/tasks/:id
DELETE /api/tasks/:id
POST   /api/tasks/:id/reset
POST   /api/tasks/:id/repair
GET    /api/tasks/:id/sessions

// Task Groups
GET    /api/task-groups
POST   /api/task-groups
PUT    /api/task-groups/:id
DELETE /api/task-groups/:id
POST   /api/task-groups/:id/add-tasks
POST   /api/task-groups/:id/remove-tasks

// Workflow
POST   /api/workflow/start
POST   /api/workflow/stop
POST   /api/workflow/pause/:runId
POST   /api/workflow/resume/:runId
GET    /api/workflow/status

// Options
GET    /api/options
PUT    /api/options

// Models
GET    /api/models

// Branches
GET    /api/branches

// Containers
GET    /api/container/status
GET    /api/container/profiles
GET    /api/container/images
POST   /api/container/build
GET    /api/container/build-status

// Stats
GET    /api/stats/usage
GET    /api/stats/tasks
GET    /api/stats/models
GET    /api/stats/duration
GET    /api/stats/hourly
GET    /api/stats/daily

// Sessions
GET    /api/sessions
GET    /api/sessions/:id/messages
GET    /api/sessions/:id/usage

// Planning Chat
GET    /api/planning-prompts
GET    /api/planning-sessions
POST   /api/planning-sessions
```

---

## WebSocket Events

Connection: `ws://host/api/ws`

### Message Types (WSMessageType)

```typescript
type WSMessageType = 
  // Tasks
  | 'task_created' | 'task_updated' | 'task_deleted' 
  | 'task_archived' | 'task_reordered'
  // Runs
  | 'run_created' | 'run_updated' | 'run_archived'
  | 'run_paused' | 'run_resumed' | 'run_stopped'
  // Sessions
  | 'session_started' | 'session_message_created'
  | 'session_status_changed' | 'session_completed'
  // Planning
  | 'planning_session_created' | 'planning_session_updated'
  | 'planning_session_message' | 'planning_session_closed'
  // Containers
  | 'container_build_started' | 'container_build_progress'
  | 'container_build_completed' | 'container_build_cancelled'
  // Groups
  | 'task_group_created' | 'task_group_updated' | 'task_group_deleted'
  | 'group_execution_started' | 'group_execution_complete'
  // Workflow
  | 'execution_started' | 'execution_stopped' 
  | 'execution_complete' | 'execution_paused' | 'execution_resumed'
```

---

## Tailwind Configuration (Preserved)

```javascript
// tailwind.config.js - CRITICAL: Keep all custom values
colors: {
  dark: {
    bg: '#0c0c14',
    surface: '#151520',
    surface2: '#1e1e2d',
    surface3: '#252536',
    border: '#2a2a3e',
    'border-hover': '#3a3a52',
    text: '#f0f0f5',
    'text-secondary': '#a0a0b0',
    'text-muted': '#6a6a80',
    input: '#0a0a12',
  },
  accent: {
    primary: '#00d4ff',
    secondary: '#ff00a0',
    success: '#00ff88',
    warning: '#ffcc00',
    danger: '#ff3366',
    info: '#4488ff',
  },
  column: {
    template: '#b388ff',
    backlog: '#ffab40',
    executing: '#69f0ae',
    review: '#ff4081',
    'code-style': '#ffd740',
    codestyle: '#8b5cf6',
    done: '#18ffff',
  }
}

// Custom widths
width: {
  'sidebar': '240px',
  'kanban-column': '300px',
  'chat-min': '350px',
  'group-panel': '350px',
}

// Custom animations
animation: {
  'slide-in': 'slideIn 0.3s ease',
  'slide-out': 'slideOut 0.3s ease',
  'pulse-glow': 'pulseGlow 2s infinite',
  'fade-in-up': 'fadeInUp 0.3s ease-out',
}
```

---

## Chart Migration: Recharts → solid-chartjs

### Current Charts (StatsTab)

1. **LineChart**: Token & Cost over time (7 days)
2. **BarChart** (3x): Model usage by phase (plan/execution/review)

### Migration Strategy

```typescript
// Install dependencies
npm install chart.js solid-chartjs

// Replace Recharts components:
<LineChart> → <SolidChart> with type="line"
<BarChart>  → <SolidChart> with type="bar"

// Data format changes:
Recharts: [{ label: 'Mon', tokens: 1000, cost: 0.5 }, ...]
Chart.js: {
  labels: ['Mon', 'Tue', ...],
  datasets: [
    { label: 'Tokens', data: [1000, ...], borderColor: '#6366f1' },
    { label: 'Cost', data: [0.5, ...], borderColor: '#10b981' }
  ]
}
```

### Chart Colors (Must Match Current)

```javascript
// LineChart - Token & Cost Over Time
tokensLine: '#6366f1'  // Indigo
costLine: '#10b981'    // Emerald

// BarChart - Model Usage
barFill: '#6366f1'     // Indigo
gridColor: '#334155'   // Slate 700
axisColor: '#64748b'   // Slate 500
tooltipBg: '#1e293b'   // Slate 800
tooltipBorder: '#334155' // Slate 700
```

---

## File Structure (Target)

```
kanban-solid/
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── src/
│   ├── index.tsx              # Entry point
│   ├── App.tsx               # Root App component
│   ├── styles/
│   │   └── theme.css         # Tailwind + custom styles
│   ├── components/
│   │   ├── board/
│   │   │   ├── KanbanBoard.tsx
│   │   │   ├── KanbanColumn.tsx
│   │   │   ├── TaskCard.tsx
│   │   │   ├── VirtualCard.tsx
│   │   │   ├── GroupPanel.tsx
│   │   │   ├── GroupActionBar.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── TopBar.tsx
│   │   ├── tabs/
│   │   │   ├── TabBar.tsx
│   │   │   ├── OptionsTab.tsx
│   │   │   ├── ContainersTab.tsx
│   │   │   ├── ArchivedTasksTab.tsx
│   │   │   └── StatsTab.tsx
│   │   ├── chat/
│   │   │   ├── ChatContainer.tsx
│   │   │   ├── ChatPanel.tsx
│   │   │   └── ChatMessage.tsx
│   │   ├── modals/
│   │   │   ├── TaskModal.tsx
│   │   │   ├── OptionsModal.tsx
│   │   │   ├── ExecutionGraphModal.tsx
│   │   │   ├── ConfirmModal.tsx
│   │   │   ├── StopConfirmModal.tsx
│   │   │   ├── SessionModal.tsx
│   │   │   ├── TaskSessionsModal.tsx
│   │   │   ├── BestOfNDetailModal.tsx
│   │   │   ├── BatchEditModal.tsx
│   │   │   ├── ApproveModal.tsx
│   │   │   ├── RevisionModal.tsx
│   │   │   ├── StartSingleModal.tsx
│   │   │   ├── ContainerConfigModal.tsx
│   │   │   ├── GroupCreateModal.tsx
│   │   │   ├── RestoreToGroupModal.tsx
│   │   │   └── PlanningPromptModal.tsx
│   │   └── common/
│   │       ├── ModalWrapper.tsx
│   │       ├── ModelPicker.tsx
│   │       ├── ThinkingLevelSelect.tsx
│   │       ├── MarkdownEditor.tsx
│   │       ├── HelpButton.tsx
│   │       ├── TabbedLogPanel.tsx
│   │       └── ToastContainer.tsx
│   ├── stores/               # SolidJS stores (replacing contexts)
│   │   ├── tasksStore.ts
│   │   ├── runsStore.ts
│   │   ├── optionsStore.ts
│   │   ├── groupsStore.ts
│   │   ├── chatStore.ts
│   │   ├── uiStore.ts
│   │   └── websocketStore.ts
│   ├── hooks/                # SolidJS hooks
│   │   ├── useDragDrop.ts
│   │   ├── useKeyboard.ts
│   │   ├── useFocusTrap.ts
│   │   ├── useModelSearch.ts
│   │   ├── useStats.ts
│   │   ├── useVersion.ts
│   │   └── useApi.ts
│   ├── api/                  # API client
│   │   ├── client.ts
│   │   ├── tasks.ts
│   │   ├── runs.ts
│   │   ├── options.ts
│   │   ├── groups.ts
│   │   ├── sessions.ts
│   │   ├── containers.ts
│   │   ├── stats.ts
│   │   └── planning.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       ├── date.ts
│       └── dropValidation.ts
└── tests/
    └── (test files)
```

---

## Migration Checklist

### Phase 1: Setup
- [ ] Create `kanban-solid` directory
- [ ] Initialize SolidJS project with Vite
- [ ] Install dependencies (solid-js, @tanstack/solid-query, solid-chartjs, chart.js, fuse.js, highlight.js, tailwindcss)
- [ ] Copy Tailwind config with ALL custom colors/values
- [ ] Copy global styles from `theme.css`
- [ ] Setup TypeScript configuration
- [ ] Create type definitions

### Phase 2: Core Infrastructure
- [ ] Create API client (port from React version)
- [ ] Create WebSocket store with SolidJS reactivity
- [ ] Create data stores (tasks, runs, options, groups)
- [ ] Create UI store (modals, toasts, chat)
- [ ] Create drag & drop hook
- [ ] Create keyboard shortcuts hook

### Phase 3: Layout Components
- [ ] App component with store providers
- [ ] Sidebar component
- [ ] TopBar component
- [ ] TabBar component
- [ ] TabbedLogPanel component

### Phase 4: Kanban Components
- [ ] KanbanBoard component
- [ ] KanbanColumn component
- [ ] TaskCard component
- [ ] VirtualCard component
- [ ] GroupPanel component
- [ ] GroupActionBar component

### Phase 5: Tab Views
- [ ] OptionsTab (complex form)
- [ ] ContainersTab
- [ ] ArchivedTasksTab
- [ ] StatsTab (with solid-chartjs)

### Phase 6: Chat System
- [ ] ChatContainer component
- [ ] ChatPanel component
- [ ] ChatMessage component
- [ ] Chat stores

### Phase 7: Modals
- [ ] ModalWrapper component
- [ ] TaskModal (complex form with Best-of-N)
- [ ] All other modals
- [ ] ToastContainer

### Phase 8: Common Components
- [ ] ModelPicker with Fuse.js
- [ ] ThinkingLevelSelect
- [ ] MarkdownEditor (TipTap integration)
- [ ] HelpButton

### Phase 9: Testing & Polish
- [ ] Port all unit tests
- [ ] Verify all colors match exactly
- [ ] Verify all animations work
- [ ] Test drag & drop
- [ ] Test keyboard shortcuts
- [ ] Test WebSocket reconnection
- [ ] Test all modals
- [ ] Performance testing

---

## Critical Notes

1. **Colors must match EXACTLY** - The cyberpunk dark theme is a key feature
2. **All animations must be preserved** - Users expect the smooth transitions
3. **Drag & drop must work identically** - Critical workflow feature
4. **Keyboard shortcuts must be identical** - Users rely on these
5. **Chart colors must match** - Maintain visual consistency
6. **Modal behaviors must match** - Focus trap, escape to close, etc.
7. **WebSocket reconnection** - Must handle disconnects gracefully

---

## Dependencies to Install

```bash
# Core
npm install solid-js

# Routing (if needed)
npm install @solidjs/router

# Data fetching
npm install @tanstack/solid-query

# Charts
npm install chart.js solid-chartjs

# Search
npm install fuse.js

# Editor
npm install @tiptap/core @tiptap/starter-kit @tiptap/react
npm install @tiptap/extension-code-block @tiptap/extension-link
npm install @tiptap/extension-placeholder @tiptap/extension-underline

# Syntax highlighting
npm install highlight.js

# Diagrams (for execution graph)
npm install mermaid

# Dev tools
npm install -D typescript vite vite-plugin-solid
npm install -D tailwindcss postcss autoprefixer
npm install -D @testing-library/jest-dom vitest
```
