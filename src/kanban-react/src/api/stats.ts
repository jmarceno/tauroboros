/**
 * Stats API - Statistics and analytics endpoints
 */

import { apiClient } from './client.ts'
import type { UsageStats, TaskStats, ModelUsageStats, HourlyUsage, DailyUsage } from '@/types'

export const statsApi = {
  // Get usage stats for a time range (24h, 7d, 30d, lifetime)
  getUsage: (range: string) =>
    apiClient.get<UsageStats>(`/api/stats/usage?range=${encodeURIComponent(range)}`),

  // Get task completion statistics
  getTaskStats: () =>
    apiClient.get<TaskStats>('/api/stats/tasks'),

  // Get model usage breakdown by responsibility
  getModelUsage: () =>
    apiClient.get<ModelUsageStats>('/api/stats/models'),

  // Get average task duration in minutes
  getAverageDuration: () =>
    apiClient.get<number>('/api/stats/duration'),

  // Get hourly usage time series (last 24h)
  getHourlyUsage: () =>
    apiClient.get<HourlyUsage[]>('/api/stats/timeseries/hourly'),

  // Get daily usage time series for specified days
  getDailyUsage: (days: number) =>
    apiClient.get<DailyUsage[]>(`/api/stats/timeseries/daily?days=${days}`),
}
