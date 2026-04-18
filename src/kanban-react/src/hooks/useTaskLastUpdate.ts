/**
 * Task Last Update Hook - TanStack Query Wrapper
 */

import { useMemo, useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { tasksApi } from '@/api'
import type { WebSocketHook } from './useWebSocket.ts'

interface LastUpdateMap {
  [taskId: string]: number
}

/**
 * Format a timestamp as a relative time string (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp * 1000
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 10) return "just now"
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

  if (diffMin < 2) return "recent"
  if (diffMin < 30) return "medium"
  return "old"
}

export function useTaskLastUpdate(wsHook: WebSocketHook) {
  const queryClient = useQueryClient()

  // Get last update timestamp for a task
  const getLastUpdate = useCallback((taskId: string): number | undefined => {
    const data = queryClient.getQueryData<{ taskId: string; lastUpdateAt: number | null }>(
      ['tasks', 'detail', taskId, 'lastUpdate']
    )
    return data?.lastUpdateAt ?? undefined
  }, [queryClient])

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
    const data = await tasksApi.getLastUpdate(taskId)
    queryClient.setQueryData(['tasks', 'detail', taskId, 'lastUpdate'], data)
  }, [queryClient])

  // Build lastUpdateMap from query cache
  const lastUpdateMap = useMemo(() => {
    const map: LastUpdateMap = {}
    // We can't know all task IDs without listing them, so this is reactive to what has been loaded
    return map
  }, [])

  // Listen for WebSocket events
  useEffect(() => {
    if (!wsHook) return

    const unsubscribe = wsHook.on('session_message_created', (payload) => {
      const msg = payload as { taskId?: string; timestamp?: number }
      if (msg.taskId && msg.timestamp) {
        const current = getLastUpdate(msg.taskId)
        // Only update if this message is newer
        if (!current || msg.timestamp > current) {
          queryClient.setQueryData(
            ['tasks', 'detail', msg.taskId, 'lastUpdate'],
            { taskId: msg.taskId, lastUpdateAt: msg.timestamp }
          )
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [wsHook, queryClient, getLastUpdate])

  return {
    lastUpdateMap,
    getLastUpdate,
    formatLastUpdate,
    loadLastUpdate,
    getUpdateAgeClass: getUpdateAgeClassCallback,
  }
}
