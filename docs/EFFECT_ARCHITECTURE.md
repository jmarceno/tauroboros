# Effect Architecture Guide

This document describes the Effect-first architecture patterns used in TaurOboros.

## Overview

TaurOboros uses a fully Effect-first architecture. This guide documents the patterns and rules for maintaining consistency.

## Core Principles

### 1. Runtime Boundaries

Effects may only be executed at these approved runtime boundaries:

- **Backend entrypoint** (`src/backend-ts/index.ts`) - Main application startup
- **Bun HTTP adapter** (`src/backend-ts/server/server.ts`) - Request handling boundary
- **WebSocket handlers** - Real-time event boundaries
- **Frontend UI boundary** (`src/frontend/src/`) - User interaction handlers
- **Test harness** (`tests/`) - Test execution boundary

**Rule**: No other module may call `Effect.runPromise`, `Effect.runSync`, or similar execution functions.

### 2. Service Definition Pattern

All services use `Context.GenericTag` for dependency injection:

```typescript
import { Context } from "effect"

// Service interface
export interface MyService {
  readonly doSomething: (input: Input) => Effect.Effect<Output, MyServiceError>
}

// Service tag
export const MyService = Context.GenericTag<MyService>("MyService")
```

**Rule**: Do not use `Context.Service`. Stay on the current Effect dependency line.

### 3. Error Handling Pattern

All domain errors use `Schema.TaggedError`:

```typescript
import { Schema } from "effect"

export class MyServiceError extends Schema.TaggedError<MyServiceError>()(
  "MyServiceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}
```

**Rule**: Do not use `throw new Error` for normal domain failures. Only use exceptions for truly unexpected/defect scenarios.

### 4. Resource Management Pattern

All long-lived resources use `Effect.acquireRelease`:

```typescript
import { Effect } from "effect"

const resource = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => acquireResource(),
    catch: (cause) => new MyServiceError({ operation: "acquire", message: String(cause), cause }),
  }),
  (resource) => Effect.promise(() => releaseResource(resource))
)
```

**Rule**: Never use manual `try/finally` for resource cleanup in Effect code.

### 5. Layer Composition Pattern

Application composition uses Effect Layers:

```typescript
import { Layer, Effect } from "effect"

// Service layers
const DatabaseLayer = Layer.effect(
  DatabaseContext,
  Effect.gen(function* () {
    // Acquire database
    return database
  })
)

// Compose application
const AppLayer = Layer.merge(DatabaseLayer, OtherServiceLayer)

// Execute at boundary
const program = Effect.gen(function* () {
  const db = yield* DatabaseContext
  // ... use db
}).pipe(Effect.provide(AppLayer))

// Only at runtime boundary:
await Effect.runPromise(program)
```

**Rule**: No manual service graph construction outside of layer composition.

### 6. Logging Pattern

All operational logging uses `Effect.log`:

```typescript
import { Effect } from "effect"

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Processing task").pipe(
    Effect.annotateLogs({ taskId: task.id, runId: run.id })
  )
})
```

**Rule**: No `console.log/error/warn` in application code. Only use console for debugging or in the entrypoint before Effect runtime is ready.

### 7. Error Matching Pattern

Use typed error matching instead of string inspection:

```typescript
const program = Effect.gen(function* () {
  const result = yield* someOperation.pipe(
    Effect.catchTag("MyServiceError", (error) =>
      Effect.succeed(fallbackResult)
    ),
    Effect.catchTag("DatabaseError", (error) =>
      Effect.fail(new ApplicationError({ message: "Database unavailable" }))
    )
  )
})
```

**Rule**: Never inspect error messages for control flow.

## Module Categories

### Backend Modules (Fully Migrated)

All backend modules follow the Effect-first architecture:

- `src/backend-ts/shared/errors.ts` - Domain error definitions (Schema.TaggedError)
- `src/backend-ts/shared/logger.ts` - Structured logging service
- `src/backend-ts/shared/services.ts` - Service tags (Context.GenericTag)
- `src/backend-ts/shared/error-codes.ts` - Error codes for API compatibility
- `src/backend-ts/index.ts` - Backend entrypoint (runtime boundary)
- `src/backend-ts/server.ts` - Server composition via layers
- `src/backend-ts/server/server.ts` - HTTP server with scoped resources
- `src/backend-ts/server/router.ts` - HTTP routing via Effect interpreters
- `src/backend-ts/server/route-interpreter.ts` - Central route error handling
- `src/backend-ts/server/routes/*.ts` - All route handlers (Effect-based)
- `src/backend-ts/server/websocket.ts` - WebSocket hub with scoped ownership
- `src/backend-ts/orchestrator.ts` - Main orchestration engine (Effect-native)
- `src/backend-ts/db.ts` - Database with typed errors
- `src/backend-ts/telegram.ts` - Telegram integration (Effect-based)
- `src/backend-ts/runtime/planning-session.ts` - Planning sessions
- `src/backend-ts/runtime/session-manager.ts` - Session management
- `src/backend-ts/runtime/pi-process.ts` - Pi process management
- `src/backend-ts/runtime/container-pi-process.ts` - Container process management
- `src/backend-ts/runtime/container-manager.ts` - Container management
- `src/backend-ts/runtime/container-image-manager.ts` - Container image management
- `src/backend-ts/runtime/global-scheduler.ts` - Task scheduling
- `src/backend-ts/runtime/best-of-n.ts` - Best-of-N execution
- `src/backend-ts/runtime/review-session.ts` - Review sessions
- `src/backend-ts/runtime/smart-repair.ts` - Smart repair service
- `src/backend-ts/runtime/self-healing.ts` - Self-healing service
- `src/backend-ts/runtime/codestyle-session.ts` - Code style sessions
- `src/backend-ts/runtime/worktree.ts` - Git worktree operations

### Frontend Modules (Fully Migrated)

- `src/frontend/src/api/client.ts` - Effect-based HTTP client
- `src/frontend/src/api/*.ts` - All API modules (Effect-based)
- `src/frontend/src/stores/*.ts` - All stores (Effect-based)
- `src/frontend/src/App.tsx` - Main app with Effect boundaries

## Code Standards

When adding new features or modifying existing code:

- [ ] Use `Schema.TaggedError` for all domain errors
- [ ] Return `Effect.Effect<T, E>` from all async operations
- [ ] Use `Effect.gen` for sequential operations
- [ ] Use `Effect.acquireRelease` for resource management
- [ ] Use `Effect.log*` for operational logging
- [ ] Use `Context.GenericTag` for services
- [ ] Only call `Effect.run*` at runtime boundaries
- [ ] Never use `throw new Error` for domain failures
- [ ] Never use `console.log/error/warn` in application code

## Verification

Run the migration verification script:

```bash
bun run scripts/verify-migration.ts
```

This checks:
- No `throw new Error` for domain failures
- No `console.log/error/warn` in application code
- `Effect.run*` only at runtime boundaries
- Proper use of Effect patterns

Run the full test suite:

```bash
bun test tests/*.test.ts
bun run test:effect-migration
```

## Common Migration Patterns

### Converting a Promise-based method

**Before:**
```typescript
async function getUser(id: string): Promise<User> {
  const user = await db.query("SELECT * FROM users WHERE id = ?", [id])
  if (!user) {
    throw new Error("User not found")
  }
  return user
}
```

**After:**
```typescript
function getUser(id: string): Effect.Effect<User, DatabaseError> {
  return Effect.gen(function* () {
    const user = yield* Effect.tryPromise({
      try: () => db.query("SELECT * FROM users WHERE id = ?", [id]),
      catch: (cause) => new DatabaseError({ operation: "getUser", message: String(cause), cause }),
    })
    if (!user) {
      return yield* new DatabaseError({
        operation: "getUser",
        message: `User ${id} not found`,
      })
    }
    return user
  })
}
```

### Converting a class with async methods

**Before:**
```typescript
class UserService {
  constructor(private db: Database) {}

  async createUser(name: string): Promise<User> {
    return await this.db.insert({ name })
  }
}
```

**After:**
```typescript
import { Effect, Context } from "effect"

export interface UserService {
  readonly createUser: (name: string) => Effect.Effect<User, DatabaseError>
}

export const UserService = Context.GenericTag<UserService>("UserService")

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const db = yield* DatabaseContext

    return {
      createUser: (name) => Effect.gen(function* () {
        return yield* Effect.tryPromise({
          try: () => db.insert({ name }),
          catch: (cause) => new DatabaseError({ operation: "createUser", message: String(cause), cause }),
        })
      }),
    }
  })
)
```

## Resources

- Effect Documentation: https://effect.website
- Effect GitHub: https://github.com/Effect-TS/effect
- Migration guides in `~/.local/share/effect-solutions/effect`
