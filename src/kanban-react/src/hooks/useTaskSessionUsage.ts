import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { SessionUsageRollup } from '@/types'
import { useApi } from './useApi'

const POLL_INTERVAL = 3000 // 3 seconds

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
  const api = useApi()
  const [usageCache, setUsageCache] = useState<Record<string, SessionUsageRollup>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const lastFetchTimeRef = useRef<Record<string, number>>({})
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionIdsRef = useRef<string[]>([])

  // Fetch all sessions and their usage for this task
  const loadTaskSessionUsage = useCallback(async (forceRefresh = false) => {
    if (!taskId) return

    setIsLoading(true)
    setError(null)

    try {
      // Get all sessions for this task
      const sessions = await api.getTaskSessions(taskId)
      const sessionIds = sessions.map(s => s.id)
      sessionIdsRef.current = sessionIds

      // Fetch usage for each session (with caching)
      const usagePromises = sessionIds.map(async (sessionId) => {
        const lastFetch = lastFetchTimeRef.current[sessionId] || 0
        const isFresh = Date.now() - lastFetch < POLL_INTERVAL

        // Use cached value if fresh and not forcing refresh
        if (!forceRefresh) {
          const cached = usageCache[sessionId]
          if (cached && isFresh) {
            return { sessionId, usage: cached }
          }
        }

        // Fetch from API
        try {
          const usage = await api.getSessionUsage(sessionId)
          lastFetchTimeRef.current[sessionId] = Date.now()
          return { sessionId, usage }
        } catch {
          // Return null for sessions that fail to load
          return { sessionId, usage: null }
        }
      })

      const results = await Promise.all(usagePromises)

      // Update cache with new values
      setUsageCache(prev => {
        const newCache = { ...prev }
        results.forEach(({ sessionId, usage }) => {
          if (usage) {
            newCache[sessionId] = usage
          }
        })
        return newCache
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [taskId, api, usageCache])

  // Start polling when taskId is provided
  useEffect(() => {
    if (!taskId) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      return
    }

    // Initial load
    loadTaskSessionUsage()

    // Start polling
    pollIntervalRef.current = setInterval(() => {
      loadTaskSessionUsage()
    }, POLL_INTERVAL)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [taskId, loadTaskSessionUsage, refreshTrigger])

  // Calculate aggregated totals
  const aggregated = useMemo(() => {
    let totalTokens = 0
    let totalCost = 0

    sessionIdsRef.current.forEach(sessionId => {
      const usage = usageCache[sessionId]
      if (usage) {
        totalTokens += usage.totalTokens
        totalCost += usage.totalCost
      }
    })

    return { totalTokens, totalCost }
  }, [usageCache])

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

  // Refresh function
  const refresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1)
  }, [])

  return {
    totalTokens: aggregated.totalTokens,
    totalCost: aggregated.totalCost,
    formattedTokens: formatTokenCount(aggregated.totalTokens),
    formattedCost: formatCost(aggregated.totalCost),
    isLoading,
    error,
    refresh,
  }
}
