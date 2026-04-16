import { useState, useCallback, useMemo } from 'react'
import type { WorkflowRun, Task } from '@/types'
import { useApi } from './useApi'

export function useRuns() {
  const api = useApi()
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [tasksRef, setTasksRef] = useState<Task[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    return run.taskOrder?.includes(taskId) || false
  }, [runs])

  const getRunProgressLabel = useCallback((run: WorkflowRun) => {
    const total = run.taskOrder?.length ?? 0
    const completed = Math.min(run.currentTaskIndex ?? 0, total)
    if (total === 0) return 'No tasks'
    return `${completed}/${total} tasks complete`
  }, [])

  const loadRuns = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await api.getRuns()
      setRuns(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [api])

  const pauseRun = useCallback(async (id: string) => {
    const run = await api.pauseRun(id)
    setRuns(prev => prev.map(r => r.id === id ? run : r))
    return run
  }, [api])

  const resumeRun = useCallback(async (id: string) => {
    const run = await api.resumeRun(id)
    setRuns(prev => prev.map(r => r.id === id ? run : r))
    return run
  }, [api])

  const stopRun = useCallback(async (id: string) => {
    const run = await api.stopRun(id)
    setRuns(prev => prev.map(r => r.id === id ? run : r))
    return run
  }, [api])

  const archiveRun = useCallback(async (id: string) => {
    await api.archiveRun(id)
    setRuns(prev => prev.filter(r => r.id !== id))
  }, [api])

  const updateRunFromWebSocket = useCallback((run: WorkflowRun) => {
    setRuns(prev => {
      const idx = prev.findIndex(r => r.id === run.id)
      if (idx >= 0) {
        return prev.map(r => r.id === run.id ? run : r)
      } else {
        return [run, ...prev]
      }
    })
  }, [])

  const removeRun = useCallback((id: string) => {
    setRuns(prev => prev.filter(r => r.id !== id))
  }, [])

  const setTasksReference = useCallback((tasks: Task[]) => {
    setTasksRef(tasks)
  }, [])

  const contextValue = useMemo(() => ({
    runs,
    activeRuns,
    staleRuns,
    hasStaleRuns,
    consumedRunSlots,
    isLoading,
    error,
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
  }), [
    runs, activeRuns, staleRuns, hasStaleRuns, consumedRunSlots, isLoading, error,
    setTasksReference, isStaleRun, getTaskRunLock, isTaskMutationLocked, getTaskRunColor,
    isTaskInRun, getRunProgressLabel, loadRuns, pauseRun, resumeRun, stopRun, archiveRun,
    updateRunFromWebSocket, removeRun
  ])

  return contextValue
}
