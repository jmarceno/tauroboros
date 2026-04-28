import type { PiSessionKind } from "../db/types.ts"
import type { PiKanbanDB } from "../db.ts"
import type { RunExecutionPhase } from "../types.ts"
import { Effect, Schema } from "effect"

export class PausedSessionStateError extends Schema.TaggedError<PausedSessionStateError>()("PausedSessionStateError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

type DbPausedSessionState = NonNullable<ReturnType<PiKanbanDB["loadPausedSessionState"]>>

function mapDbPausedSessionState(
  dbState: DbPausedSessionState,
  operation: string,
): Effect.Effect<PausedSessionState, PausedSessionStateError> {
  return Effect.gen(function* () {
    const cwd = dbState.cwd ?? dbState.worktreeDir
    if (!cwd) {
      return yield* new PausedSessionStateError({
        operation,
        message: `Paused session ${dbState.sessionId} is missing both cwd and worktreeDir`,
      })
    }

    return {
      sessionId: dbState.sessionId,
      taskId: dbState.taskId,
      taskRunId: dbState.taskRunId,
      sessionKind: dbState.sessionKind as PiSessionKind,
      cwd,
      worktreeDir: dbState.worktreeDir,
      branch: dbState.branch,
      model: dbState.model,
      thinkingLevel: dbState.thinkingLevel,
      lastPrompt: dbState.lastPrompt,
      lastPromptTimestamp: dbState.pausedAt,
      containerId: dbState.containerId,
      containerName: null,
      containerImage: dbState.containerImage,
      piSessionId: dbState.piSessionId,
      piSessionFile: dbState.piSessionFile,
      context: dbState.context,
      executionPhase: dbState.executionPhase,
      pauseReason: dbState.pauseReason,
    }
  })
}

/**
 * Context captured when pausing a session for richer resume
 */
export interface PausedSessionContext {
  agentOutputSnapshot: string | null
  pendingToolCalls: unknown[] | null
  reviewCount: number
}

/**
 * Paused session state - persisted to database only for resume across server restarts
 * Strictly uses database storage for ACID guarantees and referential integrity.
 */
export interface PausedSessionState {
  sessionId: string
  taskId: string | null
  taskRunId: string | null
  sessionKind: PiSessionKind
  cwd: string | null
  worktreeDir: string | null
  branch: string | null
  model: string
  thinkingLevel: string
  lastPrompt: string | null
  lastPromptTimestamp: number
  containerId: string | null
  containerName: string | null
  containerImage: string | null
  piSessionId: string | null
  piSessionFile: string | null
  context: PausedSessionContext | null
  /**
   * Execution phase when paused (e.g., "executing", "reviewing")
   */
  executionPhase?: string | null
  /**
   * Reason for pausing (e.g., "user_pause", "server_shutdown")
   */
  pauseReason?: string | null
}

/**
 * Save paused state for a session to the database.
 * Uses database storage only for ACID guarantees and referential integrity.
 */
export function savePausedSessionState(
  db: PiKanbanDB,
  state: PausedSessionState
): void {
  db.savePausedSessionState({
    sessionId: state.sessionId,
    taskId: state.taskId,
    taskRunId: state.taskRunId,
    sessionKind: state.sessionKind,
    cwd: state.cwd,
    worktreeDir: state.worktreeDir,
    branch: state.branch,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    piSessionId: state.piSessionId,
    piSessionFile: state.piSessionFile,
    containerId: state.containerId,
    containerImage: state.containerImage,
    pausedAt: state.lastPromptTimestamp,
    lastPrompt: state.lastPrompt,
    executionPhase: state.executionPhase ?? null,
    context: state.context ?? {
      agentOutputSnapshot: null,
      pendingToolCalls: null,
      reviewCount: 0,
    },
    pauseReason: state.pauseReason ?? null,
  })
}

/**
 * Load paused state for a session from the database.
 */
export function loadPausedSessionState(
  db: PiKanbanDB,
  sessionId: string
): Effect.Effect<PausedSessionState | null, PausedSessionStateError> {
  return Effect.gen(function* () {
    const dbState = db.loadPausedSessionState(sessionId)
    if (!dbState) {
      return null
    }

    return yield* mapDbPausedSessionState(dbState, "loadPausedSessionState")
  })
}

/**
 * Clear paused state for a session from the database.
 */
export function clearPausedSessionState(
  db: PiKanbanDB,
  sessionId: string
): void {
  db.clearPausedSessionState(sessionId)
}

/**
 * List all paused sessions from the database.
 */
export function listPausedSessions(db: PiKanbanDB): Effect.Effect<PausedSessionState[], PausedSessionStateError> {
  return Effect.forEach(
    db.listPausedSessions(),
    (dbState) => mapDbPausedSessionState(dbState, "listPausedSessions"),
    { concurrency: 1 },
  )
}

/**
 * Get paused sessions for a specific task from the database.
 */
export function getPausedSessionsByTask(
  db: PiKanbanDB,
  taskId: string
): Effect.Effect<PausedSessionState[], PausedSessionStateError> {
  return Effect.forEach(
    db.getPausedSessionsByTask(taskId),
    (dbState) => mapDbPausedSessionState(dbState, "getPausedSessionsByTask"),
    { concurrency: 1 },
  )
}

/**
 * Clear all paused session states from the database.
 */
export function clearAllPausedSessionStates(db: PiKanbanDB): void {
  db.clearAllPausedSessionStates()
}

/**
 * Paused run state - tracks the entire workflow run pause state.
 * Stored in the database for ACID guarantees and consistency with session-level state.
 */
export interface PausedRunState {
  runId: string
  kind: "all_tasks" | "single_task" | "workflow_review" | "group_tasks"
  taskOrder: string[]
  currentTaskIndex: number
  currentTaskId: string | null
  targetTaskId: string | null
  pausedAt: number
  sessions: PausedSessionState[]
  executionPhase: RunExecutionPhase
}

/**
 * Save paused run state to database.
 */
export function savePausedRunState(state: PausedRunState, db: PiKanbanDB): void {
  db.savePausedRunState({
    runId: state.runId,
    kind: state.kind,
    taskOrder: state.taskOrder,
    currentTaskIndex: state.currentTaskIndex,
    currentTaskId: state.currentTaskId,
    targetTaskId: state.targetTaskId,
    pausedAt: state.pausedAt,
    executionPhase: state.executionPhase,
  })
}

/**
 * Load paused run state from database.
 */
export function loadPausedRunState(
  runId: string,
  db: PiKanbanDB,
): Effect.Effect<PausedRunState | null, PausedSessionStateError> {
  return Effect.gen(function* () {
    const dbState = db.loadPausedRunState(runId)
    if (!dbState) {
      return null
    }

    const pausedSessions = yield* listPausedSessions(db).pipe(
      Effect.map((sessions) =>
        sessions.filter((session) => session.taskId !== null && dbState.taskOrder.includes(session.taskId)),
      ),
    )

    return {
      runId: dbState.runId,
      kind: dbState.kind,
      taskOrder: dbState.taskOrder,
      currentTaskIndex: dbState.currentTaskIndex,
      currentTaskId: dbState.currentTaskId,
      targetTaskId: dbState.targetTaskId,
      pausedAt: dbState.pausedAt,
      sessions: pausedSessions,
      executionPhase: dbState.executionPhase,
    }
  })
}

/**
 * Clear paused run state from database.
 */
export function clearPausedRunState(runId: string, db: PiKanbanDB): void {
  db.clearPausedRunState(runId)
}

/**
 * Check if there's a paused run state in the database.
 */
export function hasPausedRunState(runId: string, db: PiKanbanDB): boolean {
  return db.hasPausedRunState(runId)
}

/**
 * List all paused run states from database.
 */
export function listPausedRunStates(db: PiKanbanDB): Effect.Effect<PausedRunState[], PausedSessionStateError> {
  return Effect.gen(function* () {
    const dbStates = db.listPausedRunStates()
    const pausedSessions = yield* listPausedSessions(db)

    return dbStates.map((dbState) => ({
      runId: dbState.runId,
      kind: dbState.kind,
      taskOrder: dbState.taskOrder,
      currentTaskIndex: dbState.currentTaskIndex,
      currentTaskId: dbState.currentTaskId,
      targetTaskId: dbState.targetTaskId,
      pausedAt: dbState.pausedAt,
      sessions: pausedSessions.filter(
        (session) => session.taskId !== null && dbState.taskOrder.includes(session.taskId),
      ),
      executionPhase: dbState.executionPhase,
    }))
  })
}

/**
 * Session pause state manager - tracks individual session pause info in memory.
 * This is kept in memory during runtime for quick access.
 * For persisted state, use the database methods above.
 */
export class SessionPauseStateManager {
  private pausedSessions = new Map<string, PausedSessionState>()

  /**
   * Register a session that can be paused
   */
  registerSession(state: PausedSessionState): void {
    this.pausedSessions.set(state.sessionId, state)
  }

  /**
   * Get pause state for a session
   */
  getSessionState(sessionId: string): PausedSessionState | undefined {
    return this.pausedSessions.get(sessionId)
  }

  /**
   * Update session pause state
   */
  updateSessionState(sessionId: string, updates: Partial<PausedSessionState>): void {
    const existing = this.pausedSessions.get(sessionId)
    if (existing) {
      this.pausedSessions.set(sessionId, { ...existing, ...updates })
    }
  }

  /**
   * Remove a session from pause tracking
   */
  removeSession(sessionId: string): void {
    this.pausedSessions.delete(sessionId)
  }

  /**
   * Get all tracked sessions
   */
  getAllSessions(): PausedSessionState[] {
    return Array.from(this.pausedSessions.values())
  }

  /**
   * Clear all tracked sessions
   */
  clear(): void {
    this.pausedSessions.clear()
  }
}

// Singleton instance for runtime use
export const sessionPauseStateManager = new SessionPauseStateManager()
