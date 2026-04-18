---
name: task-debug
description: Diagnose and repair failed, stuck, or otherwise not progressing TaurOboros tasks using session logs, timelines, worktree state, and deterministic repair logic.
compatibility: opencode
metadata:
  audience: agents
  workflow: tauroboros
---

## What I do

- Diagnose why a task is `failed`, `stuck`, `review`, or otherwise not progressing.
- Reconstruct what an agent actually did by examining the session timeline and messages.
- Compare task output against worktree changes to verify implementation completeness.
- Apply the correct repair action (`reset_backlog`, `queue_implementation`, `mark_done`, `fail_task`, `restore_plan_approval`, `continue_with_more_reviews`, `smart`) based on evidence.
- Identify when to escalate to human review versus auto-repair.

## When to use me

- A task is `failed` or `stuck` and you need to understand why.
- A task has `errorMessage` set and you need to investigate.
- A task is stuck in `review` status and not progressing.
- An agent session ended unexpectedly or produced no useful output.
- A best-of-n task has failed worker/reviewer runs and you need to assess the damage.
- The workflow is not progressing and you need to diagnose the bottleneck.
- You want to verify that a completed task actually made the promised changes.
- You need to inspect session messages, I/O, or usage statistics.
- A planning session is not responding or needs to be debugged.
- Container mode tasks are failing to start or resume properly.
- A paused run cannot be resumed after server restart.

## Core Behavior

- **Always investigate before acting.** Reading logs and timelines is faster than trial-and-error repair.
- **Cross-reference evidence.** A task's `agentOutput` alone is insufficient—check the worktree git status and session timeline.
- **Prefer `reset_backlog` when evidence is ambiguous.** Starting fresh is often more productive than patching a broken state.
- **Use `mark_done` only when worktree AND output both confirm completion.** An empty worktree with a "done" plan is NOT done.
- **Preserve history.** Before resetting or repairing, note what happened so the next repair attempt has context.

## Investigation Workflow

### Step 1: Gather Task State

Start by fetching the task and understanding its current state:

```bash
# Get task details
curl http://localhost:<port>/api/tasks/<task-id>

# Get task runs (for best-of-n)
curl http://localhost:<port>/api/tasks/<task-id>/runs

# Get task candidates (for best-of-n)
curl http://localhost:<port>/api/tasks/<task-id>/candidates

# Get best-of-n summary
curl http://localhost:<port>/api/tasks/<task-id>/best-of-n-summary

# Get review status
curl http://localhost:<port>/api/tasks/<task-id>/review-status
```

Key fields to examine:

| Field | What it tells you |
| --- | --- |
| `status` | Current board state (`failed`, `stuck`, `review`, `executing`, etc.) |
| `errorMessage` | If set, the workflow recorded a failure reason |
| `agentOutput` | Accumulated tagged output (`[plan]`, `[exec]`, `[review-fix-N]`) |
| `sessionId` / `sessionUrl` | Workflow session link—use for timeline |
| `worktreeDir` | Worktree path—check git status there |
| `executionPhase` | Internal phase for plan-mode tasks |
| `planRevisionCount` | Number of plan revision cycles |
| `reviewCount` | How many review cycles ran |
| `bestOfNSubstage` | For best-of-n: which phase is active |
| `reviewActivity` | `idle` or `running`—is review currently active |
| `isArchived` | Whether task has been archived |
| `thinkingLevel` | Default reasoning level (default/low/medium/high) |
| `planThinkingLevel` | Reasoning level for planning phase |
| `executionThinkingLevel` | Reasoning level for execution phase |
| `executionStrategy` | `standard` or `best_of_n` |
| `smartRepairHints` | Any hints previously provided for repair |
| `maxReviewRunsOverride` | Per-task override for max review cycles |
| `jsonParseRetryCount` | Failed JSON parse attempts in review |

### Step 2: Examine Session Timeline and Messages

The session timeline gives you the full message log in chronological order:

```bash
# Get formatted timeline entries
curl http://localhost:<port>/api/sessions/<session-id>/timeline

# Get raw messages (full content) with pagination
curl "http://localhost:<port>/api/sessions/<session-id>/messages?limit=500&offset=0"

# Get session usage rollup (tokens, cost, cache)
curl http://localhost:<port>/api/sessions/<session-id>/usage

# Get session I/O records with filtering
curl "http://localhost:<port>/api/sessions/<session-id>/io?limit=500"
curl "http://localhost:<port>/api/sessions/<session-id>/io?recordType=lifecycle"

# Get all messages for a task (across all its sessions)
curl http://localhost:<port>/api/tasks/<task-id>/messages

# Get messages for a specific task run
curl http://localhost:<port>/api/task-runs/<run-id>/messages

# Check server version and compiled status
curl http://localhost:<port>/api/version
```

Timeline entry fields:

| Field | What it tells you |
| --- | --- |
| `id` | Entry ID |
| `timestamp` | Unix timestamp |
| `relativeTime` | Milliseconds from session start |
| `role` | `user`, `assistant`, `system`, `tool` |
| `messageType` | `text`, `tool_call`, `tool_result`, `step_start`, `step_finish`, `error`, etc. |
| `summary` | Short human-readable description |
| `hasToolCalls` | Whether the message triggered tools |
| `hasEdits` | Whether file edits occurred |
| `modelProvider` / `modelId` | Which model was used |

Session message fields:

| Field | What it tells you |
| --- | --- |
| `id` | Message ID |
| `seq` | Sequence number within session |
| `sessionId` | Session ID |
| `taskId` / `taskRunId` | Associated task/run |
| `role` | Message role (`user`, `assistant`, `system`, `tool`) |
| `messageType` | Type of message (`text`, `tool_call`, `tool_result`, `thinking`, `user_prompt`, `assistant_response`, etc.) |
| `contentJson` | Content as JSON |
| `eventName` | Event name (e.g., `thinking`, `tool_call`, `assistant_response`) |
| `toolName` / `toolArgsJson` / `toolResultJson` | Tool call details |
| `toolStatus` | Tool execution status |
| `toolCallId` | Tool call ID for correlation |
| `editDiff` / `editFilePath` | File edit details |
| `promptTokens` / `completionTokens` / `totalTokens` | Token usage |
| `cacheReadTokens` / `cacheWriteTokens` | Cache token usage |
| `costTotal` | Cost in USD |
| `agentName` | Agent name if provided |
| `modelProvider` / `modelId` | Model information |

### Step 3: Check Worktree Git State

The worktree tells you what actually changed on disk:

```bash
# In the worktree directory
cd <worktree-dir>
git status --porcelain
git diff --stat
git log --oneline -5
```

**Interpretation:**

| Worktree state | Likely meaning |
| --- | --- |
| Clean (no changes) | Agent made no commits or the worktree was deleted |
| Uncommitted changes | Agent worked but didn't commit |
| Committed changes | Agent completed work in worktree |
| Mixed (some files) | Partial implementation |

### Step 4: Compare Output vs. Worktree

A task is truly complete only when:
1. `agentOutput` contains a `[plan]` block (if planmode) or `[exec]` block
2. The worktree has real file changes matching the promised work
3. For best-of-n: at least one candidate exists with `status: "available"`

**Red flags:**
- `agentOutput` is empty but task is `executing`—session likely crashed
- Worktree is clean but `agentOutput` shows a plan—agent never started implementation
- `errorMessage` says "no captured [plan] block"—plan mode task never produced a plan
- Review cycles keep finding the same gaps—implementation is not converging

### Step 5: Understand Repair Actions

Use `POST /api/tasks/<task-id>/repair-state` with an `action` field:

```bash
# Manual repair action
curl -X POST http://localhost:<port>/api/tasks/<task-id>/repair-state \
  -H "Content-Type: application/json" \
  -d '{"action": "reset_backlog"}'

# Smart repair with optional hints
curl -X POST http://localhost:<port>/api/tasks/<task-id>/repair-state \
  -H "Content-Type: application/json" \
  -d '{"action": "smart", "smartRepairHints": "Focus on the database migration issue"}'
```

Available actions:

| Action | When to use |
| --- | --- |
| `reset_backlog` | Task did nothing useful, or state is too corrupted to repair. Start fresh. |
| `queue_implementation` | Task has a valid `[plan]` AND the worktree shows real changes. Resume from implementation. |
| `mark_done` | Worktree AND output both confirm complete work. Close the task. |
| `fail_task` | State is invalid and should stay visible with an error. Use when task cannot be repaired. |
| `restore_plan_approval` | Task should return to plan approval review. |
| `continue_with_more_reviews` | Stuck in review due to limit; allow more review cycles. |
| `smart` | Let the repair model analyze the situation and decide. Requires `repairModel` to be configured in options. |

## Planning Session Debugging

Planning sessions are interactive chat sessions for task planning:

```bash
# List active planning sessions
curl http://localhost:<port>/api/planning/sessions

# Get specific planning session
curl http://localhost:<port>/api/planning/sessions/<session-id>

# Get planning session messages
curl http://localhost:<port>/api/planning/sessions/<session-id>/messages

# Close a stuck planning session
curl -X POST http://localhost:<port>/api/planning/sessions/<session-id>/close
```

Planning session states:
- `starting` - Session is initializing
- `active` - Session is ready for messages
- `paused` - Session was paused (for resume)
- `completed` - Session finished normally
- `failed` - Session encountered an error

Planning sessions support:
- Context attachments (files, screenshots, other tasks)
- Model switching mid-conversation
- Thinking level adjustment
- Streaming message updates (thinking deltas, text deltas)

## Smart Repair

The server has built-in smart repair that analyzes the full context:

```bash
curl -X POST http://localhost:<port>/api/tasks/<task-id>/repair-state \
  -H "Content-Type: application/json" \
  -d '{"action": "smart"}'
```

Smart repair gathers:
- Worktree git status and diff
- Session messages (last 5)
- Workflow session history
- Task runs (best-of-n)
- Latest `[plan]`, `[exec]`, and `[user-revision-request]` blocks from `agentOutput`

It then prompts the configured `repairModel` to decide the best action.

## Common Failure Patterns

### Pattern 1: Task crashed with no output

**Symptoms:** `status: "executing"`, `agentOutput: ""`, `sessionId` present but session is gone.

**Diagnosis:** Check session timeline for the last message. Look for `tool_status: "error"` or abrupt truncation.

**Repair:** `reset_backlog`

### Pattern 2: Plan mode task never produced a plan

**Symptoms:** `executionPhase: "plan_complete_waiting_approval"`, `errorMessage` mentions missing `[plan]` block.

**Diagnosis:** Agent either crashed during planning or the plan wasn't captured due to output truncation.

**Repair:** `reset_backlog` (to re-run planning) or `fail_task` (if planning keeps failing)

### Pattern 3: Worktree is clean but task shows output

**Symptoms:** `agentOutput` has `[exec]` block, but `git status` in worktree is clean.

**Diagnosis:** Agent described work but didn't actually edit files, OR worktree was deleted.

**Repair:** `reset_backlog` to re-run implementation, or investigate if worktree cleanup failed.

### Pattern 4: Best-of-n workers all failed

**Symptoms:** `bestOfNSubstage: "workers_running"`, all `task_runs` have `status: "failed"`.

**Diagnosis:** Check `errorMessage` on each failed run. Common causes: compilation errors, test failures, permission issues.

**Repair:** Fix underlying issue, then `reset_backlog` or use `continue_with_more_reviews` if the issue is review-related.

### Pattern 5: Review keeps finding the same gaps

**Symptoms:** `reviewCount` keeps incrementing, same `gaps` appear in each `[review-fix-N]` block.

**Diagnosis:** Implementation is not converging. Agent keeps making the same mistakes.

**Repair options:**
- `continue_with_more_reviews` to allow more cycles
- `reset_backlog` with improved instructions
- Add `smartRepairHints` to give the agent targeted guidance
- Override `maxReviewRunsOverride` to increase the limit

### Pattern 6: Task stuck in plan approval

**Symptoms:** `status: "review"`, `awaitingPlanApproval: true`, `executionPhase: "plan_complete_waiting_approval"`.

**Diagnosis:** Plan-mode task completed planning but is waiting for user approval.

**Repair options:**
- User approves: `POST /api/tasks/<id>/approve-plan`
- User requests revision: `POST /api/tasks/<id>/request-plan-revision` with `feedback`
- Reset to re-plan: `reset_backlog`

### Pattern 7: Task is archived

**Symptoms:** `isArchived: true`, task not visible in UI.

**Diagnosis:** Task was archived after completion or manual archival.

**Repair:** Tasks cannot be unarchived via API. Create a new task if needed.

### Pattern 8: Planning session is stuck

**Symptoms:** Planning session shows `starting` or `active` but doesn't respond to messages.

**Diagnosis:** Check session messages for errors. Container mode planning sessions may have image preparation issues.

**Repair:** 
- Check container image status if using container mode
- Close and recreate the planning session
- Review session I/O records for startup errors

### Pattern 9: Container resume failed

**Symptoms:** Paused container task fails to resume, or resume creates new work instead of continuing.

**Diagnosis:** Check if original container still exists with `podman ps -a`. Container may have been killed or auto-removed.

**Repair:**
- If container exists: Check container logs with `podman logs <container-id>`
- If container gone: Task will recreate container and use continuation prompt
- For critical resume failures, reset task to backlog

### Pattern 10: Review loop JSON parse failures

**Symptoms:** `jsonParseRetryCount` keeps increasing, review never completes.

**Diagnosis:** Reviewer is outputting malformed JSON. Check `maxJsonParseRetries` in options (default: 5).

**Repair:**
- Increase `maxJsonParseRetries` in options if reviewer is close but formatting is off
- Use `smartRepairHints` to tell repair model about JSON formatting issues
- Reset task with clearer instructions about JSON output format

## Debugging Best-of-N Tasks

For best-of-n tasks, you can drill into individual runs:

```bash
# Get all worker runs
curl http://localhost:<port>/api/tasks/<task-id>/runs

# Get candidates (successful worker outputs)
curl http://localhost:<port>/api/tasks/<task-id>/candidates

# Get best-of-n summary
curl http://localhost:<port>/api/tasks/<task-id>/best-of-n-summary
```

Best-of-n substages:

| Substage | Meaning |
| --- | --- |
| `idle` | Not yet started or completed |
| `workers_running` | Worker candidates are being generated |
| `reviewers_running` | Reviewers are evaluating candidates |
| `final_apply_running` | Final applier is preparing merge result |
| `blocked_for_manual_review` | Waiting for human decision |
| `completed` | Successfully completed |

Manual candidate selection:

```bash
curl -X POST http://localhost:<port>/api/tasks/<task-id>/best-of-n/select-candidate \
  -H "Content-Type: application/json" \
  -d '{"candidateId": "<candidate-id>"}'
```

Abort best-of-n:

```bash
curl -X POST http://localhost:<port>/api/tasks/<task-id>/best-of-n/abort \
  -H "Content-Type: application/json" \
  -d '{"reason": "Aborting due to incorrect approach"}'
```

## State Transitions

Understanding how tasks move between states helps you diagnose issues:

```
backlog → executing (when picked up by orchestrator)
executing → review (after implementation, before approval)
executing → done (autoCommit + successful exec without review)
executing → failed (unrecoverable error)
review → backlog (plan approved or revision requested)
review → done (review passed, no more reviews needed)
review → stuck (review found unresolved gaps)
stuck → backlog (via repair)
failed → backlog (via repair)
```

The orchestrator handles transitions automatically, but stuck/failed states indicate something went wrong that it couldn't resolve.

## Architecture Overview

The debug skill operates on the **standalone server with SQLite database** architecture:

1. **Standalone Server** (`src/server/server.ts`)
   - HTTP API on configured port (default 3789)
    - SQLite database at `.tauroboros/tasks.db`
   - Message logger captures all session events with token/cost tracking
   - WebSocket server broadcasts real-time updates

2. **Vue Kanban UI** (`src/kanban-vue/`)
   - Vue 3 + Tailwind CSS + Vite
   - Real-time updates via WebSocket
   - 5 kanban columns (template, backlog, executing, review, done)

3. **Database Tables:**

    `tasks` — Core task state with archive support

    `task_runs` — Child runs for best-of-n

    `task_candidates` — Successful worker artifacts

    `workflow_runs` — Workflow run tracking with colors

    `workflow_sessions` — Workflow session management

    `session_messages` — Normalized message log with token/cost tracking and cache info

    `session_io` — Raw I/O capture stream

    `prompt_templates` / `prompt_template_versions` — Prompt management

## Persistence Layout

Database location: `<workspace>/.tauroboros/tasks.db`

The storage layer is in `src/db.ts`.

Session logs are stored in `session_messages` table and available via:
- `GET /api/sessions/:sessionId/timeline` — Timeline entries
- `GET /api/sessions/:sessionId/messages` — Full messages with pagination (supports `limit`, `offset`)
- `GET /api/sessions/:sessionId/usage` — Token/cost rollup with cache info
- `GET /api/sessions/:sessionId/io` — Raw I/O records (supports `limit`, `offset`, `recordType` filter)
- `GET /api/tasks/:taskId/messages` — All messages for a task
- `GET /api/task-runs/:runId/messages` — Messages for a specific run

## Container Mode Debugging

When container isolation is enabled:

```bash
# Check container image status
curl http://localhost:<port>/api/container/image-status

# Check if containers are running for paused sessions
curl http://localhost:<port>/api/runs/<run-id>/paused-state
```

Container image status values:
- `not_present` - Image needs to be built/pulled
- `preparing` - Image is being built or pulled
- `ready` - Image is ready for use
- `error` - Image preparation failed

Container resume uses **attachment strategy** (preferred):
- Preserves filesystem state, environment variables, running processes
- Uses `podman exec` to reconnect to existing containers
- Only falls back to recreation if attach fails

## Workflow Run Management

For debugging workflow-level issues:

```bash
# List all workflow runs
curl http://localhost:<port>/api/runs

# Check for any paused runs
curl http://localhost:<port>/api/runs/paused-state

# Pause a run (preserves state for resume)
curl -X POST http://localhost:<port>/api/runs/<run-id>/pause

# Resume a paused run
curl -X POST http://localhost:<port>/api/runs/<run-id>/resume

# Graceful stop (allows current task to finish)
curl -X POST http://localhost:<port>/api/runs/<run-id>/stop

# Destructive stop (kills everything, loses data)
curl -X POST http://localhost:<port>/api/runs/<run-id>/stop \
  -H "Content-Type: application/json" \
  -d '{"destructive": true}'

# Archive a completed/failed run
curl -X DELETE http://localhost:<port>/api/runs/<run-id>
```

Pause/Resume behavior:
- Saves session state to database for resume across server restarts
- Kills active processes but preserves worktree and context
- On resume, recreates containers if needed (container mode)
- Supports both graceful and destructive stop modes

## Session Management

For debugging session-level issues:

```bash
# Get workflow session details
curl http://localhost:<port>/api/sessions/<session-id>

# Get session messages with pagination
curl "http://localhost:<port>/api/sessions/<session-id>/messages?limit=100&offset=0"

# Get session timeline (condensed view)
curl http://localhost:<port>/api/sessions/<session-id>/timeline

# Get token/cost usage rollup (includes cache tokens)
curl http://localhost:<port>/api/sessions/<session-id>/usage

# Get raw I/O records
curl "http://localhost:<port>/api/sessions/<session-id>/io?limit=100"

# Get I/O records filtered by type
curl "http://localhost:<port>/api/sessions/<session-id>/io?recordType=lifecycle"
```

## Execution Graph Inspection

For understanding task execution order:

```bash
# Get execution graph with dependency resolution
curl http://localhost:<port>/api/execution-graph
```

This returns:
- `nodes`: All tasks that will run with execution metadata (including expanded worker/reviewer counts for best-of-n)
- `edges`: Dependency relationships
- `batches`: Tasks grouped by execution batch (parallelizable)
- `pendingApprovals`: Tasks waiting for plan approval

## Container Mode

When container isolation is enabled:

```bash
# Check container image status
curl http://localhost:<port>/api/container/image-status
```

The image status endpoint returns:
- `enabled`: Whether container mode is enabled
- `status`: `not_present`, `preparing`, `ready`, or `error`
- `message`: Human-readable status message
- `progress`: Download/build progress (0-100)
- `errorMessage`: Error details if status is `error`

## Resetting Tasks

To reset a task to clean backlog state:

```bash
curl -X POST http://localhost:<port>/api/tasks/<task-id>/reset
```

This clears:
- `status` → `backlog`
- `reviewCount` → 0
- `errorMessage` → null
- `completedAt` → null
- `sessionId` / `sessionUrl` → null
- `worktreeDir` → null (worktree is cleaned up)
- `executionPhase` → `not_started`
- `awaitingPlanApproval` → false
- `planRevisionCount` → 0
- `bestOfNSubstage` → `idle` (for best-of-n tasks)

## Diagnostic Checklist

When debugging a failing task, verify:

- [ ] Task `status` and `errorMessage` are set correctly
- [ ] `sessionId` points to a real workflow session
- [ ] Session timeline shows what the agent was doing when it stopped
- [ ] Worktree exists and has the expected changes (or lack thereof)
- [ ] `agentOutput` contains the expected tagged blocks (`[plan]`, `[exec]`)
- [ ] For best-of-n: task runs and candidates reflect expected progress
- [ ] `executionPhase` and `awaitingPlanApproval` are consistent with the task type
- [ ] Review gaps (if any) are specific and actionable
- [ ] `isArchived` is false (archived tasks don't execute)
- [ ] `requirements` dependencies are satisfied or will be satisfied
- [ ] `reviewActivity` is `idle` (if `running`, a review is currently in progress)
- [ ] `thinkingLevel` / `planThinkingLevel` / `executionThinkingLevel` are appropriate
- [ ] Session messages contain no unhandled errors in `toolStatus`
- [ ] Token/cost usage in session rollup seems reasonable (including cache tokens)
- [ ] `jsonParseRetryCount` is within `maxJsonParseRetries` limit
- [ ] For container mode: container image status is `ready`
- [ ] For paused runs: check `/api/runs/paused-state` for resume availability
- [ ] Planning sessions (if any) show proper state transitions
- [ ] `maxReviewRunsOverride` is set appropriately if reviews keep failing

## What to Tell the User

After diagnosing a task issue, report:

- What the evidence shows (what the agent did, what the worktree contains)
- Why the current state is incorrect
- What repair action you took (or recommended)
- Any assumptions made during diagnosis
- What the user should expect after the repair (e.g., "task will restart from planning")

## Debugging Task Groups

Task Groups are virtual workflows that execute multiple related tasks together. When debugging issues with groups, consider both the group-level and task-level state.

### Group Debugging Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/task-groups` | List all groups |
| `GET` | `/api/task-groups/:id` | Get group with full task details |
| `POST` | `/api/task-groups/:id/start` | Start group execution (returns error details) |
| `GET` | `/api/tasks/:id/group` | Get task's group membership |

### Common Group Issues

#### Pattern 1: Group fails to start

**Symptoms:** `POST /api/task-groups/:id/start` returns 409 Conflict.

**Diagnosis:** Check the error message:
- "A workflow is already running" - Another workflow/groups is executing
- "Some tasks are not in backlog status" - Tasks moved outside backlog
- "external dependencies" - Group tasks depend on non-group tasks

**Repair:**
- Stop the current workflow first
- Move tasks back to backlog
- Move external dependencies into the group or complete them first

#### Pattern 2: Group task stuck in group panel

**Symptoms:** Task shows in group panel but doesn't appear in execution.

**Diagnosis:** Check:
- Task `status` is `backlog` or `template` (not `executing`, `review`, etc.)
- Task has no external dependencies on non-group tasks
- Group `status` is `active`

**Repair:**
- Reset the task if it's stuck
- Check if the group run completed or failed

#### Pattern 3: Group shows completed but tasks are not done

**Symptoms:** Group `status` is `completed` but some tasks are still in other statuses.

**Diagnosis:** Check:
- Each task's individual `status` and `executionPhase`
- `agentOutput` for each task
- Worktree state for each task

**Repair:**
- Investigate each stuck task individually using the investigation workflow above
- Reset stuck tasks as needed

### Group vs Individual Task Debugging

When a task is part of a group:

1. **Check group state first** - Is the group `active` or `completed`?
2. **Check task membership** - Use `GET /api/tasks/:id/group`
3. **Check group run** - Look at the `workflow_run` with `kind: "group_tasks"`
4. **Debug as normal** - Once task membership is confirmed, debug using standard patterns

### Group Workflow Run Inspection

Group executions create `workflow_runs` with `kind: "group_tasks"`:

```bash
# Get all workflow runs
curl http://localhost:<port>/api/runs

# Look for runs with kind: "group_tasks"
# Check:
# - status: "running", "completed", "failed"
# - current_task_id: which task is/was executing
# - current_task_index: position in group task order
# - task_order: array of all task IDs in execution order
```

### Restoring Tasks from Groups

When a task is removed from a group or the group is deleted:

```bash
# Move a task back to general backlog (removes from group)
curl -X POST http://localhost:<port>/api/tasks/:id/move-to-group \
  -H "Content-Type: application/json" \
  -d '{"groupId": null}'

# The task will reappear in the main backlog column
```

### Group Diagnostic Checklist

When debugging group issues, verify:

- [ ] Group `status` is `active` (not `completed` or `archived`)
- [ ] Group tasks are all in `backlog` or `template` status
- [ ] No external dependencies on non-group tasks
- [ ] No other workflow is running (check `GET /api/runs`)
- [ ] Container images are valid if using container mode
- [ ] Group `workflow_run` status reflects actual state
- [ ] Tasks have no circular dependencies within the group

### What to Tell the User About Groups

When diagnosing group issues, report:

- Whether the issue is at the group level or task level
- If at group level: current run status, task order, blocking issues
- If at task level: which task has the problem and its current state
- What repair action resolves the issue
- Expected behavior after repair (e.g., "group will restart from task X")
