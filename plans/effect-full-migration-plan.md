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
- [x] Replace raw `throw new Error(...)` in `src/orchestrator.ts`, `src/runtime/smart-repair.ts`, `src/runtime/self-healing.ts`, `src/runtime/best-of-n.ts`, `src/runtime/review-session.ts`, `src/db.ts`, `src/server/routes/*.ts`, `src/server/server.ts`. `src/db.ts`, `src/orchestrator.ts`, `src/runtime/best-of-n.ts`, `src/server/routes/container-routes.ts`, and `src/server/server.ts` no longer use raw `throw new Error(...)` for domain failures; runtime session wrappers now map `PiProcessError` / `SessionManagerExecuteError` into local tagged error types.
- [x] Replace ad hoc `catch` blocks in `src/server/routes/*.ts` with typed error handling that maps domain errors to HTTP responses centrally. `execution-routes.ts`, `session-routes.ts`, `task-group-routes.ts`, `task-routes.ts`, and `container-routes.ts` now route failures through shared `HttpRouteError` helpers and the central route interpreter.
- [~] Replace string-based error inspection in route handlers and orchestration edges with tag-based or explicit error-type handling. Route handlers now use `HttpRouteError` and error code matching; orchestrator still retains some internal string classification for merge-conflict heuristics and timeout messaging.
- [x] Replace frontend `ApiErrorResponse extends Error` plus handwritten parsing in `src/kanban-solid/src/api/client.ts` with typed Effect failures and typed API-response decoding. The Solid frontend API modules now return Effects through `ApiClientError`, and the Solid store/component query and event boundaries execute them through one `runApiEffect` UI boundary.
- [~] Remove permissive fallback behavior such as unknown-level default branches and implicit fallback cases in integrations. Server routes use `HttpRouteError` with explicit status codes; orchestrator task execution still has some fallback error handling.
- [x] Standardize API error payload encoding so backend and frontend share one explicit error contract. (`src/shared/error-codes.ts` defines `ErrorCode` enum and `ApiError` interface)

Target files for this phase:

- [x] `src/runtime/planning-session.ts` - Fully migrated to `PlanningSessionError` tagged errors
- [x] `src/runtime/session-manager.ts` - Fully migrated to `SessionManagerExecuteError` tagged errors
- [x] `src/shared/errors.ts` - Complete base error types using `Schema.TaggedError`
- [x] `src/shared/error-codes.ts` - Created shared errors module
- [x] `src/orchestrator.ts` - Core orchestrator operations and internal invariant failures now use tagged orchestrator errors; raw `throw new Error(...)` paths removed from this module
- [x] `src/runtime/global-scheduler.ts` - Fully migrated to `GlobalSchedulerError` tagged errors
- [x] `src/runtime/smart-repair.ts` - Session/process failures now map to `SmartRepairError`; Effect generator typing cleaned up
- [x] `src/runtime/self-healing.ts` - Session/process failures now map to `SelfHealingError`; Effect generator typing cleaned up
- [x] `src/runtime/best-of-n.ts` - Remaining raw `throw new Error(...)` paths replaced with `BestOfNError`
- [x] `src/runtime/review-session.ts` - Session/process failures now map to `ReviewSessionError`; Effect generator typing cleaned up
- [~] `src/runtime/pi-process.ts` - Uses `PiProcessError` and `CollectEventsTimeoutError` for typed failures; `start()` method returns Effect; some internal validation uses raw throws
- [~] `src/runtime/container-pi-process.ts` - Uses `PiProcessError` and `CollectEventsTimeoutError` for typed failures; `start()` method returns Effect; some internal validation uses raw throws
- [~] `src/server/routes/execution-routes.ts` - Start/stop/pause/resume/queue-status routes now use typed Effect route interpreter; server callbacks now consume Effect-returning control handlers
- [x] `src/server/routes/task-routes.ts` - Orchestrator call sites, create-and-wait handling, revision flow, best-of-n endpoints, repair-state, and self-heal routes now use the typed route helper/interpreter path; remaining Effect-language-service notes are advisory only
- [~] `src/server/routes/session-routes.ts` - Standardized API error codes; unsupported event handling moved to shared route interpreter
- [~] `src/server/routes/planning-routes.ts` - Session create/message/reconnect/model/close and task payload validation moved to typed Effect route errors via shared interpreter
- [~] `src/server/routes/task-group-routes.ts` - CRUD/start routes moved to shared route interpreter and structured error codes
- [~] `src/server/routes/stats-routes.ts` - Structured error codes applied for validation failures
- [~] `src/server/routes/container-routes.ts` - Profile/status/validate/dockerfile/images/delete paths moved to shared route interpreter; build flow still partially Promise-based
- [x] `src/db.ts` - Database schema validation, type conversions, and remaining domain-failure paths now use `DatabaseError`; raw `throw new Error(...)` paths removed from this module
- [x] `src/server/server.ts` - Container validation, notification handling, and startup checks migrated to `ServerRuntimeError`; constructor no longer instantiates runtime dependencies
- [x] `src/telegram.ts` - Migrated to Effect-based notification helpers with `TelegramError`; corrected invalid generator usage and server now uses Effect pipelines for notification handling
- [x] `src/kanban-solid/src/api/client.ts` - Legacy promise client removed; request execution now returns typed `Effect` failures via `ApiClientError`
- [x] `src/kanban-solid/src/api/*.ts`, `src/kanban-solid/src/stores/*.ts` - Solid API modules now expose Effect-based request programs only, and store/query/mutation/event handlers consume them through the shared `runApiEffect` UI boundary without keeping a Promise compatibility client

Completion gate:

- [~] Business modules no longer rely on `throw new Error(...)` for normal domain failures. Backend runtime, orchestration, db, server routes, Telegram, server runtime, and Solid API/store paths are migrated; remaining work is concentrated in runtime process internals and orchestration heuristics.
- [~] Route behavior no longer depends on substring matching against exception messages. Backend routes use `HttpRouteError` with explicit error codes; orchestrator still uses limited string inspection for internal merge/timeout heuristics.
- [x] Frontend API failures are represented as typed Effect failures instead of handwritten `Error` subclasses and ad hoc parsing.

## Phase 2: Rebuild Application Composition Around Layers

Relevant guides:

- `migration/services.md`
- `migration/runtime.md`
- `migration/generators.md`

Checklist:

- [x] Introduce service tags and layers for project root resolution, settings, database access, orchestrator control, server runtime, container image management, container runtime management, planning-session management, websocket broadcasting, and notifications. (`src/shared/services.ts` defines all service tags; `src/server.ts` uses Context.GenericTag for runtime assembly)
- [x] Refactor `src/server.ts` so runtime assembly is entirely layer-driven and no longer mixes manual construction with Effect composition. `createPiServerEffect` is now the only production assembly path and `makePiServerRuntime` owns the full graph inside layer setup.
- [x] Remove synchronous bridge constructors such as the legacy-style `createPiServer()` path once all callers use the Effect-based assembly path.
- [x] Move side-effectful initialization out of constructors in `src/server/server.ts` and related classes into layer builders or scoped constructors. `PiKanbanServer` now receives `SmartRepairService`, `ContainerImageManager`, `PiContainerManager`, and `PlanningSessionManager` as injected dependencies.
- [x] Remove direct ad hoc `new PiKanbanDB(...)`, `new PiOrchestrator(...)`, `new PiKanbanServer(...)`, `new PiContainerManager(...)`, and similar runtime graph construction from top-level flow code. Runtime object graph construction now happens only inside `makePiServerRuntime` during layer assembly.
- [~] Ensure every long-lived backend subsystem is acquired from context, not passed manually through expanding constructor chains. Production assembly now happens only through the Effect-based server factory; deeper class-level constructor injection to full Effect services/layers remains for later phases.

Target files for this phase:

- [x] `src/index.ts` - Uses the scoped Effect-based server creation path (`createPiServerScopedEffect`) at the production runtime boundary
- [x] `src/server.ts` - Legacy `createPiServer()` sync bridge removed; runtime graph assembled only through `createPiServerEffect` and `PiServerRuntimeLayer`
- [x] `src/server/server.ts` - `PiKanbanServer` constructor no longer creates runtime managers and receives injected dependencies from layer assembly
- [~] `src/orchestrator.ts` - `PiOrchestrator` is now constructed only inside the Effect assembly path, but still receives deps via constructor rather than Effect context
- [~] `src/db.ts` - `PiKanbanDB` is instantiated only inside `makePiServerRuntime`, but is not yet a scoped context service
- [~] `src/runtime/container-manager.ts` - Runtime ownership is now centralized via scoped server assembly and explicit `close()` finalization; broader service/layer conversion is still pending
- [~] `src/runtime/container-image-manager.ts` - Runtime ownership is now centralized via scoped server assembly and explicit `close()` finalization; status broadcasting is still callback-based
- [~] `src/runtime/planning-session.ts` - `PlanningSessionManager` still receives deps via constructor, but the scoped runtime now constructs it with the real container manager and finalizes it centrally
- [ ] `src/telegram.ts`

Completion gate:

- [x] Backend composition is expressed as one layer graph. `PiServerRuntimeLayer` is the sole production composition path.
- [x] No top-level backend module manually constructs the runtime object graph outside layer setup.
- [x] Legacy constructor-based assembly helpers have been deleted.
- [x] Focused backend validation passed after cutover: `bun test tests/server.test.ts tests/planning-chat-auto-reconnect.test.ts tests/archived-api.test.ts tests/plan-mode.test.ts`.

## Phase 3: Move All Long-Lived Resources Into Scope Ownership

Relevant guides:

- `migration/scope.md`
- `migration/runtime.md`
- `migration/generators.md`

Checklist:

- [~] Convert database lifetime to a scoped service instead of a manually closed class instance. Production server assembly now acquires/releases `PiKanbanDB` with `Effect.acquireRelease` in `src/server.ts`, but the DB is not yet exposed as a scoped context service across the whole backend.
- [x] Convert Bun server startup and shutdown to a scoped resource with finalizers rather than manual `try/finally` and signal-hook cleanup. `src/index.ts` now runs the program under `Effect.scoped`, uses a scoped signal listener, and relies on scoped runtime finalizers instead of manual `server.stop()` / `db.close()` shutdown callbacks.
- [~] Convert websocket hub ownership to a scoped service. Production server assembly now acquires/releases `WebSocketHub` with `Effect.acquireRelease` and injects it into `PiKanbanServer`, but it is not yet exposed as a standalone scoped context service.
- [~] Convert container image manager and container manager ownership to scoped resources. The production server runtime now acquires/releases both managers explicitly and finalizes them through `close()`; `ContainerImageManager` still uses callback-based status updates rather than scoped subscriptions.
- [x] Convert planning-session manager ownership to a scoped resource. The production server runtime now acquires/releases `PlanningSessionManager`, and each `PlanningSession` keeps its process and streaming subscription inside its own owned scope.
- [x] Convert listener subscription APIs in `src/runtime/pi-process.ts` and `src/runtime/container-pi-process.ts` from plain unsubscribe callbacks to Effect-managed scoped subscriptions. Both process implementations now expose scoped `subscribeEvents(...)` subscriptions and no longer return raw unsubscribe callbacks.
- [x] Replace manual timer lifecycle management with Effect-owned resource lifecycles where the timer is part of business logic. RPC send/wait/collect timeouts in both process implementations now use `Effect.timeoutFail(...)` instead of manual `setTimeout` / `clearTimeout` ownership.
- [~] Remove duplicated manual shutdown logic once the scoped finalizers are in place. The production entrypoint no longer duplicates DB/server shutdown logic; direct test/manual construction paths still own their own explicit cleanup.

Target files for this phase:

- [x] `src/index.ts` - Production runtime now uses `Effect.scoped(createPiServerScopedEffect(...))` and a scoped signal-wait effect instead of manual shutdown callbacks
- [~] `src/db.ts` - `PiKanbanDB` still exposes `.close()`, but the production server runtime now owns its lifetime through `Effect.acquireRelease` in `src/server.ts`
- [~] `src/server/server.ts` - `PiKanbanServer` no longer constructs/owns `WebSocketHub`; websocket, container/image managers, and planning-session manager are now injected from the outer scoped runtime
- [~] `src/server/websocket.ts` - `WebSocketHub` now has an explicit `close()` finalizer and is acquired/released by the production scoped runtime
- [x] `src/runtime/pi-process.ts` - Event listeners are now scoped subscriptions via `subscribeEvents(...)`, and command/idle/collect timeouts are owned by Effect timeouts instead of raw timers
- [x] `src/runtime/container-pi-process.ts` - Event listeners are now scoped subscriptions via `subscribeEvents(...)`, and command/idle/collect timeouts are owned by Effect timeouts instead of raw timers
- [~] `src/runtime/planning-session.ts` - Session process and streaming subscription now live in a dedicated `Scope.CloseableScope`; manager acquisition still needs to move fully into the outer scoped runtime
- [~] `src/runtime/session-manager.ts` - Uses `Effect.acquireRelease` for session execution
- [~] `src/runtime/container-manager.ts` - `PiContainerManager` now has explicit runtime finalization via `close()` and is acquired/released by the scoped server runtime; internal Podman operations are still Promise-based
- [~] `src/runtime/container-image-manager.ts` - `ContainerImageManager` now has explicit runtime finalization via `close()` and is acquired/released by the scoped server runtime; status updates remain callback-based

Completion gate:

- [~] Every long-lived backend resource has one owner and one finalization path. DB, websocket hub, server lifetime, container manager, container image manager, and planning-session manager are now owned by the production scoped runtime; broader context-service cutover is still pending.
- [~] Manual resource cleanup code that duplicates scope finalizers has been deleted. Production shutdown duplication is removed, but explicit cleanup remains in direct-construction tests and in still-unscoped runtime subsystems.
- [~] Listener and timer cleanup is no longer callback-only and untracked. Native/container Pi process subscriptions and timeout ownership are now Effect-managed; container/image/runtime-manager ownership still needs the same cutover.

## Phase 4: Convert Runtime and Orchestration Flow to Effect-Native Concurrency

Relevant guides:

- `migration/forking.md`
- `migration/scope.md`
- `migration/runtime.md`
- `migration/generators.md`

Checklist:

- [~] Rewrite orchestration control flow so runs, sessions, and background execution are represented as Effect programs rather than Promise-returning methods wrapped by Effect at the boundary. `PiOrchestrator` class methods (`startAll`, `startSingle`, `startGroup`, `stopRun`, `pauseRun`, `resumeRun`) are async methods returning Promises; orchestrator internally uses `Effect.runPromise` for session execution
- [x] Convert `PiSessionManager` to expose Effect-only operations. All Promise wrapper methods removed, callbacks moved to second parameter.
- [x] Convert `PlanningSession` and `PlanningSessionManager` to expose Effect-only operations. All Promise wrapper methods removed, and `PlanningSession` now keeps its process/subscription ownership in a dedicated Effect scope.
- [~] Convert `PiRpcProcess` and `ContainerPiProcess` lifecycle control to Effect-owned interruption, timeout, and supervision rather than handwritten `AbortController`, callback, and timer logic. Timeout and listener ownership are now Effect-managed; stream reader cancellation still uses internal `AbortController`-driven loops.
- [~] Refactor `src/orchestrator.ts` so run-control operations are native Effects, not Promise methods with thin Effect wrappers. `PiOrchestrator` is still a class with async methods; helper functions (`runOrchestratorOperationPromiseEffect`, `runOrchestratorOperationSyncEffect`) bridge Effect and Promise
- [~] Convert `src/runtime/global-scheduler.ts` and related execution coordination to Effect-native state/concurrency primitives. (`throw new Error` removed; typed `GlobalSchedulerError` in place, state model still mutable class)
- [ ] Replace manual mutable coordination where it exists solely to compensate for missing structured concurrency.
- [~] Remove legacy wrapper helpers such as `runOrchestratorOperationPromise` and similar bridging utilities once call sites use native Effect services. `runOrchestratorOperationPromise` still exists and is used by `PiKanbanServer` callbacks

Target files for this phase:

- [~] `src/orchestrator.ts` - `PiOrchestrator` class with async methods; uses `Effect.runPromise` for session execution; `runOrchestratorOperationPromiseEffect` bridges Effect/Promise
- [x] `src/runtime/session-manager.ts` - **COMPLETE** - `executePrompt` now returns `Effect.Effect<ExecuteSessionPromptResult, SessionManagerExecuteError | PiProcessError>`; session startup uses Effect-returning `proc.start()`
- [x] `src/runtime/planning-session.ts` - **COMPLETE** - All methods (`start`, `sendMessage`, `close`, `reconnect`, `setModel`, `setThinkingLevel`) now return Effects, and session-owned process/subscription resources live in a dedicated scope instead of per-message unsubscribe callbacks
- [~] `src/runtime/pi-process.ts` - Uses Effect for `send`, `prompt`, `collectEvents`, `close`, `forceKill`; timeout ownership and event subscriptions are Effect-managed, while stream reader cancellation still uses `AbortController`
- [~] `src/runtime/container-pi-process.ts` - Uses Effect for `send`, `prompt`, `collectEvents`, `close`, `forceKill`; timeout ownership and event subscriptions are Effect-managed, while stream capture remains callback-based over container stdio
- [~] `src/runtime/global-scheduler.ts` - Raw throws replaced with tagged `GlobalSchedulerError`; API remains sync/mutable class with Map-based state
- [~] `src/runtime/review-session.ts` - Uses `Effect.runPromise` for session execution
- [~] `src/runtime/best-of-n.ts` - Uses `Effect.runPromise` for session execution
- [~] `src/runtime/codestyle-session.ts` - Uses `Effect.runPromise` for session execution
- [~] `src/runtime/smart-repair.ts` - Uses `Effect.runPromise` for session execution
- [~] `src/runtime/self-healing.ts` - Uses `Effect.runPromise` for session execution

Completion gate:

- [~] Runtime and orchestration modules no longer export duplicate Promise and Effect APIs for the same actions. `PiSessionManager`, `PlanningSession`, `PlanningSessionManager` are Effect-only; `PiOrchestrator` still has Promise-based public API
- [~] Run/session cancellation is driven by Effect interruption and scope ownership. Session execution uses `Effect.acquireRelease`; orchestrator cancellation uses manual flags (`shouldStop`, `shouldPause`)
- [ ] Manual bridging helpers that existed only to call Promise methods from Effects have been deleted. `runOrchestratorOperationPromise` and `runOrchestratorOperationSync` still exist

## Phase 5: Replace Ad Hoc Logging With Effect Observability

Relevant guides:

- `migration/services.md`
- `migration/error-handling.md`

Checklist:

- [x] Introduce a shared logging service or Effect logging configuration for backend application code. (`src/shared/logger.ts` defines `LoggerService`, `LiveLoggerService`, `LoggerLayer` using `Effect.log*`)
- [~] Replace console logging in `src/index.ts`, `src/server/server.ts`, `src/orchestrator.ts`, and runtime process modules with structured Effect logging. `src/index.ts` still uses `console.log/warn/error`; `src/recovery/startup-recovery.ts` uses `Effect.log*`; most other modules still use `console.log/error/warn`
- [ ] Standardize log fields for `runId`, `taskId`, `taskRunId`, `sessionId`, `containerId`, route name, and operation name.
- [ ] Route all integration logging, including Telegram and container events, through the same logging path.
- [ ] Decide and apply one policy for log levels and error rendering.
- [ ] Remove residual console-based operational logging from frontend API/store code and move user-visible error reporting to typed UI handling.

Target files for this phase:

- [~] `src/index.ts` - Still uses `console.log/warn/error` extensively
- [~] `src/server/server.ts` - Still uses `console.log/error` for container initialization and notifications
- [~] `src/orchestrator.ts` - Still uses `console.log/warn/error` extensively
- [x] `src/recovery/startup-recovery.ts` - Uses `Effect.logInfo` and `Effect.logError` consistently
- [~] `src/runtime/pi-process.ts` - Still uses `console.error` for process error handling
- [~] `src/runtime/container-pi-process.ts` - Still uses `console.log/error` for container lifecycle
- [~] `src/runtime/container-manager.ts` - Still uses `console.log/error` extensively
- [ ] `src/telegram.ts`
- [ ] `src/kanban-solid/src/api/*`
- [ ] `src/kanban-solid/src/stores/*`

Completion gate:

- [~] Console-based operational logging has been removed from application modules. `startup-recovery.ts` is fully migrated; `index.ts`, `server.ts`, `orchestrator.ts`, `pi-process.ts`, `container-pi-process.ts`, `container-manager.ts` still use console
- [ ] Logging metadata is consistent across backend execution paths.
- [~] Startup recovery is no longer the only subsystem using Effect-native logging.

## Phase 6: Rebuild the HTTP Boundary as Effect Programs

Relevant guides:

- `migration/runtime.md`
- `migration/error-handling.md`
- `migration/generators.md`

Checklist:

- [x] Change `src/server/types.ts` so route and control contracts are Effect-based rather than Promise-based. (server control callbacks converted to `Effect.Effect`; `RouteHandler` now accepts Effect-returning handlers)
- [~] Refactor route registration functions in `src/server/routes/*.ts` so they build Effects instead of wrapping business logic in per-route `try/catch` blocks. (execution-routes uses Effect throughout; task-routes partially converted; planning/task-group/container remain mixed with async Response returns)
- [x] Introduce one central interpreter that maps typed errors to HTTP responses. (`src/server/route-interpreter.ts` defines `HttpRouteError`, `runRouteEffect`, and helper constructors `badRequestError`, `notFoundError`, `conflictError`, `serviceUnavailableError`, `internalRouteError`)
- [~] Keep only one Bun adapter layer that executes route Effects at the request boundary. (`src/server/router.ts` dispatches to `runRouteEffect` for Effect returns; some routes still use `Effect.runPromise` locally in `task-routes.ts`)
- [x] Refactor `PiKanbanServer` so callbacks and integration points are Effect-based services, not Promise-returning function slots. (server control callback signatures migrated to `Effect.Effect`)
- [~] Update direct server call sites/tests to match the new Effect-returning callback contract. (`tests/plan-mode.test.ts` updated; remaining test fixtures should be checked)
- [ ] Migrate notification and external HTTP integrations behind Effect services before they are invoked from routes or server lifecycle code. `src/telegram.ts` still uses direct `fetch` with `console.error` for failures
- [ ] Remove route-local behavior that depends on message-string inspection or ad hoc JSON parsing for control flow.

Target files for this phase:

- [x] `src/server/types.ts` - `RunControlFn`, `StartFn`, `StartSingleFn`, etc. all return `Effect.Effect`; `RouteHandler` accepts Effect-returning handlers
- [x] `src/server/router.ts` - `dispatch()` calls `runRouteEffect` for Effect returns
- [~] `src/server/server.ts` - Server callbacks use Effect; still has `console.log/error` for initialization and notifications
- [~] `src/server/routes/execution-routes.ts` - Uses Effect throughout for route handlers
- [~] `src/server/routes/task-routes.ts` - Partially converted; still uses `Effect.runPromise` for some orchestrator calls and background polling
- [~] `src/server/routes/session-routes.ts` - Standardized API error codes; uses Effect for route handlers
- [~] `src/server/routes/planning-routes.ts` - Uses Effect for route handlers with typed errors
- [~] `src/server/routes/container-routes.ts` - Partially converted; build flow still uses `runRouteEffect` locally
- [~] `src/server/routes/task-group-routes.ts` - Uses Effect for route handlers with typed errors
- [~] `src/server/routes/stats-routes.ts` - Uses Effect for route handlers with typed errors
- [ ] `src/telegram.ts` - Still uses direct `fetch` with manual error handling

Completion gate:

- [~] Route modules do not implement business logic through ad hoc `try/catch` blocks. `execution-routes.ts` fully converted; other routes still have mixed patterns
- [~] The Bun HTTP layer is becoming the primary place where request Effects are executed. (`src/server/router.ts` dispatches to `runRouteEffect`; `task-routes.ts` still has local `Effect.runPromise` calls)
- [x] Promise-based server callback types have been deleted.

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

- [ ] `src/kanban-solid/src/api/client.ts` - Still uses Promise-based `fetch` with manual error handling
- [ ] `src/kanban-solid/src/api/*.ts` - Not yet migrated to Effect
- [ ] `src/kanban-solid/src/stores/tasksStore.ts`
- [ ] `src/kanban-solid/src/stores/runsStore.ts`
- [ ] `src/kanban-solid/src/stores/optionsStore.ts`
- [ ] `src/kanban-solid/src/stores/taskGroupsStore.ts`
- [ ] `src/kanban-solid/src/stores/workflowControlStore.ts`
- [ ] `src/kanban-solid/src/stores/websocketStore.ts`
- [ ] `src/kanban-solid/src/stores/planningChatStore.ts`
- [ ] `src/kanban-solid/src/stores/sessionUsageStore.ts`
- [ ] `src/kanban-solid/src/App.tsx` - Still uses direct `fetch` and Promise patterns

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

Target files for this phase:

- `tests/helpers/effect.ts` - Provides Effect-aware test utilities
- `tests/settings-effect.test.ts` - Effect-based tests for settings
- `tests/startup-recovery.test.ts` - Effect-based tests for startup recovery
- `tests/plan-mode.test.ts` - Uses Effect-returning server callbacks
- Other test files still use Promise-based patterns

Completion gate:

- [ ] The test suite validates the migrated architecture rather than only the old Promise behavior.
- [ ] Verification scripts catch reintroduction of banned legacy patterns.

## Phase 9: Delete Remaining Bridge Code and Finalize the Cutover

Relevant guides:

- `migration/runtime.md`
- `migration/services.md`
- `migration/error-handling.md`

Checklist:

- [ ] Remove any remaining helper whose only purpose was bridging old Promise code into Effect code. (`runOrchestratorOperationPromise`, `runOrchestratorOperationSync`, `runOrchestratorOperationPromiseEffect`, `runOrchestratorOperationSyncEffect` should be consolidated or removed)
- [ ] Remove dead exports and duplicate APIs left behind by intermediate migration work.
- [ ] Remove unused fallback code, compatibility comments, and temporary adapters.
- [ ] Update README and architecture docs to describe the final Effect-first runtime model.
- [ ] Re-run the audit queries and confirm the application now matches the target architecture rather than the mixed architecture described in the original report.
- [ ] Produce a final verification note or report documenting the completed cutover and the remaining intentional runtime boundaries.

Target files for this phase:

- [~] `src/orchestrator.ts` - `runOrchestratorOperationPromise` and `runOrchestratorOperationSync` bridge Effect/Promise; needed until `PiOrchestrator` methods return Effects directly
- [~] `src/server.ts` - `createPiServer` (sync) still exists alongside `createPiServerEffect`
- [~] `src/server/routes/task-routes.ts` - Still uses `Effect.runPromise` for background polling and orchestrator calls

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
