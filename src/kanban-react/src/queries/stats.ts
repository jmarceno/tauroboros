/**
 * Stats Queries - TanStack Query hooks for statistics and analytics
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { statsApi } from '@/api'
import { queryKeys } from './keys.ts'
import type { UsageStats, TaskStats, ModelUsageStats, HourlyUsage, DailyUsage } from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get usage stats for a time range
 */
export function useUsageStatsQuery(
  range = '7d',
  options?: Omit<UseQueryOptions<UsageStats, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.stats.usage(range),
    queryFn: () => statsApi.getUsage(range),
    staleTime: 60000,
    ...options,
  })
}

/**
 * Get task completion statistics
 */
export function useTaskStatsQuery(
  options?: Omit<UseQueryOptions<TaskStats, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.stats.tasks,
    queryFn: statsApi.getTaskStats,
    staleTime: 60000,
    ...options,
  })
}

/**
 * Get model usage breakdown by responsibility
 */
export function useModelUsageQuery(
  options?: Omit<UseQueryOptions<ModelUsageStats, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.stats.models,
    queryFn: statsApi.getModelUsage,
    staleTime: 60000,
    ...options,
  })
}

/**
 * Get average task duration
 */
export function useAverageDurationQuery(
  options?: Omit<UseQueryOptions<number, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.stats.duration,
    queryFn: statsApi.getAverageDuration,
    staleTime: 60000,
    ...options,
  })
}

/**
 * Get hourly usage time series (last 24h)
 */
export function useHourlyUsageQuery(
  options?: Omit<UseQueryOptions<HourlyUsage[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.stats.hourly,
    queryFn: statsApi.getHourlyUsage,
    staleTime: 30000,
    ...options,
  })
}

/**
 * Get daily usage time series for specified days
 */
export function useDailyUsageQuery(
  days: number,
  options?: Omit<UseQueryOptions<DailyUsage[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.stats.daily(days),
    queryFn: () => statsApi.getDailyUsage(days),
    staleTime: 60000,
    ...options,
  })
}
