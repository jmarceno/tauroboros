# Workflow Run Clean/Reset Feature

## Overview

Add a **"Clean Run"** button to the workflow run card (bottom panel) that resets all tasks in the run back to a clean state, allowing users to restart the workflow from scratch without manual database operations.

**Design Goals:**
- **Safe**: Preserves task definitions, only resets execution state
- **Complete**: Cleans all associated data (sessions, runs, reports)
- **Fast**: Database operations complete in <100ms
- **User-controlled**: One-click action with confirmation

---

## Technical Approach

### Reset Operations

Based on the successful database cleanup performed for the "Fix Self-Healing Architecture" group, the clean operation performs these atomic changes:

#### Task State Reset (per task in run)
```typescript
// Core state
status: "backlog"
executionPhase: "not_started"
errorMessage: null
agentOutput: ""

// Counters
reviewCount: 0
jsonParseRetryCount: 0
planRevisionCount: 0
awaitingPlanApproval: 0

// References
worktreeDir: null
sessionId: null
sessionUrl: null
completedAt: null

// Self-healing state
selfHealStatus: "idle"
selfHealMessage: null
selfHealReportId: null
reviewActivity: "idle"
```

#### Associated Data Cleanup
```sql
-- Delete task execution records
DELETE FROM task_runs WHERE task_id IN (run.taskOrder);
DELETE FROM task_candidates WHERE task_id IN (run.taskOrder);

-- Delete sessions and messages
DELETE FROM session_messages WHERE session_id IN (
  SELECT id FROM workflow_sessions WHERE task_id IN (run.taskOrder)
);
DELETE FROM workflow_sessions WHERE task_id IN (run.taskOrder);

-- Delete self-heal reports
DELETE FROM self_heal_reports WHERE task_id IN (run.taskOrder);

-- Delete the workflow run itself
DELETE FROM workflow_runs WHERE id = run.id;
```

#### Worktree Cleanup
```bash
# Prune orphaned git worktrees
git worktree prune

# Remove worktree directories if still exist
rm -rf .worktrees/<task-name>-*/
```

---

## Integration Points

### 1. Backend API Endpoint

**Location:** Add to server routes (`src/server/routes/`)

```typescript
POST /api/workflow-runs/:id/clean

Request: { confirm: boolean }
Response: { 
  success: boolean, 
  tasksReset: number,
  sessionsDeleted: number,
  runsDeleted: number,
  message: string 
}

Errors:
- 404: Run not found
- 400: Run is currently active (status: running/queued/paused)
- 403: Run is already being cleaned by another request
```

**Implementation Location:** New file `src/server/routes/workflow-run-routes.ts` or extend existing routes

**Effect Implementation:**
```typescript
// src/orchestrator/clean-run.ts
export function cleanWorkflowRun(
  runId: string,
  context: OrchestratorContext
): Effect.Effect<CleanRunResult, CleanRunError> {
  return Effect.gen(function* () {
    // 1. Validate run exists and is not active
    const run = context.db.getWorkflowRun(runId)
    if (!run) return yield* new CleanRunError({ code: "RUN_NOT_FOUND" })
    if (isRunActive(run.status)) {
      return yield* new CleanRunError({ 
        code: "RUN_ACTIVE",
        message: "Cannot clean an active workflow run" 
      })
    }

    // 2. Clean tasks
    let tasksReset = 0
    for (const taskId of run.taskOrder) {
      context.db.updateTask(taskId, {
        status: "backlog",
        executionPhase: "not_started",
        errorMessage: null,
        agentOutput: "",
        worktreeDir: null,
        sessionId: null,
        sessionUrl: null,
        completedAt: null,
        selfHealStatus: "idle",
        selfHealMessage: null,
        selfHealReportId: null,
        reviewCount: 0,
        jsonParseRetryCount: 0,
        planRevisionCount: 0,
        awaitingPlanApproval: 0,
        reviewActivity: "idle",
      })
      tasksReset++
    }

    // 3. Clean associated data
    const sessionsDeleted = context.db.deleteSessionsForTasks(run.taskOrder)
    const taskRunsDeleted = context.db.deleteTaskRunsForTasks(run.taskOrder)
    const candidatesDeleted = context.db.deleteCandidatesForTasks(run.taskOrder)
    const reportsDeleted = context.db.deleteSelfHealReportsForTasks(run.taskOrder)

    // 4. Delete the run
    context.db.deleteWorkflowRun(runId)

    // 5. Broadcast updates
    context.broadcast({ type: "run_cleaned", payload: { runId } })
    for (const taskId of run.taskOrder) {
      context.broadcast({ type: "task_updated", payload: { taskId, status: "backlog" } })
    }

    return {
      success: true,
      tasksReset,
      sessionsDeleted,
      runsDeleted: 1,
      message: `Reset ${tasksReset} tasks and deleted ${sessionsDeleted} sessions`
    }
  })
}
```

### 2. Database Methods

**Location:** `src/db.ts`

Add these methods to the PiKanbanDB class:

```typescript
/**
 * Delete all sessions associated with given task IDs
 */
deleteSessionsForTasks(taskIds: string[]): number {
  const placeholders = taskIds.map(() => "?").join(",")
  
  // First delete session messages (foreign key constraint)
  const messagesResult = this.db.prepare(`
    DELETE FROM session_messages 
    WHERE session_id IN (
      SELECT id FROM workflow_sessions WHERE task_id IN (${placeholders})
    )
  `).run(...taskIds)
  
  // Then delete sessions
  const sessionsResult = this.db.prepare(`
    DELETE FROM workflow_sessions WHERE task_id IN (${placeholders})
  `).run(...taskIds)
  
  return sessionsResult.changes
}

/**
 * Delete all task_runs for given task IDs
 */
deleteTaskRunsForTasks(taskIds: string[]): number {
  const placeholders = taskIds.map(() => "?").join(",")
  const result = this.db.prepare(`
    DELETE FROM task_runs WHERE task_id IN (${placeholders})
  `).run(...taskIds)
  return result.changes
}

/**
 * Delete all task_candidates for given task IDs
 */
deleteCandidatesForTasks(taskIds: string[]): number {
  const placeholders = taskIds.map(() => "?").join(",")
  const result = this.db.prepare(`
    DELETE FROM task_candidates WHERE task_id IN (${placeholders})
  `).run(...taskIds)
  return result.changes
}

/**
 * Delete all self_heal_reports for given task IDs
 */
deleteSelfHealReportsForTasks(taskIds: string[]): number {
  const placeholders = taskIds.map(() => "?").join(",")
  const result = this.db.prepare(`
    DELETE FROM self_heal_reports WHERE task_id IN (${placeholders})
  `).run(...taskIds)
  return result.changes
}
```

### 3. Orchestrator Integration

**Location:** `src/orchestrator.ts` - add public method

```typescript
/**
 * Clean/reset a workflow run and all its tasks
 */
cleanRun(runId: string): Effect.Effect<CleanRunResult, OrchestratorOperationError> {
  return this.wrapOperation("cleanRun", Effect.gen(this, function* () {
    const result = yield* cleanWorkflowRun(runId, {
      db: this.db,
      broadcast: this.broadcast,
    })
    return result
  }))
}
```

---

## User Experience

### Kanban UI Changes

#### 1. Workflow Run Card (Bottom Panel)

**Location:** `src/kanban-solid/src/components/WorkflowRunCard.tsx` or similar

Add to the run card footer/actions area:

```tsx
// In the run card component, add to action buttons
<div class="run-actions">
  {/* Existing buttons */}
  <button 
    class="btn-clean"
    onClick={() => handleCleanRun(run)}
    disabled={isRunActive(run.status)}
    title={isRunActive(run.status) ? "Cannot clean active run" : "Reset all tasks to start fresh"}
  >
    <svg class="icon-clean">{/* broom/refresh icon */}</svg>
    Clean Run
  </button>
</div>
```

**Design Specifications:**
- Button style: Secondary action (ghost/outline style)
- Icon: Refresh/broom icon (suggests "cleaning")
- Position: Right side of run card actions
- Disabled state: When run is active (running/queued/paused)
- Hover tooltip: Explains what the button does

#### 2. Confirmation Modal

**Location:** `src/kanban-solid/src/components/modals/CleanRunModal.tsx`

```tsx
// New modal component
export function CleanRunModal(props: { run: WorkflowRun; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal title="Clean Workflow Run">
      <div class="modal-body">
        <p class="warning-text">
          This will reset all {props.run.taskOrder.length} tasks in this run to their initial state.
        </p>
        <ul class="affected-list">
          <li>Task execution state will be cleared</li>
          <li>All sessions and logs will be deleted</li>
          <li>Self-healing reports will be removed</li>
          <li>Tasks will return to "backlog" status</li>
        </ul>
        <p class="note-text">Task definitions and prompts will be preserved.</p>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onClick={props.onCancel}>Cancel</button>
        <button class="btn-danger" onClick={props.onConfirm}>Clean Run</button>
      </div>
    </Modal>
  )
}
```

#### 3. Success/Error Notifications

```tsx
// After successful clean
showNotification({
  type: "success",
  title: "Run Cleaned",
  message: `Reset ${result.tasksReset} tasks. Ready to restart.`
})

// On error
showNotification({
  type: "error",
  title: "Clean Failed",
  message: error.message
})
```

---

## Implementation Plan

### Phase 1: Backend Infrastructure

1. **Database Methods (src/db.ts)**
   - [ ] Add `deleteSessionsForTasks(taskIds: string[]): number`
   - [ ] Add `deleteTaskRunsForTasks(taskIds: string[]): number`
   - [ ] Add `deleteCandidatesForTasks(taskIds: string[]): number`
   - [ ] Add `deleteSelfHealReportsForTasks(taskIds: string[]): number`

2. **Clean Run Module (src/orchestrator/clean-run.ts)**
   - [ ] Create `CleanRunError` tagged error type
   - [ ] Implement `cleanWorkflowRun()` Effect function
   - [ ] Define `CleanRunResult` interface
   - [ ] Add comprehensive logging

3. **Orchestrator Integration**
   - [ ] Add `cleanRun(runId: string)` public method
   - [ ] Wire up to context

4. **Server Routes**
   - [ ] Create/extend route file for workflow runs
   - [ ] Add `POST /api/workflow-runs/:id/clean` endpoint
   - [ ] Implement request validation
   - [ ] Add error handling

### Phase 2: Frontend UI

1. **API Integration**
   - [ ] Add `cleanRun()` method to workflow runs API client
   - [ ] Create Solid JS mutation for clean action
   - [ ] Handle loading states

2. **Workflow Run Card**
   - [ ] Add Clean button to run card component
   - [ ] Implement disabled state logic (active runs)
   - [ ] Add tooltip/help text
   - [ ] Style button (icon + text)

3. **Confirmation Modal**
   - [ ] Create CleanRunModal component
   - [ ] Show task count and affected items
   - [ ] Implement confirm/cancel actions

4. **Notifications**
   - [ ] Add success notification with task count
   - [ ] Add error notification
   - [ ] Update run list after clean

### Phase 3: Testing

1. **Unit Tests**
   - [ ] Test database delete methods
   - [ ] Test cleanWorkflowRun Effect
   - [ ] Test API endpoint validation

2. **Integration Tests**
   - [ ] Test full clean flow end-to-end
   - [ ] Test with failed run
   - [ ] Test with completed run
   - [ ] Test with partially completed run

3. **Edge Cases**
   - [ ] Test cleaning already-clean run
   - [ ] Test cleaning non-existent run
   - [ ] Test cleaning active run (should fail)

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Run is active | Button disabled, API returns 400 error |
| Run already cleaned | Button shows "Already Clean", no-op on click |
| Partially completed run | Cleans completed and failed tasks equally |
| Missing worktree directories | Continues cleaning (prune handles orphans) |
| Database transaction failure | Rollback all changes, report error |
| Concurrent clean requests | Lock run during clean, reject duplicate requests |
| Run has 0 tasks | Success with message "No tasks to clean" |

---

## API Specification

### Clean Workflow Run

```http
POST /api/workflow-runs/:id/clean
Content-Type: application/json

{
  "confirm": true  // Required confirmation flag
}
```

**Success Response (200):**
```json
{
  "success": true,
  "tasksReset": 8,
  "sessionsDeleted": 86,
  "runsDeleted": 1,
  "message": "Reset 8 tasks and deleted 86 sessions. Ready to restart."
}
```

**Error Response (400):**
```json
{
  "success": false,
  "error": "RUN_ACTIVE",
  "message": "Cannot clean an active workflow run. Stop the run first."
}
```

**Error Response (404):**
```json
{
  "success": false,
  "error": "RUN_NOT_FOUND",
  "message": "Workflow run not found"
}
```

---

## WebSocket Events

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `run_cleaned` | Server → Client | `{ runId: string }` | Notify all clients run was cleaned |
| `task_updated` | Server → Client | `{ taskId: string, status: "backlog" }` | Individual task reset notification |

---

## Benefits

1. **User empowerment**: Self-service reset without manual database edits
2. **Safety**: Preserves task definitions, only resets execution state
3. **Speed**: Complete clean in <100ms database time
4. **Completeness**: Removes all associated data (sessions, reports, runs)
5. **Visibility**: UI shows exactly what will be affected before confirmation

---

## Alternative Approaches Considered

| Alternative | Why Not Used |
|-------------|--------------|
| Per-task clean button | Too granular for "start fresh" use case |
| Auto-clean on restart | Loses history, user may want to inspect failures |
| Soft delete (archive) | Keeps data, doesn't solve "fresh start" need |
| CLI-only command | Most users interact via UI |

---

## Open Questions

1. Should we keep a "clean log" for audit purposes?
2. Should cleaned runs be recoverable (soft delete)?
3. Do we want a "clean all runs" bulk action?
4. Should worktree cleanup be async (background job)?
5. Do we need to clean container volumes too?

---

## Decision Log

- **Per-run clean button**: Located in run card, not global
- **Confirmation required**: Prevent accidental cleans
- **Hard delete**: Fully remove data, no soft delete
- **Active run protection**: Disable button + API validation
- **Broadcast updates**: All clients see cleaned state immediately
