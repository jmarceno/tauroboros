import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import type { SessionUsageRollup } from "@/types"
import { useApi } from "./useApi"

const CACHE_TTL = 30000 // 30 seconds cache

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

export function useSessionUsage(): UseSessionUsageReturn {
  const api = useApi()
  const getSessionUsage = api.getSessionUsage
  const requestCache = useRequestCache<SessionUsageRollup>()

  const [usageCache, setUsageCache] = useState<Record<string, SessionUsageRollup>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())

  const lastFetchTimeRef = useRef<Record<string, number>>({})
  const watchedSessionsRef = useRef<Set<string>>(new Set())

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
        } catch {
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
    setActiveSessionIds(new Set())
    requestCache.clear()
  }, [requestCache])

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      watchedSessionsRef.current.clear()
    }
  }, [])

  return {
    usageCache,
    isLoading,
    error,
    activeSessionIds,
    loadSessionUsage,
    getCachedUsage,
    clearCache,
    startWatching,
    stopWatching,
    formatTokenCount,
    formatCost,
  }
}
