import type { PiSessionKind } from "../db/types.ts"
import type { PiKanbanDB } from "../db.ts"

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
): PausedSessionState | null {
  const dbState = db.loadPausedSessionState(sessionId)
  if (!dbState) return null

  return {
    sessionId: dbState.sessionId,
    taskId: dbState.taskId,
    taskRunId: dbState.taskRunId,
    sessionKind: dbState.sessionKind as PiSessionKind,
    cwd: dbState.cwd ?? dbState.worktreeDir ?? "",
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
export function listPausedSessions(db: PiKanbanDB): PausedSessionState[] {
  const dbSessions = db.listPausedSessions()
  return dbSessions.map((s) => ({
    sessionId: s.sessionId,
    taskId: s.taskId,
    taskRunId: s.taskRunId,
    sessionKind: s.sessionKind as PiSessionKind,
    cwd: s.cwd ?? s.worktreeDir ?? "",
    worktreeDir: s.worktreeDir,
    branch: s.branch,
    model: s.model,
    thinkingLevel: s.thinkingLevel,
    lastPrompt: s.lastPrompt,
    lastPromptTimestamp: s.pausedAt,
    containerId: s.containerId,
    containerName: null,
    containerImage: s.containerImage,
    piSessionId: s.piSessionId,
    piSessionFile: s.piSessionFile,
    context: s.context,
    executionPhase: s.executionPhase,
    pauseReason: s.pauseReason,
  }))
}

/**
 * Get paused sessions for a specific task from the database.
 */
export function getPausedSessionsByTask(
  db: PiKanbanDB,
  taskId: string
): PausedSessionState[] {
  const dbSessions = db.getPausedSessionsByTask(taskId)
  return dbSessions.map((s) => ({
    sessionId: s.sessionId,
    taskId: s.taskId,
    taskRunId: s.taskRunId,
    sessionKind: s.sessionKind as PiSessionKind,
    cwd: s.cwd ?? s.worktreeDir ?? "",
    worktreeDir: s.worktreeDir,
    branch: s.branch,
    model: s.model,
    thinkingLevel: s.thinkingLevel,
    lastPrompt: s.lastPrompt,
    lastPromptTimestamp: s.pausedAt,
    containerId: s.containerId,
    containerName: null,
    containerImage: s.containerImage,
    piSessionId: s.piSessionId,
    piSessionFile: s.piSessionFile,
    context: s.context,
    executionPhase: s.executionPhase,
    pauseReason: s.pauseReason,
  }))
}

/**
 * Clear all paused session states from the database.
 */
export function clearAllPausedSessionStates(db: PiKanbanDB): void {
  db.clearAllPausedSessionStates()
}

/**
 * Paused run state - tracks the entire workflow run pause state
 * Now stored in database for ACID guarantees and consistency with session-level state.
 * @deprecated The file-based PausedRunState is replaced by database storage. Use the DB methods directly.
 */
export interface PausedRunState {
  runId: string
  kind: "all_tasks" | "single_task" | "workflow_review"
  taskOrder: string[]
  currentTaskIndex: number
  currentTaskId: string | null
  targetTaskId: string | null
  pausedAt: number
  sessions: PausedSessionState[]
  executionPhase: "not_started" | "planning" | "executing" | "reviewing" | "committing"
}

// Legacy file-based imports - kept for backward compatibility during migration
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs"
import { join } from "path"

const PAUSE_STATE_DIR = ".tauroboros/pause-state";
const PAUSE_STATE_FILE = "paused-run.json";

function getPauseStatePath(): string {
  return join(process.cwd(), PAUSE_STATE_DIR, PAUSE_STATE_FILE)
}

function ensurePauseStateDir(): void {
  const dir = join(process.cwd(), PAUSE_STATE_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Save paused run state to database.
 * Replaces file-based storage with database storage for ACID guarantees.
 */
export function savePausedRunState(state: PausedRunState, db?: PiKanbanDB): void {
  if (db) {
    // Use database storage (preferred)
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
  } else {
    // Fallback to file-based storage for backward compatibility
    ensurePauseStateDir()
    const path = getPauseStatePath()
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8")
  }
}

/**
 * Load paused run state from database.
 * Falls back to file-based storage for backward compatibility.
 */
export function loadPausedRunState(runId?: string, db?: PiKanbanDB): PausedRunState | null {
  if (db && runId) {
    // Use database storage (preferred)
    const dbState = db.loadPausedRunState(runId)
    if (dbState) {
      // Get associated paused sessions for this run
      const pausedSessions = db.listPausedSessions().filter(s =>
        s.taskId && dbState.taskOrder.includes(s.taskId)
      )

      return {
        runId: dbState.runId,
        kind: dbState.kind,
        taskOrder: dbState.taskOrder,
        currentTaskIndex: dbState.currentTaskIndex,
        currentTaskId: dbState.currentTaskId,
        targetTaskId: dbState.targetTaskId,
        pausedAt: dbState.pausedAt,
        sessions: pausedSessions.map(s => ({
          sessionId: s.sessionId,
          taskId: s.taskId,
          taskRunId: s.taskRunId,
          sessionKind: s.sessionKind as PiSessionKind,
          cwd: s.cwd ?? s.worktreeDir ?? "",
          worktreeDir: s.worktreeDir,
          branch: s.branch,
          model: s.model,
          thinkingLevel: s.thinkingLevel,
          lastPrompt: s.lastPrompt,
          lastPromptTimestamp: s.pausedAt,
          containerId: s.containerId,
          containerName: null,
          containerImage: s.containerImage,
          piSessionId: s.piSessionId,
          piSessionFile: s.piSessionFile,
          context: s.context,
          executionPhase: s.executionPhase,
          pauseReason: s.pauseReason,
        })),
        executionPhase: dbState.executionPhase,
      }
    }
    return null
  }

  // Fallback to file-based storage for backward compatibility
  const path = getPauseStatePath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const content = readFileSync(path, "utf-8")
    return JSON.parse(content) as PausedRunState
  } catch {
    return null
  }
}

/**
 * Clear paused run state from database.
 * Also clears from file-based storage for cleanup.
 */
export function clearPausedRunState(runId?: string, db?: PiKanbanDB): void {
  if (db && runId) {
    // Clear from database
    db.clearPausedRunState(runId)
  }

  // Also clear from file-based storage for cleanup
  const path = getPauseStatePath()
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Check if there's a paused run state in database or on disk.
 */
export function hasPausedRunState(runId?: string, db?: PiKanbanDB): boolean {
  if (db && runId) {
    // Check database first (preferred)
    if (db.hasPausedRunState(runId)) {
      return true
    }
  }
  // Fallback to file-based check
  return existsSync(getPauseStatePath())
}

/**
 * List all paused run states from database.
 */
export function listPausedRunStates(db: PiKanbanDB): PausedRunState[] {
  const dbStates = db.listPausedRunStates()
  return dbStates.map(dbState => {
    // Get associated paused sessions for this run
    const pausedSessions = db.listPausedSessions().filter(s =>
      s.taskId && dbState.taskOrder.includes(s.taskId)
    )

    return {
      runId: dbState.runId,
      kind: dbState.kind,
      taskOrder: dbState.taskOrder,
      currentTaskIndex: dbState.currentTaskIndex,
      currentTaskId: dbState.currentTaskId,
      targetTaskId: dbState.targetTaskId,
      pausedAt: dbState.pausedAt,
      sessions: pausedSessions.map(s => ({
        sessionId: s.sessionId,
        taskId: s.taskId,
        taskRunId: s.taskRunId,
        sessionKind: s.sessionKind as PiSessionKind,
        cwd: s.cwd ?? s.worktreeDir ?? "",
        worktreeDir: s.worktreeDir,
        branch: s.branch,
        model: s.model,
        thinkingLevel: s.thinkingLevel,
        lastPrompt: s.lastPrompt,
        lastPromptTimestamp: s.pausedAt,
        containerId: s.containerId,
        containerName: null,
        containerImage: s.containerImage,
        piSessionId: s.piSessionId,
        piSessionFile: s.piSessionFile,
        context: s.context,
        executionPhase: s.executionPhase,
        pauseReason: s.pauseReason,
      })),
      executionPhase: dbState.executionPhase,
    }
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
