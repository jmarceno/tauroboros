/**
 * useStats Hook - Combined statistics and analytics
 *
 * This hook aggregates all stats queries and provides a unified interface
 * for the StatsTab component. All queries run in parallel for efficiency.
 */

import { useMemo, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useUsageStatsQuery,
  useTaskStatsQuery,
  useModelUsageQuery,
  useAverageDurationQuery,
  useHourlyUsageQuery,
  useDailyUsageQuery,
  queryKeys,
} from '@/queries'
import type { UsageStats, TaskStats, ModelUsageStats, HourlyUsage, DailyUsage } from '@/types'

export interface UseStatsReturn {
  usageStats: UsageStats
  taskStats: TaskStats
  modelUsage: ModelUsageStats
  averageDuration: number
  hourlyUsage: HourlyUsage[]
  dailyUsage7d: DailyUsage[]
  dailyUsage30d: DailyUsage[]
  isLoading: boolean
  error: string | null
  loadAllStats: () => Promise<void>
}

// Default empty states per plan
const defaultUsageStats: UsageStats = {
  totalTokens: 0,
  totalCost: 0,
  tokenChange: 0,
  costChange: 0,
}

const defaultTaskStats: TaskStats = {
  completed: 0,
  failed: 0,
  averageReviews: 0,
}

const defaultModelUsageStats: ModelUsageStats = {
  plan: [],
  execution: [],
  review: [],
}

/**
 * Hook for accessing all system statistics
 *
 * All queries run in parallel automatically via TanStack Query's
 * concurrent execution model (async-parallel best practice).
 */
export function useStats(): UseStatsReturn {
  const queryClient = useQueryClient()

  // All queries run in parallel - TanStack Query fires them concurrently
  // Following async-parallel best practice from react-best-practices
  const usageQuery = useUsageStatsQuery('7d')
  const taskStatsQuery = useTaskStatsQuery()
  const modelUsageQuery = useModelUsageQuery()
  const durationQuery = useAverageDurationQuery()
  const hourlyQuery = useHourlyUsageQuery()
  const daily7Query = useDailyUsageQuery(7)
  const daily30Query = useDailyUsageQuery(30)

  // Compute loading state - true if ANY query is fetching
  // Using useMemo for stable reference (rerender-memo best practice)
  const isLoading = useMemo(
    () =>
      usageQuery.isFetching ||
      taskStatsQuery.isFetching ||
      modelUsageQuery.isFetching ||
      durationQuery.isFetching ||
      hourlyQuery.isFetching ||
      daily7Query.isFetching ||
      daily30Query.isFetching,
    [
      usageQuery.isFetching,
      taskStatsQuery.isFetching,
      modelUsageQuery.isFetching,
      durationQuery.isFetching,
      hourlyQuery.isFetching,
      daily7Query.isFetching,
      daily30Query.isFetching,
    ]
  )

  // Compute error from first failed query
  // Using useMemo for stable reference
  const error = useMemo((): string | null => {
    const errors = [
      usageQuery.error,
      taskStatsQuery.error,
      modelUsageQuery.error,
      durationQuery.error,
      hourlyQuery.error,
      daily7Query.error,
      daily30Query.error,
    ]
    const firstError = errors.find((e): e is NonNullable<typeof e> => e !== null)
    if (firstError === undefined) return null
    // Extract error message from Error instances or objects with message property
    if (firstError instanceof Error) return firstError.message
    if (typeof firstError === 'object' && 'message' in firstError && typeof firstError.message === 'string') {
      return firstError.message
    }
    // Fallback to string representation for primitive errors
    return String(firstError)
  }, [
    usageQuery.error,
    taskStatsQuery.error,
    modelUsageQuery.error,
    durationQuery.error,
    hourlyQuery.error,
    daily7Query.error,
    daily30Query.error,
  ])

  // Refresh all stats by invalidating queries
  // Using useCallback for stable reference (rerender-functional-setstate pattern)
  const loadAllStats = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.stats.all })
  }, [queryClient])

  return {
    usageStats: usageQuery.data ?? defaultUsageStats,
    taskStats: taskStatsQuery.data ?? defaultTaskStats,
    modelUsage: modelUsageQuery.data ?? defaultModelUsageStats,
    averageDuration: durationQuery.data ?? 0,
    hourlyUsage: hourlyQuery.data ?? [],
    dailyUsage7d: daily7Query.data ?? [],
    dailyUsage30d: daily30Query.data ?? [],
    isLoading,
    error,
    loadAllStats,
  }
}
