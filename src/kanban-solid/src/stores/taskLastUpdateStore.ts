/**
 * Task Last Update Store - Tracks last update timestamps for tasks
 * Replaces: TaskLastUpdateContext
 */

import { createSignal } from 'solid-js'
import { useQueryClient } from '@tanstack/solid-query'
import { Effect, Either } from 'effect'
import { tasksApi, runApiEffect } from '@/api'

const queryKeys = {
  tasks: {
    lastUpdate: (taskId: string) => ['tasks', 'lastUpdate', taskId] as const,
  },
}

export function createTaskLastUpdateStore() {
  const queryClient = useQueryClient()
  const [lastUpdates, setLastUpdates] = createSignal<Record<string, number>>({})
  const [lastUpdateErrors, setLastUpdateErrors] = createSignal<Record<string, string>>({})

  const setLastUpdateError = (taskId: string, message: string | null) => {
    setLastUpdateErrors(prev => {
      const next = { ...prev }
      if (message) {
        next[taskId] = message
      } else {
        delete next[taskId]
      }
      return next
    })
  }

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
  const loadLastUpdateEffect = (taskId: string) =>
    tasksApi.getLastUpdate(taskId).pipe(
      Effect.map((data) => {
        if (data.lastUpdateAt !== null) {
          setLastUpdates(prev => ({ ...prev, [taskId]: data.lastUpdateAt }))
          queryClient.setQueryData(queryKeys.tasks.lastUpdate(taskId), data.lastUpdateAt)
          setLastUpdateError(taskId, null)
          return data.lastUpdateAt
        }

        setLastUpdateError(taskId, null)
        return null
      }),
      Effect.tapError((error) =>
        Effect.logError(`[task-last-update-store] Failed to load last update for task ${taskId}: ${error.message}`),
      ),
      Effect.either,
      Effect.flatMap((result) =>
        Effect.sync(() => {
          if (Either.isLeft(result)) {
            setLastUpdateError(taskId, result.left.message)
            return null
          }
          return result.right
        })
      ),
    )

  const loadLastUpdate = (taskId: string) => runApiEffect(loadLastUpdateEffect(taskId))

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
    lastUpdateErrors,
  }
}
