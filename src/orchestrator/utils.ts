import { Effect } from "effect"
import type { OrchestratorOperationError } from "./errors.ts"
import { WorktreeError } from "../runtime/worktree.ts"

/**
 * Get current Unix timestamp.
 */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Strip and normalize a string value.
 * Removes leading/trailing whitespace and reduces multiple newlines.
 */
export function stripAndNormalize(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n")
}

/**
 * Tag output with a specific tag.
 */
export function tagOutput(tag: string, text: string): string {
  return text.trim() ? `\n[${tag}]\n${text.trim()}\n` : ""
}

/**
 * Convert a value to a Record if possible.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Check if an error is an explicit merge-failure worktree error.
 */
export function isMergeConflictWorktreeError(error: unknown): error is WorktreeError {
  return error instanceof WorktreeError && error.code === "MERGE_FAILED"
}

/**
 * Determine if a task that timed out was "essentially complete" based on collected events.
 * This heuristic checks if meaningful work was done before the timeout occurred.
 */
export function checkEssentialCompletion(collectedEvents: readonly unknown[]): {
  isEssentiallyComplete: boolean
  reason: string
} {
  if (collectedEvents.length === 0) {
    return { isEssentiallyComplete: false, reason: "No events collected" }
  }

  // Event types that indicate substantial work was done
  const workIndicators = new Set([
    "tool_start",      // Tool execution started
    "tool_complete",   // Tool execution completed
    "text",            // Text output
    "message_update",  // Assistant message
    "file_write",      // File was written
    "bash_command",    // Bash command executed
    "git_commit",      // Git commit was made
  ])

  // Count meaningful events
  let workEventCount = 0
  let hasFileWrite = false
  let hasGitCommit = false
  let hasToolComplete = false
  let hasMessageUpdate = false

  for (const event of collectedEvents) {
    const eventRecord = asRecord(event)
    const eventType = typeof eventRecord.type === "string" ? eventRecord.type : ""
    if (workIndicators.has(eventType)) {
      workEventCount++
    }
    if (eventType === "file_write") hasFileWrite = true
    if (eventType === "git_commit") hasGitCommit = true
    if (eventType === "tool_complete") hasToolComplete = true
    if (eventType === "message_update") hasMessageUpdate = true
  }

  // Heuristic: If we have at least 5 work events AND
  // either a file write, git commit, tool completion, or substantial messages,
  // consider the task essentially complete
  if (workEventCount >= 5 && (hasFileWrite || hasGitCommit || hasToolComplete || hasMessageUpdate)) {
    return {
      isEssentiallyComplete: true,
      reason: `Task made substantial progress (${workEventCount} work events, fileWrite=${hasFileWrite}, gitCommit=${hasGitCommit}, toolComplete=${hasToolComplete})`,
    }
  }

  // Lower threshold for git commit specifically (if commit happened, task is essentially done)
  if (hasGitCommit) {
    return { isEssentiallyComplete: true, reason: "Git commit was made before timeout" }
  }

  return {
    isEssentiallyComplete: false,
    reason: `Insufficient progress indicators (${workEventCount} work events, need at least 5 with file/tool/message activity)`,
  }
}

/**
 * Run a shell command as an Effect.
 */
export function runShellCommandEffect(
  command: string,
  cwd: string,
): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, OrchestratorOperationError> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    },
    catch: (cause): OrchestratorOperationError => {
      const { OrchestratorOperationError } = require("./errors.ts")
      return new OrchestratorOperationError({
        operation: "runShellCommand",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      })
    },
  })
}
