import type { Router } from "../router.ts"
import type { ServerRouteContext } from "../types.ts"
import { isStatsTimeRange } from "../validators.ts"
import { ErrorCode, createApiError } from "../../shared/error-codes.ts"

export function registerStatsRoutes(router: Router, _ctx: ServerRouteContext): void {
  // GET /api/stats/usage?range=24h|7d|30d|lifetime
  router.get("/api/stats/usage", ({ url, json, db }) => {
    const rangeParam = url.searchParams.get("range") ?? "lifetime"
    if (!isStatsTimeRange(rangeParam)) {
      return json(createApiError("Invalid range. Allowed values: 24h, 7d, 30d, lifetime", ErrorCode.INVALID_RANGE), 400)
    }
    return json(db.getUsageStats(rangeParam))
  })

  router.get("/api/stats/tasks", ({ json, db }) => {
    return json(db.getTaskStats())
  })

  router.get("/api/stats/models", ({ json, db }) => {
    return json(db.getModelUsageByResponsibility())
  })

  router.get("/api/stats/duration", ({ json, db }) => {
    return json(db.getAverageTaskDuration())
  })

  router.get("/api/stats/timeseries/hourly", ({ json, db }) => {
    return json(db.getHourlyUsageTimeSeries())
  })

  router.get("/api/stats/timeseries/daily", ({ url, json, db }) => {
    const days = Number(url.searchParams.get("days") ?? 30)
    return json(db.getDailyUsageTimeSeries(days))
  })
}
