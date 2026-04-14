---
name: workflow-task-setup
description: Convert any user-provided implementation plan or scope document into TaurOboros kanban tasks with correct dependencies, states, and persistence.
compatibility: opencode
metadata:
  audience: agents
  workflow: tauroboros
---

## What I do

- Turn any user-provided planning material into TaurOboros tasks.
- Map steps and milestones into executable backlog tasks or reusable templates.
- Set dependencies, ordering, and task options so the workflow can run them correctly.
- Configure `standard` vs `best_of_n` execution strategy per task when needed.
- Explain and use the workflow's API, database layout, and state model accurately.

## When to use me

- The user wants tasks created from a plan, spec, issue, notes, checklist, design doc, or any other document that describes scope, ideas, or implementation steps.
- The user wants an existing document translated into kanban tasks.
- The user wants tasks normalized, split, merged, reordered, or reconfigured before execution.

## Core Behavior

- Prefer creating tasks, not starting execution, unless the user explicitly asks to run them.
- Prefer small, outcome-based tasks that can be completed and reviewed independently.
- Keep each task prompt self-contained enough that an execution agent can act on it without needing to rediscover the original plan.
- Use dependencies for real sequencing constraints, not just because steps are numbered.
- Create template tasks only when the user wants reusable blueprints; otherwise create backlog tasks.
- Reuse or update an existing task instead of creating a duplicate when the match is clear. If the match is ambiguous, ask.
- Use `best_of_n` only for tasks where multiple candidate implementations and convergence are useful; otherwise keep `standard`.

## Recommended Workflow

1. Read the source material and extract the real deliverables, constraints, and acceptance criteria.
2. Check existing tasks before creating new ones.
3. Split the work into the smallest useful execution units.
4. Decide whether each item should be a `template` or `backlog` task.
5. Add dependencies only where one task truly blocks another.
6. Create tasks in intended execution order, or reorder them afterward.
7. Verify the stored result by listing tasks again and summarizing the mapping back to the user.

## Task Shape

The workflow task model is defined in `src/types.ts`.

Required fields for useful task creation:

| Field | Meaning |
| --- | --- |
| `name` | Short card title shown on the board |
| `prompt` | Main execution instructions |

Common optional fields:

| Field | Meaning | Normal default |
| --- | --- | --- |
| `status` | Board state | `backlog` for runnable tasks, `template` for reusable blueprints |
| `branch` | Target git branch | Global workflow default branch |
| `planModel` | Planning model override | `default` |
| `executionModel` | Execution model override | `default` |
| `planmode` | Pause after planning and wait for approval | `false` |
| `autoApprovePlan` | Automatically approve plan without waiting | `false` |
| `review` | Run review loop after implementation | `true` |
| `autoCommit` | Auto-commit on success | `true` |
| `deleteWorktree` | Remove worktree when task completes, resets, or is marked done. If `false`, worktree is preserved even on failure. | `true` |
| `requirements` | Array of blocking task ids | `[]` |
| `thinkingLevel` | Default reasoning level: `default`, `low`, `medium`, `high` | `default` |
| `planThinkingLevel` | Reasoning level for planning phase only | `default` (inherits from `thinkingLevel`) |
| `executionThinkingLevel` | Reasoning level for execution phase only | `default` (inherits from `thinkingLevel`) |
| `executionStrategy` | Execution mode: `standard` or `best_of_n` | `standard` |
| `bestOfNConfig` | Best-of-N worker/reviewer/final-applier config | `null` unless strategy is `best_of_n` |
| `skipPermissionAsking` | Skip asking for permissions during execution | `true` |
| `maxReviewRunsOverride` | Override global max reviews for this task | `null` |
| `smartRepairHints` | Hints for smart repair when task is stuck | `null` |

Advanced fields normally left alone on fresh task creation:

| Field | Meaning |
| --- | --- |
| `executionPhase` | Internal phase for plan-mode lifecycle |
| `bestOfNSubstage` | Internal substage for best-of-n lifecycle |
| `awaitingPlanApproval` | Whether a plan-mode task is waiting for approval |
| `planRevisionCount` | Number of plan revision cycles |
| `reviewActivity` | Current review activity state: `idle` or `running` |
| `agentOutput` | Accumulated agent output |
| `reviewCount` | Review loop counter |
| `sessionId` / `sessionUrl` | Linked workflow session |
| `worktreeDir` | Active worktree location |
| `errorMessage` | Failure detail |
| `completedAt` | Unix timestamp when done |
| `isArchived` | Whether task is archived |
| `archivedAt` | Unix timestamp when archived |

## State Model

Task status values:

| Status | Meaning |
| --- | --- |
| `template` | Reusable blueprint, not meant to execute directly |
| `backlog` | Ready for execution when dependencies are satisfied |
| `executing` | Currently running |
| `review` | Waiting for review or user attention |
| `done` | Finished successfully |
| `failed` | Execution failed |
| `stuck` | Review found unresolved gaps or the workflow could not continue |

Execution phase values:

| Phase | Meaning |
| --- | --- |
| `not_started` | Normal initial state |
| `plan_complete_waiting_approval` | Planning finished and the task is paused |
| `plan_revision_pending` | Plan revision has been requested |
| `implementation_pending` | Plan was approved and implementation can run |
| `implementation_done` | Implementation finished |

Best-of-N substage values:

| Substage | Meaning |
| --- | --- |
| `idle` | No active best-of-n internals running |
| `workers_running` | Worker candidates are running |
| `reviewers_running` | Reviewers are evaluating candidates |
| `final_apply_running` | Final applier is running and preparing merge result |
| `blocked_for_manual_review` | Automation paused for human decision |
| `completed` | Best-of-n flow finished successfully |

Important runtime rules from the server and orchestrator:

- A task is executable when `status = backlog` and `executionPhase != plan_complete_waiting_approval`.
- A plan-mode task also becomes executable when `executionPhase = implementation_pending`.
- When a plan-mode task finishes planning, it moves to `status = review`, `awaitingPlanApproval = true`, `executionPhase = plan_complete_waiting_approval`.
- Approving that plan moves it to `status = backlog`, `awaitingPlanApproval = false`, `executionPhase = implementation_pending`.
- Requesting a plan revision moves it to `executionPhase = plan_revision_pending`.
- Resetting a task to backlog clears it back to `executionPhase = not_started` and `awaitingPlanApproval = false`.
- Best-of-N and plan mode cannot be combined in v1 (`planmode = true` with `executionStrategy = best_of_n` is rejected by API validation).
- For `best_of_n`, the board still treats it as one logical task card while child runs are stored separately.
- `failed` and `stuck` appear in the review column in the UI, but they are distinct stored statuses.
- **Worktree preservation on failure**: When a task fails, the worktree is **NOT** automatically deleted. The worktree (and its partial/complete work) is preserved so users can inspect, debug, or recover their work. Worktrees are only deleted when:
  - Task completes successfully (if `deleteWorktree` is `true`, the default)
  - User explicitly resets a task to backlog (cleanup happens regardless of `deleteWorktree`)
  - User explicitly marks a task as done (cleanup happens if `deleteWorktree` is `true`)

## Dependency Rules

- Dependencies are stored as task ids in `requirements`.
- The DB stores `requirements` as a JSON string, but the API uses a JSON array of strings.
- Only add a dependency when task B should not begin until task A is completed.
- Avoid artificial chains when tasks can be reviewed and executed independently.
- Circular dependencies will break scheduling.
- Tasks that are already outside the current executable set do not block batching the same way as active backlog items, so dependencies are most meaningful between active tasks you are setting up.

## Architecture Overview

TaurOboros uses a **standalone server with SQLite database** architecture:

1. **Standalone Server** (`src/server/server.ts`) - Runs as a Bun server
   - Provides HTTP API and WebSocket server
   - Manages SQLite database with ACID guarantees
   - Runs the task orchestrator with pause/resume support
   - Handles workflow runs, sessions, and execution
   - Supports both native and container isolation modes

2. **Kanban UI** (`src/kanban-vue/`) - Vue 3 + Tailwind CSS + Vite
   - Build output: `src/kanban-vue/dist/`
   - WebSocket live updates
   - 5 kanban columns: template, backlog, executing, review, done
   - 8 modals: Task, Options, Execution Graph, Approve, Revision, Start Single, Session Viewer, Best-of-N Details
   - Planning Chat modal for interactive task planning
   - Container Configuration modal for image management

3. **Configuration** (`.tauroboros/settings.json` for infrastructure config)
    - Database location: `<workspace>/.tauroboros/tasks.db`
    - Container settings for isolation mode
    - Skills auto-discovery from `.pi/skills/`

## Planning Chat

Interactive planning sessions allow real-time collaboration with AI:

```bash
# Create a planning session
curl -X POST http://localhost:<port>/api/planning/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "systemPrompt": "You are a helpful planning assistant...",
    "model": "claude-sonnet-4",
    "thinkingLevel": "medium"
  }'

# Send a message with context attachments
curl -X POST http://localhost:<port>/api/planning/sessions/<id>/message \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Help me plan this feature...",
    "contextAttachments": [
      {"type": "file", "name": "README.md", "content": "..."},
      {"type": "task", "name": "Related Task", "taskId": "abc123"}
    ]
  }'

# Change model mid-conversation
curl -X POST http://localhost:<port>/api/planning/sessions/<id>/set-model \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4"}'
```

Planning sessions support:
- **Streaming responses**: Real-time thinking and text deltas
- **Context attachments**: Files, screenshots, and other tasks
- **Model switching**: Change AI model without losing context
- **Session persistence**: Reconnect to planning sessions after server restart

## Persistence Layout

The workflow DB is managed by the standalone server at:

`<workspace>/.tauroboros/tasks.db`

The storage layer lives in `src/db.ts`.

### Tables

#### `tasks`

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `name` | Task name |
| `idx` | Board ordering |
| `prompt` | Task instructions |
| `branch` | Git branch |
| `plan_model` | Planning model |
| `execution_model` | Execution model |
| `planmode` | `0/1` boolean |
| `auto_approve_plan` | `0/1` boolean - auto approve plans |
| `review` | `0/1` boolean |
| `auto_commit` | `0/1` boolean |
| `delete_worktree` | `0/1` boolean |
| `status` | Task status string |
| `requirements` | JSON array string of task ids |
| `agent_output` | Aggregated output |
| `review_count` | Number of review attempts |
| `session_id` | Workflow session id |
| `session_url` | Session URL |
| `worktree_dir` | Worktree path |
| `error_message` | Failure details |
| `created_at` | Unix timestamp |
| `updated_at` | Unix timestamp |
| `completed_at` | Unix timestamp or null |
| `thinking_level` | `default`, `low`, `medium`, `high` |
| `execution_phase` | Internal plan-mode phase |
| `awaiting_plan_approval` | `0/1` boolean |
| `plan_revision_count` | Number of plan revisions |
| `execution_strategy` | `standard` or `best_of_n` |
| `best_of_n_config` | JSON config for worker/reviewer/final-applier runs |
| `best_of_n_substage` | Internal best-of-n substage |
| `skip_permission_asking` | `0/1` boolean |
| `max_review_runs_override` | Override max reviews |
| `smart_repair_hints` | Hints for repair |
| `review_activity` | `idle` or `running` |
| `is_archived` | `0/1` boolean |
| `archived_at` | Unix timestamp or null |

Indexes:
- `idx_tasks_status` on `status`
- `idx_tasks_idx` on `idx`
- `idx_tasks_status_idx` on `status, idx`
- `idx_tasks_execution_strategy` on `execution_strategy`

#### `options`

Key-value store used for workflow defaults.

Important keys:

| Key | Meaning |
| --- | --- |
| `commit_prompt` | Commit instructions |
| `branch` | Default branch |
| `plan_model` | Default plan model |
| `execution_model` | Default execution model |
| `review_model` | Default review model |
| `repair_model` | Default repair model |
| `extra_prompt` | Extra prompt appended to all tasks |
| `command` | Pre-execution command |
| `parallel_tasks` | Parallelism limit |
| `port` | Kanban server port |
| `thinking_level` | Default thinking level |
| `plan_thinking_level` | Thinking level for planning phase |
| `execution_thinking_level` | Thinking level for execution phase |
| `review_thinking_level` | Thinking level for review phase |
| `repair_thinking_level` | Thinking level for repair phase |
| `max_reviews` | Maximum review cycles |
| `max_json_parse_retries` | Max JSON parse retry attempts (default: 5) |
| `auto_delete_normal_sessions` | Auto-delete normal sessions |
| `auto_delete_review_sessions` | Auto-delete review sessions |
| `show_execution_graph` | Show execution graph in UI |
| `telegram_bot_token` | Telegram bot token |
| `telegram_chat_id` | Telegram chat ID |
| `telegram_notifications_enabled` | Enable Telegram notifications |
| `column_sorts` | JSON column sort preferences |
| `container_enabled` | Enable container isolation mode |
| `container_image` | Container image name |
| `container_auto_prepare` | Auto-build/pull image on startup |

#### `task_runs`

Child run records for best-of-n internals.

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `task_id` | Parent logical task id |
| `phase` | `worker`, `reviewer`, `final_applier` |
| `slot_index` / `attempt_index` | Expanded slot position and attempt |
| `model` | Model used for the run |
| `task_suffix` | Optional slot-specific prompt suffix |
| `status` | `pending`, `running`, `done`, `failed`, `skipped` |
| `session_id` / `session_url` | Session metadata |
| `worktree_dir` | Worktree path |
| `summary` | Short run summary |
| `error_message` | Run-level error details |
| `candidate_id` | Linked candidate id (worker runs) |
| `metadata_json` | Structured metadata (reviewer output, verification, etc.) |
| `created_at` | Unix timestamp |
| `updated_at` | Unix timestamp |
| `completed_at` | Unix timestamp or null |

#### `task_candidates`

Successful worker candidate artifacts for best-of-n.

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `task_id` | Parent logical task id |
| `worker_run_id` | Source worker run |
| `status` | `available`, `selected`, `rejected` |
| `changed_files_json` | JSON array of changed file paths |
| `diff_stats_json` | JSON diff stats map |
| `verification_json` | JSON verification result |
| `summary` | Candidate summary |
| `error_message` | Candidate artifact error detail |
| `created_at` | Unix timestamp |
| `updated_at` | Unix timestamp |

#### `workflow_runs`

Workflow run records for batch execution.

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `kind` | `all_tasks`, `single_task`, `workflow_review` |
| `status` | `running`, `paused`, `stopping`, `completed`, `failed` |
| `display_name` | Human-readable run name |
| `target_task_id` | Target task for single-task runs |
| `task_order_json` | JSON array of task IDs in execution order |
| `current_task_id` | Currently executing task |
| `current_task_index` | Index in task order |
| `pause_requested` | `0/1` boolean |
| `stop_requested` | `0/1` boolean |
| `error_message` | Failure details |
| `created_at` | Unix timestamp |
| `started_at` | Unix timestamp |
| `updated_at` | Unix timestamp |
| `finished_at` | Unix timestamp or null |
| `is_archived` | `0/1` boolean |
| `archived_at` | Unix timestamp or null |
| `color` | Hex color for UI |

#### `workflow_sessions`

Workflow session records linking to PI sessions.

| Column | Notes |
| --- | --- |
| `id` | Text primary key |
| `task_id` | Associated task |
| `task_run_id` | Associated task run (for best-of-n) |
| `session_kind` | `task`, `task_run_worker`, `task_run_reviewer`, `task_run_final_applier`, `review_scratch`, `repair`, `plan`, `plan_revision` |
| `status` | `starting`, `active`, `paused`, `completed`, `failed`, `aborted` |
| `cwd` | Working directory |
| `worktree_dir` | Worktree path |
| `branch` | Git branch |
| `pi_session_id` | PI session ID |
| `pi_session_file` | PI session file path |
| `process_pid` | Process PID |
| `model` | Model used |
| `thinking_level` | Thinking level |
| `started_at` | Unix timestamp |
| `updated_at` | Unix timestamp |
| `finished_at` | Unix timestamp or null |
| `exit_code` | Exit code or null |
| `exit_signal` | Exit signal or null |
| `error_message` | Error message or null |

#### `session_messages`

Normalized session message log with pi-native event schema.

| Column | Notes |
| --- | --- |
| `id` | Integer primary key |
| `seq` | Sequence number within session |
| `message_id` | Message UUID |
| `session_id` | Workflow session ID |
| `timestamp` | Unix timestamp |
| `role` | `user`, `assistant`, `system`, `tool` |
| `event_name` | Event name |
| `message_type` | Message type |
| `content_json` | JSON content |
| `model_provider` | Model provider |
| `model_id` | Model ID |
| `agent_name` | Agent name |
| `prompt_tokens` | Token count |
| `completion_tokens` | Token count |
| `cache_read_tokens` | Token count |
| `cache_write_tokens` | Token count |
| `total_tokens` | Token count |
| `cost_json` | Cost breakdown JSON |
| `cost_total` | Total cost |
| `tool_call_id` | Tool call ID |
| `tool_name` | Tool name |
| `tool_args_json` | Tool arguments JSON |
| `tool_result_json` | Tool result JSON |
| `tool_status` | Tool status |
| `edit_diff` | Edit diff |
| `edit_file_path` | Edited file path |
| `session_status` | Session status |
| `workflow_phase` | Workflow phase |
| `raw_event_json` | Raw event JSON |

#### `session_io`

Raw session I/O capture stream.

| Column | Notes |
| --- | --- |
| `id` | Integer primary key |
| `session_id` | Workflow session ID |
| `seq` | Sequence number |
| `stream` | `stdin`, `stdout`, `stderr`, `server` |
| `record_type` | `rpc_command`, `rpc_response`, `rpc_event`, `stderr_chunk`, `lifecycle`, `snapshot`, `prompt_rendered` |
| `payload_json` | JSON payload |
| `payload_text` | Text payload |
| `created_at` | Unix timestamp |

#### `prompt_templates`

Prompt template storage.

| Column | Notes |
| --- | --- |
| `id` | Integer primary key |
| `key` | Template key (unique) |
| `name` | Human-readable name |
| `description` | Description |
| `template_text` | Template text |
| `variables_json` | JSON array of variable names |
| `is_active` | `0/1` boolean |
| `created_at` | Unix timestamp |
| `updated_at` | Unix timestamp |

#### `prompt_template_versions`

Version history for prompt templates.

| Column | Notes |
| --- | --- |
| `id` | Integer primary key |
| `prompt_template_id` | Reference to template |
| `version` | Version number |
| `template_text` | Template text at this version |
| `variables_json` | Variables JSON |
| `created_at` | Unix timestamp |

## Preferred Write Path

Prefer the HTTP API when the kanban server is running, because API writes also broadcast UI updates.

New task creation appends to the end of the board using `max(idx) + 1`; use the reorder endpoint if the final order matters.

Base URL:

`http://localhost:<port>`

The port is read from the `options` table under the `port` key (default: 3789).

### Useful Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tasks` | List tasks |
| `POST` | `/api/tasks` | Create task |
| `GET` | `/api/tasks/:id` | Get single task |
| `PATCH` | `/api/tasks/:id` | Update task |
| `DELETE` | `/api/tasks/:id` | Delete/archive task |
| `PUT` | `/api/tasks/reorder` | Reorder by `idx` |
| `POST` | `/api/tasks/:id/reset` | Reset task to backlog |
| `POST` | `/api/tasks/:id/start` | Start single task |
| `POST` | `/api/tasks/:id/approve-plan` | Approve a plan-mode task |
| `POST` | `/api/tasks/:id/request-plan-revision` | Request plan revision |
| `POST` | `/api/tasks/:id/request-revision` | Alias for request-plan-revision |
| `GET` | `/api/tasks/:id/review-status` | Get review status |
| `POST` | `/api/tasks/:id/repair-state` | Repair task state |
| `GET` | `/api/tasks/:id/runs` | List best-of-n child runs for task |
| `GET` | `/api/tasks/:id/candidates` | List best-of-n candidate artifacts |
| `GET` | `/api/tasks/:id/best-of-n-summary` | Aggregated best-of-n progress/status |
| `POST` | `/api/tasks/:id/best-of-n/select-candidate` | Manually select a candidate |
| `POST` | `/api/tasks/:id/best-of-n/abort` | Abort best-of-n execution |
| `GET` | `/api/tasks/:id/messages` | Get session messages for task |
| `DELETE` | `/api/tasks/done/all` | Archive/delete all done tasks |
| `GET` | `/api/options` | Read workflow defaults |
| `PUT` | `/api/options` | Update workflow defaults |
| `GET` | `/api/branches` | List git branches |
| `GET` | `/api/models` | List available PI models |
| `GET` | `/api/runs` | List workflow runs |
| `DELETE` | `/api/runs/:id` | Archive a workflow run |
| `POST` | `/api/runs/:id/pause` | Pause a workflow run |
| `POST` | `/api/runs/:id/resume` | Resume a workflow run |
| `POST` | `/api/runs/:id/stop` | Stop a workflow run |
| `POST` | `/api/start` | Start all tasks |
| `POST` | `/api/execution/start` | Start all tasks (alt) |
| `POST` | `/api/stop` | Stop execution |
| `POST` | `/api/execution/stop` | Stop execution (alt) |
| `POST` | `/api/execution/pause` | Pause execution |
| `GET` | `/api/execution-graph` | Get execution graph |
| `GET` | `/api/sessions/:id` | Get workflow session |
| `GET` | `/api/sessions/:id/messages` | Get session messages |
| `GET` | `/api/sessions/:id/timeline` | Get session timeline entries |
| `GET` | `/api/sessions/:id/usage` | Get session usage rollup |
| `GET` | `/api/sessions/:id/io` | Get session I/O records |
| `GET` | `/api/task-runs/:id/messages` | Get messages for task run |
| `POST` | `/api/pi/sessions/:id/events` | Ingest PI session events |
| `POST` | `/api/tasks/create-and-wait` | Create task and wait for completion |
| `GET` | `/api/version` | Get server version info |
| `GET` | `/api/prompt-templates` | List prompt templates |
| `POST` | `/api/prompt-templates` | Create/update prompt template |
| `GET` | `/api/planning/sessions` | List planning sessions |
| `POST` | `/api/planning/sessions` | Create planning session |
| `GET` | `/api/container/image-status` | Get container image status |
| `POST` | `/api/container/config` | Update container config |
| `GET` | `/healthz` | Health check |
| `GET` | `/ws` | WebSocket endpoint |

API payload field names use camelCase.
DB column names use snake_case.

If you must write directly to SQLite (standalone server manages this database):

- `requirements` must be JSON-encoded text.
- boolean fields are stored as `0` or `1`.
- `best_of_n_config` must be JSON-encoded text when strategy is `best_of_n`.
- direct DB writes do not broadcast websocket updates.
- creating via raw SQL means you are responsible for `idx`, timestamps, and field normalization.
- when the server receives a `PATCH` that sets `status = backlog` without an explicit `executionPhase`, it resets `executionPhase` to `not_started` and `awaitingPlanApproval` to `false`.

**Note**: The standalone server must be running for the HTTP API to work. If you see connection errors, the server may need to be started with `bun start` from the project root.

## CI/CD Integration

Synchronous task creation for CI/CD pipelines:

```bash
# Create task and wait for completion
curl -X POST http://localhost:<port>/api/tasks/create-and-wait \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Run tests",
    "prompt": "Run the test suite and report results...",
    "timeoutMs": 600000,
    "pollIntervalMs": 5000
  }'
```

The `create-and-wait` endpoint:
- Creates a task, starts execution, and polls until completion
- Returns full task and run details on completion
- Supports `timeoutMs` (max 2 hours) and `pollIntervalMs` (1-30 seconds)
- Returns HTTP 408 on timeout with current status
- Ideal for CI/CD pipelines that need to wait for task completion

## Container Configuration

Container isolation provides process and filesystem isolation:

```bash
# Check container image status
curl http://localhost:<port>/api/container/image-status

# Update container configuration
curl -X POST http://localhost:<port>/api/container/config \
  -H "Content-Type: application/json" \
  -d '{
    "image": "pi-agent:alpine",
    "autoPrepare": true,
    "packages": ["nodejs", "python3"]
  }'

# Add packages to container
curl -X POST http://localhost:<port>/api/container/packages \
  -H "Content-Type: application/json" \
  -d '{"package": "typescript"}'
```

Container mode features:
- **Same-path binding**: Worktree paths are identical inside/outside container
- **Image preparation**: Build/pull images before first use (not during task execution)
- **Resume support**: Containers can be reattached on resume after pause
- **Emergency stop**: Kill all containers immediately if needed

## Useful Queries

Inspect current tasks:

```sql
SELECT id, idx, name, status, execution_phase, awaiting_plan_approval, requirements
FROM tasks
WHERE is_archived = 0
ORDER BY idx ASC;
```

Inspect only runnable backlog tasks:

```sql
SELECT id, idx, name, branch, status, execution_phase
FROM tasks
WHERE status = 'backlog'
  AND execution_phase != 'plan_complete_waiting_approval'
  AND is_archived = 0
ORDER BY idx ASC;
```

Inspect templates:

```sql
SELECT id, idx, name
FROM tasks
WHERE status = 'template'
  AND is_archived = 0
ORDER BY idx ASC;
```

Inspect workflow defaults:

```sql
SELECT key, value
FROM options
ORDER BY key ASC;
```

Inspect tasks waiting for plan approval:

```sql
SELECT id, idx, name, status, execution_phase, awaiting_plan_approval
FROM tasks
WHERE awaiting_plan_approval = 1
  AND is_archived = 0
ORDER BY idx ASC;
```

Inspect archived tasks:

```sql
SELECT id, name, status, archived_at
FROM tasks
WHERE is_archived = 1
ORDER BY archived_at DESC;
```

Example direct insert shape:

```sql
INSERT INTO tasks (
  id, name, idx, prompt, branch, plan_model, execution_model,
  planmode, auto_approve_plan, review, auto_commit, delete_worktree, status,
  requirements, created_at, updated_at, thinking_level,
  execution_phase, awaiting_plan_approval, skip_permission_asking,
  execution_strategy, is_archived, archived_at
) VALUES (
  'task1234',
  'Implement feature X',
  7,
  'Implement feature X according to the user-approved scope...',
  'main',
  'default',
  'default',
  0,
  0,
  1,
  1,
  1,
  'backlog',
  '[]',
  unixepoch(),
  unixepoch(),
  'default',
  'not_started',
  0,
  1,
  'standard',
  0,
  NULL
);
```

## Example API Payloads

Create a normal backlog task:

```json
{
  "name": "Build settings form",
  "prompt": "Implement the settings form described in the user-provided scope. Preserve the existing UI patterns and add only the fields required by the spec.",
  "status": "backlog",
  "branch": "main",
  "planModel": "default",
  "executionModel": "default",
  "planmode": false,
  "autoApprovePlan": false,
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "skipPermissionAsking": true,
  "requirements": [],
  "thinkingLevel": "default",
  "planThinkingLevel": "medium",
  "executionThinkingLevel": "low"
}
```

Create a plan-mode task that should pause for approval after planning:

```json
{
  "name": "Design migration strategy",
  "prompt": "Review the source material, produce a migration plan, and stop for approval before implementation.",
  "status": "backlog",
  "planmode": true,
  "autoApprovePlan": false,
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "skipPermissionAsking": true,
  "requirements": [],
  "thinkingLevel": "medium"
}
```

Create a best-of-n task:

```json
{
  "name": "Implement API pagination (best-of-n)",
  "prompt": "Add cursor-based pagination to the list endpoint and update tests.",
  "status": "backlog",
  "executionStrategy": "best_of_n",
  "bestOfNConfig": {
    "workers": [
      { "model": "claude-sonnet-4", "count": 2 },
      { "model": "claude-haiku-4", "count": 1, "taskSuffix": "Prefer minimal schema changes." }
    ],
    "reviewers": [
      { "model": "claude-sonnet-4", "count": 1 }
    ],
    "finalApplier": {
      "model": "claude-opus-4",
      "taskSuffix": "Preserve current API response compatibility."
    },
    "minSuccessfulWorkers": 1,
    "selectionMode": "pick_or_synthesize",
    "verificationCommand": "bun test"
  },
  "planmode": false,
  "review": true,
  "autoCommit": true,
  "deleteWorktree": true,
  "skipPermissionAsking": true,
  "requirements": [],
  "thinkingLevel": "medium"
}
```

## Plan-to-Task Heuristics

- If the source describes milestones, map each milestone to one or more executable tasks.
- If the source mixes research, implementation, and validation, split those into separate tasks when they can be reviewed independently.
- If one step exists only to unblock another, make it a dependency.
- If a step is optional, risky, or calls for human approval, consider `planmode = true`.
- If the user wants reusable scaffolding for future work, create `template` tasks instead of backlog tasks.
- Keep prompts explicit about files, subsystems, constraints, and verification expectations when those are available in the source.

## Prompt Template Customization

Customize prompts for different execution phases:

```bash
# List all templates
curl http://localhost:<port>/api/prompt-templates

# Get a specific template
curl http://localhost:<port>/api/prompt-templates/execution

# Create custom template
curl -X POST http://localhost:<port>/api/prompt-templates \
  -H "Content-Type: application/json" \
  -d '{
    "key": "my_custom_execution",
    "name": "My Custom Execution",
    "templateText": "You are an expert {{language}} developer...",
    "variables": ["task", "options", "worktreeDir", "language"]
  }'

# Set as active
curl -X POST http://localhost:<port>/api/prompt-templates/my_custom_execution/set-active \
  -H "Content-Type: application/json" \
  -d '{"version": 1}'
```

Built-in template keys:
- `execution` - Main task execution prompt
- `planning` - Plan mode planning phase
- `plan_revision` - Plan mode revision
- `review` - Review loop
- `review_fix` - Review fix iteration
- `commit` - Git commit instructions
- `repair` - Smart repair analysis
- `best_of_n_worker` - Best-of-n worker
- `best_of_n_reviewer` - Best-of-n reviewer
- `best_of_n_final_applier` - Best-of-n final merge

## Validation Checklist

Before finishing, verify:

- task names are distinct and readable
- prompts are actionable
- dependencies reference real task ids
- no obvious circular dependency exists
- statuses are appropriate for the user's intent
- plan-mode tasks are only used where an approval pause is actually useful
- `best_of_n` is only used where candidate fan-out/convergence is useful
- `bestOfNConfig` is valid (workers present, counts > 0, final applier model present, min successful workers <= total workers)
- `planThinkingLevel` and `executionThinkingLevel` are set appropriately if different from default
- `maxReviewRunsOverride` is set if task needs more/fewer reviews than global default
- `maxJsonParseRetries` is appropriate for review complexity
- Telegram notifications are configured if user wants status updates
- ordering in `idx` matches the intended flow

## What to Tell the User

After setup, report:

- how many tasks you created or updated
- any templates versus backlog tasks
- any important dependencies you added
- any assumptions you made while translating the source material
- any ambiguities that still need user input
