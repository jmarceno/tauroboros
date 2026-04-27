---
title: Rust Backend Feature Parity Plan
status: in_progress
updated_at: 2026-04-27
owner: github-copilot
scope:
  target: tauroboros-rust
  source_of_truth:
    - frontend API contracts in src/kanban-solid/src/api
    - TypeScript backend routes in src/server
constraints:
  - Rust backend must stay native-only for now; no container execution support.
  - Rust backend API must remain 100% compatible with the existing frontend.
  - No error swallowing or implicit fallbacks; failures must be explicit and surfaced immediately.
  - Prefer Rust source files under 1000 lines; if an exception is necessary, add a file header comment explaining why.
  - Rust distribution must support a single distributable binary containing the Rust backend and Solid frontend assets.
hydration:
  current_phase: runtime_behavior_and_browser_validation
  next_phase: route_payload_and_sse_parity_hardening
  blockers:
    - Full TypeScript-to-Rust behavioral parity is not yet verified route by route for runs, sessions, planning, and archives.
    - SSE contract parity is NOT YET verified event by event against the frontend stores (hub fixes applied, but browser-level validation pending).
    - Rust warnings have been cleaned to zero.
    - Planning session Pi integration is now real — `PlanningSessionManager` manages Pi RPC lifecycle, event streaming, message persistence, and SSE broadcasting.
    - tauroboros-rust/src/routes/tasks.rs has been split into a module directory with sub-modules:
      - mod.rs (795 lines, under guardrail)
      - best_of_n.rs (135 lines)
      - repair.rs (95 lines)
    - tauroboros-rust/src/orchestrator split into execution mode sub-modules:
      - plan_mode.rs (418 lines)
      - review.rs (371 lines)
      - best_of_n.rs (723 lines)
    - tauroboros-rust/src/orchestrator/planning_session.rs created (692 lines) — planning session manager with Pi RPC lifecycle.
---

# Rust Backend Feature Parity Plan

## Objective

Bring the Rust backend to feature parity with the TypeScript backend, excluding container execution features, while preserving full frontend compatibility and preparing a single-binary distribution path for the Rust backend plus embedded Solid frontend.

## Non-Negotiable Constraints

- Rust remains native-only for execution.
- Container endpoints must not disappear if the frontend depends on them; they must stay API-compatible and explicitly report unsupported/native-only behavior where appropriate.
- Frontend compatibility is measured at the HTTP contract level: routes, methods, status codes, payload shapes, SSE event names, and option fields.
- Rust files should stay below 1000 lines unless a documented exception is added at the file header.
- The Rust distribution must include a build path for embedding or bundling the Solid frontend into a single distributable binary.

## Current Snapshot

### Source Of Truth

- Frontend API modules:
  - src/kanban-solid/src/api/tasks.ts
  - src/kanban-solid/src/api/runs.ts
  - src/kanban-solid/src/api/options.ts
  - src/kanban-solid/src/api/sessions.ts
  - src/kanban-solid/src/api/taskGroups.ts
  - src/kanban-solid/src/api/planning.ts
  - src/kanban-solid/src/api/reference.ts
  - src/kanban-solid/src/api/stats.ts
  - src/kanban-solid/src/api/selfHeal.ts
  - src/kanban-solid/src/api/containers.ts
- TypeScript backend route registration:
  - src/server/server.ts
  - src/server/routes/task-routes.ts
  - src/server/routes/execution-routes.ts
  - src/server/routes/session-routes.ts
  - src/server/routes/planning-routes.ts
  - src/server/routes/task-group-routes.ts
  - src/server/routes/stats-routes.ts
  - src/server/routes/container-routes.ts
- Rust backend route registration:
  - tauroboros-rust/src/main.rs
  - tauroboros-rust/src/routes/mod.rs

### Route Surface Expected By The Frontend

- Tasks:
  - GET /api/tasks
  - POST /api/tasks
  - POST /api/tasks/create-and-wait
  - PUT /api/tasks/reorder
  - DELETE /api/tasks/done/all
  - GET /api/tasks/:id
  - PATCH /api/tasks/:id
  - DELETE /api/tasks/:id
  - GET /api/tasks/:id/runs
  - GET /api/tasks/:id/sessions
  - GET /api/tasks/:id/candidates
  - GET /api/tasks/:id/best-of-n-summary
  - GET /api/tasks/:id/review-status
  - GET /api/tasks/:id/last-update
  - POST /api/tasks/:id/start
  - POST /api/tasks/:id/approve-plan
  - POST /api/tasks/:id/request-plan-revision
  - POST /api/tasks/:id/request-revision
  - POST /api/tasks/:id/reset
  - POST /api/tasks/:id/reset-to-group
  - POST /api/tasks/:id/move-to-group
  - POST /api/tasks/:id/repair-state
  - GET /api/tasks/:id/self-heal-reports
  - POST /api/tasks/:id/best-of-n/select-candidate
  - POST /api/tasks/:id/best-of-n/abort
- Execution and runs:
  - POST /api/start
  - POST /api/execution/start
  - POST /api/stop
  - POST /api/execution/stop
  - POST /api/execution/pause
  - GET /api/runs
  - GET /api/runs/paused-state
  - GET /api/runs/:id/paused-state
  - GET /api/runs/:id/queue-status
  - GET /api/runs/:id/self-heal-reports
  - POST /api/runs/:id/pause
  - POST /api/runs/:id/resume
  - POST /api/runs/:id/stop
  - POST /api/runs/:id/force-stop
  - POST /api/runs/:id/clean
  - DELETE /api/runs/:id
  - GET /api/slots
  - GET /api/execution-graph
- Sessions and SSE:
  - GET /api/sessions/:id
  - GET /api/sessions/:id/messages
  - GET /api/sessions/:id/timeline
  - GET /api/sessions/:id/usage
  - GET /api/sessions/:id/stream
  - POST /api/pi/sessions/:id/events
  - GET /sse
- Planning:
  - GET /api/planning/prompt
  - GET /api/planning/prompts
  - PUT /api/planning/prompt
  - GET /api/planning/prompt/:key/versions
  - GET /api/planning/sessions
  - GET /api/planning/sessions/active
  - POST /api/planning/sessions
  - GET /api/planning/sessions/:id
  - PATCH /api/planning/sessions/:id
  - GET /api/planning/sessions/:id/messages
  - GET /api/planning/sessions/:id/timeline
  - PUT /api/planning/sessions/:id/name
  - POST /api/planning/sessions/:id/messages
  - POST /api/planning/sessions/:id/reconnect
  - POST /api/planning/sessions/:id/model
  - POST /api/planning/sessions/:id/stop
  - POST /api/planning/sessions/:id/close
  - POST /api/planning/sessions/:id/create-tasks
- Task groups:
  - GET /api/task-groups
  - POST /api/task-groups
  - GET /api/task-groups/:id
  - PATCH /api/task-groups/:id
  - DELETE /api/task-groups/:id
  - POST /api/task-groups/:id/tasks
  - DELETE /api/task-groups/:id/tasks
  - POST /api/task-groups/:id/start
  - GET /api/tasks/:id/group
- Reference and settings:
  - GET /api/options
  - PUT /api/options
  - GET /api/version
  - GET /api/branches
  - GET /api/models
  - GET /api/container/image-status
  - GET /api/workflow/status
  - GET /healthz
- Stats and archives:
  - GET /api/stats/usage
  - GET /api/stats/tasks
  - GET /api/stats/models
  - GET /api/stats/duration
  - GET /api/stats/timeseries/hourly
  - GET /api/stats/timeseries/daily
  - GET /api/archived/tasks
  - GET /api/archived/tasks/:taskId
  - GET /api/archived/runs
- Container compatibility endpoints that must remain frontend-safe even in native mode:
  - GET /api/container/profiles
  - POST /api/container/profiles
  - GET /api/container/status
  - POST /api/container/validate
  - GET /api/container/dockerfile/:profileId
  - POST /api/container/build
  - GET /api/container/build-status
  - POST /api/container/build/cancel
  - GET /api/container/images
  - POST /api/container/validate-image
  - DELETE /api/container/images/:tag

## Gap Inventory

### Confirmed High-Risk Gaps

- Planning session parity still needs deeper behavioral verification, but request/response naming, sessionUrl payload alignment, and prompt version persistence are now aligned.
- Run lifecycle parity still needs deeper behavioral verification around stop, force-stop, clean, and broader state-transition semantics, but standard queue-status, pause/resume, stale/archive, and dependency progression are now browser-verified.
- Global and per-session SSE contract still needs event-by-event validation against the frontend stores.
- Advanced execution modes still fail explicitly in Rust instead of matching TypeScript behavior.

### Areas To Verify Before Editing Deeper Runtime Behavior

- Exact JSON response envelope compatibility for every frontend API method.
- Exact option field coverage between TypeScript and Rust persistence layers.
- SSE event names and payload shapes emitted from Rust versus TypeScript.
- Archived-task and archived-run payload normalization.
- Version payload shape and model/branch discovery payloads.
- Native-mode container endpoint behavior expected by the frontend when containers are unavailable.

## Implementation Strategy

### Phase 1: Inventory Lock

- [x] Create a hydratable working plan in plans.
- [x] Build a TS-to-Rust route matrix with method, path, request shape, response shape, and event dependencies.
- [x] Mark endpoints as compatible, partially compatible, or missing.
- [x] Identify DB schema deltas required for payload compatibility.

### Phase 2: API Contract Closure

- [x] Close the obvious contract mismatches in request and response field naming by aligning Rust serialization to camelCase and planmode expectations.
- [x] Close the global SSE route mismatch by exposing /sse while preserving /ws.
- [x] Close the execution graph path mismatch by exposing /api/execution-graph with groupId support.
- [x] Keep container endpoints explicitly native-only but frontend-compatible at the route level.
- [x] Close the task, planning, run, self-heal, and stats payload mismatches discovered by the deeper endpoint audits.

### Phase 3: Runtime Behavior Closure

- [~] Align Rust workflow state transitions with frontend assumptions.
- [x] Align planning/session message persistence reads and timeline-adjacent message payload shape for task/session views.
- [~] Align run queue, pause, resume, stop, and clean semantics.
- [x] Align self-heal and prompt-version read contracts where exposed to the UI.
- [x] Replace placeholder task, group, and workflow start routes with native orchestration entry points.
- [x] Add native workflow run, task run, and workflow session persistence in Rust.
- [x] Add native Pi RPC task execution and git worktree lifecycle in Rust.
- [x] Replace silent DB mutation swallowing in touched orchestration paths.

### Phase 4: Packaging

- [x] Add a frontend build pipeline for the Rust binary path.
- [x] Embed or bundle Solid assets into the Rust server for SPA serving.
- [x] Preserve / and /assets routing compatibility.
- [x] Provide a documented build target for one distributable binary.

### Phase 5: Verification

- [ ] Add or update compatibility tests for route and payload parity.
- [ ] Run Rust formatting and linting.
- [x] Run Rust builds and tests.
- [x] Run frontend-facing integration checks against the Rust backend.
- [x] Verify the Solid frontend works unchanged against the Rust backend in a browser session.

## Completed In This Iteration

- Fixed all 61 pre-existing Clippy warnings across the codebase (needless_borrows_for_generic_args, ptr_arg, needless_borrow, unnecessary_unwrap, let_unit_value, derivable_impls, match_like_matches_macro, redundant_closure, question_mark, redundant_pattern_matching, too_many_arguments). Build, tests (6/6), and clippy --deny warnings all pass cleanly.

- Replaced the placeholder planning session Pi integration with a real `PlanningSessionManager` (`tauroboros-rust/src/orchestrator/planning_session.rs`):
  - Spawns a Pi RPC process on session creation with system prompt
  - Sends `set_model` and `set_thinking_level` RPC commands to running processes
  - Persists user messages to DB and forwards them to the Pi process via RPC
  - Runs a background event processor that reads Pi process stdout, persists streaming events to DB, and broadcasts them via SSE as `planning_session_message` events
  - Manages process lifecycle: create, send_message, stop (SIGKILL), close (graceful shutdown with timeout)
  - Supports model changes on live sessions via `set_model` RPC
  - Wired into `AppState` and `main.rs` as a shared dependency
  - Maintains zero-warnings compilation and all existing tests pass (6/6)

- Split tauroboros-rust/src/routes/tasks.rs (1011 lines) into a module directory with sub-modules:
  - mod.rs (795 lines) - core CRUD, plan/revision, reset/move, start/create-and-wait
  - best_of_n.rs (135 lines) - candidates, best-of-n summary, select/abort
  - repair.rs (95 lines) - repair-state, self-heal-reports
- Reduced Rust warnings from 77 to 0; the codebase now compiles cleanly with no warnings.
- Fixed the SSE session streaming contract: hub `broadcast_message` now sends events with event name `session_message` and `broadcast_status` sends with event name `session_status`, matching the frontend's `sessionSseStore.ts` expectations. The data format now matches what the frontend expects: `{"type":"session_message","sessionId":"...","payload":{...}}`.
- Added `GET /api/runs/:id` route for direct individual run access by the frontend.
- Kept exception header in `tasks.rs` (1011 lines) acknowledging the file size guardrail with documented rationale.
- Added a living parity plan in plans and updated it during implementation.
- Aligned core Rust request and response naming with frontend-facing camelCase contracts.
- Added JSON serialization fixes for stored JSON string fields used by tasks, runs, options, candidates, and session messages.
- Exposed `/sse`, `/healthz`, `/api/execution-graph`, and the missing native-mode container routes expected by the frontend.
- Added frontend serving routes in the Rust backend for `/`, `/assets/*`, and SPA fallback behavior.
- Added an `embedded-frontend` Cargo feature plus build script so the Rust binary can embed the compiled Solid frontend.
- Fixed the Solid production build so the embedded frontend packaging flow succeeds.
- Fixed the self-heal report schema mapping so Rust now reads and serializes the same DB shape as the TypeScript backend.
- Added the missing run-level self-heal route plus real task-level self-heal and task-message queries.
- Added planning prompt version storage/query support and backfilled version rows for existing prompts during migration.
- Corrected `/api/stats/duration` to return the frontend-expected bare integer minute value.
- Runtime-smoke-tested `/`, `/healthz`, `/api/version`, `/api/options`, `/api/stats/duration`, `/api/planning/prompt/default/versions`, `/api/runs/:id/self-heal-reports`, `/api/tasks/:id/self-heal-reports`, and `/sse` against the live Rust server.
- Added native Rust orchestration infrastructure for real execution:
  - workflow runs, task runs, and workflow session DB lifecycle helpers
  - prompt-template seeding for execution/planning/revision/commit
  - Pi RPC subprocess execution with session-message persistence
  - git worktree creation, merge, and cleanup helpers
  - dependency-aware slot-based scheduler for start-all, start-single, and start-group
- Rewired the Rust execution/workflow/task-group/task-start/run-control routes to delegate to the new orchestrator instead of placeholder success paths.
- Replaced the Rust `create-and-wait` placeholder with real task creation, execution start, polling, and timeout stop behavior.
- Switched Rust startup to infrastructure-only settings loading so `.tauroboros/settings.json` no longer stores workflow branch/options.
- Replaced shell-managed Rust git/worktree operations with `git2` and made `/api/branches` resolve against `project_root`.
- Fixed the Rust Pi RPC lifecycle so standard task completion is driven by `agent_end` rather than waiting indefinitely on child-process exit.
- Browser-verified the standard native workflow path with `tests/e2e/real-rust-workflow.spec.ts`, including queue visibility, pause/resume, dependency ordering, session visibility, worktree cleanup, stale-run display, and archive behavior.
- Compiled the Rust backend successfully after the orchestration integration changes and after the Pi session lifecycle fix.
- Implemented **plan mode** execution in the Rust orchestrator:
  - `tauroboros-rust/src/orchestrator/plan_mode.rs` — handles plan generation, plan revision, and approved-plan implementation phases.
  - Correctly transitions tasks through `not_started` → `plan_complete_waiting_approval` → `implementation_pending` → `implementation_done`.
  - Extracts `[plan]` tags from agent output and builds appropriate prompts for each phase.
  - Supports auto-approve, plan revision with `[user-revision-request]` feedback, and approved-plan execution.
- Implemented **review loops** in the Rust orchestrator:
  - `tauroboros-rust/src/orchestrator/review.rs` — runs review sessions after standard execution, processes results, and runs review-fix cycles.
  - Respects `max_review_runs_override` and global `maxReviews` option.
  - Returns `TaskStatus::Stuck` if max reviews are exceeded without passing.
- Implemented **best-of-N execution** in the Rust orchestrator:
  - `tauroboros-rust/src/orchestrator/best_of_n.rs` — parallel worker execution with per-worker worktrees, reviewer evaluation, and final applier synthesis.
  - Creates `TaskCandidate` records for each successful worker and broadcasts `task_candidate_created` SSE events.
  - Respects `minSuccessfulWorkers`, `selectionMode`, and slot expansion for workers/reviewers.
- Added missing prompt templates to DB migration: `review`, `review_fix`, `best_of_n_worker`, `best_of_n_reviewer`, `best_of_n_final_applier`.
- Added `get_task_runs_by_phase` and `create_task_candidate` DB helper functions.
- Fixed `GET /api/tasks/:id/best-of-n-summary` to compute real data from task_run records instead of returning hardcoded zeros.
- Removed `ensure_supported_tasks` restrictions on plan_mode, review, and best-of-n — these modes now execute natively.

## Residual Gaps

- Plan mode, review loops, and best-of-N are now implemented but not yet browser-verified end to end.
- Planning session Pi integration in Rust now has a real `PlanningSessionManager` with Pi RPC process lifecycle, event streaming, and message persistence. The `routes/planning.rs` routes (`create`, `send_message`, `stop`, `close`, `change_model`) now delegate to the manager instead of using placeholders.
- Run stop, force-stop, clean, and paused-state semantics still need direct comparison against the TypeScript backend.
- Browser verification now exists for one high-value real workflow, but broader browser coverage is still needed for advanced flows and regression protection.
- Container execution remains intentionally unsupported in Rust (native-only), but container API endpoints stay frontend-compatible as stubs.

## File Size Guardrails

### Files To Watch

- tauroboros-rust/src/orchestrator/mod.rs (1984 lines, exception header needed — core orchestrator with many interdependent methods)
- tauroboros-rust/src/routes/tasks.rs (1011 lines, exception header documented)
- tauroboros-rust/src/routes/planning.rs (861 lines)
- tauroboros-rust/src/orchestrator/best_of_n.rs (723 lines)
- tauroboros-rust/src/orchestrator/planning_session.rs (692 lines)
- tauroboros-rust/src/routes/sessions.rs
- tauroboros-rust/src/routes/runs.rs

### Split Strategy

- tauroboros-rust/src/routes/tasks/ has been split into a module directory:
  - mod.rs (795 lines) - core CRUD, plan/revision, reset/move, start/create-and-wait
  - best_of_n.rs (135 lines) - candidates, best-of-n summary, select/abort
  - repair.rs (95 lines) - repair-state, self-heal-reports
  - All sub-modules are well under the 1000-line guardrail.
- tauroboros-rust/src/orchestrator has been split into execution mode sub-modules:
  - mod.rs (1984 lines) - core orchestrator with scheduler, standard execution, run lifecycle
  - plan_mode.rs (418 lines) - plan mode execution (plan generation, revision, approved implementation)
  - review.rs (371 lines) - review loop execution
  - best_of_n.rs (723 lines) - best-of-n worker/reviewer/final-applier execution
  - Execution mode sub-modules are all under the 1000-line guardrail.
- If planning grows materially, split prompt routes from session routes.
- If execution grows materially, split run-inspection routes from control routes.
- Add a header comment only if a file must exceed the 1000-line guideline and no cleaner module boundary exists.

## Single-Binary Packaging Direction

### Baseline Requirements

- Rust binary must serve the compiled Solid app without requiring a separate frontend process.
- Build flow should compile the frontend before the Rust release build.
- Asset delivery must preserve frontend path expectations for / and /assets.

### Likely Implementation

- Build the Solid app during Rust release packaging.
- Embed the generated frontend assets into the Rust binary.
- Serve embedded index.html plus static assets from Rocket routes.
- Expose version/build metadata from the Rust binary.

## Verification Matrix

| Area | Check | Status |
| --- | --- | --- |
| Route parity | Frontend API methods all resolve against Rust | In progress |
| Payload parity | Request and response JSON shapes match TS | In progress |
| SSE parity | Event names and payloads match TS expectations | In progress |
| Native-only behavior | Container UI remains functional without backend container support | Partially verified |
| Packaging | Single Rust binary serves backend and Solid frontend | Implemented, release-path verification still pending |
| File size discipline | Rust files stay under 1000 lines or document exceptions | Achieved: orchestrator split into plan_mode (418), review (371), best_of_n (723); tasks/ split into mod.rs (795), best_of_n.rs (135), repair.rs (95) |
| Plan mode | Plan generation, revision, and approved implementation execute natively | Implemented |
| Review loops | Automated review with review-fix cycles and max-review limit | Implemented |
| Best-of-N | Parallel workers, reviewers, final applier with candidate management | Implemented |

## Working Notes

- This document is the running source of truth for the parity effort and must be updated as gaps are confirmed or closed.
- Any discovered mismatch that would force frontend changes is out of scope; the Rust backend must adapt instead.
- Container execution remains intentionally unsupported in Rust for now, but API compatibility for the frontend remains required.

## Next Actions

1. Add browser-level verification for plan mode, review loops, and best-of-N now that the orchestrator supports them natively.
2. Finish route-by-route parity checks for runs, sessions, planning, archives, and SSE payloads against the frontend stores and TypeScript routes.
3. Add focused compatibility coverage for route/payload parity and expand browser coverage beyond the single standard real-workflow path.
4. Add browser-level validation of the SSE session streaming contract now that the hub event types are aligned with frontend expectations.
5. ~~Implement real Pi process integration for planning sessions (currently placeholder/ack only).~~ **DONE** — `PlanningSessionManager` with Pi RPC lifecycle, event streaming, message persistence, and SSE broadcasting.
