# Pre-Execution Git Snapshots

## Overview

A lightweight, fast, git-native snapshot mechanism that automatically creates a backup of the current git state when a task starts executing. If anything goes wrong (bad rebase, destructive operation, failed execution), users can restore to the pre-execution state with a single action.

**Design Goals:**
- **Simple**: Uses native git commands (stash)
- **Fast**: ~100ms snapshot creation, no workflow delay
- **Safe**: Captures tracked, untracked, and staged files
- **User-controlled**: Auto-create, manual restore

---

## Technical Approach

### Snapshot Mechanism

Uses `git stash push --include-untracked` to capture the complete worktree state:

```bash
# When task starts executing
git stash push --include-untracked -m "pi-easy-workflow:snapshot:task-abc123:pre-execution:1699999999"
```

### Metadata Storage

Database table for tracking snapshots:

```typescript
interface TaskSnapshot {
  id: string              // snap_<uuid>
  taskId: string          // task_<uuid>
  taskRunId: string       // Which run this snapshot belongs to
  stashRef: string        // "stash@{n}" reference
  snapshotType: "auto_pre_execution" | "manual" | "pre_commit"
  createdAt: number
  restoredAt?: number     // If restored
  cleanedAt?: number      // If cleaned after success
}
```

---

## Integration Points

### 1. Snapshot Creation (Automatic)

**Location:** `orchestrator.executeTask()` after worktree setup (~line 1167)

```typescript
// After: this.activeWorktreeInfo = worktreeInfo
// Before: pre-execution command runs

const snapshot = await this.worktree.createSnapshot(worktreeInfo.directory, {
  taskId: task.id,
  taskRunId: this.currentRunId!,
  type: "auto_pre_execution",
  message: `pre-execution:${Date.now()}`
})

this.db.createTaskSnapshot(snapshot)
```

### 2. Snapshot Cleanup (Success)

**Location:** `orchestrator.executeTask()` after worktree.complete() (~line 1212)

```typescript
// After successful worktree.complete()
// Drop the stash - task succeeded

await this.worktree.dropSnapshot(worktreeInfo.directory, snapshot.stashRef)
this.db.markSnapshotCleaned(snapshot.id)
```

### 3. Snapshot Preservation (Failure)

**Location:** `orchestrator.executeTask()` catch block (~line 1226)

```typescript
// Task failed - keep snapshot, update task with reference

this.db.updateTask(task.id, {
  status: "failed",
  errorMessage: message,
  snapshotId: snapshot.id  // User can see "Restore available" in UI
})
```

---

## User Experience

### Kanban UI Changes

1. **Task Card Indicator**
   - Small shield icon when snapshot exists
   - Shows "Restore available" on failed tasks

2. **Task Detail Panel**
   - Failed tasks display: "🛠️ Restore to pre-execution"
   - Clear explanation of what restore does
   - One-click restore action

3. **API Endpoint**
   ```typescript
   POST /api/tasks/:id/restore-snapshot
   // Restores from snapshot and resets task to backlog
   ```

---

## Implementation Plan

### Phase 1: Core Infrastructure

1. **Database Migration (v10)**
   - Create `task_snapshots` table
   - Add indexes for task_id and task_run_id lookups

2. **Worktree Lifecycle Extensions**
   - `createSnapshot(worktreeDir, options)` - Create stash with metadata
   - `restoreSnapshot(worktreeDir, stashRef)` - Apply/pop stash
   - `dropSnapshot(worktreeDir, stashRef)` - Remove stash after success
   - `listSnapshots(worktreeDir)` - Find stashes by pattern

3. **Database Methods**
   - `createTaskSnapshot(snapshot)` - Insert snapshot record
   - `getTaskSnapshot(id)` - Get snapshot by ID
   - `getTaskSnapshotsForTask(taskId)` - List task snapshots
   - `markSnapshotRestored(id)` - Update restored_at
   - `markSnapshotCleaned(id)` - Update cleaned_at

### Phase 2: Orchestrator Integration

1. **Snapshot Creation Hook**
   - Integrate into `executeTask()` after worktree setup
   - Store snapshot reference in task metadata

2. **Snapshot Cleanup on Success**
   - Drop stash after successful worktree.complete()
   - Mark as cleaned in database

3. **Snapshot Preservation on Failure**
   - Keep stash when task fails
   - Update task with snapshotId for UI visibility

4. **Restore Method**
   - `restoreTaskFromSnapshot(taskId, snapshotId)`
   - Applies stash, resets task state to backlog
   - Clears agent output and error state

### Phase 3: UI Integration

1. **Task Card Component**
   - Add snapshot indicator icon (shield)
   - Show on hover: "Snapshot available"

2. **Task Detail Panel**
   - Add "Restore" button for failed tasks with snapshots
   - Confirmation dialog explaining the action
   - Success/error notifications

3. **API Routes**
   - `POST /api/tasks/:id/restore-snapshot`
   - `GET /api/tasks/:id/snapshots` (list)

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Nested stashes | Track by `stash@{n}` reference, not position |
| Stash already exists | Create new stash, track both references |
| Restore conflicts | Report error, don't delete stash, user manually resolves |
| Multiple snapshots | Each run creates its own, old ones cleaned on success |
| Worktree deleted | Can't restore, show error to user |
| Empty stash (clean worktree) | Still create - ensures predictable behavior |

---

## Benefits

1. **Zero workflow delay**: Stash creation is <100ms for typical repos
2. **No external dependencies**: Uses git, already required
3. **Complete state capture**: Tracked + untracked + staged files
4. **User control**: Automatic creation, manual restoration
5. **Minimal storage**: Git's efficient storage, auto-cleanup on success
6. **Fits existing architecture**: Extends worktree system naturally

---

## Alternative Approaches Considered

| Alternative | Why Not Used |
|-------------|--------------|
| ZFS/Btrfs snapshots | Requires specific filesystems, not portable |
| Tar archive | Slower, more disk space, custom format |
| Git worktree copy | Too slow (~1s+), doubles disk usage |
| Pre-commit hook | Happens too late, doesn't cover untracked |

---

## Open Questions

1. Should we snapshot before plan mode too, or only pre-execution?
2. Should failed snapshots auto-expire (e.g., cleanup after 7 days)?
3. Do we want a global "restore all" option for multi-task workflows?
4. Should we keep the last N snapshots per task instead of just one?

---

## Decision Log

- **Use git stash**: Fast, portable, complete capture
- **Auto-create, manual restore**: User controls when to restore
- **Per-task snapshots**: Each task execution gets its own snapshot
- **Cleanup on success**: Remove stash to avoid clutter
- **Preserve on failure**: Keep stash for potential restore
