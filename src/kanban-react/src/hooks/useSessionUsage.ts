/**
 * Session Usage Hook - TanStack Query Wrapper
 * 
 * Simplified using TanStack Query's built-in caching and deduplication.
 */

import { useMemo, useCallback, useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSessionUsageQuery, queryKeys } from '@/queries'
import { sessionsApi, tasksApi } from '@/api'
import type { SessionUsageRollup } from '@/types'
import type { WebSocketHook } from './useWebSocket.ts'

export function useSessionUsage(wsHook?: WebSocketHook) {
  const queryClient = useQueryClient()
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())

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

  // Compute aggregated usage cache from active sessions
  const usageCache = useMemo(() => {
    const cache: Record<string, SessionUsageRollup> = {}
    let isLoading = false
    let hasError = false

    activeSessionIds.forEach(sessionId => {
      const query = queryClient.getQueryState<SessionUsageRollup>(queryKeys.sessions.usage(sessionId))
      if (query?.status === 'success' && query.data) {
        cache[sessionId] = query.data
      }
      if (query?.status === 'pending') isLoading = true
      if (query?.status === 'error') hasError = true
    })

    return { cache, isLoading, hasError }
  }, [activeSessionIds, queryClient])

  // Load session usage
  const loadSessionUsage = useCallback(async (
    sessionId: string,
    forceRefresh = false
  ): Promise<SessionUsageRollup | null> => {
    if (forceRefresh) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions.usage(sessionId) })
    }
    
    const data = await queryClient.fetchQuery({
      queryKey: queryKeys.sessions.usage(sessionId),
      queryFn: () => sessionsApi.getUsage(sessionId),
    })
    
    return data
  }, [queryClient])

  const getCachedUsage = useCallback((sessionId: string): SessionUsageRollup | null => {
    return usageCache.cache[sessionId] ?? null
  }, [usageCache.cache])

  const clearCache = useCallback(() => {
    activeSessionIds.forEach(sessionId => {
      queryClient.removeQueries({ queryKey: queryKeys.sessions.usage(sessionId) })
    })
    setActiveSessionIds(new Set())
  }, [activeSessionIds, queryClient])

  const startWatching = useCallback((sessionId: string) => {
    setActiveSessionIds(prev => {
      const newSet = new Set(prev)
      newSet.add(sessionId)
      return newSet
    })
    // Load immediately if not cached
    loadSessionUsage(sessionId)
  }, [loadSessionUsage])

  const stopWatching = useCallback((sessionId: string) => {
    setActiveSessionIds(prev => {
      const newSet = new Set(prev)
      newSet.delete(sessionId)
      return newSet
    })
  }, [])

  // Track task sessions for aggregated usage
  const [taskSessionMap, setTaskSessionMap] = useState<Record<string, string[]>>({})

  const startWatchingTask = useCallback(async (taskId: string) => {
    const sessions = await tasksApi.getTaskSessions(taskId)
    const sessionIds = sessions.map(s => s.id)
    
    setTaskSessionMap(prev => ({ ...prev, [taskId]: sessionIds }))
    
    // Start watching all sessions for this task
    sessionIds.forEach(sessionId => {
      startWatching(sessionId)
    })
  }, [startWatching])

  const stopWatchingTask = useCallback((taskId: string) => {
    const sessionIds = taskSessionMap[taskId] || []
    sessionIds.forEach(sessionId => {
      stopWatching(sessionId)
    })
    setTaskSessionMap(prev => {
      const next = { ...prev }
      delete next[taskId]
      return next
    })
  }, [taskSessionMap, stopWatching])

  const getTaskUsage = useCallback((taskId: string): { totalTokens: number; totalCost: number } => {
    const sessionIds = taskSessionMap[taskId] || []
    let totalTokens = 0
    let totalCost = 0

    sessionIds.forEach(sessionId => {
      const usage = getCachedUsage(sessionId)
      if (usage) {
        totalTokens += usage.totalTokens
        totalCost += usage.totalCost
      }
    })

    return { totalTokens, totalCost }
  }, [taskSessionMap, getCachedUsage])

  // WebSocket integration for real-time updates
  useEffect(() => {
    if (!wsHook) return

    const unsubscribe = wsHook.on('session_message_created', (payload: unknown) => {
      const msg = payload as { sessionId?: string; timestamp?: number }
      
      if (msg.sessionId && activeSessionIds.has(msg.sessionId)) {
        // Debounce the refresh
        const timer = setTimeout(() => {
          loadSessionUsage(msg.sessionId!, true)
        }, 2000)
        
        return () => clearTimeout(timer)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [wsHook, activeSessionIds, loadSessionUsage])

  return {
    usageCache: usageCache.cache,
    isLoading: usageCache.isLoading,
    error: usageCache.hasError ? 'Failed to load usage data' : null,
    activeSessionIds,
    loadSessionUsage,
    getCachedUsage,
    clearCache,
    startWatching,
    stopWatching,
    startWatchingTask,
    stopWatchingTask,
    getTaskUsage,
    formatTokenCount,
    formatCost,
  }
}
