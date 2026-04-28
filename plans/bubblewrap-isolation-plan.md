# Bubblewrap Isolation Implementation Plan

## Scope

- Implement this only for the Rust backend and the current Solid frontend.
- Do not preserve runtime compatibility with the deprecated TypeScript backend.
- Planning sessions stay outside bubblewrap.
- For this iteration, do not split filesystem access by execution phase. Every non-planning agent session gets full repository-tree access inside bubblewrap.
- Bubblewrap is on by default and can be disabled globally from Options.
- Sandboxed sessions always keep full network access, read access to `~/.pi`, read-write access to `/tmp`, and access to development binaries.

## Current-State Findings

1. All non-interactive task execution in the Rust backend ultimately spawns Pi from `src/backend/src/orchestrator/pi.rs`.
2. Interactive planning sessions are launched separately in `src/backend/src/orchestrator/planning_session.rs` via `routes/planning.rs`.
3. The Rust backend already commits and merges directly through `src/backend/src/orchestrator/git.rs`. This plan keeps that completion model and does not introduce a separate commit agent module or commit session.
4. Task worktrees live under `<repo>/.worktrees/...`, and each worktree `.git` file points back into the main repository `.git/worktrees/...` metadata. The earlier worktree-only design would have required special git metadata handling; the simplified full-tree design avoids that first-pass complexity.
5. Best-of-N reviewers currently run without a task worktree and use the project root as `cwd`, which fits the simplified full-tree profile and removes the need for a reviewer-specific filesystem policy in this iteration.

## Target Runtime Model

### Isolation Profiles

| Profile | Applies To | Filesystem Access |
| --- | --- | --- |
| Planning bypass | `PiSessionKind::Planning`, `PiSessionKind::Plan`, `PiSessionKind::PlanRevision` | No bubblewrap |
| Full-tree profile | Standard task execution, review-fix sessions, review scratch, best-of-n workers, best-of-n reviewers, and best-of-n final applier | Full repository root RW, including the main tree, `.git`, and `.worktrees` |

### Always-On Bubblewrap Grants

- `~/.pi` mounted read-only.
- `/tmp` mounted read-write.
- Shared network namespace so agents always have full host network access.
- Existing directories from `PATH` mounted read-only so common toolchains remain executable.
- Required system library and runtime roots mounted read-only (for example `/usr`, `/bin`, `/lib`, `/lib64`, `/sbin`, plus distro-specific roots when present).
- Minimal runtime files needed for DNS/TLS and process execution mounted read-only (for example `/etc/resolv.conf`, `/etc/hosts`, `/etc/nsswitch.conf`, CA certificate roots, `/dev/null`, `/dev/urandom`, `/proc`).
- Per-task extra grants layered on top with explicit `ro` or `rw` access.

### Data Model Changes

- Global option: `bubblewrapEnabled: boolean`, default `true`.
- Per-task field: `additionalAgentAccess`, represented as an array of objects like `{ path, access }`, where `access` is exactly `ro` or `rw`.
- Per-session persisted metadata: the resolved isolation mode plus the fully resolved path grants used for that session, so audits and debugging can inspect the actual sandbox that was applied.

## File-by-File Plan

### New file: `src/backend/src/orchestrator/isolation.rs`

- Add the Rust-side isolation domain model:
  - `PathAccessMode` (`ReadOnly`, `ReadWrite`)
  - `PathGrant`
  - `SessionIsolationMode` (`None`, `Bubblewrap`)
  - `ResolvedIsolationSpec`
- Centralize all path normalization and validation:
  - expand `~/...`
  - canonicalize absolute paths
  - reject ambiguous or missing paths with explicit `ApiError`
  - collapse duplicates deterministically
- Add helpers to derive the correct session profile from task/session context.
- Add a helper that resolves the repository root and builds the full-tree grant for all non-planning sessions.
- Build the final `bwrap` argv here instead of scattering flags across orchestrator modules.
- Discover host binary directories from `PATH` and add them as read-only mounts, then add system library/runtime directories needed by those binaries.
- Serialize the resolved grants into JSON so the session record can store the exact sandbox used.

### `src/backend/src/orchestrator/mod.rs`

- Register the new `isolation` module.
- Keep the current completion flow in place after agent execution:
  1. implementation session under the full-tree profile
  2. optional review / review-fix under the same full-tree profile
  3. existing backend-side `auto_commit_worktree()` / `merge_and_cleanup_worktree()` handling
- Add audit details that clearly distinguish sandboxed agent execution from backend-side git completion work.
- Keep the existing no-fallback policy: if bubblewrap setup fails, the task fails explicitly instead of falling back to unsandboxed Pi.

### `src/backend/src/orchestrator/pi.rs`

- Refactor `spawn_process()` so it can launch either plain `pi` or `bwrap ... -- pi ...` based on the already-resolved session isolation spec.
- Stop deriving everything from `PI_BIN` alone. Build a structured spawn plan containing:
  - executable
  - args
  - env
  - current dir
  - optional bubblewrap wrapper args
- Set an explicit in-sandbox `HOME` value that makes `~/.pi` resolve consistently.
- Keep stdout/stderr handling and RPC framing unchanged.
- Extend audit logging to capture whether the session ran sandboxed, which profile was used, and the normalized grants JSON.

### `src/backend/src/orchestrator/planning_session.rs`

- Keep interactive planning session creation and reconnect flows unsandboxed.
- Make that exemption explicit by persisting `SessionIsolationMode::None` on planning sessions instead of relying on the absence of wrapper logic.
- Keep the current process-spawn path intact so planning sessions do not accidentally inherit the task-execution sandbox later.

### `src/backend/src/orchestrator/plan_mode.rs`

- Treat plan generation and plan revision as planning-bypass sessions.
- Keep approved implementation sessions sandboxed like normal non-planning task execution under the full-tree profile.
- Keep the current direct `auto_commit_worktree()` / `merge_and_cleanup_worktree()` completion path.
- Do not introduce a separate plan-mode filesystem policy in this iteration; implementation and any commit prompt use the same full-tree sandbox.

### `src/backend/src/orchestrator/review.rs`

- Review scratch sessions should use the standard full-tree profile.
- Review-fix sessions should also use the standard full-tree profile.
- No bubblewrap flag assembly should live here; the only responsibility in this file is choosing the correct session kind/profile and persisting it on the session record.
- Review loops should still operate on the task worktree as their primary target, but the sandbox no longer hides the rest of the repository in this iteration.

### `src/backend/src/orchestrator/best_of_n.rs`

- Worker sessions: use the standard full-tree profile.
- Reviewer sessions: use the same full-tree profile for now instead of getting a special reviewer sandbox.
- Final applier session: keep implementation under the same full-tree profile.
- Keep the current backend-side post-apply merge/cleanup flow.
- Ensure the same isolation metadata and audit conventions are used across worker, reviewer, and final applier sessions even though completion stays backend-driven.

### `src/backend/src/orchestrator/git.rs`

- Split the current helpers into clearer responsibilities:
  - resolve repository root and task worktree paths
  - verify whether a worktree has uncommitted changes
  - verify whether a task branch is merged into the target branch
  - cleanup worktree only after verification
- Keep backend-side git helpers as the existing completion mechanism for auto-commit, merge, verification, and cleanup.
- Tighten validation around the current backend-driven merge path rather than replacing it.
- Add unit tests for:
  - repo root and worktree path resolution
  - merge verification
  - cleanup safety after backend-driven merge completion

### `src/backend/src/models.rs`

- Add `bubblewrap_enabled: bool` to `Options`.
- Add a structured per-task access field, for example `additional_agent_access`, backed by JSON and serialized as camelCase to the frontend.
- Add new supporting types, such as:
  - `TaskPathGrant`
  - `TaskPathAccessMode`
  - `SessionIsolationMode`
- Add session metadata fields to `PiWorkflowSession`:
  - `isolation_mode`
  - `path_grants_json`
- Keep serde/sqlx mappings aligned with the existing style.

### `src/backend/src/db/mod.rs`

- Update fresh schema creation for new databases:
  - `options.bubblewrap_enabled INTEGER NOT NULL DEFAULT 1`
  - `tasks.additional_agent_access TEXT`
  - `pi_workflow_sessions.isolation_mode TEXT NOT NULL DEFAULT 'none'`
  - `pi_workflow_sessions.path_grants_json TEXT NOT NULL DEFAULT '[]'`
- Make this the new canonical schema and DO NOT introduce any migration
- No commit-prompt changes are required for this scope because the plan does not introduce a new commit session or commit agent flow.

### `src/backend/src/db/queries.rs`

- Include `additional_agent_access` in `create_task_db()` and `update_task()`.
- Ensure `get_task()` / `get_tasks()` / `get_options()` hydrate the new fields automatically via the updated models.
- Add JSON encode/decode handling for the per-task access grants using the same pattern already used for JSON-backed fields.

### `src/backend/src/db/runtime.rs`

- Extend `CreateWorkflowSessionRecord` and `UpdateWorkflowSessionRecord` to carry:
  - resolved isolation mode
  - resolved grants JSON
- Persist the resolved sandbox configuration at session creation time instead of re-deriving it in `spawn_process()`.
- Keep this data stable through reconnects and status transitions.
- This record should become the single source of truth for what sandbox a specific session actually used.

### `src/backend/src/routes/options.rs`

- Accept and persist `bubblewrapEnabled` in `UpdateOptionsRequest`.
- Return it in `GET /api/options` with `true` as the default for fresh installs.
- Broadcast `options_updated` after changes as today.
- Do not add a per-task bubblewrap on/off switch here. The request only asked for a global kill switch.

### `src/backend/src/routes/tasks/mod.rs`

- Accept `additionalAgentAccess` on create and update payloads.
- Validate request shape at the HTTP boundary:
  - every item has a non-empty path
  - `access` is exactly `ro` or `rw`
  - duplicates are rejected or normalized deterministically
- Keep deeper canonicalization in the shared backend helper layer, but malformed request bodies should fail fast here.
- Ensure task list/detail normalization round-trips the new field.

### `src/backend/src/routes/planning.rs`

- Interactive planning sessions created here must remain outside bubblewrap.
- If session records now expose isolation metadata, return `isolationMode: none` for planning sessions so the UI can distinguish them from task execution sessions.
- Treat `PiSessionKind::ContainerConfig` explicitly during implementation:
  - either keep it aligned with planning bypass for now
  - or decide later to sandbox it separately
- Do not let it silently inherit task-execution bubblewrap behavior.

### `src/frontend/src/components/tabs/OptionsTab.tsx`

- Add a global `bubblewrapEnabled` toggle, defaulting to `true` for fresh/empty form state.
- Add concise help text that explains:
  - this is the global kill switch
  - planning sessions are not sandboxed
  - all other agent sessions are sandboxed by default with full repository access
- Update save/reset flows so the value round-trips cleanly.

### `src/frontend/src/components/modals/TaskModal.tsx`

- Add an advanced-section editor for `additionalAgentAccess`.
- Recommended UI shape:
  - repeatable rows
  - `path` text field
  - `access` select with `ro` / `rw`
  - add/remove row actions
- Keep it separate from container image settings; this is a filesystem grant editor, not container configuration.
- Default to no extra grants.
- Serialize directly to the backend payload shape.

### Frontend shared types source

- The frontend currently resolves shared types through a path outside the Solid tree. Since compatibility with the deprecated TypeScript backend can be broken, use this implementation to stop depending on legacy runtime assumptions.
- Whichever file is authoritative for frontend shared types at implementation time must add:
  - `Options.bubblewrapEnabled`
  - `Task.additionalAgentAccess`
  - any new session/isolation fields surfaced in the UI
- If the current alias still points into legacy definitions, move it to a frontend-owned or Rust-owned contract file as part of this work instead of threading new Rust-only fields through deprecated runtime code.

### `src/frontend/src/api/options.ts`

- Keep request/response typing in sync with `bubblewrapEnabled`.
- No route shape change is needed beyond the new field.

### `src/frontend/src/api/tasks.ts`

- Extend `CreateTaskDTO` / `UpdateTaskDTO` typing to carry `additionalAgentAccess`.
- If task or session detail views will expose isolation metadata, add the corresponding typed fields now rather than treating them as untyped payload.

### `src/frontend/src/stores/optionsStore.ts`

- Ensure option cache state includes `bubblewrapEnabled`.
- No special behavior beyond typing and invalidation should be needed.

### `src/frontend/src/stores/tasksStore.ts`

- Ensure cached task updates preserve `additionalAgentAccess`.
- If task/session detail UI later surfaces isolation metadata, the store will already have the right data shape.

### New doc: `docs/bubblewrap-isolation.md`

- Create a Rust-backend-specific bubblewrap document instead of extending the old TS-only container isolation doc.
- Document:
  - default-on bubblewrap behavior
  - planning exemption
  - always-on grants (`~/.pi`, `/tmp`, network, binaries)
  - full-tree access for all non-planning sessions in this iteration
  - per-task extra grant format
  - explicit failure behavior when `bwrap` is missing or a path grant is invalid

### `README.md`

- Update the isolation section to describe bubblewrap as the Rust default.
- Update the all sections to remove the references about containers
- Make it explicit that planning sessions are exempt, but all other agent sessions currently get full repository access inside bubblewrap.

## Tests To Add Or Update

### Rust unit tests

- New tests in `src/backend/src/orchestrator/isolation.rs`:
  - path normalization
  - duplicate grant collapsing
  - planning/full-tree profile resolution
  - bubblewrap argv generation
- Update `src/backend/src/orchestrator/git.rs` tests:
  - branch merge verification
  - cleanup behavior after backend-driven merge completion
- Add focused spawn-plan tests near `src/backend/src/orchestrator/pi.rs` to prove that session metadata selects plain `pi` versus `bwrap -- pi` correctly.

### API and integration tests

- `tests/execution.test.ts`
  - standard execution sessions are sandboxed by default
  - turning off `options.bubblewrapEnabled` disables the wrapper globally
- `tests/plan-mode.test.ts`
  - planning session kinds bypass bubblewrap
  - plan-mode implementation runs sandboxed
- `tests/review-loop.test.ts`
  - review scratch and review-fix sessions use the standard full-tree profile
- `tests/best-of-n.test.ts`
  - workers, reviewers, and final applier use the standard full-tree profile
- `tests/server.test.ts` or `tests/settings-effect.test.ts`
  - `bubblewrapEnabled` round-trips through the options API
  - `additionalAgentAccess` round-trips through the task API
- Add one focused end-to-end test for backend-driven completion:
  - a non-planning sandboxed session can access both the task worktree and main repository tree
  - existing backend auto-commit and merge still succeed after sandboxed execution
  - task only reaches `done` after merge verification passes

## Recommended Implementation Order

1. Add model, schema, and API contract changes for `bubblewrapEnabled`, `additionalAgentAccess`, and session isolation metadata.
2. Implement `src/backend/src/orchestrator/isolation.rs` with unit tests.
3. Persist resolved session isolation metadata in `db/runtime.rs` and session creation sites.
4. Wrap `PiSessionExecutor::spawn_process()` with bubblewrap support.
5. Harden the existing backend-driven auto-commit / merge / cleanup path so it works cleanly alongside sandboxed execution metadata.
6. Update docs and integration tests.

## Key Decisions And Risks

1. This simplified version deliberately drops worktree-only isolation. Any non-planning session can touch the main repository tree, so audit logging and merge verification need to be stronger to compensate.
2. `PiSessionKind::ContainerConfig` needs an explicit decision during implementation. It should either stay aligned with planning bypass or get its own separate sandbox policy, but it must not inherit task-execution behavior by accident.
3. Backend-driven git completion may still need narrow access to `~/.gitconfig` and possibly `~/.ssh` depending on how commit identity and remotes are configured on the host. This should be validated with focused tests rather than assumed.
4. Do not add silent fallback to unsandboxed execution if `bwrap` is missing. Surface a clear task/session failure with clear logging instead.

## Success Criteria

- Planning sessions remain unsandboxed.
- All non-planning agent execution sessions use bubblewrap by default.
- All non-planning sandboxed sessions can access the full repository tree for now.
- Existing backend-driven auto-commit and merge behavior continues to work after sandboxed execution.
- `~/.pi` is always readable, `/tmp` is always writable, network remains shared/full, and development binaries remain usable.
- Users can add per-task extra path grants with explicit `ro` / `rw` access.
- Global Options can disable bubblewrap entirely.
- Session records and logs show which isolation profile was actually used.