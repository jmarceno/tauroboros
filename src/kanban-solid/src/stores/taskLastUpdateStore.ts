/**
 * Task Last Update Store - Tracks last update timestamps for tasks
 * Replaces: TaskLastUpdateContext
 */

import { createSignal } from 'solid-js'
import { useQueryClient } from '@tanstack/solid-query'
import { tasksApi, runApiEffect } from '@/api'

const queryKeys = {
  tasks: {
    lastUpdate: (taskId: string) => ['tasks', 'lastUpdate', taskId] as const,
  },
}

export function createTaskLastUpdateStore() {
  const queryClient = useQueryClient()
  const [lastUpdates, setLastUpdates] = createSignal<Record<string, number>>({})

  // Get last update for a task (from local state or query cache)
  const getLastUpdate = (taskId: string): number | null => {
    // First check local state (for WebSocket updates)
    const localValue = lastUpdates()[taskId]
    if (localValue) return localValue

    // Then check query cache
    const cached = queryClient.getQueryData<number>(queryKeys.tasks.lastUpdate(taskId))
    return cached ?? null
  }

  // Load last update from backend
  const loadLastUpdate = async (taskId: string): Promise<number | null> => {
    try {
      const data = await runApiEffect(tasksApi.getLastUpdate(taskId))
      if (data.lastUpdateAt !== null) {
        // Update local state
        setLastUpdates(prev => ({ ...prev, [taskId]: data.lastUpdateAt }))
        // Update query cache
        queryClient.setQueryData(queryKeys.tasks.lastUpdate(taskId), data.lastUpdateAt)
        return data.lastUpdateAt
      }
      return null
    } catch {
      return null
    }
  }

  // Update last update timestamp (typically called from WebSocket)
  const updateLastUpdate = (taskId: string, timestamp: number) => {
    setLastUpdates(prev => ({ ...prev, [taskId]: timestamp }))
    queryClient.setQueryData(queryKeys.tasks.lastUpdate(taskId), timestamp)
  }

  // Clear all tracked updates
  const clearAll = () => {
    setLastUpdates({})
  }

  return {
    lastUpdates,
    getLastUpdate,
    loadLastUpdate,
    updateLastUpdate,
    clearAll,
  }
}
