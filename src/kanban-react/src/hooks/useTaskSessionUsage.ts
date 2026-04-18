/**
 * Task Session Usage Hook - TanStack Query Wrapper
 * 
 * Aggregates usage across all sessions for a task.
 */

import { useMemo, useCallback, useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/queries'
import type { SessionUsageRollup } from '@/types'
import { tasksApi } from '@/api'

interface TaskSessionUsage {
  totalTokens: number
  totalCost: number
  formattedTokens: string
  formattedCost: string
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useTaskSessionUsage(taskId: string | undefined): TaskSessionUsage {
  const queryClient = useQueryClient()
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [sessionIds, setSessionIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch session IDs for this task
  useEffect(() => {
    if (!taskId) {
      setSessionIds([])
      return
    }

    let cancelled = false

    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const sessions = await tasksApi.getTaskSessions(taskId!)
        if (!cancelled) {
          setSessionIds(sessions.map(s => s.id))
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [taskId, refreshTrigger])

  // Calculate aggregated usage
  const aggregated = useMemo(() => {
    let totalTokens = 0
    let totalCost = 0
    let hasData = false

    sessionIds.forEach(sessionId => {
      const usage = queryClient.getQueryData<SessionUsageRollup>(queryKeys.sessions.usage(sessionId))
      if (usage) {
        totalTokens += usage.totalTokens
        totalCost += usage.totalCost
        hasData = true
      }
    })

    return { totalTokens, totalCost, hasData }
  }, [sessionIds, queryClient])

  // Format helpers
  const formatTokenCount = useCallback((count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M'
    } else if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'k'
    }
    return count.toString()
  }, [])

  const formatCost = useCallback((cost: number): string => {
    if (cost >= 1) {
      return '$' + cost.toFixed(2)
    } else if (cost >= 0.01) {
      return '$' + cost.toFixed(3)
    } else if (cost > 0) {
      return '$' + cost.toFixed(4)
    }
    return '$0'
  }, [])

  const formattedTokens = formatTokenCount(aggregated.totalTokens)
  const formattedCost = formatCost(aggregated.totalCost)

  const refresh = useCallback(() => {
    // Clear usage cache for all sessions
    sessionIds.forEach(sessionId => {
      queryClient.removeQueries({ queryKey: queryKeys.sessions.usage(sessionId) })
    })
    setRefreshTrigger(prev => prev + 1)
  }, [sessionIds, queryClient])

  return {
    totalTokens: aggregated.totalTokens,
    totalCost: aggregated.totalCost,
    formattedTokens,
    formattedCost,
    isLoading,
    error,
    refresh,
  }
}
