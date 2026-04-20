# Full Effect Migration Plan

Date: 2026-04-20
Source audit: `plans/reports/effect-migration-audit-2026-04-20.md`

This plan is intended to take TaurOboros from a mixed Promise/Effect architecture to a fully migrated Effect-first application.

This plan intentionally contains no effort estimates.

## Guidance Baseline

This plan was derived from the repository audit and from the local Effect guidance available in `~/.local/share/effect-solutions/effect`.

The `effect-solutions` CLI is not available in the current environment, so the local checkout must be used when the CLI cannot be run.

Guides consulted while producing this plan:

- `migration/services.md`
- `migration/error-handling.md`
- `migration/scope.md`
- `migration/forking.md`
- `migration/runtime.md`
- `migration/generators.md`
- `.patterns/testing-patterns.md`

## Objective

Replace the current mixed architecture with one coherent Effect architecture across backend and frontend, with these end-state properties:

- One application composition model based on Effect services and layers.
- One error model based on tagged, typed failures.
- One resource ownership model based on scopes and finalizers.
- One concurrency model based on Effect lifecycles instead of manual Promise orchestration.
- One observability model based on Effect logging and explicit metadata.
- One execution-boundary rule: only true runtime edges execute Effects.

## Non-Negotiable Migration Rules

- [ ] Use one service-definition model across the repository. On the current dependency line, standardize on `Context.GenericTag` plus `Layer.*`. Do not introduce `Context.Service` unless the dependency upgrade is performed as a separate full cutover before this plan begins.
- [ ] Keep `Effect.run*` only at true runtime edges: process entrypoint, Bun request adapter, Solid/TanStack UI adapter, and test harness.
- [ ] When a module is migrated, remove the old Promise-based, callback-based, or manual compatibility path in the same change. Do not keep both exports alive.
- [ ] Remove fallback behavior during migration. Unknown cases must become explicit typed failures, not permissive defaults.
- [ ] Replace string-based error inspection with typed error matching.
- [ ] Replace console-based operational logging with the chosen Effect logging implementation. Do not keep both logging systems in application code.
- [ ] Update all call sites before merging a migrated subsystem. No subsystem is considered migrated while legacy callers still require the old API.
- [ ] Consult the relevant Effect guide topics before each phase. If the CLI is unavailable, use the local checkout under `~/.local/share/effect-solutions/effect`.

## Target Architecture

The fully migrated application should look like this:

- `src/index.ts` owns the single backend runtime boundary and executes one top-level application effect.
- `src/server.ts` builds the application through layers only and does not manually construct the runtime graph with ad hoc `new` calls.
- `src/server/server.ts`, `src/orchestrator.ts`, `src/runtime/*`, and integration modules are Effect services acquired from context.
- Long-lived resources such as database connections, Bun server instances, websocket hubs, process managers, and container managers are scoped resources with explicit finalization.
- Route modules build business effects and delegate response translation to one central interpreter.
- Frontend API, websocket, and store modules are authored in Effect; UI components only trigger effects through a single UI execution boundary.
- Tests use Effect-aware patterns for Effect-returning modules and preserve pure tests for pure functions.

## Allowed Runtime Boundaries After Migration

After the migration is complete, the only allowed places where Effects may be executed are:

- Backend process entrypoint in `src/index.ts`
- Bun request adapter and websocket edge adapters in the server boundary
- Frontend UI boundary helper used by query, mutation, and event handlers
- Test harness utilities for running Effect-based tests

Every other module must expose Effects or pure data/functions, not Promise wrappers.

## Module Cutover Map

| Area | Primary Files | Target State |
| --- | --- | --- |
| Application composition | `src/index.ts`, `src/server.ts`, `src/server/server.ts` | Layer-built runtime, one execution boundary |
| Error model | `src/runtime/*.ts`, `src/orchestrator.ts`, `src/server/routes/*.ts`, `src/telegram.ts`, `src/kanban-solid/src/api/client.ts` | Tagged, typed failures only |
| Resource ownership | `src/db.ts`, `src/runtime/pi-process.ts`, `src/runtime/container-pi-process.ts`, `src/runtime/planning-session.ts`, `src/runtime/session-manager.ts`, `src/server/server.ts` | Scoped resources and scoped subscriptions |
| Concurrency | `src/orchestrator.ts`, `src/runtime/global-scheduler.ts`, `src/runtime/planning-session.ts`, `src/runtime/session-manager.ts`, `src/runtime/container-pi-process.ts` | Effect-managed task/session lifecycles |
| HTTP boundary | `src/server/types.ts`, `src/server/router.ts`, `src/server/routes/*.ts` | Effect-returning handlers, central response interpreter |
| Frontend | `src/kanban-solid/src/api/*`, `src/kanban-solid/src/stores/*`, `src/kanban-solid/src/App.tsx` | Effect-authored async flows, thin UI execution boundary |
| Observability | `src/index.ts`, `src/server/server.ts`, `src/runtime/*`, `src/orchestrator.ts`, frontend API/store modules | Structured Effect logging and metadata |

## Phase 0: Lock the Migration Baseline

Relevant guides:

- `migration/services.md`
- `migration/runtime.md`
- `migration/generators.md`

Checklist:

- [x] Freeze the service-definition baseline for this migration: stay on the current Effect dependency line and use `Context.GenericTag` consistently across all new and migrated services.
- [x] Define the repository-wide rule that only edge adapters may call `Effect.run*`.
- [x] Define the repository-wide rule that no module may export both a legacy Promise API and a new Effect API for the same behavior.
- [x] Define the repository-wide rule that fallback branches must be removed, not preserved.
- [x] Add migration guardrails to CI or verification scripts so new internal `Effect.runPromise`, `console.log/error/warn`, and `throw new Error` regressions are caught while the migration is in progress.
- [x] Document the allowed runtime boundaries and the banned compatibility patterns in the repository docs.

Completion gate:

- [x] The architecture rules are encoded in repo documentation and automated verification.
- [x] The implementer can point to one allowed service-definition pattern and one allowed effect-execution pattern.

## Phase 1: Establish a Single Typed Error Model

Relevant guides:

- `migration/error-handling.md`
- `migration/generators.md`
- `migration/schema.md`

Checklist:

- [x] Create or consolidate domain error modules for runtime, orchestration, server, integration, and frontend API failures.
- [x] Replace raw `throw new Error(...)` paths in `src/runtime/planning-session.ts`, `src/runtime/session-manager.ts` with tagged errors (`PlanningSessionError`, `SessionManagerExecuteError`).
- [~] Replace raw `throw new Error(...)` in `src/orchestrator.ts`, `src/telegram.ts`, and other backend modules. (`src/runtime/global-scheduler.ts` migrated to `GlobalSchedulerError`)
- [~] Replace ad hoc `catch` blocks in `src/server/routes/*.ts` with typed error handling that maps domain errors to HTTP responses centrally. (`src/server/routes/planning-routes.ts` and `src/server/routes/execution-routes.ts` migrated)
- [ ] Replace string-based error inspection in route handlers and orchestration edges with tag-based or explicit error-type handling.
- [ ] Replace frontend `ApiErrorResponse extends Error` plus handwritten parsing in `src/kanban-solid/src/api/client.ts` with typed Effect failures and typed API-response decoding.
- [ ] Remove permissive fallback behavior such as unknown-level default branches and implicit fallback cases in integrations.
- [ ] Standardize API error payload encoding so backend and frontend share one explicit error contract.

Target files for this phase:

- [x] `src/runtime/planning-session.ts` - Fully migrated to `PlanningSessionError` tagged errors
- [x] `src/runtime/session-manager.ts` - Fully migrated to `SessionManagerExecuteError` tagged errors
- [x] `src/shared/errors.ts` - Complete base error types using `Schema.TaggedError`
- [x] `src/shared/error-codes.ts` - Created shared errors module
- [~] `src/orchestrator.ts` - Partial migration with `OrchestratorOperationError`, `OrchestratorUnavailableError`
- [ ] `src/runtime/pi-process.ts`
- [ ] `src/runtime/container-pi-process.ts`
- [~] `src/server/routes/execution-routes.ts` - Start/stop/pause/resume/queue-status routes now use typed Effect route interpreter and no route-local try/catch blocks
- [ ] `src/server/routes/task-routes.ts`
- [ ] `src/server/routes/session-routes.ts`
- [~] `src/server/routes/planning-routes.ts` - Session create/message/reconnect/model/close and task payload validation moved to typed Effect route errors and route-level interpreter
- [ ] `src/telegram.ts`
- [ ] `src/kanban-solid/src/api/client.ts`

Completion gate:

- [~] Business modules no longer rely on `throw new Error(...)` for normal domain failures.
- [ ] Route behavior no longer depends on substring matching against exception messages.
- [ ] Frontend API failures are represented as typed Effect failures instead of handwritten `Error` subclasses and ad hoc parsing.

## Phase 2: Rebuild Application Composition Around Layers

Relevant guides:

- `migration/services.md`
- `migration/runtime.md`
- `migration/generators.md`

Checklist:

- [ ] Introduce service tags and layers for project root resolution, settings, database access, orchestrator control, server runtime, container image management, container runtime management, planning-session management, websocket broadcasting, and notifications.
- [ ] Refactor `src/server.ts` so runtime assembly is entirely layer-driven and no longer mixes manual construction with Effect composition.
- [ ] Remove synchronous bridge constructors such as the legacy-style `createPiServer()` path once all callers use the Effect-based assembly path.
- [ ] Move side-effectful initialization out of constructors in `src/server/server.ts` and related classes into layer builders or scoped constructors.
- [ ] Remove direct ad hoc `new PiKanbanDB(...)`, `new PiOrchestrator(...)`, `new PiKanbanServer(...)`, `new PiContainerManager(...)`, and similar runtime graph construction from top-level flow code.
- [ ] Ensure every long-lived backend subsystem is acquired from context, not passed manually through expanding constructor chains.

Target files for this phase:

- `src/index.ts`
- `src/server.ts`
- `src/server/server.ts`
- `src/orchestrator.ts`
- `src/db.ts`
- `src/runtime/container-manager.ts`
- `src/runtime/container-image-manager.ts`
- `src/runtime/planning-session.ts`
- `src/telegram.ts`

Completion gate:

- [ ] Backend composition is expressed as one layer graph.
- [ ] No top-level backend module manually constructs the runtime object graph outside layer setup.
- [ ] Legacy constructor-based assembly helpers have been deleted.

## Phase 3: Move All Long-Lived Resources Into Scope Ownership

Relevant guides:

- `migration/scope.md`
- `migration/runtime.md`
- `migration/generators.md`

Checklist:

- [ ] Convert database lifetime to a scoped service instead of a manually closed class instance.
- [ ] Convert Bun server startup and shutdown to a scoped resource with finalizers rather than manual `try/finally` and signal-hook cleanup.
- [ ] Convert websocket hub ownership to a scoped service.
- [ ] Convert container image manager and container manager ownership to scoped resources.
- [ ] Convert planning-session manager ownership to a scoped resource.
- [ ] Convert listener subscription APIs in `src/runtime/pi-process.ts` and `src/runtime/container-pi-process.ts` from plain unsubscribe callbacks to Effect-managed scoped subscriptions.
- [ ] Replace manual timer lifecycle management with Effect-owned resource lifecycles where the timer is part of business logic.
- [ ] Remove duplicated manual shutdown logic once the scoped finalizers are in place.

Target files for this phase:

- `src/index.ts`
- `src/db.ts`
- `src/server/server.ts`
- `src/server/websocket.ts`
- `src/runtime/pi-process.ts`
- `src/runtime/container-pi-process.ts`
- `src/runtime/planning-session.ts`
- `src/runtime/session-manager.ts`
- `src/runtime/container-manager.ts`
- `src/runtime/container-image-manager.ts`

Completion gate:

- [ ] Every long-lived backend resource has one owner and one finalization path.
- [ ] Manual resource cleanup code that duplicates scope finalizers has been deleted.
- [ ] Listener and timer cleanup is no longer callback-only and untracked.

## Phase 4: Convert Runtime and Orchestration Flow to Effect-Native Concurrency

Relevant guides:

- `migration/forking.md`
- `migration/scope.md`
- `migration/runtime.md`
- `migration/generators.md`

Checklist:

- [~] Rewrite orchestration control flow so runs, sessions, and background execution are represented as Effect programs rather than Promise-returning methods wrapped by Effect at the boundary.
- [x] Convert `PiSessionManager` to expose Effect-only operations. All Promise wrapper methods removed, callbacks moved to second parameter.
- [x] Convert `PlanningSession` and `PlanningSessionManager` to expose Effect-only operations. All Promise wrapper methods removed.
- [~] Convert `PiRpcProcess` and `ContainerPiProcess` lifecycle control to Effect-owned interruption, timeout, and supervision rather than handwritten `AbortController`, callback, and timer logic.
- [ ] Refactor `src/orchestrator.ts` so run-control operations are native Effects, not Promise methods with thin Effect wrappers.
- [~] Convert `src/runtime/global-scheduler.ts` and related execution coordination to Effect-native state/concurrency primitives. (`throw new Error` removed; typed `GlobalSchedulerError` in place, state model still mutable class)
- [ ] Replace manual mutable coordination where it exists solely to compensate for missing structured concurrency.
- [~] Remove legacy wrapper helpers such as `runOrchestratorOperationPromise` and similar bridging utilities once call sites use native Effect services.

Target files for this phase:

- [~] `src/orchestrator.ts` - Core methods still use Promises, helper functions use Effect
- [x] `src/runtime/session-manager.ts` - **COMPLETE** - `executePrompt` now returns `Effect.Effect<ExecuteSessionPromptResult, SessionManagerExecuteError>`
- [x] `src/runtime/planning-session.ts` - **COMPLETE** - All methods (`start`, `sendMessage`, `close`, `reconnect`, `setModel`, `setThinkingLevel`) now return Effects
- [~] `src/runtime/pi-process.ts` - Uses Effect for `send`, `prompt`, `collectEvents`, `close`, `forceKill`
- [~] `src/runtime/container-pi-process.ts` - Uses Effect for `send`, `prompt`, `collectEvents`, `close`, `forceKill`
- [~] `src/runtime/global-scheduler.ts` - Raw throws replaced with tagged `GlobalSchedulerError`; API remains sync/mutable and still needs Effect-native primitives
- [~] `src/runtime/review-session.ts` - Updated caller to use `Effect.runPromise`
- [~] `src/runtime/best-of-n.ts` - Updated callers to use `Effect.runPromise`
- [~] `src/runtime/codestyle-session.ts` - Updated caller to use `Effect.runPromise`

Completion gate:

- [~] Runtime and orchestration modules no longer export duplicate Promise and Effect APIs for the same actions.
- [~] Run/session cancellation is driven by Effect interruption and scope ownership.
- [ ] Manual bridging helpers that existed only to call Promise methods from Effects have been deleted.

## Phase 5: Replace Ad Hoc Logging With Effect Observability

Relevant guides:

- `migration/services.md`
- `migration/error-handling.md`

Checklist:

- [ ] Introduce a shared logging service or Effect logging configuration for backend application code.
- [ ] Replace console logging in `src/index.ts`, `src/server/server.ts`, `src/orchestrator.ts`, and runtime process modules with structured Effect logging.
- [ ] Standardize log fields for `runId`, `taskId`, `taskRunId`, `sessionId`, `containerId`, route name, and operation name.
- [ ] Route all integration logging, including Telegram and container events, through the same logging path.
- [ ] Decide and apply one policy for log levels and error rendering.
- [ ] Remove residual console-based operational logging from frontend API/store code and move user-visible error reporting to typed UI handling.

Target files for this phase:

- `src/index.ts`
- `src/server/server.ts`
- `src/orchestrator.ts`
- `src/recovery/startup-recovery.ts`
- `src/runtime/pi-process.ts`
- `src/runtime/container-pi-process.ts`
- `src/telegram.ts`
- `src/kanban-solid/src/api/*`
- `src/kanban-solid/src/stores/*`

Completion gate:

- [ ] Console-based operational logging has been removed from application modules.
- [ ] Logging metadata is consistent across backend execution paths.
- [ ] Startup recovery is no longer the only subsystem using Effect-native logging.

## Phase 6: Rebuild the HTTP Boundary as Effect Programs

Relevant guides:

- `migration/runtime.md`
- `migration/error-handling.md`
- `migration/generators.md`

Checklist:

- [ ] Change `src/server/types.ts` so route and control contracts are Effect-based rather than Promise-based.
- [~] Refactor route registration functions in `src/server/routes/*.ts` so they build Effects instead of wrapping business logic in per-route `try/catch` blocks. (`src/server/routes/planning-routes.ts` and `src/server/routes/execution-routes.ts` partial complete)
- [~] Introduce one central interpreter that maps typed errors to HTTP responses. (`src/server/route-interpreter.ts` introduced and used by planning/execution routes)
- [ ] Keep only one Bun adapter layer that executes route Effects at the request boundary.
- [ ] Refactor `PiKanbanServer` so callbacks and integration points are Effect-based services, not Promise-returning function slots.
- [ ] Migrate notification and external HTTP integrations behind Effect services before they are invoked from routes or server lifecycle code.
- [ ] Remove route-local behavior that depends on message-string inspection or ad hoc JSON parsing for control flow.

Target files for this phase:

- `src/server/types.ts`
- `src/server/router.ts`
- `src/server/server.ts`
- [~] `src/server/routes/execution-routes.ts`
- `src/server/routes/task-routes.ts`
- `src/server/routes/session-routes.ts`
- [~] `src/server/routes/planning-routes.ts`
- `src/server/routes/container-routes.ts`
- `src/server/routes/task-group-routes.ts`
- `src/server/routes/stats-routes.ts`
- `src/telegram.ts`

Completion gate:

- [ ] Route modules do not implement business logic through ad hoc `try/catch` blocks.
- [ ] The Bun HTTP layer is the only place where request Effects are executed.
- [ ] Promise-based server callback types have been deleted.

## Phase 7: Migrate the Frontend to Effect-Authored Async Flows

Relevant guides:

- `migration/services.md`
- `migration/error-handling.md`
- `migration/runtime.md`
- `.patterns/testing-patterns.md`

Checklist:

- [ ] Replace the Promise-based frontend HTTP client in `src/kanban-solid/src/api/client.ts` with an Effect-authored HTTP service and typed response decoding.
- [ ] Convert all API modules under `src/kanban-solid/src/api/*` to expose Effect-based operations instead of raw `fetch` or Promise-returning helpers.
- [ ] Convert websocket handling in `src/kanban-solid/src/stores/websocketStore.ts` and related modules to Effect-managed subscriptions and event handling.
- [ ] Convert data and mutation logic in frontend stores to Effect-authored flows.
- [ ] Choose one frontend execution-boundary pattern and apply it everywhere. If TanStack Query remains, query and mutation functions must be thin boundary adapters over Effect programs, with no handwritten Promise business logic left in the store or API layers.
- [ ] Remove component-level `try/catch`, direct `fetch`, and Promise orchestration from `src/kanban-solid/src/App.tsx` and related components.
- [ ] Replace frontend handwritten error translation with typed domain or transport failures interpreted by UI presenters.
- [ ] Remove duplicate async patterns across stores so there is one standard way to trigger, await, cancel, and display asynchronous work in the frontend.

Target files for this phase:

- `src/kanban-solid/src/api/client.ts`
- `src/kanban-solid/src/api/*.ts`
- `src/kanban-solid/src/stores/tasksStore.ts`
- `src/kanban-solid/src/stores/runsStore.ts`
- `src/kanban-solid/src/stores/optionsStore.ts`
- `src/kanban-solid/src/stores/taskGroupsStore.ts`
- `src/kanban-solid/src/stores/workflowControlStore.ts`
- `src/kanban-solid/src/stores/websocketStore.ts`
- `src/kanban-solid/src/stores/planningChatStore.ts`
- `src/kanban-solid/src/stores/sessionUsageStore.ts`
- `src/kanban-solid/src/App.tsx`

Completion gate:

- [ ] Frontend API and store modules no longer contain raw `fetch`, handwritten `AbortController` timeout handling, or Promise-based error translation.
- [ ] UI components only trigger Effect-backed operations through the chosen boundary helper.
- [ ] The frontend no longer has a second legacy async architecture alongside Effect-authored flows.

## Phase 8: Convert Tests and Verification to the Final Architecture

Relevant guides:

- `.patterns/testing-patterns.md`

Checklist:

- [ ] Move Effect-heavy tests to Effect-aware test patterns and stop relying on generic Promise wrappers for core behavior verification.
- [ ] Use the chosen Effect-aware test style for Effect-returning modules and keep plain tests only for pure functions.
- [ ] Add focused tests for layer assembly, typed error translation, scoped cleanup, cancellation/interruption, route error mapping, and frontend API/store execution boundaries.
- [ ] Update verification scripts so the migration invariants are machine-checked.
- [ ] Update CI and local scripts so the chosen test flow is the standard project path.

Completion gate:

- [ ] The test suite validates the migrated architecture rather than only the old Promise behavior.
- [ ] Verification scripts catch reintroduction of banned legacy patterns.

## Phase 9: Delete Remaining Bridge Code and Finalize the Cutover

Relevant guides:

- `migration/runtime.md`
- `migration/services.md`
- `migration/error-handling.md`

Checklist:

- [ ] Remove any remaining helper whose only purpose was bridging old Promise code into Effect code.
- [ ] Remove dead exports and duplicate APIs left behind by intermediate migration work.
- [ ] Remove unused fallback code, compatibility comments, and temporary adapters.
- [ ] Update README and architecture docs to describe the final Effect-first runtime model.
- [ ] Re-run the audit queries and confirm the application now matches the target architecture rather than the mixed architecture described in the original report.
- [ ] Produce a final verification note or report documenting the completed cutover and the remaining intentional runtime boundaries.

Completion gate:

- [ ] The application uses one Effect-first architecture end to end.
- [ ] No legacy compatibility paths remain in migrated code.
- [ ] The only remaining `Effect.run*` calls are the approved runtime-boundary adapters.

## Search-Based Verification Checklist

These checks should be hydrated continuously during implementation and must pass before the migration is considered complete.

- [ ] `rg -n "throw new Error\(" src src/kanban-solid/src` returns no application-code matches that represent normal domain failure paths.
- [ ] `rg -n "console\.(log|warn|error)" src src/kanban-solid/src` returns only approved logger implementation sites, if any.
- [ ] `rg -n "Effect\.run(Promise|Sync|Fork|Callback)\(" src src/kanban-solid/src` returns only approved runtime-boundary adapters.
- [ ] `rg -n ": .*Promise<|=> Promise<" src/server src/runtime src/kanban-solid/src/api src/kanban-solid/src/stores` returns only approved library-boundary adapter signatures.
- [ ] `rg -n "\bfetch\(" src/kanban-solid/src` returns only the designated frontend HTTP service or approved UI boundary adapter.
- [ ] `rg -n "AbortController|setTimeout|clearTimeout" src/runtime src/kanban-solid/src` returns only approved runtime-edge usage that cannot be replaced by Effect primitives.
- [ ] `rg -n "Context\.GenericTag|Layer\.|Schema\.TaggedError|Effect\.log" src` shows the migrated architecture expanding into composition, error handling, and observability instead of remaining isolated to current hotspots.

## Final Acceptance Criteria

- [ ] Backend composition is layer-built and Effect-first.
- [ ] Runtime modules expose Effect operations, not Promise wrappers.
- [ ] Orchestrator control flow uses Effect-native lifecycle management.
- [ ] HTTP routes are interpreted from typed Effect programs through one central response interpreter.
- [ ] Frontend API and store layers are authored in Effect and use one standard execution-boundary helper.
- [ ] Typed failures, structured logging, and scoped resource ownership are used consistently across the application.
- [ ] No legacy compatibility or fallback code paths remain.
