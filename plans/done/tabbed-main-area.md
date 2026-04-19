# Implementation Plan: Tabbed Main Area

## Overview

Convert the main kanban area into a tabbed interface where the project name is today. This replaces the single-view kanban with a tabbed layout containing:
1. **Kanban** - Existing kanban functionality (Tab 1)
2. **Options** - Options modal content as a tab (Tab 2)
3. **Containers** - Container config modal content as a tab (Tab 3)
4. **Archived** - Archived tasks panel grouped by workflow run (Tab 4)
5. **Stats** - System global statistics with Recharts visualizations (Tab 5)

## Current State Analysis

### Existing Components
- `App.tsx` - Main application component with sidebar, top bar, kanban board, and modals
- `Sidebar.tsx` - Contains workflow controls, stats, and configuration buttons
- `TopBar.tsx` - Shows "Pi Easy Workflow" as project name
- `OptionsModal.tsx` - Full-featured options configuration modal
- `ContainerConfigModal.tsx` - Container image builder modal
- Database stores `isArchived` tasks in `tasks` table with `archivedAt` timestamp
- `workflow_sessions` table tracks all sessions with `taskId` references

### Key Data Types
```typescript
interface Task {
  isArchived: boolean
  archivedAt: number | null
  // ... other fields
}

interface WorkflowRun {
  id: string
  taskOrder: string[]
  // ... other fields
}
```

## Implementation Plan

### Phase 1: Tab Infrastructure

#### 1.1 Create Tab State Management
**File:** `src/kanban-react/src/contexts/TabContext.tsx`

Create a React context to manage the active tab state across the application:

```typescript
interface TabContextValue {
  activeTab: MainTabId
  setActiveTab: (tab: MainTabId) => void
}

type MainTabId = 'kanban' | 'options' | 'containers' | 'archived' | 'stats'
```

**Note:** Tab state is NOT persisted to localStorage. Default tab on load is `kanban`.

#### 1.2 Create TabBar Component
**File:** `src/kanban-react/src/components/tabs/TabBar.tsx`

A horizontal tab bar component that:
- Displays 5 tabs with icons and labels
- Shows active tab with accent border/highlight
- Remains visible at the top of the main content area
- Replaces the project name breadcrumb in TopBar
- Uses existing CSS variables for consistent styling

```typescript
interface TabBarProps {
  activeTab: MainTabId
  onTabChange: (tab: MainTabId) => void
}
```

**Tab definitions:**
| ID | Label | Icon |
|----|-------|------|
| `kanban` | Kanban | Kanban board icon |
| `options` | Options | Gear/settings icon |
| `containers` | Containers | Docker/container icon |
| `archived` | Archived | Archive box icon |
| `stats` | Stats | Chart/statistics icon |

#### 1.3 Update App.tsx Structure
Modify `App.tsx` to:
- Wrap main content in tab container
- Move TopBar/tab switching logic
- Conditionally render tab content based on active tab
- Remove sidebar "Options" and "Containers" buttons (moved to tabs)

### Phase 2: Options Tab

#### 2.1 Create OptionsTab Component
**File:** `src/kanban-react/src/components/tabs/OptionsTab.tsx`

Extract and adapt `OptionsModal` content into a tab panel:
- Same form fields and validation
- Remove modal overlay styling
- Use full tab height for content
- Add "Save" and "Cancel" buttons at bottom
- Keep form state in local component state

#### 2.2 Update Sidebar
Remove "Options" button from Configuration section since it's now a tab.

### Phase 3: Containers Tab

#### 3.1 Create ContainersTab Component
**File:** `src/kanban-react/src/components/tabs/ContainersTab.tsx`

Extract and adapt `ContainerConfigModal` content into a tab panel:
- Same Build/Images tabs structure
- Remove modal overlay styling
- Use full tab height for content
- Integrate seamlessly with container state

#### 3.2 Update Sidebar
Remove "Containers" button from Configuration section since it's now a tab.

### Phase 4: Archived Tasks Tab

#### 4.1 Database API Extension
**File:** `src/db.ts` - Add new methods to `PiKanbanDB` class

```typescript
// Get all archived tasks grouped by workflow run
getArchivedTasksGroupedByRun(): Map<string, { run: WorkflowRun; tasks: Task[] }>

// Get archived tasks for a specific run
getArchivedTasksByRun(runId: string): Task[]

// Get all archived tasks (flat list)
getArchivedTasks(): Task[]
```

**File:** `src/server/server.ts` - Add new API endpoints

```
GET /api/archived/tasks
- Returns all archived tasks with their run info
- Response: { runs: Array<{ run: WorkflowRun; tasks: Task[] }> }

GET /api/archived/tasks/:taskId
- Returns single archived task details

GET /api/archived/runs
- Returns all archived workflow runs that have tasks
```

#### 4.2 API Hook for Archived Tasks
**File:** `src/kanban-react/src/hooks/useArchivedTasks.ts`

```typescript
interface UseArchivedTasksReturn {
  archivedRuns: ArchivedRun[]
  isLoading: boolean
  error: string | null
  loadArchivedTasks: () => Promise<void>
  refreshArchivedTasks: () => Promise<void>
}

interface ArchivedRun {
  run: WorkflowRun
  tasks: ArchivedTask[]
  taskCount: number
}

interface ArchivedTask extends Task {
  sessionId: string | null
  completedAt: number | null
}
```

#### 4.3 ArchivedTasksTab Component
**File:** `src/kanban-react/src/components/tabs/ArchivedTasksTab.tsx`

**Layout:**
- Collapsible sections for each workflow run
- Each section shows run name, date, task count
- Tasks displayed as cards (reuse `TaskCard` component)
- Full task details available on click
- Clicking task title opens session chat (reuse SessionModal)

**IMPORTANT: Archived tasks are read-only.** There is no way to restore archived tasks back to the kanban.

**Features:**
- Search/filter archived tasks
- Expand/collapse run sections
- View task details (same as kanban task modal, read-only)
- View session chat history
- Sort by date, name, or status

**Component Structure:**
```typescript
// Sub-components:
ArchivedTasksTab.tsx          // Main container (read-only)
ArchivedRunSection.tsx        // Collapsible run group
ArchivedTaskCard.tsx          // Task card (uses existing TaskCard)
ArchivedTaskDetail.tsx        // Task detail modal (view-only, no restore action)
```

### Phase 5: Stats Tab (with Recharts)

#### 5.1 Database Stats Queries
**File:** `src/db.ts` - Add aggregation methods

```typescript
// Get token/cost statistics for time ranges
getUsageStats(range: '24h' | '7d' | '30d' | 'lifetime'): UsageStats

// Get task completion statistics
getTaskStats(): TaskStats

// Get model usage breakdown
getModelUsageByResponsibility(): ModelUsageStats

// Get average task duration
getAverageTaskDuration(): number

// Get hourly token/cost time series (for 24h view)
getHourlyUsageTimeSeries(): HourlyUsage[]

// Get daily token/cost time series (for 7d/30d views)
getDailyUsageTimeSeries(days: number): DailyUsage[]
```

```typescript
interface UsageStats {
  totalTokens: number
  totalCost: number
  tokenChange: number  // percentage vs previous period
  costChange: number
}

interface TaskStats {
  completed: number
  failed: number
  averageReviews: number
}

interface ModelUsageStats {
  plan: Array<{ model: string; count: number }>
  execution: Array<{ model: string; count: number }>
  review: Array<{ model: string; count: number }>
}

interface DailyUsage {
  date: string
  tokens: number
  cost: number
}

interface HourlyUsage {
  hour: string      // ISO timestamp for the hour
  tokens: number
  cost: number
}
```

#### 5.2 API Endpoints for Stats
**File:** `src/server/server.ts` - Add stats endpoints

```
GET /api/stats/usage?range=24h|7d|30d|lifetime
GET /api/stats/tasks
GET /api/stats/models
GET /api/stats/duration
GET /api/stats/timeseries/hourly    # Returns hourly data for last 24h
GET /api/stats/timeseries/daily?days=30  # Returns daily data for specified days
```

#### 5.3 Stats Hook
**File:** `src/kanban-react/src/hooks/useStats.ts`

```typescript
interface UseStatsReturn {
  usageStats: UsageStats
  taskStats: TaskStats
  modelUsage: ModelUsageStats
  averageDuration: number
  hourlyUsage: HourlyUsage[]      // For 24h view (hourly granularity)
  dailyUsage7d: DailyUsage[]      // For 7d view (daily granularity)
  dailyUsage30d: DailyUsage[]     // For 30d view (daily granularity)
  isLoading: boolean
  error: string | null
  loadAllStats: () => Promise<void>
}
```

#### 5.4 StatsTab Component with Recharts
**File:** `src/kanban-react/src/components/tabs/StatsTab.tsx`

**Install Recharts:**
```bash
cd src/kanban-react && npm install recharts
```

**Layout (default view: weekly):**
```
┌─────────────────────────────────────────────────────────────┐
│  Token & Cost Overview                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ Last 24h │ │ Last 7d  │ │ Last 30d │ │ Lifetime  │     │
│  │ 1.2M tok │ │ 8.5M tok │ │ 32M tok  │ │ 156M tok  │     │
│  │ $4.50    │ │ $32.10   │ │ $128.40  │ │ $590.20   │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
├─────────────────────────────────────────────────────────────┤
│  Task Statistics                                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │ Done     │ │ Failed   │ │ Avg Revs │                   │
│  │   247    │ │    12    │ │   1.8    │                   │
│  └──────────┘ └──────────┘ └──────────┘                   │
├─────────────────────────────────────────────────────────────┤
│  Token & Cost Over Time                                     │
│  [24h] [7d*] [30d]  ← Toggle buttons (7d is default)    │
│  [Line Chart - Recharts]                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │     ╱╲    ╱╲                                        │   │
│  │   ╱    ╲╱    ╲                                      │   │
│  │ ─╱──────────────╲────────────────────────────────── │   │
│  └─────────────────────────────────────────────────────┘   │
│  * 24h = hourly data, 7d/30d = daily data                │
├─────────────────────────────────────────────────────────────┤
│  Most Used Models                                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│  │ Plan Model  │ │ Exec Model  │ │Review Model │         │
│  │ [Bar Chart] │ │ [Bar Chart] │ │ [Bar Chart] │         │
│  │ claude-3.5  │ │ o3-mini     │ │ o4-mini     │         │
│  │ 45% ████░░  │ │ 62% █████░  │ │ 38% ███░░░  │         │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
├─────────────────────────────────────────────────────────────┤
│  Average Task Duration                                      │
│  [Stat Card]                                                │
│  2h 34m avg                                                │
└─────────────────────────────────────────────────────────────┘
```

**Time Series Data Granularity:**
- **24h view**: Hourly granularity (24 data points)
- **7d view**: Daily granularity (7 data points) - **DEFAULT**
- **30d view**: Daily granularity (30 data points)

**Components:**
```typescript
StatsTab.tsx                    // Main container with scroll
TokenCostOverview.tsx          // 4 stat cards for tokens/costs
TaskStatsOverview.tsx          // Done/Failed/Avg Reviews
UsageLineChart.tsx             // Line chart with Recharts
UsageLineChartToggle.tsx       // Toggle between 24h/7d/30d views
ModelUsageBarChart.tsx          // Bar chart with Recharts
AverageDurationCard.tsx         // Simple stat display
```

**Recharts Implementation:**
```typescript
// Line Chart for token/cost over time
<LineChart data={dailyUsage}>
  <Line type="monotone" dataKey="tokens" stroke="#6366f1" />
  <Line type="monotone" dataKey="cost" stroke="#10b981" />
  <XAxis dataKey="date" />
  <YAxis />
  <Tooltip />
</LineChart>

// Bar Chart for model usage
<BarChart data={modelUsage}>
  <Bar dataKey="count" fill="#6366f1" />
  <XAxis dataKey="model" />
  <YAxis />
  <Tooltip />
</BarChart>
```

### Phase 6: Session Chat Integration for Archived Tasks

#### 6.1 Reuse Existing SessionModal
The `SessionModal` component already handles session viewing. Integrate it with ArchivedTasksTab:

```typescript
// In ArchivedTasksTab.tsx
const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

{selectedSessionId && (
  <SessionModal 
    sessionId={selectedSessionId} 
    onClose={() => setSelectedSessionId(null)} 
  />
)}
```

### Phase 7: Final Integration

#### 7.1 Update TopBar
Remove project name breadcrumb from TopBar (replaced by TabBar)

#### 7.2 Update App Layout
```tsx
<main className="main-content">
  <TopBar />  {/* Keep for keyboard hints */}
  <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
  
  <div className="tab-content">
    {activeTab === 'kanban' && <KanbanBoard ... />}
    {activeTab === 'options' && <OptionsTab onSave={handleOptionsSave} onCancel={...} />}
    {activeTab === 'containers' && <ContainersTab />}
    {activeTab === 'archived' && <ArchivedTasksTab />}
    {activeTab === 'stats' && <StatsTab />}
  </div>
  
  <TabbedLogPanel ... />
</main>
```

#### 7.3 Keyboard Shortcuts
Add new keyboard shortcut `Ctrl+1-5` to switch tabs.

## File Changes Summary

### New Files
```
src/kanban-react/src/
├── components/tabs/
│   ├── TabBar.tsx
│   ├── OptionsTab.tsx
│   ├── ContainersTab.tsx
│   ├── ArchivedTasksTab.tsx
│   │   ├── ArchivedRunSection.tsx
│   │   └── ArchivedTaskCard.tsx
│   └── StatsTab.tsx
│       ├── TokenCostOverview.tsx
│       ├── TaskStatsOverview.tsx
│       ├── UsageLineChart.tsx
│       ├── UsageLineChartToggle.tsx
│       ├── ModelUsageBarChart.tsx
│       └── AverageDurationCard.tsx
├── contexts/
│   └── TabContext.tsx
└── hooks/
    ├── useArchivedTasks.ts
    └── useStats.ts

### Package Updates
```bash
# Add to src/kanban-react/package.json
npm install recharts
```

### Modified Files
```
src/
├── db.ts                        # Add archived tasks queries
├── db/types.ts                   # Add stats types
├── server/server.ts              # Add stats API endpoints
└── kanban-react/src/
    ├── App.tsx                   # Integrate tabs
    ├── components/board/
    │   ├── Sidebar.tsx           # Remove Options/Containers buttons
    │   └── TopBar.tsx            # Remove project breadcrumb
    └── package.json              # Add recharts dependency
```

## Technical Considerations

### Database Queries
- Archived tasks query should be efficient (use indexes on `is_archived`, `archived_at`)
- Stats aggregation queries should consider caching for expensive aggregations
- Use SQL `GROUP BY` for efficient grouping

### Performance
- Lazy load archived tasks and stats data
- Implement virtual scrolling for large archived task lists
- Cache stats data with reasonable TTL

### Error Handling
- Show loading states during data fetch
- Display clear error messages
- Provide retry mechanisms

### Accessibility
- Tab navigation with keyboard (arrow keys)
- ARIA labels for tabs
- Focus management when switching tabs
