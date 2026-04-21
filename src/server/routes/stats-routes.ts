import { Effect } from "effect"
import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { isStatsTimeRange } from "../validators.ts"
import { ErrorCode } from "../../shared/error-codes.ts"
import { badRequestError } from "../route-interpreter.ts"

export function registerStatsRoutes(router: Router, _ctx: ServerRouteContext): void {
  // GET /api/stats/usage?range=24h|7d|30d|lifetime
  router.get("/api/stats/usage", ({ url, json, db }) =>
    Effect.gen(function* () {
      const rangeParam = url.searchParams.get("range") ?? "lifetime"
      if (!isStatsTimeRange(rangeParam)) {
        return yield* Effect.fail(badRequestError(
          "Invalid range. Allowed values: 24h, 7d, 30d, lifetime",
          ErrorCode.INVALID_RANGE,
        ))
      }
      return json(db.getUsageStats(rangeParam))
    }),
  )

  router.get("/api/stats/tasks", ({ json, db }) => Effect.sync(() => json(db.getTaskStats())))

  router.get("/api/stats/models", ({ json, db }) => Effect.sync(() => json(db.getModelUsageByResponsibility())))

  router.get("/api/stats/duration", ({ json, db }) => Effect.sync(() => json(db.getAverageTaskDuration())))

  router.get("/api/stats/timeseries/hourly", ({ json, db }) => Effect.sync(() => json(db.getHourlyUsageTimeSeries())))

  router.get("/api/stats/timeseries/daily", ({ url, json, db }) =>
    Effect.sync(() => {
      const days = Number(url.searchParams.get("days") ?? 30)
      return json(db.getDailyUsageTimeSeries(days))
    }),
  )
}
