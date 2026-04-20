/**
 * Session Usage Store - Tracks session usage (tokens, cost) for tasks
 * Replaces: SessionUsageContext
 */

import { createSignal } from 'solid-js'
import { useQueryClient } from '@tanstack/solid-query'
import type { SessionUsageRollup } from '@/types'
import * as api from '@/api'

const queryKeys = {
  sessions: {
    usage: (sessionId: string) => ['sessions', 'usage', sessionId] as const,
  },
}

export function createSessionUsageStore() {
  const queryClient = useQueryClient()
  const runApi = api.runApiEffect
  const [activeSessionIds, setActiveSessionIds] = createSignal<Set<string>>(new Set())
  const [taskSessionMap, setTaskSessionMap] = createSignal<Record<string, string[]>>({})

  // Format helpers
  const formatTokenCount = (count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M'
    } else if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'k'
    }
    return count.toString()
  }

  const formatCost = (cost: number): string => {
    if (cost >= 1) {
      return '$' + cost.toFixed(2)
    } else if (cost >= 0.01) {
      return '$' + cost.toFixed(3)
    } else if (cost > 0) {
      return '$' + cost.toFixed(4)
    }
    return '$0'
  }

  // Get cached usage for a session
  const getCachedUsage = (sessionId: string): SessionUsageRollup | null => {
    return queryClient.getQueryData<SessionUsageRollup>(queryKeys.sessions.usage(sessionId)) ?? null
  }

  // Load session usage
  const loadSessionUsage = async (sessionId: string, forceRefresh = false): Promise<SessionUsageRollup | null> => {
    if (forceRefresh) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions.usage(sessionId) })
    }
    
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.sessions.usage(sessionId),
        queryFn: () => runApi(api.sessionsApi.getUsage(sessionId)),
        staleTime: 5000,
      })
      return data
    } catch {
      return null
    }
  }

  // Start watching a session
  const startWatching = (sessionId: string) => {
    setActiveSessionIds(prev => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
    // Load immediately if not cached
    loadSessionUsage(sessionId)
  }

  // Stop watching a session
  const stopWatching = (sessionId: string) => {
    setActiveSessionIds(prev => {
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }

  // Start watching all sessions for a task
  const startWatchingTask = async (taskId: string) => {
    try {
      const sessions = await runApi(api.tasksApi.getTaskSessions(taskId))
      const sessionIds = sessions.map(s => s.id)
      
      setTaskSessionMap(prev => ({ ...prev, [taskId]: sessionIds }))
      
      // Start watching all sessions for this task
      sessionIds.forEach(sessionId => {
        startWatching(sessionId)
      })
    } catch {
      return
    }
  }

  // Stop watching a task
  const stopWatchingTask = (taskId: string) => {
    const sessionIds = taskSessionMap()[taskId] || []
    sessionIds.forEach(sessionId => {
      stopWatching(sessionId)
    })
    setTaskSessionMap(prev => {
      const next = { ...prev }
      delete next[taskId]
      return next
    })
  }

  // Get aggregated usage for a task
  const getTaskUsage = (taskId: string): { totalTokens: number; totalCost: number; hasData: boolean } => {
    const sessionIds = taskSessionMap()[taskId] || []
    let totalTokens = 0
    let totalCost = 0
    let hasData = false

    sessionIds.forEach(sessionId => {
      const usage = getCachedUsage(sessionId)
      if (usage) {
        totalTokens += usage.totalTokens
        totalCost += usage.totalCost
        hasData = true
      }
    })

    return { totalTokens, totalCost, hasData }
  }

  // Check if we're loading usage for a task
  const isLoadingTaskUsage = (taskId: string): boolean => {
    const sessionIds = taskSessionMap()[taskId] || []
    return sessionIds.some(sessionId => {
      const queryState = queryClient.getQueryState(queryKeys.sessions.usage(sessionId))
      return queryState?.status === 'pending'
    })
  }

  return {
    activeSessionIds,
    formatTokenCount,
    formatCost,
    getCachedUsage,
    loadSessionUsage,
    startWatching,
    stopWatching,
    startWatchingTask,
    stopWatchingTask,
    getTaskUsage,
    isLoadingTaskUsage,
  }
}
