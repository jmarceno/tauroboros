# Full Effect Migration Plan

Date: 2026-04-21
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
- [x] Add migration guardrails to CI or verification scripts so new internal `Effect.runPromise`, `console.log/error/warn`, and `throw new Error` regressions are caught while the migration is in progress. `scripts/verify-migration.ts` now distinguishes banned-pattern violations from positive migration metrics and supports `--strict` when the repo is ready for a hard gate.
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
- [~] Remove permissive fallback behavior such as unknown-level default branches and implicit fallback cases in integrations. Server routes use `HttpRouteError` with explicit status codes, Telegram notification-level handling is now explicit-failure only, and paused-session persistence now fails explicitly when required resume fields are missing; orchestrator task execution still has some fallback error handling.
- [x] Standardize API error payload encoding so backend and frontend share one explicit error contract. (`src/shared/error-codes.ts` defines `ErrorCode` enum and `ApiError` interface)
- [x] Replace raw `throw new Error(...)` and non-tagged parse failures in `src/runtime/strict-json.ts` with explicit typed failures and update all callers. `StrictJsonError` now owns strict JSON parse failures, and dependent runtime modules consume it through existing typed error mapping.
- [x] Remove backward-compatibility fallback branches in `src/runtime/session-pause-state.ts`; paused-run persistence now uses explicit database-only paths and returns `PausedSessionStateError` when persisted resume state is incomplete.

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
- [~] `src/server/routes/container-routes.ts` - Profile/status/validate/dockerfile/images/delete/build paths now run through shared route interpreter and Effect-authored programs; some route registration still uses async Bun handler signatures at the HTTP boundary
- [x] `src/db.ts` - Database schema validation, type conversions, and remaining domain-failure paths now use `DatabaseError`; raw `throw new Error(...)` paths removed from this module
- [x] `src/server/server.ts` - Container validation, notification handling, and startup checks migrated to `ServerRuntimeError`; constructor no longer instantiates runtime dependencies, and Telegram notifications now flow through a scoped Effect queue worker instead of an ad hoc `ManagedRuntime.runPromise(...)` side path
- [x] `src/telegram.ts` - Migrated to Effect-based notification helpers with `TelegramError`; response decoding and unsupported notification levels now fail explicitly instead of falling back or swallowing parse failures
- [x] `src/kanban-solid/src/api/client.ts` - Legacy promise client removed; request execution now returns typed `Effect` failures via `ApiClientError`
- [x] `src/kanban-solid/src/api/*.ts`, `src/kanban-solid/src/stores/*.ts` - Solid API modules now expose Effect-based request programs only, and store/query/mutation/event handlers consume them through the shared `runApiEffect` UI boundary without keeping a Promise compatibility client
- [x] `src/runtime/strict-json.ts` - Fully migrated to `StrictJsonError` tagged failures; raw `throw new Error(...)` removed
- [x] `src/runtime/session-pause-state.ts` - Paused-session and paused-run loading now return `Effect` values and fail explicitly with `PausedSessionStateError` when persisted resume fields are incomplete

Completion gate:

- [~] Business modules no longer rely on `throw new Error(...)` for normal domain failures. Backend runtime, orchestration, db, server routes, Telegram, server runtime, and Solid API/store paths are mostly migrated; remaining work is concentrated in runtime process internals, container/runtime helpers, and orchestration heuristics.
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
- [~] `src/runtime/container-manager.ts` - Runtime ownership is now centralized via scoped server assembly and explicit `close()` finalization; public operations are Effect-only and explicit mock-server startup failure is enforced. `ContainerProcess` lifecycle methods (`kill`/`inspect`) are now Effect-returning, and resume/existence checks are partially migrated, but substantial internal Podman helpers still use private async/Promise implementations.
- [~] `src/runtime/container-image-manager.ts` - Runtime ownership is now centralized via scoped server assembly and explicit `close()` finalization; public operations are Effect-only, and image-prepare/build/pull plus podman-exec internals are now Effect-native. Remaining work is callback-based status broadcasting plus strict explicit-failure cleanup in package-validation/config IO paths.
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
- [~] `src/runtime/container-manager.ts` - `PiContainerManager` now has explicit runtime finalization via `close()` and is acquired/released by the scoped server runtime; internal Podman operations are still mostly Promise-based, though `ContainerProcess` lifecycle methods are now Effect-returning.
- [~] `src/runtime/container-image-manager.ts` - `ContainerImageManager` now has explicit runtime finalization via `close()` and is acquired/released by the scoped server runtime; internal prepare/build/pull/exec flows are Effect-native, while status notifications remain callback-based.

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

- [~] Rewrite orchestration control flow so runs, sessions, and background execution are represented as Effect programs rather than Promise-returning methods wrapped by Effect at the boundary. `PiOrchestrator` now exposes Effect-returning public control methods (`startAll`, `startSingle`, `startGroup`, `stopRun`, `stop`, `destructiveStop`, `forceStop`, `pauseRun`, `pause`, `resumeRun`, `resume`, `manualSelfHealRecover`), its internal run-start, scheduling, stale-run cleanup, resume, and image-validation flows are now native Effects, and background task lifecycle failures now log and explicitly fail the affected run instead of being swallowed; remaining work is primarily the broader mutable scheduler/control-state model rather than internal Promise bridges.
- [x] Convert `PiSessionManager` to expose Effect-only operations. All Promise wrapper methods removed, callbacks moved to second parameter.
- [x] Convert `PlanningSession` and `PlanningSessionManager` to expose Effect-only operations. All Promise wrapper methods removed, and `PlanningSession` now keeps its process/subscription ownership in a dedicated Effect scope.
- [~] Convert `PiRpcProcess` and `ContainerPiProcess` lifecycle control to Effect-owned interruption, timeout, and supervision rather than handwritten `AbortController`, callback, and timer logic. Timeout and listener ownership are now Effect-managed, stdout/stderr capture now runs on Effect-managed fibers instead of inline `Effect.run*` execution, extension-UI request handling stays inside those Effect programs, and the `pi-process-factory` sync/async bridge wrappers are removed; stream reader cancellation still uses internal `AbortController`-driven loops.
- [x] Refactor `src/orchestrator.ts` so run-control operations are native Effects, not Promise methods with thin Effect wrappers. The legacy `runOrchestratorOperationPromiseEffect` / `runOrchestratorOperationSyncEffect` bridge helpers are deleted, `PiOrchestrator` now exposes Effect-returning public control methods, the server consumes them directly, and the internal run-start / scheduling / resume / image-validation bridge cluster has been converted to native Effects.
- [~] Convert `src/runtime/global-scheduler.ts` and related execution coordination to Effect-native state/concurrency primitives. (`throw new Error` removed; typed `GlobalSchedulerError` in place, state model still mutable class)
- [ ] Replace manual mutable coordination where it exists solely to compensate for missing structured concurrency.
- [~] Remove legacy wrapper helpers such as `runOrchestratorOperationPromise` and similar bridging utilities once call sites use native Effect services. The unused `runOrchestratorOperationPromise(...)` / `runOrchestratorOperationSync(...)` wrappers and the server-side `runOrchestratorOperation*Effect(...)` adapters are deleted, the server now consumes `PiOrchestrator`’s Effect-returning public methods directly, and the private orchestrator Promise bridge helpers have also been removed; remaining bridge cleanup is now outside the orchestrator module.
- [ ] Migrate `src/runtime/worktree.ts` to an Effect-first public API and update all orchestrator / best-of-n call sites in the same change.

Target files for this phase:

- [~] `src/orchestrator.ts` - `PiOrchestrator` class now exposes Effect-returning public control methods, the pause-session path plus the stop/destructive-stop teardown path (`stopRun`, `destructiveStop`, `killSessionImmediately`) are now native Effect code, resumed-task/review-fix session flows are consolidated through `runSessionPrompt(...)`, the internal run-start / scheduling / resume / image-validation bridge cluster is now Effect-native, and background scheduler-maintenance failures now transition the run/tasks into explicit failed states instead of being suppressed; remaining work is the mutable coordination model, not residual `Effect.run*` or Promise signatures in this file.
- [x] `src/runtime/session-manager.ts` - **COMPLETE** - `executePrompt` now returns `Effect.Effect<ExecuteSessionPromptResult, SessionManagerExecuteError | PiProcessError>`; session startup uses Effect-returning `proc.start()`
- [x] `src/runtime/planning-session.ts` - **COMPLETE** - All methods (`start`, `sendMessage`, `close`, `reconnect`, `setModel`, `setThinkingLevel`) now return Effects, and session-owned process/subscription resources live in a dedicated scope instead of per-message unsubscribe callbacks
- [~] `src/runtime/pi-process.ts` - Uses Effect for `send`, `prompt`, `collectEvents`, `close`, `forceKill`, and stdout/stderr stream processing; timeout ownership, event subscriptions, and extension-UI request handling are Effect-managed, while stream reader cancellation still uses `AbortController`
- [~] `src/runtime/container-pi-process.ts` - Uses Effect for `send`, `prompt`, `collectEvents`, `close`, `forceKill`, and stdout/stderr stream processing; timeout ownership, event subscriptions, and extension-UI request handling are Effect-managed, while stream reader cancellation still uses `AbortController`
- [~] `src/runtime/global-scheduler.ts` - Raw throws replaced with tagged `GlobalSchedulerError`; API remains sync/mutable class with Map-based state
- [x] `src/runtime/review-session.ts` - Review scratch runner is Effect-only and consumes `PiSessionManager.executePrompt(...)` without Promise wrappers
- [x] `src/runtime/best-of-n.ts` - Best-of-N runner now returns an `Effect`, uses Effect-native worker/reviewer/final-applier session execution internally, and no longer calls `Effect.runPromise(...)` inside the module
- [x] `src/runtime/codestyle-session.ts` - `CodeStyleSessionRunner.run(...)` is Effect-only, and tests execute it at the test boundary
- [x] `src/runtime/smart-repair.ts` - Smart repair service is Effect-only and consumes `PiSessionManager.executePrompt(...)` without Promise wrappers
- [x] `src/runtime/self-healing.ts` - Self-healing investigation service is Effect-only and consumes `PiSessionManager.executePrompt(...)` without Promise wrappers
- [x] `src/runtime/pi-process-factory.ts` - Removed `createPiProcess()` / async Promise bridge wrappers; callers now use `createPiProcessEffect(...)`, `isContainerRuntimeAvailableEffect(...)`, and `validateContainerSetupEffect(...)` directly
- [x] `src/runtime/worktree.ts` - Worktree operations and lifecycle helpers are Effect-first and consumed directly by orchestrator / best-of-n without Promise bridge exports

Completion gate:

- [~] Runtime and orchestration modules no longer export duplicate Promise and Effect APIs for the same actions. `PiSessionManager`, `PlanningSession`, `PlanningSessionManager`, `PiReviewSessionRunner`, `BestOfNRunner`, `SmartRepairService`, `SelfHealingService`, `PiOrchestrator`, `PiContainerManager`, `ContainerImageManager`, `WorktreeLifecycle`, and `MockServerManager` are now Effect-only at their exported/public surfaces; remaining bridge debt is concentrated in private runtime helpers plus server/frontend boundary adapters.
- [~] Run/session cancellation is driven by Effect interruption and scope ownership. Session execution uses `Effect.acquireRelease`; orchestrator cancellation uses manual flags (`shouldStop`, `shouldPause`)
- [~] Manual bridging helpers that existed only to call Promise methods from Effects have been deleted. Public/server bridge helpers are removed, and `src/orchestrator.ts` no longer contains internal `Effect.runPromise(...)` / `Effect.runSync(...)` bridge usage; remaining bridge cleanup is now in runtime utilities, server adapters, and frontend boundary helpers.

## Phase 5: Replace Ad Hoc Logging With Effect Observability

Relevant guides:

- `migration/services.md`
- `migration/error-handling.md`

Checklist:

- [x] Introduce a shared logging service or Effect logging configuration for backend application code. (`src/shared/logger.ts` defines `LoggerService`, `LiveLoggerService`, `LoggerLayer` using `Effect.log*`)
- [~] Replace console logging in `src/index.ts`, `src/server/server.ts`, `src/orchestrator.ts`, and runtime process modules with structured Effect logging. The backend `src/**` tree no longer uses raw `console.log/error/warn`; the server notification path no longer uses an internal `ManagedRuntime.runPromise(...)`, and the remaining observability debt is concentrated in runtime/container utilities rather than server notification handling.
- [ ] Standardize log fields for `runId`, `taskId`, `taskRunId`, `sessionId`, `containerId`, route name, and operation name.
- [ ] Route all integration logging, including Telegram and container events, through the same logging path.
- [ ] Decide and apply one policy for log levels and error rendering.
- [ ] Remove residual console-based operational logging from frontend API/store code and move user-visible error reporting to typed UI handling.

Target files for this phase:

- [~] `src/index.ts` - Still uses boundary-adjacent `Effect.runSync(Effect.log*)` helpers instead of a fully normalized entrypoint logging flow
- [~] `src/server/server.ts` - Notification dispatch now runs through a scoped Effect queue worker started at server startup; remaining work is normalizing logging metadata rather than removing backend console usage
- [x] `src/orchestrator.ts` - Raw console and non-boundary `Effect.run*` bridge usage removed from this module; remaining observability work is metadata standardization and cross-module consistency
- [x] `src/recovery/startup-recovery.ts` - Uses `Effect.logInfo` and `Effect.logError` consistently
- [~] `src/runtime/pi-process.ts` - Backend `console.*` usage is removed; remaining observability work is structured metadata consistency and direct stream/process logging normalization
- [~] `src/runtime/container-pi-process.ts` - Backend `console.*` usage is removed; remaining observability work is structured metadata consistency and direct stream/process logging normalization
- [~] `src/runtime/container-manager.ts` - Backend `console.*` usage is removed; remaining observability work is structured metadata consistency and direct stderr/stdout helper normalization
- [x] `src/telegram.ts` - Notification sending, response decoding, and unsupported notification levels now fail explicitly with `TelegramError`
- [ ] `src/kanban-solid/src/api/*`
- [ ] `src/kanban-solid/src/stores/*`

Completion gate:

- [~] Console-based operational logging has been removed from application modules. `startup-recovery.ts`, `orchestrator.ts`, `pi-process.ts`, `container-pi-process.ts`, `container-manager.ts`, and `mock-server-manager.ts` are now off raw `console.*`; the remaining work is normalizing runtime/container/frontend logging metadata and replacing direct stdout/stderr helpers where appropriate.
- [ ] Logging metadata is consistent across backend execution paths.
- [~] Startup recovery is no longer the only subsystem using Effect-native logging.

## Phase 6: Rebuild the HTTP Boundary as Effect Programs

Relevant guides:

- `migration/runtime.md`
- `migration/error-handling.md`
- `migration/generators.md`

Checklist:

- [x] Change `src/server/types.ts` so route and control contracts are Effect-based rather than Promise-based. Server control callbacks and `RouteHandler` are now Effect-only.
- [x] Refactor route registration functions in `src/server/routes/*.ts` so they build Effects instead of wrapping business logic in per-route `try/catch` blocks. Route modules now return Effect programs directly and no longer use route-local `runRouteEffect(...)` execution.
- [x] Introduce one central interpreter that maps typed errors to HTTP responses. (`src/server/route-interpreter.ts` defines `HttpRouteError`, `runRouteEffect`, and helper constructors `badRequestError`, `notFoundError`, `conflictError`, `serviceUnavailableError`, `internalRouteError`)
- [x] Keep only one Bun adapter layer that executes route Effects at the request boundary. `src/server/router.ts` now always executes `RouteHandler` programs via `runRouteEffect(...)`.
- [x] Refactor `PiKanbanServer` so callbacks and integration points are Effect-based services, not Promise-returning function slots. (server control callback signatures migrated to `Effect.Effect`)
- [~] Update direct server call sites/tests to match the new Effect-returning callback contract. `tests/test-utils.ts` now runs `PiKanbanServer.startEffect(...)` through a scoped test boundary, `tests/archived-api.test.ts` was updated to use the Effect start path directly, `tests/plan-mode.test.ts` and the orchestrator execution suites already execute Effect-returning APIs at the test boundary, and the focused backend slice (`tests/server.test.ts`, `tests/archived-api.test.ts`, `tests/plan-mode.test.ts`) now passes; the broader suite still needs a full repo sweep.
- [~] Migrate notification and external HTTP integrations behind Effect services before they are invoked from routes or server lifecycle code. Telegram notifications now run through Effect programs and a scoped server worker queue; broader service/layer ownership for outbound integrations is still pending.
- [ ] Remove route-local behavior that depends on message-string inspection or ad hoc JSON parsing for control flow.

Target files for this phase:

- [x] `src/server/types.ts` - `RunControlFn`, `StartFn`, `StartSingleFn`, etc. all return `Effect.Effect`, and `RouteHandler` is now Effect-only
- [x] `src/server/router.ts` - `dispatch()` executes Effect handlers through `runRouteEffect` with no mixed Promise/Response compatibility branch
- [~] `src/server/server.ts` - Server callbacks use Effect, backend console-based operational logging is removed, scoped notification worker startup uses current Effect fork APIs, and direct server-registered API routes (`/api/options`, `/api/version`, `/api/branches`, etc.) now return Effect handlers; remaining work is broader runtime normalization outside the HTTP route layer
- [x] `src/server/routes/execution-routes.ts` - Effect-only route handlers; no async route callbacks and no route-local `runRouteEffect(...)`
- [x] `src/server/routes/task-routes.ts` - Effect-only route handlers for CRUD, revision, reset, and orchestration paths; no async route callbacks
- [x] `src/server/routes/session-routes.ts` - Effect-only route handlers with typed error mapping
- [x] `src/server/routes/planning-routes.ts` - Effect-only route handlers with typed errors
- [x] `src/server/routes/container-routes.ts` - Effect-only route handlers for profile/build/image flows and typed error mapping
- [x] `src/server/routes/task-group-routes.ts` - Effect-only route handlers with typed errors
- [x] `src/server/routes/stats-routes.ts` - Effect-only route handlers
- [~] `src/telegram.ts` - Uses explicit `TelegramError` failures and server-owned Effect dispatch; outbound HTTP still relies on `fetch` inside `Effect.tryPromise(...)`

Completion gate:

- [x] Route modules no longer execute business logic through mixed Promise route callbacks or route-local Effect execution helpers. Route handlers now return Effect programs directly.
- [x] The Bun HTTP layer is the place where request Effects are executed. `src/server/router.ts` dispatches handlers through `runRouteEffect(...)` exclusively.
- [x] Promise-based server callback types have been deleted.

## Phase 7: Migrate the Frontend to Effect-Authored Async Flows

Relevant guides:

- `migration/services.md`
- `migration/error-handling.md`
- `migration/runtime.md`
- `.patterns/testing-patterns.md`

Checklist:

- [ ] Replace the Promise-based frontend HTTP client in `src/kanban-solid/src/api/client.ts` with an Effect-authored HTTP service and typed response decoding.
- [~] Convert all API modules under `src/kanban-solid/src/api/*` to expose Effect-based operations instead of raw `fetch` or Promise-returning helpers. Container-related UI flows now go through `containersApi`/`tasksApi` plus `runApiEffect(...)`, and the remaining deliberate Promise boundary is concentrated in `api/client.ts`.
- [~] Convert websocket handling in `src/kanban-solid/src/stores/websocketStore.ts` and related modules to Effect-managed subscriptions and event handling. Reconnect scheduling now runs as an Effect program (`Effect.sleep`) executed through the shared UI boundary helper, while event-handler registration still uses callback sets.
- [~] Convert data and mutation logic in frontend stores to Effect-authored flows. `workflowControlStore.ts`, `taskLastUpdateStore.ts`, `sessionUsageStore.ts`, `tasksStore.ts`, `runsStore.ts`, and `optionsStore.ts` now build/execute their async flow via Effect programs and the shared boundary helper; planning-chat and remaining stores/components still need full unification.
- [ ] Choose one frontend execution-boundary pattern and apply it everywhere. If TanStack Query remains, query and mutation functions must be thin boundary adapters over Effect programs, with no handwritten Promise business logic left in the store or API layers.
- [~] Remove component-level `try/catch`, direct `fetch`, and Promise orchestration from `src/kanban-solid/src/App.tsx` and related components. Raw `fetch` has been removed from `App.tsx` and `ContainersTab.tsx`; remaining frontend imperative error handling is now narrower and localized.
- [ ] Replace frontend handwritten error translation with typed domain or transport failures interpreted by UI presenters.
- [ ] Remove duplicate async patterns across stores so there is one standard way to trigger, await, cancel, and display asynchronous work in the frontend.

Target files for this phase:

- [~] `src/kanban-solid/src/api/client.ts` - Effect-authored request execution is in place; `runApiEffect(...)` remains the deliberate Promise-returning UI boundary helper and `response.json()` still crosses a Promise-based browser API
- [~] `src/kanban-solid/src/api/*.ts` - API modules are Effect-based; remaining cleanup is concentrated in boundary typing and any lingering boundary-only Promise helpers
- [x] `src/kanban-solid/src/stores/tasksStore.ts` - Query invalidation and batch mutations now execute via Effect programs (`Effect.promise`, `Effect.forEach`) through the shared UI boundary helper; Promise orchestration wrappers (`Promise.all`, `async` mutation wrappers) removed.
- [x] `src/kanban-solid/src/stores/runsStore.ts` - Query invalidation and mutation wrappers now execute via Effect programs through the shared UI boundary helper; dead legacy bridge API `setTasksRef` removed.
- [x] `src/kanban-solid/src/stores/optionsStore.ts` - Query invalidation and mutation wrappers now execute via Effect programs through the shared UI boundary helper; handwritten async wrappers removed.
- [x] `src/kanban-solid/src/stores/taskGroupsStore.ts` - `loadGroupDetails(...)` now uses the shared Effect UI boundary directly without a Promise-typed compatibility wrapper
- [x] `src/kanban-solid/src/stores/workflowControlStore.ts` - Pause/resume/stop flows are now authored as Effect programs and only executed at the store boundary
- [x] `src/kanban-solid/src/stores/websocketStore.ts` - Reconnect loop now uses Effect-based timing (`Effect.sleep`) executed through the shared UI boundary helper; direct Promise sleep loop removed and reconnect lifecycle/token handling normalized.
- [~] `src/kanban-solid/src/stores/planningChatStore.ts` - Message send/reconnect/retry flow now runs as an internal Effect program; other planning-chat mutations still use handwritten async orchestration
- [x] `src/kanban-solid/src/stores/sessionUsageStore.ts` - Session usage loading now builds an Effect flow around cache invalidation/query fetch and runs it at the shared boundary
- [x] `src/kanban-solid/src/stores/taskLastUpdateStore.ts` - Last-update loading now builds an Effect flow and updates local/query cache from inside that program
- [~] `src/kanban-solid/src/App.tsx` - Direct container-status `fetch` removed; broader Promise/event orchestration still remains in app-level handlers
- [~] `src/kanban-solid/src/components/tabs/ContainersTab.tsx` - Raw container/task `fetch` calls removed in favor of `containersApi` / `tasksApi` plus `runApiEffect(...)`; UI error presentation still needs typed presenter cleanup

Completion gate:

- [~] Frontend API and store modules no longer contain raw `fetch`, handwritten `AbortController` timeout handling, or Promise-based error translation. The verifier now reports no Promise-signature violations outside the deliberate UI boundary file (`api/client.ts`); remaining frontend migration work is concentrated in broader store/event orchestration and typed UI error presentation.
- [ ] UI components only trigger Effect-backed operations through the chosen boundary helper.
- [ ] The frontend no longer has a second legacy async architecture alongside Effect-authored flows.

## Phase 8: Convert Tests and Verification to the Final Architecture

Relevant guides:

- `.patterns/testing-patterns.md`

Checklist:

- [~] Move Effect-heavy tests to Effect-aware test patterns and stop relying on generic Promise wrappers for core behavior verification. The shared backend server fixture now executes `startEffect(...)` through `Effect.scoped(...)`, and direct server construction tests have been updated to use the same boundary.
- [~] Use the chosen Effect-aware test style for Effect-returning modules and keep plain tests only for pure functions. The main backend runtime/server tests now execute migrated Effect APIs at the test boundary; broader suite consistency remains incomplete.
- [~] Add focused tests for layer assembly, typed error translation, scoped cleanup, cancellation/interruption, route error mapping, and frontend API/store execution boundaries. Added `tests/effect-http-boundary.test.ts` (route error mapping) and `tests/frontend-store-boundaries.test.ts` (frontend execution-boundary invariants); layer/scoped-cancellation coverage remains incomplete.
- [x] Update verification scripts so the migration invariants are machine-checked. `scripts/verify-migration.ts` now checks migrated frontend stores for banned async wrapper declarations plus task/websocket Promise orchestration regressions.
- [~] Update CI and local scripts so the chosen test flow is the standard project path. Added `test:effect-migration` script and integrated strict migration verification into `scripts/run-tests.ts`; CI wiring still needs explicit workflow updates.

Target files for this phase:

- `tests/helpers/effect.ts` - Provides Effect-aware test utilities
- `tests/settings-effect.test.ts` - Effect-based tests for settings
- `tests/startup-recovery.test.ts` - Effect-based tests for startup recovery
- `tests/plan-mode.test.ts` - Uses Effect-returning server callbacks
- `tests/test-utils.ts` - Shared server fixture now executes `startEffect(...)` through `Effect.scoped(...)` instead of expecting a legacy production Promise API
- `tests/archived-api.test.ts` - Direct `PiKanbanServer` construction path now starts the server with `Effect.runPromise(Effect.scoped(server.startEffect(0)))`
- `tests/orchestration.test.ts`, `tests/orchestrator-stale-running.test.ts`, `tests/execution.test.ts`, `tests/review-loop.test.ts`, `tests/best-of-n.test.ts`, `tests/group-execution.test.ts` - Orchestrator tests now execute `PiOrchestrator` methods at the test boundary with `Effect.runPromise(...)`; targeted validation currently passes after the public API cutover, runtime-process boundary refactor, pause-session Effect migration, stop/destructive-stop Effect migration, and resumed-task/review-fix session-path consolidation with `bun test tests/orchestration.test.ts tests/orchestrator-stale-running.test.ts tests/execution.test.ts tests/review-loop.test.ts tests/best-of-n.test.ts tests/group-execution.test.ts`
- `tests/codestyle-session.test.ts` - Updated to execute `CodeStyleSessionRunner.run(...)` at the test boundary with `Effect.runPromise(...)` and to mock `PiSessionManager.executePrompt(...)` as an Effect-returning method
- `tests/smart-repair.test.ts` - Updated to execute `SmartRepairService.applyAction(...)` / `repair(...)` at the test boundary instead of asserting on unevaluated Effect values
- Other test files still use Promise-based patterns

Completion gate:

- [~] The test suite validates the migrated architecture rather than only the old Promise behavior. Focused backend server/runtime validation now passes after moving server start to the scoped Effect test boundary and fixing the `/api/models` model-discovery runtime regression.
- [x] Verification scripts catch reintroduction of banned legacy patterns. Current verifier includes backend guardrails plus migrated frontend-store async-boundary checks.

## Phase 9: Delete Remaining Bridge Code and Finalize the Cutover

Relevant guides:

- `migration/runtime.md`
- `migration/services.md`
- `migration/error-handling.md`

Checklist:

- [~] Remove any remaining helper whose only purpose was bridging old Promise code into Effect code. `runOrchestratorOperationPromise`, `runOrchestratorOperationSync`, `runOrchestratorOperationPromiseEffect`, and `runOrchestratorOperationSyncEffect` are removed; the remaining bridge cleanup is now inside private orchestrator internals rather than at the server boundary.
- [~] Remove dead exports and duplicate APIs left behind by intermediate migration work. Removed frontend runs-store bridge API `setTasksRef` and its app call-site; additional bridge/dead-export cleanup remains in other modules.
- [ ] Remove unused fallback code, compatibility comments, and temporary adapters.
- [ ] Update README and architecture docs to describe the final Effect-first runtime model.
- [ ] Re-run the audit queries and confirm the application now matches the target architecture rather than the mixed architecture described in the original report.
- [ ] Produce a final verification note or report documenting the completed cutover and the remaining intentional runtime boundaries.

Target files for this phase:

- [x] `src/orchestrator.ts` - `runOrchestratorOperationPromise`, `runOrchestratorOperationSync`, `runOrchestratorOperationPromiseEffect`, and `runOrchestratorOperationSyncEffect` bridge helpers are removed; `PiOrchestrator` public methods now return Effects, and the remaining conversion work has moved out of this module into runtime/server/frontend helpers
- [x] `src/server.ts` - Orchestrator control callbacks now consume `PiOrchestrator`’s Effect-returning public methods directly
- [x] `src/server/routes/task-routes.ts` - Route-local `Effect.runPromise` bridges for create-and-wait, plan revision, and manual self-heal flows have been removed

Completion gate:

- [ ] The application uses one Effect-first architecture end to end.
- [ ] No legacy compatibility paths remain in migrated code.
- [ ] The only remaining `Effect.run*` calls are the approved runtime-boundary adapters.

## Search-Based Verification Checklist

These checks should be hydrated continuously during implementation and must pass before the migration is considered complete.

- [x] `rg -n "throw new Error\(" src src/kanban-solid/src` returns no backend application-code matches representing normal domain failure paths. Latest verified backend sweep is clean; remaining incidental matches are in generated frontend assets or external bundles, not backend source.
- [~] `rg -n "console\.(log|warn|error)" src src/kanban-solid/src` returns only approved logger implementation sites, if any. Latest backend sweep is clean; remaining work is frontend/UI cleanup plus non-console stdout/stderr normalization in runtime helpers.
- [~] `rg -n "Effect\.run(Promise|Sync|Fork|Callback)\(" src src/kanban-solid/src` returns only approved runtime-boundary adapters. Latest sweep no longer reports `src/orchestrator.ts`, `src/db.ts`, `src/container-manager.ts`, `src/worktree.ts`, or `src/runtime/mock-server-manager.ts`; the remaining non-boundary usage is concentrated in true boundary-adjacent adapters plus the deliberate frontend UI boundary helper.
- [~] `rg -n ": .*Promise<|=> Promise<" src/server src/runtime src/kanban-solid/src/api src/kanban-solid/src/stores` returns only approved library-boundary adapter signatures. Latest sweep in `src/server` is now concentrated in boundary adapters (`server/router.ts`, `server/route-interpreter.ts`) plus deliberate frontend UI boundary helpers.
- [x] `rg -n "\bfetch\(" src/kanban-solid/src` returns only the designated frontend HTTP service or approved UI boundary adapter. Latest sweep reports only `src/kanban-solid/src/api/client.ts`.
- [~] `rg -n "AbortController|setTimeout|clearTimeout" src/runtime src/kanban-solid/src` returns only approved runtime-edge usage that cannot be replaced by Effect primitives. Latest sweep still reports multiple runtime/frontend timer and abort sites.
- [x] `rg -n "Context\.GenericTag|Layer\.|Schema\.TaggedError|Effect\.log" src` shows the migrated architecture expanding into composition, error handling, and observability instead of remaining isolated to current hotspots.

Latest verification snapshot (2026-04-21):

- `bun run scripts/verify-migration.ts` => 14 passed, 0 failed.
- `bun run test:effect-migration` => verifier green + focused migration boundary tests (`tests/effect-http-boundary.test.ts`, `tests/frontend-store-boundaries.test.ts`) passing.
- `bun test tests/server.test.ts tests/archived-api.test.ts tests/plan-mode.test.ts` => 39 passed, 0 failed.
- Cleared categories in this batch: `throw new Error`, backend `console.*`, and `Effect.run* outside approved boundaries` according to the current verifier rules.
- Newly guarded categories in this batch: no async-wrapper declarations in migrated frontend stores, no `Promise.all` orchestration in `tasksStore`, and no `sleepMs` reconnect loop in `websocketStore`.
- This batch also fixed post-cutover runtime regressions in scoped server startup and model discovery: the notification worker and detached container build now use the current Effect fork APIs, the shared backend test boundary keeps `startEffect(...)` inside `Effect.scoped(...)`, and `/api/models` no longer calls the removed `Effect.interruptFiber(...)` API.
- The verifier is now green, but it still under-approximates architectural debt. The real remaining blockers are concentrated in private runtime helper internals, the remaining mixed server route/store layers, the frontend websocket/store orchestration layer, and metadata/logging normalization rather than the previously listed exported runtime surfaces.
- Current batch update: `src/runtime/container-image-manager.ts` migrated image prepare/build/pull/exec internals to Effect-native programs, `src/runtime/container-manager.ts` moved `ContainerProcess` lifecycle methods to Effect returns and partially migrated container-existence/reconnect flows, and focused backend validation re-ran green with `bun test tests/server.test.ts --bail` (31 passed, 0 failed) and `bun test tests/effect-http-boundary.test.ts` (3 passed, 0 failed).
- Current batch update: removed the mixed HTTP route layer by converting route registrations in `src/server/routes/*.ts` and server-local API handlers in `src/server/server.ts` to Effect-only handlers, enforcing an Effect-only `RouteHandler` contract in `src/server/types.ts`, and simplifying `src/server/router.ts` to a single Effect execution path. Focused validation passed with `bun test tests/effect-http-boundary.test.ts tests/server.test.ts --bail` (34 passed, 0 failed).

## Final Acceptance Criteria

- [ ] Backend composition is layer-built and Effect-first.
- [ ] Runtime modules expose Effect operations, not Promise wrappers.
- [ ] Orchestrator control flow uses Effect-native lifecycle management.
- [x] HTTP routes are interpreted from typed Effect programs through one central response interpreter.
- [ ] Frontend API and store layers are authored in Effect and use one standard execution-boundary helper.
- [ ] Typed failures, structured logging, and scoped resource ownership are used consistently across the application.
- [ ] No legacy compatibility or fallback code paths remain.
