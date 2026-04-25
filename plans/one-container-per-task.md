# Plan: One Container Per Task

## Problem Statement

Currently, each **session** within a task lifecycle creates its own container. A single task with plan mode + review + auto-commit can spawn 5-12 containers:

| Phase | Sessions | Containers Created |
|-------|----------|-------------------|
| Planning | 1 plan session | 1 container |
| Implementation | 1 exec session | 1 container |
| Review loop (N iterations) | N review + N fix sessions | 2N containers |
| Code style | 1 codestyle session | 1 container |
| Commit | 1 commit session | 1 container |
| Merge repair | 1 repair session | 1 container |
| **Total (typical)** | **5-15 sessions** | **5-15 containers** |

Each container takes 5-15s to start, consumes ~512MB RAM, and leaves ephemeral filesystem state on destruction. Files installed by `apt`, npm packages downloaded, git operations cached — all lost. This is wasteful.

## Proposed Solution

**One container per task.** The container lives for the entire task lifecycle. Multiple prompts are sent sequentially to the same Pi RPC process running inside the same container. The container is created once at task start and destroyed once when the task completes.

### How It Works

Pi in RPC mode is designed for this pattern: you send `{type: "prompt", message: "..."}`, wait for `agent_end`, then send another prompt. The agent stays alive, the session persists, the conversation history accumulates.

## Architecture

### Current: Container Per Session

```
Task Lifecycle
├── Create container (session 1) → Plan prompt → agent_end → Destroy container
├── Create container (session 2) → Exec prompt → agent_end → Destroy container
├── Create container (session 3) → Review prompt → agent_end → Destroy container
├── Create container (session 4) → Fix prompt → agent_end → Destroy container
├── ...
```

### Proposed: Container Per Task

```
Task Lifecycle
├── Create container (task container)
│   ├── Plan prompt → agent_end (reuse container)
│   ├── Exec prompt → agent_end (reuse container)
│   ├── Review prompt → agent_end (reuse container)
│   ├── Fix prompt → agent_end (reuse container)
│   ├── ...
│   └── Destroy container
```

## Detailed Changes

### 1. Task-Level Container Tracking

**Impact: HIGH** — Affects data model, all session creation paths.

Current: `PiWorkflowSession` has `containerId`, container named `tauroboros-{sessionId}`.

Change: Add `containerId` to the `Task` model. Container named `tauroboros-task-{taskId}`.

```typescript
// New field on Task
containerId: string | null
```

The container is created in `executeTaskEffect` before any session is started. All sessions within the task reuse this container.

**Files affected:**
- `src/db/types.ts` — Add `containerId` to Task schema
- `src/types.ts` — Add `containerId` to Task type
- `src/runtime/container-manager.ts` — Support `--label tauroboros.task-id=...` for task-level containers
- `src/orchestrator.ts` — `executeTaskEffect` creates container, passes to all child sessions

### 2. ContainerProcess as a Reusable Resource

**Impact: HIGH** — New pattern for process lifecycle.

Currently, `ContainerPiProcess` owns the container lifecycle: `start()` creates it, `close()` destroys it. The process is tightly coupled to a single session.

Change: Extract container lifecycle from `ContainerPiProcess`. Introduce a `TaskContainer` that wraps the Podman container and exposes stdin/stdout streams. Multiple `ContainerPiProcess` instances attach to the same `TaskContainer`.

```typescript
class TaskContainer {
  containerId: string
  stdin: WritableStream
  stdout: ReadableStream

  start(): Effect<void, ContainerManagerError>
  attach(): Effect<ContainerProcess, ContainerManagerError>  // podman exec
  close(): Effect<void, ContainerManagerError>
  isRunning(): Effect<boolean, never>
}
```

`ContainerPiProcess.start()` checks for an existing `TaskContainer`. If one exists, it calls `attach()` instead of `createContainer()`. If not, it creates a new one and registers it.

**Files affected:**
- `src/runtime/container-pi-process.ts` — Accept optional `existingContainerId` from task level
- `src/runtime/container-manager.ts` — Add task-level container tracking, `createTaskContainer()`
- `src/runtime/pi-process-factory.ts` — Pass task-level container ID

### 3. Orchestrator: Container Lifecycle in executeTaskEffect

**Impact: HIGH** — Core execution flow changes.

Current flow in `executeTaskEffect`:
```
1. Create worktree
2. runStandardPrompt() → sessionManager.executePrompt() → creates container → destroys
3. runReviewLoop() → reviewRunner.run() → creates container → destroys
4. runReviewLoop() → sessionManager.executePrompt() (fix) → creates container → destroys
5. runCodeStyleCheck() → creates container → destroys
6. runCommitPrompt() → creates container → destroys
```

New flow:
```
1. Create worktree
2. CREATE TASK CONTAINER (if container mode)
3. runStandardPrompt() → sessionManager.executePrompt() → REUSE container
4. runReviewLoop() → reviewRunner.run() → REUSE container
5. runReviewLoop() → sessionManager.executePrompt() (fix) → REUSE container
6. runCodeStyleCheck() → REUSE container
7. runCommitPrompt() → REUSE container
8. DESTROY TASK CONTAINER
```

Container creation/destruction wrapped in `Effect.acquireRelease` so it's guaranteed to clean up even on error.

**Files affected:**
- `src/orchestrator.ts` — `executeTaskEffect()` method, major restructure

### 4. Session Manager: Accept Existing Container

**Impact: MEDIUM** — Interface change.

`PiSessionManager.executePrompt()` already accepts `existingContainerId` via `ExecuteSessionPromptInput`. This was designed for pause/resume. We extend this to accept a task-level container ID.

The flow:
1. Orchestrator creates `TaskContainer` before any sessions
2. Orchestrator passes `existingContainerId` to EVERY `executePrompt()` call
3. `ContainerPiProcess.start()` checks `existingContainerId`:
   - If set and container running: call `attachToContainer()` instead of `createContainer()`
   - If set but container not running: error (should not happen if lifecycle is managed)
   - If not set: create new container (backward compat)

**Files affected:**
- `src/runtime/session-manager.ts` — Minor, interface already supports this
- `src/runtime/container-pi-process.ts` — `start()` method, attach vs create logic
- `src/runtime/pi-process-factory.ts` — Pass `existingContainerId` through

### 5. Review Session Runner: Accept Existing Container

**Impact: MEDIUM** — `PiReviewSessionRunner` currently creates its own session.

`PiReviewSessionRunner.run()` creates sessions internally via `PiSessionManager`. It needs to accept and pass through the task-level container ID.

**Files affected:**
- `src/runtime/review-session.ts` — Accept `existingContainerId` param
- `src/runtime/codestyle-session.ts` — Accept `existingContainerId` param

### 6. Session Pause/Resume: Container Survivability

**Impact: HIGH** — Pause/resume must not destroy the task container.

Current: Pause kills the container (SIGTERM), resume needs container recreation.

New: Pause should NOT kill the task container. Only the Pi process inside is stopped (via `abort` RPC). The container stays alive. Resume re-attaches via `podman exec`.

Change `pauseSession()`:
- Don't call `forceKill` on task-level containers
- Instead, send `abort` RPC to the Pi process
- The container keeps running

Change `resumeTaskExecution()`:
- Container is already running, just attach via `podman exec`
- No container creation needed

**Files affected:**
- `src/orchestrator.ts` — `pauseSession()` and `resumeTaskExecution()`

### 7. Worktree/Container Cleanup Timing

**Impact: MEDIUM** — Cleanup order changes.

Currently, the worktree and container are destroyed in the same scope (the session's `acquireRelease`). With one container per task, the container must outlive individual sessions but be destroyed when the task completes.

The worktree is currently destroyed in `executeTaskEffect` after the worktree's `complete()` call. The container must be destroyed AFTER the worktree is done (so pi can still do git operations during commit/merge).

New cleanup order in `executeTaskEffect`:
```
try:
  create worktree
  create container
  ... execute all phases ...
finally:
  complete worktree (merge + remove)
  destroy container
```

**Files affected:**
- `src/orchestrator.ts` — Cleanup order in `executeTaskEffect`

### 8. Container Image Consistency

**Impact: LOW** — All sessions must use the same container image.

Currently, different phases might use different container images (e.g., task has custom `containerImage`, but review doesn't). With one container per task, the image is fixed at task start.

Validation: If a task has a custom container image, that image is used for all phases. The `resolveContainerImage()` calls made during review/fix must be consistent with the task-level image.

**Files affected:**
- `src/orchestrator/index.ts` — `resolveContainerImage` usage
- `src/orchestrator.ts` — Review loop, commit, code style image resolution

### 9. Pi Session Files (JSONL)

**Impact: MEDIUM** — Multiple prompts in the same Pi process create one JSONL file per task.

Currently, each session has its own `piSessionFile` (`.tauroboros/pi-sessions/{sessionId}.jsonl`). With one process per task, there's one JSONL file per task containing all conversation history.

The Pi process stays alive between prompts, so the session file accumulates the full conversation. This is actually better for the LLM — it has context from all phases.

Pi's `new_session` RPC command can reset context if needed between phases (e.g., between plan and exec).

**Files affected:**
- `src/runtime/planning-session.ts` — Pi session file path generation
- `src/runtime/pi-process-factory.ts` — Session file assignment

### 10. Resource Limits & Configuration

**Impact: LOW** — Container config is set once per task.

Memory, CPU, and other limits are set at container creation. Since the container lives longer (potentially minutes instead of seconds), resources might need adjustment:

- Memory: 512MB might be tight for a long-lived process with accumulated context
- CPU: 1 core is fine but might extend wall-clock time
- Disk: No change (ephemeral container filesystem)

Consider making the container slightly more generous (768MB-1GB) since it now handles the full task lifecycle.

**Files affected:**
- `src/runtime/container-pi-process.ts` — Maybe adjust defaults
- `src/config/settings.ts` — No change needed, user-configured

## Attention Points / Risks

### Risk 1: Pi Process State Between Prompts

**Severity: HIGH**

Pi's RPC agent accumulates state between prompts. The conversation history includes all prior tool calls, file edits, etc. This might cause:
- Confusion: The agent might reference previous phase's tool outputs
- Context overflow: Accumulated messages could eat context window
- Tool reuse: Tools from planning might interfere with execution

**Mitigation:**
- Use Pi's `new_session` RPC command between phases to reset conversation context
- The new session can fork from the parent, preserving relevant context
- Or: Use `compact` RPC to summarize older context

### Risk 2: Pi Process Crash = Task Failure

**Severity: HIGH**

If the Pi process crashes (OOM, bug, signal), the entire task fails because all phases share one process. Currently, only the current session is lost.

**Mitigation:**
- Add a health check before each prompt
- On crash: create a new `podman exec` session (re-attach to the same container)
- On container crash: restart container (though worktree files survive)
- Consider a "reconnect" mechanism that preserves pi session files

### Risk 3: Container Resource Exhaustion

**Severity: MEDIUM**

A long task (many review iterations) keeps the container running for an extended period. The container's filesystem accumulates:
- npm/node_modules from package installs
- apt cache from system package installs
- Large git objects and worktree modifications

**Mitigation:**
- Set resource limits (already done)
- Monitor container disk usage via `podman inspect`
- The `--rm` flag on the container ensures cleanup
- Still much cheaper than creating/destroying containers

### Risk 4: Pause/Resume Semantics Change

**Severity: HIGH**

Current pause kills everything and fully persists state. With a persistent container, pause should NOT kill the container — just the Pi process. Resume re-attaches.

If the host restarts, the container is lost (it has `--rm`). This means:
- Pause across host restart loses the container
- Resume would need to recreate the container AND re-attach to the pi session file

**Mitigation:**
- Persist container ID in paused state (already done)
- On resume: if container is gone, create a new one and use `pi --session <file>` to restore conversation
- Store pi session file path in paused state (already done)

### Risk 5: Review Loop Isolation

**Severity: MEDIUM**

Currently, each review run gets a fresh Pi process with no history. This ensures the reviewer evaluates the code objectively, not influenced by the implementation context.

With a shared process, the reviewer sees the entire conversation history. This could bias the review.

**Mitigation:**
- Use `new_session` RPC before review prompts to start fresh
- Or: send review prompts with explicit instructions to ignore history
- The `compact` command can also help here

### Risk 6: Multiple Tasks in Parallel

**Severity: LOW**

When running with `parallelTasks > 1`, each task gets its own container. No change needed — the one-container-per-task model scales linearly.

The container manager needs to track containers at both task and session level. Task-level containers are tracked by `taskId`, session-level by `sessionId`. The existing `containers` Map can be keyed by `sessionId`, with a new `taskContainers` Map keyed by `taskId`.

### Risk 7: Best-of-N Execution

**Severity: MEDIUM**

Best-of-N runs N parallel Pi processes. Each process currently gets its own container. With one container per task, Best-of-N needs N containers (one per parallel run).

This is already correct — Best-of-N creates N workers, each is conceptually a subtask, each gets its own container. The `BestOfNRunner` class needs to track containers separately.

### Risk 8: Session Pause State Schema

**Severity: MEDIUM**

The `PausedSessionState` currently stores `containerId`. When pausing a task-level session, the `containerId` is the task container. On resume, this must be correctly resolved.

The `resumeTaskExecution()` already handles `existingContainerId`. We just need to ensure the task container ID is correctly stored in the paused state.

## Migration Plan

### Phase 1: Data Model (Safe, no behavior change)
- Add `containerId` to Task type and DB schema
- Add `taskContainers` Map to `PiContainerManager`
- No behavior changes yet

### Phase 2: TaskContainer Resource (New feature, opt-in)
- Extract `TaskContainer` class
- Add `createTaskContainer()`, `attachToTaskContainer()`, `destroyTaskContainer()` to container manager
- `ContainerPiProcess` can attach to task container via `existingContainerId`
- Test independently

### Phase 3: Orchestrator Integration (High risk)
- `executeTaskEffect` creates container before sessions
- All child method calls pass `existingContainerId`
- Container destroyed in `finally` block
- Review loop, code style, commit all reuse container
- Validate parallel tasks work correctly

### Phase 4: Pause/Resume (Medium risk)
- `pauseSession` sends `abort` instead of `forceKill` for task-level containers
- `resumeTaskExecution` re-attaches via `podman exec`
- Test pause across server restart

### Phase 5: Cleanup
- Validate no orphan containers remain
- Validate worktree cleanup order
- Emergency stop still works (kills all task containers)
- Validatesettings.json and container images

### Phase 6: Validation
- Run `tests/e2e/real-workflow.spec.ts`
  - Test has to pass 3 consecutive times
  - No container should be online at the end of each run to validade resource cleanup
  - All tasks should pass to validate everything still works

## Rollout Strategy

1. **Feature flag**: Introduce `workflow.container.perTask: true` in settings. Default: `false` (backward compatible). When `true`, use one-container-per-task. When `false`, use current behavior.

2. **Gradual rollout**: Users can test with non-critical workflows first

3. **Remove flag**: After thorough testing, make one-container-per-task the default, then remove the flag

## Success Metrics

| Metric | Before | After (expected) |
|--------|--------|------------------|
| Containers per task (typical) | 5-15 | 1 |
| Avg container startup time per task | 25-75s | 5-15s |
| RAM overhead per task | 2.5-7.5GB | 512MB-1GB |
| Docker/podman API calls per task | 10-30 | 2-4 |
| Filesystem state persistence | None | Full (installs survive) |

## Key Files Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/db/types.ts` | Add field | `Task.containerId` |
| `src/types.ts` | Add field | `Task.containerId` |
| `src/runtime/container-manager.ts` | New methods | `createTaskContainer()`, `destroyTaskContainer()`, task-level tracking |
| `src/runtime/container-pi-process.ts` | Modify | Accept task-level `existingContainerId`, attach instead of create |
| `src/runtime/pi-process-factory.ts` | Modify | Pass task container ID through |
| `src/runtime/session-manager.ts` | Minor | Already supports `existingContainerId` |
| `src/runtime/review-session.ts` | Modify | Accept and pass `existingContainerId` |
| `src/runtime/codestyle-session.ts` | Modify | Accept and pass `existingContainerId` |
| `src/orchestrator.ts` | Major | `executeTaskEffect` creates/manages container lifecycle |
| `src/config/settings.ts` | Add flag | `workflow.container.perTask` feature flag |
| `src/runtime/session-pause-state.ts` | Minor | Ensure container ID survives pause |
