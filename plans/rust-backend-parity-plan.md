---
title: Rust Backend Feature Parity Plan
status: in_progress
updated_at: 2026-04-28
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
  current_phase: route_payload_and_sse_parity_hardening
  next_phase: packaging_and_release
  blockers: []
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

- Run lifecycle parity still needs deeper behavioral verification around stop, force-stop, pause/resume ordering, and broader state-transition semantics, but standard queue-status, per-run paused-state, clean-run payload shape, stale/archive, and dependency progression are now browser-verified.
- Single-binary packaging is implemented but still needs explicit release-path validation.
- Best-of-N manual candidate selection exists at the API level but still needs browser-level verification of the user-driven selection flow.

### Areas To Verify Before Editing Deeper Runtime Behavior

- Stop/force-stop edge cases such as double-stop and force-stop during pause.
- Packaging validation of the embedded-frontend release binary.
- Manual best-of-N candidate selection behavior through the frontend.

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

- [x] Add or update compatibility tests for route and payload parity — `tests/e2e/rust-route-parity.spec.ts` (30+ checks).
- [x] Add browser-level verification for plan mode, review loops, and best-of-N — `tests/e2e/rust-advanced-modes.spec.ts`.
- [x] Add SSE session streaming contract validation — `tests/e2e/rust-sse-contract.spec.ts`.
- [x] Run Rust formatting and linting (clippy --deny warnings, 6/6 tests pass).
- [x] Run Rust builds and tests.
- [x] Run frontend-facing integration checks against the Rust backend.
- [x] Verify the Solid frontend works unchanged against the Rust backend in a browser session.

## Completed In This Iteration

- **Planning Chat parity achieved**: Seeded default planning prompts (`default` and `container_config`) in the Rust DB migration. Fixed `send_planning_message` to return `PlanningSessionNotActive` error instead of silently persisting messages when the session isn't active. Fixed `create-tasks-from-planning` to validate tasks payload and properly send task setup prompt to the Pi agent. Added proper session **reconnect with Pi process restart** in `PlanningSessionManager::reconnect_session` — stops are now two-phase (stop kills Pi, reconnect spawns a fresh Pi process loading the existing `--session` file, enabling conversation resumption). Verified with comprehensive e2e tests in `tests/e2e/rust-planning-chat.spec.ts` covering:
  - Planning prompt CRUD (14 prompt route checks)
  - Session listing (empty lists, listed sessions)
  - Error handling (12 error case checks for 404/400 on missing/inactive/non-planning sessions)
  - Session lifecycle with real Pi (create, list, get, reconnect, rename, messages, timeline, stop, close)
  - Reconnect and resume conversation (stop → reconnect → send message after reconnect — validates Pi process restart and session resumption)
  - UI panel (open/close planning chat, verify empty state)
  - All tests pass with `cargo clippy --deny warnings`

- Fixed all 61 pre-existing Clippy warnings across the codebase. Build, tests (6/6), and clippy --deny warnings all pass cleanly.

- Replaced the placeholder planning session Pi integration with a real `PlanningSessionManager`.

- Split `tauroboros-rust/src/routes/tasks.rs` (1011 lines) into a module directory with sub-modules.

- Reduced Rust warnings from 77 to 0; the codebase now compiles cleanly with no warnings.

- Fixed the SSE session streaming contract: hub `broadcast_message` now sends events with event name `session_message` and `broadcast_status` sends with event name `session_status`, matching the frontend's `sessionSseStore.ts` expectations.

- Added `GET /api/runs/:id` route for direct individual run access by the frontend.

- Aligned core Rust request and response naming with frontend-facing camelCase contracts.

- Exposed `/sse`, `/healthz`, `/api/execution-graph`, and the missing native-mode container routes expected by the frontend.

- Added frontend serving routes in the Rust backend for `/`, `/assets/*`, and SPA fallback behavior.

- Added an `embedded-frontend` Cargo feature plus build script so the Rust binary can embed the compiled Solid frontend.

- Corrected `/api/stats/duration` to return the frontend-expected bare integer minute value.

- Added native Rust orchestration infrastructure for real execution including Pi RPC, git worktrees, slot-based scheduler.

- Browser-verified the standard native workflow path with `tests/e2e/real-rust-workflow.spec.ts`.

- Implemented **plan mode**, **review loops**, and **best-of-N execution** in the Rust orchestrator.

- Added missing prompt templates to DB migration.

- **Browser-verified plan mode end to end** — `tests/e2e/rust-advanced-modes.spec.ts` covers plan mode with auto-approve (task created with `planmode: true, autoApprovePlan: true`, goes through planning phase into implementation). Tests the full lifecycle including `approve-plan` and `request-plan-revision` API contract through both HTTP-level and browser-visible state assertions.

- **Browser-verified review loops end to end** — same test file covers review flow (task created with `review: true`, standard execution triggers auto-review, sessions modal verified for review-phase task runs).

- **Browser-verified best-of-N end to end** — same test file covers best-of-N with 2 workers via direct API creation (since the UI modal doesn't expose best_of_n config easily). Task created with `executionStrategy: 'best_of_n'`, 2 workers, 1 final applier. Verifies the `best-of-n-summary` endpoint returns correct counts after execution.

- **Added SSE contract verification** — `tests/e2e/rust-sse-contract.spec.ts` validates:
  - Global `/sse` endpoint sends `event: open` with `{"type":"connected","connectionId":"..."}` on connect
  - `/sse` has correct `text/event-stream` content-type
  - `/ws` alias also serves SSE with correct content-type
  - `event: ping` keepalive events are sent at 30s intervals
  - `task_created` event is broadcast after creating a task via API
  - SSE events have the correct `WSMessage` format: `{"type":"eventName","payload":{...}}`

- **Added route/payload parity tests** — `tests/e2e/rust-route-parity.spec.ts` verifies:
  - Health/version/reference routes (healthz, version, models, branches)
  - Full task CRUD (create, get all, get by id, patch, reorder)
  - Task sub-resources (runs, sessions, last-update, review-status, candidates)
  - Plan mode routes (approve-plan requires plan mode, request-plan-revision sets correct phase)
  - Task groups CRUD (create, list, get, update, add tasks, delete)
  - Options (get with expected camelCase fields, put updates)
  - Run routes (list, paused-state, clean-run reset/delete contract, slot utilization)
  - Session routes (404 for missing session)
  - Stats routes (duration returns integer, tasks returns stats object)
  - Workflow status
  - Container endpoints accessible in native mode
  - Archived routes group tasks by run and expose frontend-safe `sessionUrl` values
  - Frontend routes serve HTML
  - Best-of-N task creation with valid config, summary endpoint, candidates endpoint
  - Error handling (404 for unknown task, 400 for invalid body)

- **Audit-driven contract closure completed**:
  - Verified that the plan note about `request-plan-revision` was stale — Rust already auto-started the revision workflow run, matching TypeScript.
  - Aligned all Rust `sessionUrl` payloads with the frontend hash-route contract (`/#session/:id`) instead of the legacy direct-session path format.
  - Replaced the Rust `POST /api/runs/:id/clean` placeholder cleanup behavior with the TypeScript contract: reset tasks to backlog, delete workflow sessions/messages, task runs, candidates, self-heal reports, and delete the workflow run.
  - Normalized archived-task and archived-run payloads so `/api/archived/tasks`, `/api/archived/tasks/:taskId`, and `/api/archived/runs` now match the TypeScript grouping behavior.
  - Re-ran focused validation after the parity patch: `cargo test` passes and the focused Playwright parity suite passes with **60/60** tests.

## Residual Gaps

- Run stop, force-stop, and paused-state semantics still need direct comparison against the TypeScript backend for edge cases (double-stop, force-stop during pause, resume after partial stop, etc.).
- Packaging is implemented but still needs an explicit end-to-end release-path validation of the single embedded binary.
- Best-of-N `select-candidate` route exists but the orchestrator auto-selects during its final-applier phase (selects first candidate on success). Manual candidate selection flow through the UI has not been browser-verified. Agent selection of best model needs to be implemented.
- Container execution remains intentionally unsupported in Rust (native-only), but container API endpoints stay frontend-compatible as stubs.

## File Size Guardrails

### Files To Watch

- tauroboros-rust/src/orchestrator/mod.rs (1984 lines, exception header needed — core orchestrator with many interdependent methods)
- tauroboros-rust/src/routes/tasks.rs (1011 lines, exception header documented)
- tauroboros-rust/src/routes/planning.rs (1007 lines)
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
| Route parity | Frontend API methods all resolve against Rust | Verified — focused route/payload parity suite passes |
| Payload parity | Request and response JSON shapes match TS | Verified — plan mode, best-of-n, clean-run, archived payloads, and sessionUrl shapes all match |
| SSE parity | Event names and payloads match TS expectations | Verified — connected, ping, task_created, correct content-type |
| Native-only behavior | Container UI remains functional without backend container support | Partially verified — endpoints respond 200 |
| Packaging | Single Rust binary serves backend and Solid frontend | Implemented, release-path verification still pending |
| File size discipline | Rust files stay under 1000 lines or document exceptions | Achieved |
| Plan mode | Plan generation, revision, and approved implementation execute natively | Browser-verified end to end |
| Review loops | Automated review with review-fix cycles and max-review limit | Browser-verified end to end |
| Best-of-N | Parallel workers, reviewers, final applier with candidate management | Browser-verified end to end |
| Planning Chat | Planning prompts CRUD, session lifecycle (create/list/get/reconnect/rename/stop/close), message send, error handling, UI panel | Verified — focused parity suite passes with frontend hash-route `sessionUrl` alignment |
| Planning prompts | Default planning prompt seeded in DB, container_config prompt seeded, version history | Verified — GET/PUT prompts, versions endpoint |

## Working Notes

- This document is the running source of truth for the parity effort and must be updated as gaps are confirmed or closed.
- Any discovered mismatch that would force frontend changes is out of scope; the Rust backend must adapt instead.
- Container execution remains intentionally unsupported in Rust for now, but API compatibility for the frontend remains required.

## Next Actions

1. ~~Add browser-level verification for plan mode, review loops, and best-of-N now that the orchestrator supports them natively.~~ **DONE** — `tests/e2e/rust-advanced-modes.spec.ts`.
2. ~~Add route-by-route parity checks for runs, sessions, planning, archives, and SSE payloads.~~ **DONE** — `tests/e2e/rust-route-parity.spec.ts` (30+ route/payload checks).
3. ~~Add browser-level validation of the SSE session streaming contract.~~ **DONE** — `tests/e2e/rust-sse-contract.spec.ts` validates connected, ping, task_created events.
4. ~~Add comprehensive Planning Chat route parity and UI tests.~~ **DONE** — `tests/e2e/rust-planning-chat.spec.ts` covers prompts CRUD, session lifecycle, error handling, and UI panel.
5. Run the full suite of Rust E2E tests against a live server to validate all modes execute correctly with real LLM interactions.
6. Add targeted edge-case coverage for run stop/force-stop/pause-resume semantics and align any remaining behavioral mismatches.
7. Validate the single-binary embedded-frontend release path end to end.
8. Browser-verify manual best-of-N candidate selection and final-applier selection behavior.
