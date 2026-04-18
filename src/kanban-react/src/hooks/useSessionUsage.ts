import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import type { SessionUsageRollup, SessionMessage } from "@/types"
import { useApi } from "./useApi"
import { useWebSocket } from "./useWebSocket"

const CACHE_TTL = 30000 // 30 seconds cache
const REFRESH_DEBOUNCE_MS = 2000 // 2 seconds debounce for usage refresh

interface UseSessionUsageReturn {
  usageCache: Record<string, SessionUsageRollup>
  isLoading: boolean
  error: string | null
  activeSessionIds: Set<string>
  loadSessionUsage: (sessionId: string, forceRefresh?: boolean) => Promise<SessionUsageRollup | null>
  getCachedUsage: (sessionId: string) => SessionUsageRollup | null
  clearCache: () => void
  startWatching: (sessionId: string) => void
  stopWatching: (sessionId: string) => void
  startWatchingTask: (taskId: string) => Promise<void>
  stopWatchingTask: (taskId: string) => void
  getTaskUsage: (taskId: string) => { totalTokens: number; totalCost: number }
  formatTokenCount: (count: number) => string
  formatCost: (cost: number) => string
}

// Custom hook for request deduplication using refs
function useRequestCache<T>() {
  const cacheRef = useRef<Map<string, { data: T; timestamp: number }>>(new Map())
  const pendingRef = useRef<Map<string, Promise<T | null>>>(new Map())

  const get = useCallback((key: string): T | null => {
    const cached = cacheRef.current.get(key)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data
    }
    return null
  }, [])

  const set = useCallback((key: string, data: T) => {
    cacheRef.current.set(key, { data, timestamp: Date.now() })
  }, [])

  const getPending = useCallback((key: string): Promise<T | null> | undefined => {
    return pendingRef.current.get(key)
  }, [])

  const setPending = useCallback((key: string, promise: Promise<T | null>) => {
    pendingRef.current.set(key, promise)
  }, [])

  const deletePending = useCallback((key: string) => {
    pendingRef.current.delete(key)
  }, [])

  const clear = useCallback(() => {
    cacheRef.current.clear()
    pendingRef.current.clear()
  }, [])

  return useMemo(() => ({
    get,
    set,
    getPending,
    setPending,
    deletePending,
    clear,
  }), [get, set, getPending, setPending, deletePending, clear])
}

export function useSessionUsage(wsHook?: ReturnType<typeof useWebSocket>): UseSessionUsageReturn {
  const api = useApi()
  const getSessionUsage = api.getSessionUsage
  const requestCache = useRequestCache<SessionUsageRollup>()

  const [usageCache, setUsageCache] = useState<Record<string, SessionUsageRollup>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())

  const lastFetchTimeRef = useRef<Record<string, number>>({})
  const watchedSessionsRef = useRef<Set<string>>(new Set())
  const watchedTasksRef = useRef<Map<string, string[]>>(new Map()) // taskId -> sessionIds
  const refreshDebounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const taskSessionsCacheRef = useRef<Map<string, string[]>>(new Map()) // taskId -> sessionIds

  // Load session usage with deduplication and caching
  const loadSessionUsage = useCallback(async (
    sessionId: string,
    forceRefresh = false
  ): Promise<SessionUsageRollup | null> => {
    // Check cache first
    if (!forceRefresh) {
      const cached = requestCache.get(sessionId)
      if (cached) {
        setUsageCache(prev => ({ ...prev, [sessionId]: cached }))
        return cached
      }

      // Check local state cache
      const localCached = usageCache[sessionId]
      const lastFetch = lastFetchTimeRef.current[sessionId] || 0
      if (localCached && Date.now() - lastFetch < CACHE_TTL) {
        return localCached
      }
    }

    setIsLoading(true)
    setError(null)

    try {
      // Check for pending request to deduplicate
      const pending = requestCache.getPending(sessionId)
      if (pending) {
        const usage = await pending
        if (usage) {
          setUsageCache(prev => ({ ...prev, [sessionId]: usage }))
        }
        return usage
      }

      // Create new request
      const requestPromise = (async () => {
        try {
          const usage = await getSessionUsage(sessionId)
          requestCache.set(sessionId, usage)
          return usage
        } catch (e) {
          console.error(`[useSessionUsage] Failed to load usage for session ${sessionId}:`, e)
          return null
        } finally {
          requestCache.deletePending(sessionId)
        }
      })()

      requestCache.setPending(sessionId, requestPromise)
      const usage = await requestPromise

      if (usage) {
        setUsageCache(prev => ({ ...prev, [sessionId]: usage }))
        lastFetchTimeRef.current[sessionId] = Date.now()
      }

      return usage
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      setError(errorMsg)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [getSessionUsage, requestCache, usageCache])

  // Start watching a session (just tracks it, no polling)
  const startWatching = useCallback((sessionId: string) => {
    if (watchedSessionsRef.current.has(sessionId)) return

    watchedSessionsRef.current.add(sessionId)
    setActiveSessionIds(prev => {
      const newSet = new Set(prev)
      newSet.add(sessionId)
      return newSet
    })

    // Load immediately if not cached
    const cached = requestCache.get(sessionId)
    if (!cached) {
      loadSessionUsage(sessionId)
    }
  }, [requestCache, loadSessionUsage])

  // Stop watching a session
  const stopWatching = useCallback((sessionId: string) => {
    watchedSessionsRef.current.delete(sessionId)
    setActiveSessionIds(prev => {
      const newSet = new Set(prev)
      newSet.delete(sessionId)
      return newSet
    })
  }, [])

  // Start watching all sessions for a task
  const startWatchingTask = useCallback(async (taskId: string) => {
    if (watchedTasksRef.current.has(taskId)) return

    // Fetch all sessions for this task
    const sessions = await api.getTaskSessions(taskId)
    const sessionIds = sessions.map(s => s.id)
    
    // Store session IDs for this task
    watchedTasksRef.current.set(taskId, sessionIds)
    taskSessionsCacheRef.current.set(taskId, sessionIds)

    // Start watching each session
    sessionIds.forEach(sessionId => {
      startWatching(sessionId)
    })
  }, [api, startWatching])

  // Stop watching all sessions for a task
  const stopWatchingTask = useCallback((taskId: string) => {
    const sessionIds = watchedTasksRef.current.get(taskId)
    if (sessionIds) {
      sessionIds.forEach(sessionId => {
        stopWatching(sessionId)
      })
      watchedTasksRef.current.delete(taskId)
    }
  }, [stopWatching])

  // Get aggregated usage for a task
  const getTaskUsage = useCallback((taskId: string): { totalTokens: number; totalCost: number } => {
    const sessionIds = watchedTasksRef.current.get(taskId) || taskSessionsCacheRef.current.get(taskId) || []
    let totalTokens = 0
    let totalCost = 0

    sessionIds.forEach(sessionId => {
      const cached = requestCache.get(sessionId)
      if (cached) {
        totalTokens += cached.totalTokens
        totalCost += cached.totalCost
      } else if (usageCache[sessionId]) {
        totalTokens += usageCache[sessionId].totalTokens
        totalCost += usageCache[sessionId].totalCost
      }
    })

    return { totalTokens, totalCost }
  }, [usageCache, requestCache])

  // Get cached usage
  const getCachedUsage = useCallback((sessionId: string): SessionUsageRollup | null => {
    // Try state cache first
    const localCached = usageCache[sessionId]
    const lastFetch = lastFetchTimeRef.current[sessionId] || 0
    if (localCached && Date.now() - lastFetch < CACHE_TTL) {
      return localCached
    }

    // Try request cache
    const requestCached = requestCache.get(sessionId)
    if (requestCached) {
      // Update state cache
      setUsageCache(prev => ({ ...prev, [sessionId]: requestCached }))
      return requestCached
    }

    return null
  }, [usageCache, requestCache])

  // Clear all caches
  const clearCache = useCallback(() => {
    setUsageCache({})
    lastFetchTimeRef.current = {}
    watchedSessionsRef.current.clear()
    watchedTasksRef.current.clear()
    taskSessionsCacheRef.current.clear()
    setActiveSessionIds(new Set())
    requestCache.clear()
  }, [requestCache])

  // WebSocket integration for real-time updates
  useEffect(() => {
    if (!wsHook) return

    const unsubscribe = wsHook.on("session_message_created", (payload) => {
      const msg = payload as SessionMessage
      
      // Check if this message is for a watched session
      if (msg.sessionId && watchedSessionsRef.current.has(msg.sessionId)) {
        // Debounce the refresh to avoid API spam
        // Clear existing timer if any
        const existingTimer = refreshDebounceTimersRef.current.get(msg.sessionId)
        if (existingTimer) {
          clearTimeout(existingTimer)
        }

        // Set new debounced refresh
        const timer = setTimeout(() => {
          // Force refresh for this session
          loadSessionUsage(msg.sessionId, true)
          refreshDebounceTimersRef.current.delete(msg.sessionId)
        }, REFRESH_DEBOUNCE_MS)

        refreshDebounceTimersRef.current.set(msg.sessionId, timer)
      }
    })

    return () => {
      unsubscribe()
      // Clear all pending timers on cleanup
      refreshDebounceTimersRef.current.forEach(timer => clearTimeout(timer))
      refreshDebounceTimersRef.current.clear()
    }
  }, [wsHook, loadSessionUsage])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      watchedSessionsRef.current.clear()
      watchedTasksRef.current.clear()
      taskSessionsCacheRef.current.clear()
      refreshDebounceTimersRef.current.forEach(timer => clearTimeout(timer))
      refreshDebounceTimersRef.current.clear()
    }
  }, [])

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

  const contextValue = useMemo(() => ({
    usageCache,
    isLoading,
    error,
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
  }), [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    usageCache, activeSessionIds, loadSessionUsage, getCachedUsage,
    clearCache, startWatching, stopWatching, startWatchingTask, stopWatchingTask,
    getTaskUsage, formatTokenCount, formatCost
  ])

  return contextValue
}