import { useState, useCallback, useEffect, useRef } from 'react'
import type { SessionUsageRollup } from '@/types'
import { useApi } from './useApi'

const POLL_INTERVAL = 3000 // 3 seconds

export function useSessionUsage() {
  const api = useApi()
  const getSessionUsage = api.getSessionUsage
  const [usageCache, setUsageCache] = useState<Record<string, SessionUsageRollup>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(new Set())
  const lastFetchTimeRef = useRef<Record<string, number>>({})
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return
    pollIntervalRef.current = setInterval(async () => {
      for (const sessionId of activeSessionIds) {
        try {
          const usage = await getSessionUsage(sessionId)
          setUsageCache(prev => ({ ...prev, [sessionId]: usage }))
          lastFetchTimeRef.current[sessionId] = Date.now()
        } catch {
          // Silently fail on poll errors
        }
      }
    }, POLL_INTERVAL)
  }, [getSessionUsage, activeSessionIds])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const startWatching = useCallback((sessionId: string) => {
    setActiveSessionIds(prev => {
      const newSet = new Set(prev)
      newSet.add(sessionId)
      return newSet
    })
  }, [])

  const stopWatching = useCallback((sessionId: string) => {
    setActiveSessionIds(prev => {
      const newSet = new Set(prev)
      newSet.delete(sessionId)
      return newSet
    })
  }, [])

  useEffect(() => {
    if (activeSessionIds.size > 0) {
      startPolling()
    } else {
      stopPolling()
    }
    return () => stopPolling()
  }, [activeSessionIds, startPolling, stopPolling])

  const loadSessionUsage = useCallback(async (sessionId: string, forceRefresh = false): Promise<SessionUsageRollup | null> => {
    const lastFetch = lastFetchTimeRef.current[sessionId] || 0
    const isFresh = Date.now() - lastFetch < POLL_INTERVAL

    // Check cache without using it as dependency
    if (!forceRefresh) {
      const cached = usageCache[sessionId]
      if (cached && isFresh) {
        return cached
      }
    }

    setIsLoading(true)
    setError(null)

    try {
      const usage = await getSessionUsage(sessionId)
      setUsageCache(prev => ({ ...prev, [sessionId]: usage }))
      lastFetchTimeRef.current[sessionId] = Date.now()
      return usage
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setIsLoading(false)
    }
  }, [getSessionUsage])

  const getCachedUsage = useCallback((sessionId: string): SessionUsageRollup | null => {
    return usageCache[sessionId] || null
  }, [usageCache])

  const clearCache = useCallback(() => {
    setUsageCache({})
  }, [])

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
