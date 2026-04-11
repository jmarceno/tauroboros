# Kanban Features Implementation Plan 

**Date**: 2026-04-10
**Status**: ✅ COMPLETED - All 5 features implemented and tested

---

## Executive Summary

This document outlines the implementation plan for five new features in the kanban-vue application:

1. **Multi-Select Task Editing** - Edit multiple tasks simultaneously with Ctrl/Cmd+click
2. **Column Sorting** - Sort kanban columns by name, creation date, or update date
3. **Visual Markdown Editor** - Replace textarea with TipTap WYSIWYG editor
4. **Review Count Fix** - Ensure review count increments after every review attempt
5. **Token/Cost Tracking** - Display session usage and task costs

---

## Implementation Summary

All 5 features have been successfully implemented and are included in the build:

| Feature | Status | Files Modified/Created |
|---------|--------|----------------------|
| **1. Multi-Select Task Editing** | ✅ Complete | `useMultiSelect.ts`, `BatchEditModal.vue`, `TaskCard.vue`, `KanbanBoard.vue`, `KanbanColumn.vue`, `App.vue` |
| **2. Column Sorting** | ✅ Complete | `api.ts`, `useTasks.ts`, `KanbanColumn.vue`, `KanbanBoard.vue`, `App.vue`, `useOptions.ts` |
| **3. TipTap Markdown Editor** | ✅ Complete | `MarkdownEditor.vue`, `TaskModal.vue` + 6 new dependencies |
| **4. Review Count Fix** | ✅ Complete | `orchestrator.ts` (backend) |
| **5. Token/Cost Display** | ✅ Complete | `api.ts`, `useSessionUsage.ts`, `SessionModal.vue`, `TaskCard.vue`, `useApi.ts` |

**Build Status**: All features compile successfully. The kanban-vue production build increased from ~117KB to ~488KB (JS) due to TipTap editor dependencies.

---

## Feature 1: Multi-Select Task Editing

### Overview
Allow users to select multiple tasks with Ctrl/Cmd+click and edit their shared properties in a batch modal. This enables efficient batch updates for tasks that share common settings.

### Editable Properties (All Except)
- ❌ **name** - Not editable in batch (task-specific)
- ❌ **prompt** - Not editable in batch (task-specific)
- ❌ **requirements** - Not editable (per user request, Option A)

### Editable Shared Properties
| Property | Type | UI Component |
|----------|------|--------------|
| branch | string | Dropdown |
| planModel | string | ModelPicker |
| executionModel | string | ModelPicker |
| planmode | boolean | Checkbox |
| autoApprovePlan | boolean | Checkbox |
| review | boolean | Checkbox |
| autoCommit | boolean | Checkbox |
| deleteWorktree | boolean | Checkbox |
| skipPermissionAsking | boolean | Checkbox |
| thinkingLevel | ThinkingLevel | Dropdown |
| executionStrategy | ExecutionStrategy | Dropdown |
| bestOfNConfig | BestOfNConfig | Conditional section |
| maxReviewRunsOverride | number | Number input |

### Files to Create/Modify

#### New Files
```
src/kanban-vue/src/composables/useMultiSelect.ts       # Selection state management
src/kanban-vue/src/components/modals/BatchEditModal.vue  # Batch edit UI
```

#### Modified Files
```
src/kanban-vue/src/components/board/TaskCard.vue       # Add selection visuals + Ctrl+click handler
src/kanban-vue/src/components/board/KanbanColumn.vue # Provide selection handlers
src/kanban-vue/src/components/board/KanbanBoard.vue  # Add floating action bar
src/kanban-vue/src/App.vue                           # Provide useMultiSelect, add modal
```

### Implementation Details

#### Selection State (useMultiSelect.ts)
```typescript
export function useMultiSelect() {
  const selectedTaskIds = ref<Set<string>>(new Set())
  const isSelecting = computed(() => selectedTaskIds.value.size > 0)
  
  const toggleSelection = (taskId: string, event: MouseEvent) => {
    if (!event.ctrlKey && !event.metaKey) return false
    
    const newSet = new Set(selectedTaskIds.value)
    if (newSet.has(taskId)) {
      newSet.delete(taskId)
    } else {
      newSet.add(taskId)
    }
    selectedTaskIds.value = newSet
    return true
  }
  
  const clearSelection = () => selectedTaskIds.value.clear()
  const isSelected = (taskId: string) => selectedTaskIds.value.has(taskId)
  
  return { selectedTaskIds, isSelecting, toggleSelection, clearSelection, isSelected }
}
```

#### Batch Edit API Strategy
Use existing individual `PATCH /api/tasks/:id` endpoint in a loop:
```typescript
const updateTasks = async (taskIds: string[], data: UpdateTaskDTO) => {
  const results = await Promise.all(
    taskIds.map(id => api.updateTask(id, data))
  )
  return results
}
```

#### UI for Mixed Values
When selected tasks have different values for a field:
- **Checkboxes**: Show indeterminate state (filled square)
- **Dropdowns**: Show "—" placeholder
- **Number inputs**: Show "—" placeholder
- Only update fields the user explicitly modifies

#### Visual Selection Indicators
- Selected cards: Add `ring-2 ring-accent-primary` class
- Non-selected cards when selecting: Slightly reduced opacity (`opacity-80`)
- Floating action bar at bottom: Shows "X tasks selected" + "Edit" button + "Clear" button

---

## Feature 2: Kanban Column Sorting

### Overview
Allow users to change the sorting of tasks in each kanban column. Preferences persisted globally in Options so all users see the same order.

### Sort Options
| Option | Description | Available In |
|--------|-------------|--------------|
| `manual` | Manual order (idx-based) | template, backlog |
| `name-asc` | Name A-Z | all columns |
| `name-desc` | Name Z-A | all columns |
| `created-asc` | Oldest first | all columns |
| `created-desc` | Newest first | all columns |
| `updated-asc` | Least recently updated | all columns |
| `updated-desc` | Most recently updated | all columns |

### Persistence Strategy
Store preferences in the existing `Options` object:
```typescript
export interface Options {
  // ... existing fields
  columnSorts?: ColumnSortPreferences
}

export interface ColumnSortPreferences {
  template?: ColumnSortOption
  backlog?: ColumnSortOption
  executing?: ColumnSortOption
  review?: ColumnSortOption
  done?: ColumnSortOption
}
```

### Files to Modify
```
src/kanban-vue/src/types/api.ts           # Add types
src/kanban-vue/src/composables/useTasks.ts # Update groupedTasks sorting logic
src/kanban-vue/src/components/board/KanbanColumn.vue # Add sort dropdown
src/server/server.ts                      # Update Options schema
```

### Implementation Details

#### Sorting Logic (in groupedTasks computed)
```typescript
const getSortFn = (option: ColumnSortOption): ((a: Task, b: Task) => number) => {
  switch (option) {
    case 'name-asc': return (a, b) => a.name.localeCompare(b.name)
    case 'name-desc': return (a, b) => b.name.localeCompare(a.name)
    case 'created-asc': return (a, b) => a.createdAt - b.createdAt
    case 'created-desc': return (a, b) => b.createdAt - a.createdAt
    case 'updated-asc': return (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)
    case 'updated-desc': return (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    default: return (a, b) => a.idx - b.idx
  }
}
```

#### Drag-and-Drop Behavior
- Disable drag when column sort is not "manual"
- Show visual indicator that drag is disabled (cursor: not-allowed)

---

## Feature 3: TipTap Visual Markdown Editor

### Overview
Replace the plain textarea prompt input with a full WYSIWYG markdown editor using TipTap. Style should match TipTap's "Simple Editor" example with a clean toolbar.

### Requirements
- ✅ Full WYSIWYG (no split-pane)
- ✅ Toolbar with formatting buttons
- ✅ Resizable editor area
- ✅ Dark theme matching kanban (slate/indigo palette)
- 🎯 Stretch: Maximize button to expand to full modal

### Dependencies
```bash
npm install @tiptap/vue-3 @tiptap/starter-kit @tiptap/extension-link
npm install @tiptap/extension-placeholder @tiptap/extension-underline
npm install @tiptap/extension-code-block-lowlight lowlight
```

### Files to Create/Modify

#### New Files
```
src/kanban-vue/src/components/common/MarkdownEditor.vue    # Main editor component
src/kanban-vue/src/components/common/ToolbarButton.vue     # Reusable toolbar button
src/kanban-vue/src/styles/tiptap.css                        # TipTap custom dark theme
```

#### Modified Files
```
src/kanban-vue/src/components/modals/TaskModal.vue         # Replace textarea with MarkdownEditor
```

### Toolbar Items (Simple Editor Style)
Based on the screenshot reference:

**Row 1**: History + Block types
- Undo, Redo
- Paragraph, H1, H2, H3

**Row 2**: Formatting
- Bold, Italic, Underline, Strikethrough
- Code, Code block
- Blockquote

**Row 3**: Lists & Links
- Bullet list, Ordered list
- Link (with URL input)
- Clear formatting

### Styling Requirements
- Background: `bg-dark-surface2`
- Border: `border border-dark-surface3 rounded-lg`
- Toolbar: `bg-dark-surface border-b border-dark-surface3`
- Active button: `bg-accent-primary text-white`
- Content area: `p-3 min-h-[200px] resize-y`

### Resizable Implementation
```css
.markdown-editor-content {
  min-height: 200px;
  max-height: 500px;
  resize: vertical;
  overflow-y: auto;
}
```

### Maximize Stretch Goal
Add a maximize button that:
1. Opens the editor in a full-screen overlay modal
2. Shows the same toolbar + content
3. "Close" button returns to normal TaskModal view
4. Changes are synced between views

---

## Feature 4: Review Count Fix

### Overview
Fix the backend logic so that `reviewCount` increments after every review attempt, not just on failures. Currently, tasks that pass review on the first attempt show "review 0/N" instead of "review 1/N".

### Current Bug (src/orchestrator.ts ~lines 377-423)
```typescript
while (reviewCount < maxRuns) {
  // Run review...
  
  if (reviewRun.reviewResult.status === "pass") {
    // BUG: Returns WITHOUT incrementing reviewCount!
    return true
  }
  
  // Only increments on failure:
  reviewCount += 1
  this.db.updateTask(taskId, { reviewCount, reviewActivity: "idle" })
}
```

### Fix
Move the increment to happen immediately after each review completes:
```typescript
while (reviewCount < maxRuns) {
  // Run review...
  
  // FIX: Increment for ALL reviews (pass or fail)
  reviewCount += 1
  this.db.updateTask(taskId, { reviewCount, reviewActivity: "idle" })
  this.broadcastTask(taskId)
  
  if (reviewRun.reviewResult.status === "pass") {
    this.db.updateTask(taskId, { status: "executing", reviewActivity: "idle" })
    this.broadcastTask(taskId)
    return true
  }
  
  // Handle failures (reviewCount already incremented)
  if (reviewRun.reviewResult.status === "blocked") {
    // ...
    return false
  }
  
  if (reviewCount >= maxRuns) {
    // ...
    return false
  }
  
  // Continue to next review iteration
}
```

### Files to Modify
```
src/orchestrator.ts   # Lines 377-435 in runReviewLoop method
```

### Testing
After fix:
- Task passes review on 1st attempt → shows "review 1/2"
- Task fails 1st, passes 2nd → shows "review 2/2"
- Task fails all → shows "review 2/2" (at max)

---

## Feature 5: Token/Cost Tracking

### Overview
Display token usage and cost information in two places:
1. **SessionModal**: Show detailed usage for the currently viewed session
2. **TaskCard footer**: Show aggregated cost for the task

### Data Sources
- **API**: `GET /api/sessions/:id/usage` → `SessionUsageRollup`
- **Existing fields**: `promptTokens`, `completionTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `totalCost`

### Files to Create/Modify

#### New Files
```
src/kanban-vue/src/composables/useSessionUsage.ts    # Fetch and cache usage data
```

#### Modified Files
```
src/kanban-vue/src/components/modals/SessionModal.vue   # Display usage in header
src/kanban-vue/src/components/board/TaskCard.vue         # Add cost badge to footer
src/kanban-vue/src/types/api.ts                          # Add usage types
```

### SessionModal Display
Show compact usage stats in the modal header:
```
💰 $0.024  |  🪙 4.2k tokens
```

Expandable details (click to expand):
```
Session Usage
├── Prompt: 1,234 tokens
├── Completion: 2,456 tokens
├── Cache (read): 890 tokens
├── Cache (write): 400 tokens
└── Total: 4,980 tokens | $0.044
```

### TaskCard Footer Display
```typescript
// Only show when totalCost > 0
<div class="task-footer">
  <span class="cost-badge" v-if="usage?.totalCost">
    💰 ${{ usage.totalCost.toFixed(3) }}
  </span>
</div>
```

### Backend Considerations
Currently `task.sessionId` only tracks the main implementation session. Review sessions are created but not explicitly tracked per task. Options:

**Option A (Simpler)**: Query all sessions by taskId
- Add `GET /api/tasks/:id/sessions` endpoint
- Filter by session type (planning, implementation, review)

**Option B**: Track all session IDs on task object
- Add `planSessionId?: string`
- Add `reviewSessionIds: string[]`
- Update orchestrator to populate these

**Recommendation**: Start with Option A for SessionModal (current session only), then enhance TaskCard aggregation later.

---

## Implementation Order

### Phase 1: Quick Wins (~2 hours)
1. **Feature 4: Review Count Fix**
   - Single file backend change
   - Immediate user value
   - Risk: Low

### Phase 2: Core Features (~8-10 hours)
2. **Feature 1: Multi-Select Editing**
   - High user impact
   - Frontend-only (uses existing API)
   - Dependencies: None

3. **Feature 2: Column Sorting**
   - Enhances daily workflow
   - Requires Options schema update
   - Dependencies: None

### Phase 3: Advanced Features (~6-8 hours)
4. **Feature 3: TipTap Editor**
   - Major UX improvement
   - Dependency installation required
   - Most complex UI component

5. **Feature 5: Token/Cost Display**
   - May need backend enhancement
   - Depends on session tracking architecture
   - Can start with SessionModal only

---

## Technical Notes

### Keyboard Shortcuts
| Feature | Shortcut | Action |
|---------|----------|--------|
| Multi-Select | `Ctrl/Cmd + Click` | Toggle task selection |
| Multi-Select | `Escape` | Clear selection |
| Markdown | `Ctrl/Cmd + B` | Bold |
| Markdown | `Ctrl/Cmd + I` | Italic |

### Performance Considerations
- Batch edit: Parallel API calls with `Promise.all()`
- Column sorting: Computed properties (cached)
- TipTap editor: Lazy-load for view-only mode
- Cost display: Cache usage data, refresh on modal open

### Accessibility
- All new UI elements need proper ARIA labels
- Toolbar buttons need tooltips
- Color alone should not convey information (use icons + text)

---

## Testing Checklist

### Feature 1: Multi-Select
- [ ] Ctrl+click selects/deselects single task
- [ ] Visual indicators appear on selected cards
- [ ] Floating action bar appears with correct count
- [ ] Batch edit modal opens with correct title
- [ ] Mixed values shown as indeterminate
- [ ] Save updates all selected tasks
- [ ] Clear selection button works
- [ ] Escape key clears selection

### Feature 2: Column Sorting
- [ ] Sort dropdown appears in each column header
- [ ] Manual sort preserved for backlog/template
- [ ] Name/date sorts work correctly
- [ ] Drag disabled when not manual
- [ ] Preferences persist across page reloads
- [ ] Preferences shared across users (global)

### Feature 3: TipTap Editor
- [ ] Editor renders in TaskModal
- [ ] All toolbar buttons work
- [ ] Markdown output is correct
- [ ] Dark theme matches app
- [ ] Resizable (if implemented)
- [ ] Maximize mode works (stretch goal)
- [ ] View-only mode disables editing

### Feature 4: Review Count
- [ ] First-pass tasks show "review 1/N"
- [ ] Multi-pass tasks show correct count
- [ ] Max review limit still enforced
- [ ] Stuck tasks show correct count

### Feature 5: Token/Cost
- [ ] SessionModal shows usage data
- [ ] TaskCard shows cost badge (when > 0)
- [ ] Data loads correctly from API
- [ ] Error handling for missing data

---

## Success Criteria

All features are successful when:
1. Users can edit 5+ tasks simultaneously in under 10 seconds
2. Column sorting is intuitive and persists
3. Markdown editor feels modern and responsive
4. Review count accurately reflects attempts
5. Cost information helps users understand usage

---

## Appendix: Database Schema (for Feature 5)

### Existing (session_messages table)
```sql
prompt_tokens INTEGER
completion_tokens INTEGER
cache_read_tokens INTEGER
cache_write_tokens INTEGER
total_tokens INTEGER
cost_json TEXT
cost_total REAL
```

### Session Usage Query
```sql
SELECT
  COUNT(*) AS message_count,
  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(cost_total), 0) AS total_cost
FROM session_messages
WHERE session_id = ?
```

---

## Testing Checklist

### Feature 1: Multi-Select Task Editing
- [x] Ctrl/Cmd+click selects/deselects tasks
- [x] Visual ring indicator on selected cards
- [x] Floating action bar appears with correct count
- [x] Edit button opens BatchEditModal
- [x] Mixed values show "(mixed)" indicator
- [x] Save updates all selected tasks
- [x] Clear button clears selection
- [x] Escape key clears selection

### Feature 2: Column Sorting
- [x] Sort dropdown in each column header
- [x] Manual sort works (preserves drag-and-drop)
- [x] Name/date sorts work correctly
- [x] Drag disabled when not manual sort
- [x] Preferences persist via Options API

### Feature 3: TipTap Markdown Editor
- [x] Editor renders in TaskModal
- [x] Toolbar buttons work (bold, italic, lists, etc.)
- [x] Markdown output is correct
- [x] Dark theme matches app
- [x] Maximize button expands to full screen
- [x] View-only mode disables editing

### Feature 4: Review Count Fix
- [x] First-pass tasks show "review 1/N"
- [x] Multi-pass tasks show correct count
- [x] Max review limit still enforced

### Feature 5: Token/Cost Display
- [x] SessionModal shows usage data in header
- [x] Expandable details show token breakdown
- [x] TaskCard shows cost badge when cost > 0
- [x] Formatters work correctly ($0.024, 4.2k tokens)

---

## Deployment Notes

1. **Backend Change (Feature 4)**: The review count fix requires restarting the Bun server to pick up changes to `src/orchestrator.ts`

2. **Dependencies (Feature 3)**: New TipTap dependencies are included in `package.json`. Run `npm install` in `src/kanban-vue/` to install them.

3. **Database**: No schema changes required. Feature 5 uses existing `session_messages` table columns.

4. **Build**: Run `npm run build` from project root to build backend + frontend together.

---

**Document Version**: 1.0
**Last Updated**: 2026-04-10
**Implementation Complete**: 2026-04-10
