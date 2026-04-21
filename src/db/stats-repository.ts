import { Effect, Schema } from "effect"
import type { Database } from "bun:sqlite"
import type { StatsTimeRange, UsageStats, TaskStats, ModelUsageStats, HourlyUsage, DailyUsage } from "./types.ts"

/**
 * Error for stats repository operations
 */
export class StatsRepositoryError extends Schema.TaggedError<StatsRepositoryError>()("StatsRepositoryError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const SECONDS_IN_DAY = 86400

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

interface TokenCostRow {
  total_tokens: number | null
  total_cost: number | null
}

interface CountRow {
  cnt: number | null
}

interface AvgReviewsRow {
  avg_reviews: number | null
}

interface ModelUsageRow {
  session_kind: string
  model: string
  cnt: number | null
}

interface AvgDurationRow {
  avg_duration: number | null
}

interface HourlyUsageRow {
  hour_bucket: number
  tokens: number | null
  cost: number | null
}

interface DailyUsageRow {
  date_str: string
  tokens: number | null
  cost: number | null
}

function getTimeRangeBoundaryEffect(range: StatsTimeRange): Effect.Effect<{ start: number; previousStart: number }, StatsRepositoryError> {
  return Effect.gen(function* () {
    const now = nowUnix()
    switch (range) {
      case "24h":
        return { start: now - SECONDS_IN_DAY, previousStart: now - 2 * SECONDS_IN_DAY }
      case "7d":
        return { start: now - 7 * SECONDS_IN_DAY, previousStart: now - 14 * SECONDS_IN_DAY }
      case "30d":
        return { start: now - 30 * SECONDS_IN_DAY, previousStart: now - 60 * SECONDS_IN_DAY }
      case "lifetime":
        return { start: 0, previousStart: 0 }
      default:
        return yield* new StatsRepositoryError({
          operation: "getTimeRangeBoundary",
          message: `Invalid time range: ${JSON.stringify(range)}. Expected "24h", "7d", "30d", or "lifetime".",
        })
    }
  })
}

/** @deprecated Use getTimeRangeBoundaryEffect instead */
function getTimeRangeBoundary(range: StatsTimeRange): { start: number; previousStart: number } {
  const result = Effect.runSync(getTimeRangeBoundaryEffect(range).pipe(
    Effect.catchAll((error: StatsRepositoryError) => Effect.fail(new Error(error.message))),
    Effect.either,
  ))
  if (result._tag === "Left") {
    throw result.left
  }
  return result.right
}

function getSessionKindResponsibility(kind: string): "plan" | "execution" | "review" | "other" {
  if (kind === "plan" || kind === "plan_revision" || kind === "planning") return "plan"
  if (kind === "task" || kind === "task_run_worker" || kind === "task_run_final_applier" || kind === "repair") return "execution"
  if (kind === "task_run_reviewer" || kind === "review_scratch") return "review"
  return "other"
}

export function getUsageStats(db: Database, range: StatsTimeRange): UsageStats {
  const { start, previousStart } = getTimeRangeBoundary(range)

  const currentRow = db
    .prepare(
      `
      SELECT 
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_total), 0) AS total_cost
      FROM session_messages
      WHERE timestamp >= ?
      `,
    )
    .get(start) as TokenCostRow

  let previousTokens = 0
  let previousCost = 0

  if (range !== "lifetime" && previousStart > 0) {
    const previousRow = db
      .prepare(
        `
        SELECT 
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost_total), 0) AS total_cost
        FROM session_messages
        WHERE timestamp >= ? AND timestamp < ?
        `,
      )
      .get(previousStart, start) as TokenCostRow

    previousTokens = Number(previousRow.total_tokens ?? 0)
    previousCost = Number(previousRow.total_cost ?? 0)
  }

  const totalTokens = Number(currentRow.total_tokens ?? 0)
  const totalCost = Number(currentRow.total_cost ?? 0)

  const tokenChange = previousTokens > 0 ? ((totalTokens - previousTokens) / previousTokens) * 100 : 0
  const costChange = previousCost > 0 ? ((totalCost - previousCost) / previousCost) * 100 : 0

  return {
    totalTokens,
    totalCost,
    tokenChange: Math.round(tokenChange * 100) / 100,
    costChange: Math.round(costChange * 100) / 100,
  }
}

export function getTaskStats(db: Database): TaskStats {
  const completedRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'done'")
    .get() as CountRow

  const failedTaskRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'failed'")
    .get() as CountRow

  const failedWorkflowRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM workflow_runs WHERE status = 'failed'")
    .get() as CountRow

  const avgReviewsRow = db
    .prepare(
      `
      SELECT COALESCE(AVG(review_count), 0) AS avg_reviews
      FROM tasks
      WHERE status = 'done'
      `,
    )
    .get() as AvgReviewsRow

  const failedTaskCount = Number(failedTaskRow.cnt ?? 0)
  const failedWorkflowCount = Number(failedWorkflowRow.cnt ?? 0)

  return {
    completed: Number(completedRow.cnt ?? 0),
    // Prefer task failures when available for backward compatibility,
    // but surface failed workflows when tasks are auto-archived as done.
    failed: Math.max(failedTaskCount, failedWorkflowCount),
    averageReviews: Math.round(Number(avgReviewsRow.avg_reviews ?? 0) * 100) / 100,
  }
}

export function getModelUsageByResponsibility(db: Database): ModelUsageStats {
  const rows = db
    .prepare(
      `
      SELECT 
        session_kind,
        model,
        COUNT(*) AS cnt
      FROM workflow_sessions
      WHERE model IS NOT NULL AND model != '' AND model != 'default'
      GROUP BY session_kind, model
      `,
    )
    .all() as ModelUsageRow[]

  const plan: Array<{ model: string; count: number }> = []
  const execution: Array<{ model: string; count: number }> = []
  const review: Array<{ model: string; count: number }> = []

  for (const row of rows) {
    const responsibility = getSessionKindResponsibility(row.session_kind)
    const entry = { model: row.model, count: Number(row.cnt ?? 0) }

    switch (responsibility) {
      case "plan":
        plan.push(entry)
        break
      case "execution":
        execution.push(entry)
        break
      case "review":
        review.push(entry)
        break
      case "other":
        break
    }
  }

  const sortByCount = (a: { count: number }, b: { count: number }) => b.count - a.count
  plan.sort(sortByCount)
  execution.sort(sortByCount)
  review.sort(sortByCount)

  return { plan, execution, review }
}

export function getAverageTaskDuration(db: Database): number {
  const taskRunCountRow = db
    .prepare(
      `
      SELECT COUNT(*) AS cnt
      FROM task_runs
      WHERE completed_at IS NOT NULL
        AND created_at IS NOT NULL
        AND (status = 'done' OR status = 'failed')
      `,
    )
    .get() as CountRow

  const taskRunCount = Number(taskRunCountRow.cnt ?? 0)

  const row = taskRunCount > 0
    ? db
      .prepare(
        `
        SELECT 
          COALESCE(AVG(completed_at - created_at), 0) AS avg_duration
        FROM task_runs
        WHERE completed_at IS NOT NULL
          AND created_at IS NOT NULL
          AND (status = 'done' OR status = 'failed')
        `,
      )
      .get() as AvgDurationRow
    : db
      .prepare(
        `
        SELECT 
          COALESCE(AVG(completed_at - created_at), 0) AS avg_duration
        FROM tasks
        WHERE completed_at IS NOT NULL
          AND created_at IS NOT NULL
          AND status = 'done'
        `,
      )
      .get() as AvgDurationRow

  // Convert from seconds to minutes for display
  const seconds = Number(row.avg_duration ?? 0)
  return Math.round(seconds / 60)
}

export function getHourlyUsageTimeSeries(db: Database): HourlyUsage[] {
  const now = nowUnix()
  const twentyFourHoursAgo = now - SECONDS_IN_DAY

  const rows = db
    .prepare(
      `
      SELECT 
        (timestamp / 3600) * 3600 AS hour_bucket,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(cost_total), 0) AS cost
      FROM session_messages
      WHERE timestamp >= ?
      GROUP BY hour_bucket
      ORDER BY hour_bucket ASC
      `,
    )
    .all(twentyFourHoursAgo) as HourlyUsageRow[]

  return rows.map((row) => ({
    hour: new Date(row.hour_bucket * 1000).toISOString(),
    tokens: Number(row.tokens ?? 0),
    cost: Number(row.cost ?? 0),
  }))
}

export function getDailyUsageTimeSeries(db: Database, days: number): DailyUsage[] {
  const now = nowUnix()
  const startTime = now - days * SECONDS_IN_DAY

  const rows = db
    .prepare(
      `
      SELECT 
        date(timestamp, 'unixepoch') AS date_str,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(cost_total), 0) AS cost
      FROM session_messages
      WHERE timestamp >= ?
      GROUP BY date_str
      ORDER BY date_str ASC
      `,
    )
    .all(startTime) as DailyUsageRow[]

  return rows.map((row) => ({
    date: row.date_str,
    tokens: Number(row.tokens ?? 0),
    cost: Number(row.cost ?? 0),
  }))
}
