/**
 * Session Usage Store - Tracks session usage (tokens, cost) for tasks
 * Replaces: SessionUsageContext
 */

import { createSignal } from 'solid-js'
import { useQueryClient } from '@tanstack/solid-query'
import { Effect, Either } from 'effect'
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
  const [sessionUsageErrors, setSessionUsageErrors] = createSignal<Record<string, string>>({})
  const [taskSessionErrors, setTaskSessionErrors] = createSignal<Record<string, string>>({})

  const setSessionUsageError = (sessionId: string, message: string | null) => {
    setSessionUsageErrors(prev => {
      const next = { ...prev }
      if (message) {
        next[sessionId] = message
      } else {
        delete next[sessionId]
      }
      return next
    })
  }

  const setTaskSessionError = (taskId: string, message: string | null) => {
    setTaskSessionErrors(prev => {
      const next = { ...prev }
      if (message) {
        next[taskId] = message
      } else {
        delete next[taskId]
      }
      return next
    })
  }

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
  const loadSessionUsageEffect = (sessionId: string, forceRefresh = false) =>
    Effect.gen(function* () {
      if (forceRefresh) {
        yield* Effect.tryPromise({
          try: () => Promise.resolve(queryClient.invalidateQueries({ queryKey: queryKeys.sessions.usage(sessionId) })).then(() => undefined),
          catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
        })
      }

      return yield* Effect.tryPromise({
        try: () => queryClient.fetchQuery({
          queryKey: queryKeys.sessions.usage(sessionId),
          queryFn: () => runApi(api.sessionsApi.getUsage(sessionId)),
          staleTime: 5000,
        }),
        catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
      })
    }).pipe(
      Effect.tapError((error) =>
        Effect.logError(`[session-usage-store] Failed to load usage for session ${sessionId}: ${error.message}`),
      ),
      Effect.tap(() => Effect.sync(() => setSessionUsageError(sessionId, null))),
      Effect.either,
      Effect.flatMap((result) =>
        Effect.sync(() => {
          if (Either.isLeft(result)) {
            setSessionUsageError(sessionId, result.left.message)
            return null
          }
          return result.right
        })
      ),
    )

  const loadSessionUsage = (sessionId: string, forceRefresh = false) =>
    runApi(loadSessionUsageEffect(sessionId, forceRefresh))

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
  const startWatchingTask = (taskId: string) =>
    runApi(
      api.tasksApi.getTaskSessions(taskId).pipe(
        Effect.tapError((error) =>
          Effect.logError(`[session-usage-store] Failed to load sessions for task ${taskId}: ${error.message}`),
        ),
        Effect.tap(() => Effect.sync(() => setTaskSessionError(taskId, null))),
        Effect.either,
        Effect.flatMap((result) =>
          Effect.sync(() => {
            if (Either.isLeft(result)) {
              setTaskSessionError(taskId, result.left.message)
              return
            }

            const sessionIds = result.right.map((session) => session.id)
            setTaskSessionMap(prev => ({ ...prev, [taskId]: sessionIds }))

            sessionIds.forEach(sessionId => {
              startWatching(sessionId)
            })
          })
        ),
      ),
    )

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
    sessionUsageErrors,
    taskSessionErrors,
  }
}
