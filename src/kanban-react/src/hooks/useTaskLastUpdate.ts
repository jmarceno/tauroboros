import { useState, useCallback, useRef, useEffect } from 'react'
import { useWebSocketContext } from '@/contexts/AppContext'
import type { SessionMessage } from '@/types'

interface LastUpdateMap {
  [taskId: string]: number
}

interface TaskLastUpdateHook {
  lastUpdateMap: LastUpdateMap
  getLastUpdate: (taskId: string) => number | undefined
  formatLastUpdate: (timestamp: number) => string
  loadLastUpdate: (taskId: string) => Promise<void>
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

export function useTaskLastUpdate(): TaskLastUpdateHook & {
  getUpdateAgeClass: (timestamp: number) => string
} {
  const [lastUpdateMap, setLastUpdateMap] = useState<LastUpdateMap>({})
  const ws = useWebSocketContext()

  // Track which tasks we're watching to avoid duplicate loads
  const watchedTasksRef = useRef<Set<string>>(new Set())

  // Get last update timestamp for a task
  const getLastUpdate = useCallback((taskId: string): number | undefined => {
    return lastUpdateMap[taskId]
  }, [lastUpdateMap])

  // Format timestamp as relative time
  const formatLastUpdate = useCallback((timestamp: number): string => {
    return formatRelativeTime(timestamp)
  }, [])

  // Get CSS class based on age
  const getUpdateAgeClassCallback = useCallback((timestamp: number): string => {
    return getUpdateAgeClass(timestamp)
  }, [])

  // Load initial last update from backend
  const loadLastUpdate = useCallback(async (taskId: string): Promise<void> => {
    if (watchedTasksRef.current.has(taskId)) return
    watchedTasksRef.current.add(taskId)

    try {
      const response = await fetch(`/api/tasks/${taskId}/last-update`)
      if (!response.ok) {
        if (response.status === 404) {
          // Task not found, remove from watched
          watchedTasksRef.current.delete(taskId)
          return
        }
        throw new Error(`Failed to load last update: ${response.status}`)
      }
      const data = await response.json() as { taskId: string; lastUpdateAt: number | null }
      if (data.lastUpdateAt !== null) {
        setLastUpdateMap(prev => ({ ...prev, [taskId]: data.lastUpdateAt }))
      }
    } catch (error) {
      console.error(`[useTaskLastUpdate] Failed to load last update for task ${taskId}:`, error)
      watchedTasksRef.current.delete(taskId)
    }
  }, [])

  // Listen for WebSocket events
  useEffect(() => {
    const unsubscribe = ws.on('session_message_created', (payload) => {
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
  }, [ws])

  return {
    lastUpdateMap,
    getLastUpdate,
    formatLastUpdate,
    loadLastUpdate,
    getUpdateAgeClass: getUpdateAgeClassCallback,
  }
}
