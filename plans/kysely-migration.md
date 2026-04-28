# Kysely Migration Plan

## Overview

Complete migration from `bun:sqlite` to Kysely with full Effect integration. This is a **destructive migration** — no backward compatibility, no old code paths, no migration from existing databases. Fresh start with current schema as canonical baseline. The schema must match **exactly** what is present in `/home/jmarceno/Projects/tmp/TESTS/tauroboros/.tauroboros/tasks.db` (the reference database containing the final pre-migration schema). The `schema_migrations` table must be **excluded** — no migration history, no migration table. The schema DDL is the source of truth.

## Must Follow Rules

1. **Kysely patterns only** — Follow https://kysely.dev/docs/category/recipes and https://kysely-org.github.io/kysely-apidoc/ exactly. Do not invent custom patterns.
2. **No raw SQL** — All queries must use Kysely's query builder (`selectFrom`, `insertInto`, `updateTable`, `deleteFrom`). The only exception is schema DDL in `init.ts` (CREATE TABLE, CREATE INDEX).
3. **No stubs, no bridges, no wraps, no intermediary state** — This is a full, complete migration with no stops or transitional states. Every phase produces final production code.
4. **bun:sqlite must be completely abandoned** — No imports from `bun:sqlite` may remain. The `Database` type from `bun:sqlite` must be fully replaced by Kysely's `Kysely<DatabaseSchema>`.
5. **Effect best practices MUST be followed** — All database operations return `Effect.Effect<T, E>`. Use `Schema.TaggedError` for errors. Use `Context.GenericTag` for service tags. Use `Effect.acquireRelease` for resource management. Use `Effect.gen` for sequential operations. Use `Effect.log*` for logging. No `throw new Error` for domain failures. No `console.log/error/warn` in application code.
6. **No fallbacks** — All conditions and cases must be explicit. If a case is not handled, it must return an explicit `Effect.fail` with a `Schema.TaggedError`.
7. **All errors must be fixed** — Even errors not introduced by this migration. The final validation phase must fix every issue in the codebase.

## Phase Structure

Each phase below is an **independent prompt** for an LLM, executed in a vacuum without knowledge of prior phases. Phases execute in order; each can assume prior phases are complete. Every phase produces final, committed code — no intermediary states.

---

## Phase 1: Dependencies & Schema Infrastructure

### Bigger Goal

This is the foundation phase. It establishes the Kysely-based database infrastructure: dependencies, service tags, error types, schema type definitions, connection layer, and schema initialization. After this phase, the project has Kysely installed and a complete set of type-safe schema interfaces and a connection layer — but nothing uses it yet (the old `PiKanbanDB` still works).

### Must Follow Rules

- Use Kysely's official patterns from https://kysely.dev/docs/getting-started?dialect=sqlite
- Use `better-sqlite3` as the SQLite driver (Kysely's built-in SQLite dialect uses it)
- Use `ColumnType` and `Generated` from Kysely for column type definitions
- Schema DDL must match **exactly** the reference database at `/home/jmarceno/Projects/tmp/TESTS/tauroboros/.tauroboros/tasks.db`
- The `schema_migrations` table from the reference DB must **not** be included — no migration history
- All table and index DDL must be inline in `init.ts` (no separate migration files)
- Use `Schema.TaggedError` from Effect for all error types
- Use `Context.GenericTag` for the DatabaseService
- Use `Effect.acquireRelease` for connection lifecycle
- **No raw SQL** except in the `initializeSchema` DDL
- **No bun:sqlite** — the new code must not import from `bun:sqlite`

### Steps

#### 1.1 Add Dependencies

Add to `package.json`:
```json
{
  "dependencies": {
    "kysely": "^0.28.16",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

Run `bun install` to install the new packages.

#### 1.2 Create `src/backend-ts/services/database.ts` — DatabaseService Tag

Create a service tag for the Kysely instance:

```typescript
import { Context } from "effect"
import { Kysely } from "kysely"
import type { DatabaseSchema } from "../db/schema.ts"

export class DatabaseService extends Context.Tag("Database/DatabaseService")<
  DatabaseService,
  Kysely<DatabaseSchema>
>() {}
```

#### 1.3 Create `src/backend-ts/db/errors.ts` — Tagged Errors

Create Effect `Schema.TaggedError` types for database operations:

- `DatabaseError` — General database error with `operation` (string), `message` (string), `cause` (optional unknown)
- `QueryError` — Query-level error with `sql` (string), `message` (string), `cause` (optional unknown)
- `NotFoundError` — Entity not found with `entity` (string), `id` (string)

All errors use `Schema.TaggedError` pattern from Effect.

#### 1.4 Create `src/backend-ts/db/schema.ts` — Kysely Table Interfaces

Define the `DatabaseSchema` interface and all table interfaces matching the reference database at `/home/jmarceno/Projects/tmp/TESTS/tauroboros/.tauroboros/tasks.db`.

The reference database has these tables (extracted via `.schema`):

1. **tasks** — id (TEXT PK), name (TEXT), idx (INTEGER), prompt (TEXT), branch (TEXT), plan_model (TEXT), execution_model (TEXT), planmode (INTEGER), auto_approve_plan (INTEGER), review (INTEGER), auto_commit (INTEGER), auto_deploy (INTEGER), auto_deploy_condition (TEXT nullable), delete_worktree (INTEGER), status (TEXT), requirements (TEXT JSON), agent_output (TEXT), review_count (INTEGER), json_parse_retry_count (INTEGER), session_id (TEXT nullable), session_url (TEXT nullable), worktree_dir (TEXT nullable), error_message (TEXT nullable), created_at (INTEGER), updated_at (INTEGER), completed_at (INTEGER nullable), thinking_level (TEXT), plan_thinking_level (TEXT), execution_thinking_level (TEXT), execution_phase (TEXT), awaiting_plan_approval (INTEGER), plan_revision_count (INTEGER), execution_strategy (TEXT), best_of_n_config (TEXT nullable JSON), best_of_n_substage (TEXT), skip_permission_asking (INTEGER), max_review_runs_override (INTEGER nullable), smart_repair_hints (TEXT nullable), review_activity (TEXT), is_archived (INTEGER), archived_at (INTEGER nullable), container_image (TEXT nullable), code_style_review (INTEGER), group_id (TEXT nullable), self_heal_status (TEXT), self_heal_message (TEXT nullable), self_heal_report_id (TEXT nullable)

2. **workflow_runs** — id (TEXT PK), kind (TEXT), status (TEXT), display_name (TEXT), target_task_id (TEXT nullable), task_order_json (TEXT), current_task_id (TEXT nullable), current_task_index (INTEGER), pause_requested (INTEGER), stop_requested (INTEGER), error_message (TEXT nullable), created_at (INTEGER), started_at (INTEGER), updated_at (INTEGER), finished_at (INTEGER nullable), is_archived (INTEGER), archived_at (INTEGER nullable), color (TEXT), group_id (TEXT nullable)

3. **workflow_sessions** — id (TEXT PK), task_id (TEXT nullable FK→tasks), task_run_id (TEXT nullable), session_kind (TEXT), status (TEXT), cwd (TEXT), worktree_dir (TEXT nullable), branch (TEXT nullable), pi_session_id (TEXT nullable), pi_session_file (TEXT nullable), process_pid (INTEGER nullable), model (TEXT), thinking_level (TEXT), started_at (INTEGER), updated_at (INTEGER), finished_at (INTEGER nullable), exit_code (INTEGER nullable), exit_signal (TEXT nullable), error_message (TEXT nullable), name (TEXT nullable)

4. **session_messages** — id (INTEGER PK AUTOINCREMENT), seq (INTEGER), message_id (TEXT nullable), session_id (TEXT NOT NULL FK→workflow_sessions), timestamp (INTEGER), role (TEXT), event_name (TEXT nullable), message_type (TEXT), content_json (TEXT), model_provider (TEXT nullable), model_id (TEXT nullable), agent_name (TEXT nullable), prompt_tokens (INTEGER nullable), completion_tokens (INTEGER nullable), cache_read_tokens (INTEGER nullable), cache_write_tokens (INTEGER nullable), total_tokens (INTEGER nullable), cost_json (TEXT nullable), cost_total (REAL nullable), tool_call_id (TEXT nullable), tool_name (TEXT nullable), tool_args_json (TEXT nullable), tool_result_json (TEXT nullable), tool_status (TEXT nullable), edit_diff (TEXT nullable), edit_file_path (TEXT nullable), session_status (TEXT nullable), workflow_phase (TEXT nullable), raw_event_json (TEXT nullable), UNIQUE(session_id, seq)

5. **options** — key (TEXT PK), value (TEXT)

6. **prompt_templates** — id (INTEGER PK AUTOINCREMENT), key (TEXT UNIQUE), name (TEXT), description (TEXT), template_text (TEXT), variables_json (TEXT), is_active (INTEGER), created_at (INTEGER), updated_at (INTEGER)

7. **prompt_template_versions** — id (INTEGER PK AUTOINCREMENT), prompt_template_id (INTEGER FK→prompt_templates), version (INTEGER), template_text (TEXT), variables_json (TEXT), created_at (INTEGER), UNIQUE(prompt_template_id, version)

8. **task_runs** — id (TEXT PK), task_id (TEXT FK→tasks), phase (TEXT), slot_index (INTEGER), attempt_index (INTEGER), model (TEXT), task_suffix (TEXT nullable), status (TEXT), session_id (TEXT nullable), session_url (TEXT nullable), worktree_dir (TEXT nullable), summary (TEXT nullable), error_message (TEXT nullable), candidate_id (TEXT nullable), metadata_json (TEXT), created_at (INTEGER), updated_at (INTEGER), completed_at (INTEGER nullable)

9. **task_candidates** — id (TEXT PK), task_id (TEXT FK→tasks), worker_run_id (TEXT FK→task_runs), status (TEXT), changed_files_json (TEXT), diff_stats_json (TEXT), verification_json (TEXT), summary (TEXT nullable), error_message (TEXT nullable), created_at (INTEGER), updated_at (INTEGER)

10. **planning_prompts** — id (INTEGER PK AUTOINCREMENT), key (TEXT UNIQUE), name (TEXT), description (TEXT), prompt_text (TEXT), is_active (INTEGER), created_at (INTEGER), updated_at (INTEGER)

11. **planning_prompt_versions** — id (INTEGER PK AUTOINCREMENT), planning_prompt_id (INTEGER FK→planning_prompts), version (INTEGER), prompt_text (TEXT), created_at (INTEGER), UNIQUE(planning_prompt_id, version)

12. **container_packages** — id (INTEGER PK AUTOINCREMENT), name (TEXT UNIQUE), category (TEXT), version_constraint (TEXT nullable), install_order (INTEGER), added_at (INTEGER), source (TEXT)

13. **container_builds** — id (INTEGER PK AUTOINCREMENT), status (TEXT), started_at (INTEGER nullable), completed_at (INTEGER nullable), packages_hash (TEXT nullable), error_message (TEXT nullable), image_tag (TEXT nullable), logs (TEXT nullable)

14. **paused_session_states** — session_id (TEXT PK FK→workflow_sessions), task_id (TEXT nullable), task_run_id (TEXT nullable), session_kind (TEXT), cwd (TEXT nullable), worktree_dir (TEXT nullable), branch (TEXT nullable), model (TEXT), thinking_level (TEXT), pi_session_id (TEXT nullable), pi_session_file (TEXT nullable), container_id (TEXT nullable), container_image (TEXT nullable), paused_at (INTEGER), last_prompt (TEXT nullable), execution_phase (TEXT nullable), context_json (TEXT), pause_reason (TEXT nullable)

15. **paused_run_states** — run_id (TEXT PK FK→workflow_runs), kind (TEXT), task_order_json (TEXT), current_task_index (INTEGER), current_task_id (TEXT nullable), target_task_id (TEXT nullable), paused_at (INTEGER), execution_phase (TEXT)

16. **workflow_runs_indicators** — id (TEXT PK FK→workflow_sessions), json_out_fails (TEXT)

17. **task_groups** — id (TEXT PK), name (TEXT), color (TEXT), status (TEXT), created_at (INTEGER), updated_at (INTEGER), completed_at (INTEGER nullable)

18. **task_group_members** — id (INTEGER PK AUTOINCREMENT), group_id (TEXT FK→task_groups), task_id (TEXT FK→tasks), idx (INTEGER), added_at (INTEGER), UNIQUE(group_id, task_id)

19. **self_heal_reports** — id (TEXT PK), run_id (TEXT FK→workflow_runs), task_id (TEXT FK→tasks), task_status (TEXT), error_message (TEXT nullable), diagnostics_summary (TEXT), is_tauroboros_bug (INTEGER), root_cause_json (TEXT), proposed_solution (TEXT), implementation_plan_json (TEXT), confidence (TEXT), external_factors_json (TEXT), source_mode (TEXT), source_path (TEXT nullable), github_url (TEXT), tauroboros_version (TEXT), db_path (TEXT), db_schema_json (TEXT), raw_response (TEXT), created_at (INTEGER), updated_at (INTEGER)

Use Kysely types:
- `Generated<number>` for AUTOINCREMENT integer PKs
- `ColumnType<SelectType, InsertType, UpdateType>` where types differ per operation
- `JSONColumnType<T>` for JSON text columns (see https://kysely.dev/docs/getting-started#types)
- `string | null` for nullable TEXT columns
- `number | null` for nullable INTEGER columns

Also export `Selectable`, `Insertable`, and `Updateable` wrapper types for each table (e.g., `type Task = Selectable<TasksTable>`, `type NewTask = Insertable<TasksTable>`, `type TaskUpdate = Updateable<TasksTable>`).

#### 1.5 Create `src/backend-ts/layers/database.ts` — Connection Layer

Create the `DatabaseLive` layer using `Effect.acquireRelease`:

```typescript
import { Layer, Effect } from "effect"
import { Kysely, SqliteDialect } from "kysely"
import SQLite from "better-sqlite3"
import { DatabaseService } from "../services/database.ts"
import type { DatabaseSchema } from "../db/schema.ts"

export const DatabaseLive = (dbPath: string) =>
  Layer.scoped(
    DatabaseService,
    Effect.acquireRelease(
      Effect.sync(() => {
        const sqlite = new SQLite(dbPath)
        sqlite.pragma("journal_mode = WAL")
        sqlite.pragma("foreign_keys = ON")
        return new Kysely<DatabaseSchema>({
          dialect: new SqliteDialect({ database: sqlite }),
        })
      }),
      (db) =>
        Effect.promise(() => db.destroy().catch(() => undefined))
    )
  )
```

#### 1.6 Create `src/backend-ts/db/init.ts` — Schema Initialization

Create `initializeSchema` that runs the DDL. The DDL must match the reference database **exactly** (every column, every default, every index). The `schema_migrations` table must **not** be created.

This is the **only** place raw SQL is allowed. Use `sql` template tag from Kysely:

```typescript
import { Effect } from "effect"
import { sql } from "kysely"
import { DatabaseService } from "../services/database.ts"
import { DatabaseError } from "./errors.ts"

export const initializeSchema = Effect.gen(function* () {
  const db = yield* DatabaseService

  yield* Effect.tryPromise({
    try: () => sql`CREATE TABLE IF NOT EXISTS tasks (...full DDL...)`.execute(db),
    catch: (cause) => new DatabaseError({ operation: "initializeSchema", message: String(cause), cause }),
  })

  // ... all tables and indexes

  yield* Effect.log("Database schema initialized")
})
```

Include ALL indexes from the reference database. Do NOT create the `schema_migrations` table.

#### 1.7 Create `src/backend-ts/db/index.ts` — Barrel Exports

Re-export everything from the new db module:
- `DatabaseService` from `../services/database.ts`
- All error types from `./errors.ts`
- All schema types from `./schema.ts`
- `initializeSchema` from `./init.ts`
- `DatabaseLive` from `../layers/database.ts`

#### 1.8 Update `src/backend-ts/db/index.ts` (the existing barrel file)

The existing `src/backend-ts/db/index.ts` currently re-exports `PiKanbanDB` from `../db.ts`. **Do not remove this yet** — Phase 5 handles removal. For this phase, add the new exports alongside the existing ones. The old `PiKanbanDB` still works for now.

#### 1.9 Verification

- Run `bun run compile` to verify the code compiles
- Run `bun test tests/db.test.ts` to verify existing DB tests still pass (they use the old PiKanbanDB)
- No existing functionality should break — this phase only adds new files and dependencies

---

## Phase 2: Repository Implementation — All Entities

### Bigger Goal

Implement the complete repository layer using Kysely's query builder. Every table gets a repository module with full CRUD operations wrapped in Effect. After this phase, every database operation exists as an Effect-based function using Kysely, but nothing calls them yet (the old `PiKanbanDB` class methods are still what consumers use).

### Must Follow Rules

- **No raw SQL** — All queries use Kysely's query builder: `selectFrom`, `insertInto`, `updateTable`, `deleteFrom`, `.where()`, `.orderBy()`, `.execute()`, `.executeTakeFirst()`, `.executeTakeFirstOrThrow()`, `.returningAll()`, `.returning()`
- All functions return `Effect.Effect<T, DatabaseError | NotFoundError>`
- All functions use `Effect.gen(function* () { const db = yield* DatabaseService })`
- All `try/catch` blocks use `Effect.tryPromise` with `catch` mapping to `DatabaseError`
- Use `Effect.tryPromise` (not `Effect.try`) since Kysely returns Promises
- **No fallbacks** — if a row is not found, return `yield* new NotFoundError(...)` explicitly
- **No stubs** — every repository must have full CRUD matching the current `PiKanbanDB` methods
- Follow Kysely's repository pattern from https://kysely.dev/docs/getting-started#querying
- Import `DatabaseService` from `../../services/database.ts`
- Import errors from `../errors.ts`
- Import schema types from `../schema.ts`

### Repository Files to Create

All repositories go in `src/backend-ts/db/repositories/`. Create them in dependency order:

#### 2.1 `src/backend-ts/db/repositories/options-repository.ts`

- `getAll()` → `Effect.Effect<OptionsTable[], DatabaseError>`
- `updateOptions(partial: Partial<OptionsTable>)` → `Effect.Effect<void, DatabaseError>`
- `getOption(key: string)` → `Effect.Effect<OptionsTable | undefined, DatabaseError>`

#### 2.2 `src/backend-ts/db/repositories/prompt-repository.ts`

- `getPromptTemplate(key: string)` → `Effect.Effect<PromptTemplatesTable | undefined, DatabaseError>`
- `upsertPromptTemplate(input)` → `Effect.Effect<PromptTemplatesTable, DatabaseError>`
- `getPromptTemplateVersions(templateId: number)` → `Effect.Effect<PromptTemplateVersionsTable[], DatabaseError>`
- `createPromptTemplateVersion(input)` → `Effect.Effect<PromptTemplateVersionsTable, DatabaseError>`
- `renderPrompt(key: string, variables: Record<string, string>)` → `Effect.Effect<string, DatabaseError>`

#### 2.3 `src/backend-ts/db/repositories/planning-prompt-repository.ts`

- `getPlanningPrompt(key: string)` → `Effect.Effect<PlanningPromptsTable | undefined, DatabaseError>`
- `upsertPlanningPrompt(input)` → `Effect.Effect<PlanningPromptsTable, DatabaseError>`
- `getPlanningPromptVersions(promptId: number)` → `Effect.Effect<PlanningPromptVersionsTable[], DatabaseError>`
- `createPlanningPromptVersion(input)` → `Effect.Effect<PlanningPromptVersionsTable, DatabaseError>`

#### 2.4 `src/backend-ts/db/repositories/container-repository.ts`

- `getContainerPackages()` → `Effect.Effect<ContainerPackagesTable[], DatabaseError>`
- `addContainerPackage(input)` → `Effect.Effect<ContainerPackagesTable, DatabaseError>`
- `removeContainerPackage(id: number)` → `Effect.Effect<void, DatabaseError>`
- `createContainerBuild(input)` → `Effect.Effect<ContainerBuildsTable, DatabaseError>`
- `updateContainerBuild(id: number, input)` → `Effect.Effect<void, DatabaseError>`
- `getContainerBuilds()` → `Effect.Effect<ContainerBuildsTable[], DatabaseError>`

#### 2.5 `src/backend-ts/db/repositories/task-group-repository.ts`

- `getAll()` → `Effect.Effect<TaskGroupsTable[], DatabaseError>`
- `getById(id: string)` → `Effect.Effect<TaskGroupsTable, NotFoundError | DatabaseError>`
- `create(input)` → `Effect.Effect<TaskGroupsTable, DatabaseError>`
- `update(id: string, input)` → `Effect.Effect<TaskGroupsTable, NotFoundError | DatabaseError>`
- `remove(id: string)` → `Effect.Effect<void, DatabaseError>`
- `addTasksToGroup(groupId: string, taskIds: string[])` → `Effect.Effect<void, DatabaseError>`
- `removeTasksFromGroup(groupId: string, taskIds: string[])` → `Effect.Effect<void, DatabaseError>`
- `getGroupMembers(groupId: string)` → `Effect.Effect<TaskGroupMembersTable[], DatabaseError>`

#### 2.6 `src/backend-ts/db/repositories/task-repository.ts`

- `getAll()` → `Effect.Effect<TasksTable[], DatabaseError>`
- `getById(id: string)` → `Effect.Effect<TasksTable, NotFoundError | DatabaseError>`
- `create(input)` → `Effect.Effect<TasksTable, DatabaseError>`
- `update(id: string, input)` → `Effect.Effect<TasksTable, NotFoundError | DatabaseError>`
- `remove(id: string)` → `Effect.Effect<void, DatabaseError>`
- `archive(id: string)` → `Effect.Effect<void, NotFoundError | DatabaseError>`
- `reorder(id: string, newIdx: number)` → `Effect.Effect<void, NotFoundError | DatabaseError>`
- `getByStatus(status: string)` → `Effect.Effect<TasksTable[], DatabaseError>`
- `getByGroupId(groupId: string)` → `Effect.Effect<TasksTable[], DatabaseError>`

#### 2.7 `src/backend-ts/db/repositories/workflow-run-repository.ts`

- `getAll()` → `Effect.Effect<WorkflowRunsTable[], DatabaseError>`
- `getById(id: string)` → `Effect.Effect<WorkflowRunsTable, NotFoundError | DatabaseError>`
- `create(input)` → `Effect.Effect<WorkflowRunsTable, DatabaseError>`
- `update(id: string, input)` → `Effect.Effect<WorkflowRunsTable, NotFoundError | DatabaseError>`
- `archive(id: string)` → `Effect.Effect<void, NotFoundError | DatabaseError>`

#### 2.8 `src/backend-ts/db/repositories/session-repository.ts`

- `getById(id: string)` → `Effect.Effect<WorkflowSessionsTable, NotFoundError | DatabaseError>`
- `create(input)` → `Effect.Effect<WorkflowSessionsTable, DatabaseError>`
- `update(id: string, input)` → `Effect.Effect<WorkflowSessionsTable, NotFoundError | DatabaseError>`
- `getByTaskId(taskId: string)` → `Effect.Effect<WorkflowSessionsTable[], DatabaseError>`
- `getByStatus(status: string)` → `Effect.Effect<WorkflowSessionsTable[], DatabaseError>`

#### 2.9 `src/backend-ts/db/repositories/message-repository.ts`

- `getBySessionId(sessionId: string)` → `Effect.Effect<SessionMessagesTable[], DatabaseError>`
- `create(input)` → `Effect.Effect<SessionMessagesTable, DatabaseError>`
- `update(id: number, input)` → `Effect.Effect<SessionMessagesTable, NotFoundError | DatabaseError>`
- `getBySessionIdAndSeq(sessionId: string, seq: number)` → `Effect.Effect<SessionMessagesTable | undefined, DatabaseError>`

#### 2.10 `src/backend-ts/db/repositories/task-run-repository.ts`

- `getByTaskId(taskId: string)` → `Effect.Effect<TaskRunsTable[], DatabaseError>`
- `getById(id: string)` → `Effect.Effect<TaskRunsTable, NotFoundError | DatabaseError>`
- `create(input)` → `Effect.Effect<TaskRunsTable, DatabaseError>`
- `update(id: string, input)` → `Effect.Effect<TaskRunsTable, NotFoundError | DatabaseError>`

#### 2.11 `src/backend-ts/db/repositories/task-candidate-repository.ts`

- `getByTaskId(taskId: string)` → `Effect.Effect<TaskCandidatesTable[], DatabaseError>`
- `getById(id: string)` → `Effect.Effect<TaskCandidatesTable, NotFoundError | DatabaseError>`
- `create(input)` → `Effect.Effect<TaskCandidatesTable, DatabaseError>`
- `update(id: string, input)` → `Effect.Effect<TaskCandidatesTable, NotFoundError | DatabaseError>`

#### 2.12 `src/backend-ts/db/repositories/paused-state-repository.ts`

- `saveSessionState(state: PausedSessionStatesTable)` → `Effect.Effect<void, DatabaseError>`
- `loadSessionState(sessionId: string)` → `Effect.Effect<PausedSessionStatesTable | undefined, DatabaseError>`
- `deleteSessionState(sessionId: string)` → `Effect.Effect<void, DatabaseError>`
- `saveRunState(state: PausedRunStatesTable)` → `Effect.Effect<void, DatabaseError>`
- `loadRunState(runId: string)` → `Effect.Effect<PausedRunStatesTable | undefined, DatabaseError>`
- `deleteRunState(runId: string)` → `Effect.Effect<void, DatabaseError>`

#### 2.13 `src/backend-ts/db/repositories/indicators-repository.ts`

- `getById(id: string)` → `Effect.Effect<WorkflowRunsIndicatorsTable | undefined, DatabaseError>`
- `upsert(id: string, jsonOutFails: string)` → `Effect.Effect<void, DatabaseError>`

#### 2.14 `src/backend-ts/db/repositories/self-heal-repository.ts`

- `getById(id: string)` → `Effect.Effect<SelfHealReportsTable, NotFoundError | DatabaseError>`
- `getByRunId(runId: string)` → `Effect.Effect<SelfHealReportsTable[], DatabaseError>`
- `create(input)` → `Effect.Effect<SelfHealReportsTable, DatabaseError>`

#### 2.15 `src/backend-ts/db/repositories/index.ts`

Barrel file that re-exports all repositories.

#### 2.16 Verification

- Run `bun run compile` — must compile without errors
- No existing tests are affected since nothing uses these repositories yet

---

## Phase 3: Data Transformation Layer

### Bigger Goal

Create the type mapping layer that transforms between Kysely DB row types (snake_case, 0/1 integers, JSON strings) and domain types (camelCase, booleans, parsed JSON). These are pure functions — no Effect needed. After this phase, there is a complete pipeline from DB to domain and back.

### Must Follow Rules

- All mappers are pure functions, not Effects
- Boolean fields stored as INTEGER (0/1) in SQLite must be converted to/from `boolean`
- JSON fields stored as TEXT must be parsed/stringified
- Timestamps are Unix epoch seconds (number) — consistent with current schema
- Nullable fields must be handled explicitly (no fallbacks)
- Every field must be mapped — no partial mapping
- Use `ColumnType` from Kysely for the schema types, but the mappers handle runtime conversion
- `JSONColumnType<T>` from Kysely is the type-level marker; runtime parsing is in mappers

### Steps

#### 3.1 Create `src/backend-ts/db/transforms.ts` — JSON Column Helpers

```typescript
export const parseJSON = <T>(value: string | null): T | null => {
  if (!value) return null
  try { return JSON.parse(value) as T }
  catch { return null }
}

export const stringifyJSON = <T>(value: T | null): string | null => {
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

// Boolean conversion
export const toBool = (value: number): boolean => value === 1
export const fromBool = (value: boolean): number => value ? 1 : 0

// Optional boolean (nullable column)
export const toBoolNullable = (value: number | null): boolean | null =>
  value === null ? null : value === 1
export const fromBoolNullable = (value: boolean | null): number | null =>
  value === null ? null : value ? 1 : 0
```

#### 3.2 Create `src/backend-ts/db/mappers/task-mapper.ts`

- `toTask(row: TasksTable): Task` — Maps from DB row (snake_case, 0/1) to domain type (camelCase, boolean). Every field must be mapped explicitly.
- `fromTaskInput(input: Partial<Task>): Partial<TasksTable>` — Maps from domain to DB. Conditional mapping.
- `fromNewTask(input: NewTask): Insertable<TasksTable>` — Maps insert input.

#### 3.3 Create `src/backend-ts/db/mappers/workflow-run-mapper.ts`

- `toWorkflowRun(row: WorkflowRunsTable): WorkflowRun`
- `fromWorkflowRunInput(input: Partial<WorkflowRun>): Partial<WorkflowRunsTable>`
- Handle `task_order_json` ↔ `taskOrder` (JSON array)

#### 3.4 Create `src/backend-ts/db/mappers/session-mapper.ts`

- `toWorkflowSession(row: WorkflowSessionsTable): WorkflowSession`
- `fromWorkflowSessionInput(input: Partial<WorkflowSession>): Partial<WorkflowSessionsTable>`

#### 3.5 Create `src/backend-ts/db/mappers/message-mapper.ts`

- `toSessionMessage(row: SessionMessagesTable): SessionMessage`
- Handle JSON fields: `content_json`, `cost_json`, `tool_args_json`, `tool_result_json`, `raw_event_json`

#### 3.6 Create `src/backend-ts/db/mappers/task-run-mapper.ts`

- `toTaskRun(row: TaskRunsTable): TaskRun`
- Handle `metadata_json` ↔ `metadataJson` (Record)

#### 3.7 Create `src/backend-ts/db/mappers/task-candidate-mapper.ts`

- `toTaskCandidate(row: TaskCandidatesTable): TaskCandidate`
- Handle JSON fields: `changed_files_json`, `diff_stats_json`, `verification_json`

#### 3.8 Create `src/backend-ts/db/mappers/self-heal-mapper.ts`

- `toSelfHealReport(row: SelfHealReportsTable): SelfHealReport`
- Handle JSON fields: `root_cause_json`, `implementation_plan_json`, `external_factors_json`, `db_schema_json`

#### 3.9 Create `src/backend-ts/db/mappers/index.ts`

Barrel file re-exporting all mappers.

#### 3.10 Verification

- Run `bun run compile` — must compile without errors
- Mappers are pure functions, trivially testable

---

## Phase 4: Consumer Updates — Replace PiKanbanDB Usage

### Bigger Goal

This is the largest phase. Every file that currently imports and uses `PiKanbanDB` must be updated to use the new Kysely-based repositories via Effect's dependency injection. The `DatabaseContext` tag must be updated to use `DatabaseService` (Kysely instance) instead of `PiKanbanDB`. All runtime classes, orchestrator, server, and recovery code must be migrated.

### Must Follow Rules

- **No bun:sqlite** — no file may import `Database` from `bun:sqlite` after this phase
- **No PiKanbanDB** — no file may reference `PiKanbanDB` after this phase
- **Effect first** — all database access uses `yield* DatabaseService` (the Kysely instance) and repository functions
- **No intermediary state** — every file is fully migrated, not partially
- Follow the Effect architecture patterns from `docs/EFFECT_ARCHITECTURE.md`
- Use `Effect.gen(function* () { const db = yield* DatabaseService })` to access the Kysely instance
- Repository functions are called directly: `yield* getAllTasks()`, not through a class
- All errors use `Schema.TaggedError` — no `throw new Error`
- No fallbacks — every case is explicit

### Steps

#### 4.1 Update `src/backend-ts/shared/services.ts`

- Change `DatabaseContext` from `Context.GenericTag<PiKanbanDB>` to `Context.GenericTag<Kysely<DatabaseSchema>>` (or just re-export `DatabaseService` from `../services/database.ts`)
- Update `ServerRuntimeContext` to use the new `DatabaseService` type

#### 4.2 Update `src/backend-ts/server.ts` (main server entry)

- Replace `new PiKanbanDB(dbPath)` with `DatabaseLive(dbPath)` layer
- Wire up `DatabaseService` layer to the application
- Remove `PiKanbanDB` import

#### 4.3 Update `src/backend-ts/server/server.ts`

- Replace `PiKanbanDB` usage with `DatabaseService` (Kysely instance via Effect context)
- Update route handler construction to use repository functions

#### 4.4 Update `src/backend-ts/server/types.ts`

- Change `RequestContext.db` type from `PiKanbanDB` to `Kysely<DatabaseSchema>`

#### 4.5 Update all route files in `src/backend-ts/server/routes/`

Each route file currently accesses `db` through the request context. Update to use repository functions and `DatabaseService`.

Files to update:
- `src/backend-ts/server/routes/task-group-routes.ts`

#### 4.6 Update `src/backend-ts/runtime/session-manager.ts`

- Replace `db: PiKanbanDB` constructor parameter with Effect-based access to repositories
- Convert methods to `Effect.Effect<T, E>` return types

#### 4.7 Update `src/backend-ts/runtime/pi-process.ts`

- Replace `db: PiKanbanDB` with repository access
- Convert to Effect patterns

#### 4.8 Update `src/backend-ts/runtime/container-pi-process.ts`



#### 4.9 Update `src/backend-ts/runtime/review-session.ts`



#### 4.10 Update `src/backend-ts/runtime/message-streamer.ts`



#### 4.11 Update `src/backend-ts/runtime/codestyle-session.ts`



#### 4.12 Update `src/backend-ts/runtime/self-healing.ts`



#### 4.13 Update `src/backend-ts/runtime/smart-repair.ts`



#### 4.14 Update `src/backend-ts/runtime/planning-session.ts`



#### 4.15 Update `src/backend-ts/runtime/pi-process-factory.ts`



#### 4.16 Update `src/backend-ts/runtime/session-pause-state.ts`



#### 4.17 Update `src/backend-ts/runtime/best-of-n.ts`



#### 4.18 Update `src/backend-ts/orchestrator.ts`



#### 4.19 Update `src/backend-ts/orchestrator/auto-deploy.ts`



#### 4.20 Update `src/backend-ts/orchestrator/self-healing.ts`



#### 4.21 Update `src/backend-ts/orchestrator/clean-run.ts`



#### 4.22 Update `src/backend-ts/recovery/startup-recovery.ts`



#### 4.23 Update `src/backend-ts/db/index.ts` (barrel file)

Replace the old re-exports (`PiKanbanDB` from `../db.ts`) with the new re-exports from `./repositories/index.ts`, `./mappers/index.ts`, `./schema.ts`, `./errors.ts`, `./init.ts`, and `../services/database.ts`, `../layers/database.ts`.

#### 4.24 Verification

- Run `bun run compile` — must compile without errors
- There should be zero references to `PiKanbanDB` or `bun:sqlite` in `src/` after this phase
- `bun test` will likely fail (tests still use old patterns) — that's expected, Phase 6 handles tests

---

## Phase 5: Code Removal & Cleanup

### Bigger Goal

Remove all vestiges of the old `bun:sqlite`-based database layer. Delete the old files, remove `bun:sqlite` from the dependency graph, and clean up any remaining references. After this phase, the codebase is fully Kysely-based with zero legacy code paths.

### Must Follow Rules

- **No bun:sqlite imports** anywhere in the codebase
- **No PiKanbanDB** class or references
- **No migration files** — all removed
- **No stats-repository** using bun:sqlite types
- Verify with `rg "bun:sqlite" src/` — must return zero matches
- Verify with `rg "PiKanbanDB" src/` — must return zero matches

### Steps

#### 5.1 Delete `src/backend-ts/db.ts`

The main `PiKanbanDB` class file. All its functionality has been replaced by repositories.

#### 5.2 Delete `src/backend-ts/db/migrations.ts`

All 33 migrations. The schema is now the source of truth via `init.ts`.

#### 5.3 Delete `src/backend-ts/db/stats-repository.ts`

Stats queries. If stats functionality is needed, it should be re-implemented as a repository in Phase 4. Verify nothing outside `src/backend-ts/db.ts` imports from `stats-repository.ts`.

#### 5.4 Clean up `src/backend-ts/types.ts`

Remove any types that were only used by the old `PiKanbanDB`. Keep domain types that are still referenced by mappers and application code. The domain types (`Task`, `WorkflowRun`, etc.) should remain — they're used by the mappers.

#### 5.5 Remove `bun-types` if no longer needed

Check if `bun-types` is still needed. If `bun:sqlite` was the only reason for `bun-types`, it can be removed. However, `bun-types` may be needed for other Bun APIs.

#### 5.6 Verify no remaining references

```bash
rg "bun:sqlite" src/ --no-filename  # should be empty
rg "PiKanbanDB" src/ --no-filename  # should be empty
rg "from.*db\.ts\b" src/ --no-filename  # should be empty (old barrel import)
```

#### 5.7 Verification

- `bun run compile` — must compile without errors
- Zero references to `PiKanbanDB` or `bun:sqlite` in `src/`

---

## Phase 6: Test Updates

### Bigger Goal

Update all test files that use `PiKanbanDB` or `bun:sqlite` to use the new Kysely-based repositories. Tests must create a real SQLite database using the new infrastructure, initialize the schema, and use repository functions for test setup/verification.

### Must Follow Rules

- All tests must use the new `DatabaseLive` layer and `initializeSchema`
- No test may import from `bun:sqlite`
- No test may reference `PiKanbanDB`
- Test helpers for creating test DBs must use the new infrastructure
- Test fixtures must use repository functions, not raw `db.prepare()`

### Steps

#### 6.1 Create `tests/helpers/database.ts`

Create a test helper that:
- Creates a temporary SQLite database file
- Uses `DatabaseLive` layer to create a Kysely instance
- Runs `initializeSchema`
- Returns the `Kysely<DatabaseSchema>` instance
- Cleans up after the test

```typescript
import { Effect, Layer, Scope } from "effect"
import { DatabaseService } from "../../src/backend-ts/services/database.ts"
import { DatabaseLive } from "../../src/backend-ts/layers/database.ts"
import { initializeSchema } from "../../src/backend-ts/db/init.ts"
import { tmpdir } from "os"
import { randomUUID } from "crypto"
import { join } from "path"

export const createTestDb = Effect.gen(function* () {
  const dbPath = join(tmpdir(), `test-${randomUUID()}.db`)
  const db = yield* DatabaseLive(dbPath).pipe(
    Layer.build,
    Effect.andThen(DatabaseService)
  )
  yield* initializeSchema.pipe(Effect.provideService(DatabaseService, db))
  return { db, dbPath }
})
```

#### 6.2 Update `tests/db.test.ts`

Replace all `PiKanbanDB` usage with repository functions and the new test helper.

#### 6.3 Update `tests/execution.test.ts`



#### 6.4 Update `tests/orchestration.test.ts`



#### 6.5 Update `tests/review-loop.test.ts`



#### 6.6 Update `tests/best-of-n.test.ts`



#### 6.7 Update `tests/smart-repair.test.ts`



#### 6.8 Update `tests/codestyle-session.test.ts`



#### 6.9 Update `tests/code-style-orchestrator-integration.test.ts`



#### 6.10 Update `tests/prompts.test.ts`



#### 6.11 Update `tests/startup-recovery.test.ts`



#### 6.12 Update `tests/orchestrator-stale-running.test.ts`



#### 6.13 Update `tests/group-execution.test.ts`



#### 6.14 Update `tests/archived-api.test.ts`



#### 6.15 Verification

- `bun run compile` — must compile without errors
- `bun test` — all tests must pass

---

## Phase 7: Validation & Hardening

### Bigger Goal

This is the final quality assurance phase. Run **all** tests, fix **every** failure. Fix **all** TypeScript compiler errors and warnings. Fix **every** issue found, whether related to this migration or not. The codebase must be in a fully working state with zero errors, zero warnings, and zero test failures.

### Hard Requirements

1. **Run ALL tests** — `bun test` (and any other test commands found in `package.json`)
2. **Fix ALL test failures** — every failing test must be fixed
3. **Fix ALL tsc errors and warnings** — `bun run compile` or `bunx tsc --noEmit` must produce zero errors and zero warnings
4. **Fix ALL issues found** — any issue discovered during testing, whether related to the Kysely migration or pre-existing, must be fixed. We are a team and we work on all issues together.
5. **No bun:sqlite references** — `rg "bun:sqlite"` must return zero matches across the entire codebase
6. **No PiKanbanDB references** — `rg "PiKanbanDB"` must return zero matches across the entire codebase
7. **Effect best practices** — verify with `bun run scripts/verify-migration.ts` (or equivalent) that Effect patterns are followed
8. **No fallbacks** — all conditions and cases are explicit, no implicit fallthrough

### Steps

#### 7.1 Run the full test suite

```bash
bun test 2>&1 | tee /tmp/test-results.log
```

#### 7.2 Run TypeScript compiler check

```bash
bun run compile 2>&1 | tee /tmp/tsc-results.log
```

#### 7.3 Run migration verification script

```bash
bun run scripts/verify-migration.ts 2>&1 | tee /tmp/verify-results.log
```

#### 7.4 Fix ALL issues

For each issue found:
1. Determine the root cause
2. Fix the code
3. Re-run the relevant check
4. Repeat until zero issues

Issues to fix include (but are not limited to):
- Test failures (assertions, setup, teardown)
- TypeScript type errors
- TypeScript `@ts-ignore` or `@ts-expect-error` comments that are no longer needed
- Import errors or circular dependencies
- Runtime errors (null pointer, undefined access, etc.)
- Effect pattern violations (`throw new Error`, `console.log`, etc.)
- Missing error handling cases
- Incorrect Kysely query patterns
- Incorrect mapper conversions

#### 7.5 Verify no remaining references

```bash
rg "bun:sqlite" --type ts
rg "PiKanbanDB" --type ts
rg "from.*db\.ts\"" --type ts  # old import path
```

All must return zero matches.

#### 7.6 Final verification

```bash
bun run compile
bun test
```

Both must pass with zero errors and zero warnings.

---

## Dependencies to Add

```json
{
  "dependencies": {
    "kysely": "^0.28.16",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

## Notes

- All queries use Kysely's query builder, no raw SQL except schema DDL in `init.ts`
- All database operations return `Effect.Effect<T, DatabaseError | NotFoundError>`
- Resource management via `Effect.acquireRelease` ensures connection cleanup
- JSON columns stored as strings in SQLite, parsed in application layer via mappers
- Boolean fields stored as integers (0/1) in SQLite, converted in mappers
- Timestamps stored as Unix epoch seconds (consistent with current schema)
- Foreign key constraints enabled via SQLite PRAGMA in connection layer
- WAL mode enabled via SQLite PRAGMA in connection layer
- No migration table — fresh start, schema DDL is the source of truth
- The `schema_migrations` table from the reference DB is intentionally excluded
- `bun:sqlite` must be fully abandoned — no imports, no references, no types