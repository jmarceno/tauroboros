/**
 * Workflow Runs Hook - TanStack Query Wrapper
 */

import { useState, useMemo, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useRunsQuery,
  usePauseRunMutation,
  useResumeRunMutation,
  useStopRunMutation,
  useForceStopRunMutation,
  useArchiveRunMutation,
  queryKeys,
} from '@/queries'
import type { WorkflowRun, Task } from '@/types'

export function useRuns() {
  const queryClient = useQueryClient()
  
  // Keep track of tasks for stale run detection
  const [tasksRef, setTasksRef] = useState<Task[]>([])
  
  // Use TanStack Query for runs
  const { data: runs = [], isLoading, error } = useRunsQuery()
  
  // Mutations
  const pauseRunMutation = usePauseRunMutation()
  const resumeRunMutation = useResumeRunMutation()
  const stopRunMutation = useStopRunMutation()
  const forceStopRunMutation = useForceStopRunMutation()
  const archiveRunMutation = useArchiveRunMutation()

  const isStaleRun = useCallback((run: WorkflowRun): boolean => {
    if (run.status !== 'running' && run.status !== 'stopping' && run.status !== 'paused') {
      return false
    }

    if (!run.taskOrder || run.taskOrder.length === 0) {
      return true
    }

    const hasExecutingTask = run.taskOrder.some((taskId) => {
      const task = tasksRef.find((t) => t.id === taskId)
      return task?.status === 'executing'
    })

    return !hasExecutingTask
  }, [tasksRef])

  // Computed values
  const activeRuns = useMemo(() =>
    runs.filter(r => r.status === 'running' || r.status === 'stopping' || r.status === 'paused'),
    [runs]
  )

  const staleRuns = useMemo(() =>
    runs.filter(r => isStaleRun(r)),
    [runs, isStaleRun]
  )

  const hasStaleRuns = useMemo(() => staleRuns.length > 0, [staleRuns])

  const consumedRunSlots = useMemo(() => {
    return runs.filter(r =>
      (r.status === 'running' || r.status === 'stopping') && !isStaleRun(r)
    ).length
  }, [runs, isStaleRun])

  // Helper functions
  const getTaskRunLock = useCallback((taskId: string) => {
    return runs.find(r =>
      (r.status === 'running' || r.status === 'stopping') &&
      r.currentTaskId === taskId
    ) || null
  }, [runs])

  const isTaskMutationLocked = useCallback((taskId: string) => !!getTaskRunLock(taskId), [getTaskRunLock])

  const getTaskRunColor = useCallback((taskId: string) => {
    for (const run of runs) {
      if (run.status === 'running' || run.status === 'stopping' || run.status === 'paused') {
        if (run.taskOrder?.includes(taskId)) {
          return run.color || '#888888'
        }
      }
    }
    return null
  }, [runs])

  const isTaskInRun = useCallback((taskId: string, runId: string | null): boolean => {
    if (!runId) return false
    const run = runs.find(r => r.id === runId)
    if (!run) return false
    if (!run.taskOrder) return false
    return run.taskOrder.includes(taskId)
  }, [runs])

  const getRunProgressLabel = useCallback((run: WorkflowRun) => {
    const total = run.taskOrder?.length ?? 0
    const completed = Math.min(run.currentTaskIndex ?? 0, total)
    if (total === 0) return 'No tasks'
    return `${completed}/${total} tasks complete`
  }, [])

  // Actions
  const loadRuns = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
  }, [queryClient])

  const pauseRun = useCallback(async (id: string) => {
    return await pauseRunMutation.mutateAsync(id)
  }, [pauseRunMutation])

  const resumeRun = useCallback(async (id: string) => {
    return await resumeRunMutation.mutateAsync(id)
  }, [resumeRunMutation])

  const stopRun = useCallback(async (id: string) => {
    return await stopRunMutation.mutateAsync({ id, destructive: false })
  }, [stopRunMutation])

  const archiveRun = useCallback(async (id: string) => {
    await archiveRunMutation.mutateAsync(id)
  }, [archiveRunMutation])

  // WebSocket update handler - updates cache directly
  const updateRunFromWebSocket = useCallback((run: WorkflowRun) => {
    queryClient.setQueryData(queryKeys.runs.detail(run.id), run)
    queryClient.setQueryData<WorkflowRun[]>(queryKeys.runs.lists(), (old) => {
      if (!old) return [run]
      const idx = old.findIndex(r => r.id === run.id)
      if (idx >= 0) {
        return old.map(r => r.id === run.id ? run : r)
      }
      return [run, ...old]
    })
  }, [queryClient])

  const removeRun = useCallback((id: string) => {
    queryClient.removeQueries({ queryKey: queryKeys.runs.detail(id) })
    queryClient.setQueryData<WorkflowRun[]>(queryKeys.runs.lists(), (old) => {
      if (!old) return []
      return old.filter(r => r.id !== id)
    })
  }, [queryClient])

  const setTasksReference = useCallback((tasks: Task[]) => {
    setTasksRef(tasks)
  }, [])

  return {
    runs,
    activeRuns,
    staleRuns,
    hasStaleRuns,
    consumedRunSlots,
    isLoading,
    error: error?.message ?? null,
    setTasksRef: setTasksReference,
    isStaleRun,
    getTaskRunLock,
    isTaskMutationLocked,
    getTaskRunColor,
    isTaskInRun,
    getRunProgressLabel,
    loadRuns,
    pauseRun,
    resumeRun,
    stopRun,
    archiveRun,
    updateRunFromWebSocket,
    removeRun,
  }
}
