import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { SessionUsageRollup } from '@/types'
import { useApi } from './useApi'

const CACHE_TTL = 30000 // 30 seconds cache
const BATCH_SIZE = 3 // Max concurrent requests per batch
const BATCH_DELAY = 50 // ms between batches

interface TaskSessionUsage {
  totalTokens: number
  totalCost: number
  formattedTokens: string
  formattedCost: string
  isLoading: boolean
  error: string | null
  refresh: () => void
}

// Request deduplication helper that uses refs instead of globals
function useDeduplicatedRequest<T>() {
  const pendingRef = useRef<Map<string, Promise<T>>>(new Map())
  const cacheRef = useRef<Map<string, { data: T; timestamp: number }>>(new Map())

  const execute = useCallback(async (
    key: string,
    fetcher: () => Promise<T>,
    useCache = true
  ): Promise<T | null> => {
    // Check cache
    if (useCache) {
      const cached = cacheRef.current.get(key)
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data
      }
    }

    // Check for pending request
    if (pendingRef.current.has(key)) {
      return pendingRef.current.get(key) ?? null
    }

    // Execute new request
    const promise = fetcher()
      .then(data => {
        cacheRef.current.set(key, { data, timestamp: Date.now() })
        return data
      })
      .catch(() => null)
      .finally(() => {
        pendingRef.current.delete(key)
      })

    pendingRef.current.set(key, promise as Promise<T>)
    return promise
  }, [])

  const clearCache = useCallback((key?: string) => {
    if (key) {
      cacheRef.current.delete(key)
    } else {
      cacheRef.current.clear()
    }
  }, [])

  return { execute, clearCache }
}

// Batch processor for handling multiple requests with concurrency control
function useBatchProcessor() {
  const abortControllerRef = useRef<AbortController | null>(null)

  const processBatch = useCallback(async <T,>(
    items: string[],
    processor: (item: string) => Promise<T | null>
  ): Promise<Map<string, T>> => {
    // Cancel any in-flight requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()
    const { signal } = abortControllerRef.current

    const results = new Map<string, T>()

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      if (signal.aborted) break

      const batch = items.slice(i, i + BATCH_SIZE)
      const batchPromises = batch.map(async (item) => {
        if (signal.aborted) return null
        try {
          return await processor(item)
        } catch {
          return null
        }
      })

      const batchResults = await Promise.all(batchPromises)

      batch.forEach((item, index) => {
        const result = batchResults[index]
        if (result) {
          results.set(item, result)
        }
      })

      // Delay between batches to avoid overwhelming the browser
      if (i + BATCH_SIZE < items.length && !signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY))
      }
    }

    return results
  }, [])

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  return processBatch
}

export function useTaskSessionUsage(taskId: string | undefined): TaskSessionUsage {
  const api = useApi()
  const dedup = useDeduplicatedRequest<SessionUsageRollup>()
  const processBatch = useBatchProcessor()

  const [usageCache, setUsageCache] = useState<Record<string, SessionUsageRollup>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const lastFetchTimeRef = useRef<number>(0)
  const sessionIdsRef = useRef<string[]>([])

  // Memoized fetch function
  const fetchSessionUsage = useCallback(async (sessionId: string) => {
    return dedup.execute(
      `usage:${sessionId}`,
      () => api.getSessionUsage(sessionId),
      true
    )
  }, [api, dedup])

  // Main data loading function
  const loadTaskSessionUsage = useCallback(async (forceRefresh = false) => {
    if (!taskId) return

    // Skip if recently fetched and not forcing
    if (!forceRefresh && Date.now() - lastFetchTimeRef.current < CACHE_TTL) {
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // Get all sessions for this task
      const sessions = await api.getTaskSessions(taskId)
      const sessionIds = sessions.map(s => s.id)
      sessionIdsRef.current = sessionIds

      // Process in batches with concurrency control
      const results = await processBatch(
        sessionIds,
        (sessionId) => fetchSessionUsage(sessionId)
      )

      // Update state with results
      const newCache: Record<string, SessionUsageRollup> = {}
      results.forEach((usage, sessionId) => {
        newCache[sessionId] = usage
      })

      setUsageCache(newCache)
      lastFetchTimeRef.current = Date.now()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [taskId, api, fetchSessionUsage, processBatch])

  // Load data once when taskId changes or refresh is triggered
  useEffect(() => {
    if (!taskId) {
      lastFetchTimeRef.current = 0
      return
    }

    const isStale = Date.now() - lastFetchTimeRef.current >= CACHE_TTL
    if (isStale || refreshTrigger > 0) {
      loadTaskSessionUsage()
    }
  }, [taskId, loadTaskSessionUsage, refreshTrigger])

  // Calculate aggregated totals - memoized to prevent unnecessary recalculations
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

  // Format helpers - memoized
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
    dedup.clearCache()
    setRefreshTrigger(prev => prev + 1)
  }, [dedup])

  // Memoized formatted values
  const formattedTokens = useMemo(
    () => formatTokenCount(aggregated.totalTokens),
    [aggregated.totalTokens, formatTokenCount]
  )

  const formattedCost = useMemo(
    () => formatCost(aggregated.totalCost),
    [aggregated.totalCost, formatCost]
  )

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
