import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { SessionMessage } from '@/types'
import type { useWebSocket } from './useWebSocket'

const CACHE_TTL = 60000 // 1 minute cache for last updates

interface LastUpdateMap {
  [taskId: string]: number
}

interface TaskLastUpdateHook {
  lastUpdateMap: LastUpdateMap
  getLastUpdate: (taskId: string) => number | undefined
  formatLastUpdate: (timestamp: number) => string
  loadLastUpdate: (taskId: string) => Promise<void>
  getUpdateAgeClass: (timestamp: number) => string
}

// Custom hook for request deduplication
function useDeduplicatedFetch() {
  const pendingRef = useRef<Map<string, Promise<Response>>>(new Map())
  const cacheRef = useRef<Map<string, { data: unknown; timestamp: number }>>(new Map())

  const fetchWithDedup = useCallback(async (
    url: string,
    options?: RequestInit
  ): Promise<unknown | null> => {
    // Check cache
    const cached = cacheRef.current.get(url)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data
    }

    // Check for pending request
    if (pendingRef.current.has(url)) {
      const response = await pendingRef.current.get(url)
      if (!response) return null
      return response.json()
    }

    // Create new request
    const promise = fetch(url, options)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        cacheRef.current.set(url, { data, timestamp: Date.now() })
        return data
      })
      .catch(() => null)
      .finally(() => {
        pendingRef.current.delete(url)
      })

    pendingRef.current.set(url, promise as Promise<Response>)
    return promise
  }, [])

  const clearCache = useCallback((url?: string) => {
    if (url) {
      cacheRef.current.delete(url)
    } else {
      cacheRef.current.clear()
    }
  }, [])

  return useMemo(() => ({
    fetchWithDedup,
    clearCache,
  }), [fetchWithDedup, clearCache])
}

/**
 * Format a timestamp as a relative time string (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp * 1000
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`

  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`

  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`

  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay}d ago`
}

/**
 * Get the CSS class for the last update badge based on age
 */
function getUpdateAgeClass(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp * 1000
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 2) return 'recent'
  if (diffMin < 30) return 'medium'
  return 'old'
}

export function useTaskLastUpdate(wsHook: ReturnType<typeof useWebSocket>): TaskLastUpdateHook {
  const [lastUpdateMap, setLastUpdateMap] = useState<LastUpdateMap>({})
  const dedupFetch = useDeduplicatedFetch()

  // Track which tasks we're watching to avoid duplicate loads
  const watchedTasksRef = useRef<Set<string>>(new Set())
  const lastFetchTimeRef = useRef<Record<string, number>>({})

  // Get last update timestamp for a task
  const getLastUpdate = useCallback((taskId: string): number | undefined => {
    return lastUpdateMap[taskId]
  }, [lastUpdateMap])

  // Format timestamp as relative time
  const formatLastUpdate = useCallback((timestamp: number): string => {
    return formatRelativeTime(timestamp)
  }, [])

  // Get CSS class based on age
  const getUpdateAgeClass = useCallback((timestamp: number): string => {
    return getUpdateAgeClass(timestamp)
  }, [])

  // Load initial last update from backend with deduplication
  const loadLastUpdate = useCallback(async (taskId: string): Promise<void> => {
    // Skip if already watched and recently fetched
    if (watchedTasksRef.current.has(taskId)) {
      const lastFetch = lastFetchTimeRef.current[taskId] || 0
      if (Date.now() - lastFetch < CACHE_TTL) {
        return
      }
    }

    watchedTasksRef.current.add(taskId)

    try {
      const data = await dedupFetch.fetchWithDedup(`/api/tasks/${taskId}/last-update`) as {
        taskId: string
        lastUpdateAt: number | null
      } | null

      if (data?.lastUpdateAt !== null) {
        setLastUpdateMap(prev => ({ ...prev, [taskId]: data.lastUpdateAt }))
      }
      lastFetchTimeRef.current[taskId] = Date.now()
    } catch (error) {
      console.error(`[useTaskLastUpdate] Failed to load last update for task ${taskId}:`, error)
      watchedTasksRef.current.delete(taskId)
    }
  }, [dedupFetch])

  // Listen for WebSocket events
  useEffect(() => {
    if (!wsHook) return

    const unsubscribe = wsHook.on('session_message_created', (payload) => {
      const msg = payload as SessionMessage
      if (msg.taskId && msg.timestamp) {
        setLastUpdateMap(prev => {
          const current = prev[msg.taskId!]
          // Only update if this message is newer
          if (!current || msg.timestamp > current) {
            return { ...prev, [msg.taskId!]: msg.timestamp }
          }
          return prev
        })
      }
    })

    return () => {
      unsubscribe()
    }
  }, [wsHook])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      watchedTasksRef.current.clear()
      dedupFetch.clearCache()
    }
  }, [dedupFetch])

  return useMemo(() => ({
    lastUpdateMap,
    getLastUpdate,
    formatLastUpdate,
    loadLastUpdate,
    getUpdateAgeClass,
  }), [lastUpdateMap, getLastUpdate, formatLastUpdate, loadLastUpdate, getUpdateAgeClass])
}
