import type { Task, TaskRun, ThinkingLevel, AutoDeployCondition } from "../types.ts"
import type { StatsTimeRange } from "../db/types.ts"

export const TASK_BOOLEAN_FIELDS = [
  "planmode",
  "autoApprovePlan",
  "review",
  "codeStyleReview",
  "autoCommit",
  "autoDeploy",
  "deleteWorktree",
  "skipPermissionAsking",
] as const

export type TaskBooleanField = (typeof TASK_BOOLEAN_FIELDS)[number]

interface BestOfNSlotInput {
  model?: unknown
  count?: unknown
  taskSuffix?: unknown
}

interface BestOfNFinalApplierInput {
  model?: unknown
  taskSuffix?: unknown
}

interface BestOfNConfigInput {
  workers?: unknown
  reviewers?: unknown
  finalApplier?: unknown
  selectionMode?: unknown
  minSuccessfulWorkers?: unknown
  verificationCommand?: unknown
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "default" || value === "low" || value === "medium" || value === "high"
}

export function isExecutionStrategy(value: unknown): value is "standard" | "best_of_n" {
  return value === "standard" || value === "best_of_n"
}

export function isSelectionMode(value: unknown): value is "pick_best" | "synthesize" | "pick_or_synthesize" {
  return value === "pick_best" || value === "synthesize" || value === "pick_or_synthesize"
}

export function isStatsTimeRange(value: unknown): value is StatsTimeRange {
  return value === "24h" || value === "7d" || value === "30d" || value === "lifetime"
}

export function isAutoDeployCondition(value: unknown): value is AutoDeployCondition {
  return (
    value === "before_workflow_start" ||
    value === "after_workflow_end" ||
    value === "workflow_done" ||
    value === "workflow_failed"
  )
}

export function validateBestOfNConfig(config: unknown): { valid: boolean; error?: string } {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "bestOfNConfig must be an object" }
  }

  const cfg = config as BestOfNConfigInput
  if (!Array.isArray(cfg.workers) || cfg.workers.length === 0) {
    return { valid: false, error: "At least one worker slot is required" }
  }

  for (let i = 0; i < cfg.workers.length; i++) {
    const slot = cfg.workers[i] as BestOfNSlotInput
    if (!slot.model || typeof slot.model !== "string")
      return { valid: false, error: `Worker slot ${i + 1}: model is required` }
    if (typeof slot.count !== "number" || slot.count < 1)
      return { valid: false, error: `Worker slot ${i + 1}: count must be at least 1` }
  }

  if (!Array.isArray(cfg.reviewers)) return { valid: false, error: "Reviewers must be an array" }
  for (let i = 0; i < cfg.reviewers.length; i++) {
    const slot = cfg.reviewers[i] as BestOfNSlotInput
    if (!slot.model || typeof slot.model !== "string")
      return { valid: false, error: `Reviewer slot ${i + 1}: model is required` }
    if (typeof slot.count !== "number" || slot.count < 1)
      return { valid: false, error: `Reviewer slot ${i + 1}: count must be at least 1` }
  }

  const finalApplier = cfg.finalApplier as BestOfNFinalApplierInput | undefined
  if (!finalApplier || typeof finalApplier !== "object" || typeof finalApplier.model !== "string") {
    return { valid: false, error: "Final applier model is required" }
  }

  if (cfg.selectionMode && !isSelectionMode(cfg.selectionMode as string)) {
    return { valid: false, error: "selectionMode must be pick_best, synthesize, or pick_or_synthesize" }
  }

  // Calculate total workers with proper error handling
  let totalWorkers = 0
  for (const slot of cfg.workers) {
    if (typeof slot !== "object" || slot === null) {
      return { valid: false, error: `Worker slot must be an object: ${JSON.stringify(slot)}` }
    }
    const slotObj = slot as Record<string, unknown>
    const count = slotObj.count
    if (count === undefined || count === null) {
      return { valid: false, error: `Worker slot is missing 'count' field: ${JSON.stringify(slot)}` }
    }
    if (typeof count !== "number") {
      return { valid: false, error: `Worker slot 'count' must be a number: ${JSON.stringify(slot)}` }
    }
    totalWorkers += count
  }

  if (
    typeof cfg.minSuccessfulWorkers !== "number" ||
    cfg.minSuccessfulWorkers < 1 ||
    cfg.minSuccessfulWorkers > totalWorkers
  ) {
    return { valid: false, error: "minSuccessfulWorkers must be between 1 and total worker count" }
  }

  return { valid: true }
}

export function getInvalidTaskBooleanField(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const bodyObj = body as Record<string, unknown>
  for (const field of TASK_BOOLEAN_FIELDS) {
    const value = bodyObj[field]
    if (value !== undefined && !isBoolean(value)) return field
  }
  return null
}

export function normalizeTaskForClient(task: Task, sessionUrlFor: (sessionId: string) => string): Task {
  if (!task.sessionId) return task
  if (!task.sessionUrl || task.sessionUrl.includes("opencode") || !task.sessionUrl.includes("#session/")) {
    return { ...task, sessionUrl: sessionUrlFor(task.sessionId) }
  }
  return task
}

export function normalizeTaskRunForClient(
  run: TaskRun,
  sessionUrlFor: (sessionId: string) => string,
): TaskRun {
  if (!run.sessionId) return run
  if (!run.sessionUrl || run.sessionUrl.includes("opencode") || !run.sessionUrl.includes("#session/")) {
    return { ...run, sessionUrl: sessionUrlFor(run.sessionId) }
  }
  return run
}
