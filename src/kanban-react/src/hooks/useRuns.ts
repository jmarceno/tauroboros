import { useState, useCallback, useMemo, useRef, useEffect } from "react"
import type { WorkflowRun, Task } from "@/types"
import { useApi } from "./useApi"

export function useRuns() {
  const api = useApi()
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [tasksRef, setTasksRef] = useState<Task[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mounted ref to prevent setState on unmounted component
  const isMountedRef = useRef(true)
  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

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
    if (!run.taskOrder) return false

    // Check if task is directly in the run
    if (run.taskOrder.includes(taskId)) return true

    // Check if task is a dependency of any task in the run
    // Build a map of all tasks for dependency lookup
    const taskMap = new Map(tasksRef.map(t => [t.id, t]))

    // Collect all dependency IDs for tasks in this run
    const visited = new Set<string>()
    const toVisit = [...run.taskOrder]

    while (toVisit.length > 0) {
      const currentId = toVisit.pop()!
      if (visited.has(currentId)) continue
      visited.add(currentId)

      const task = taskMap.get(currentId)
      if (!task) continue

      // Check if this task depends on the target task
      if (task.requirements?.includes(taskId)) return true

      // Add this task's dependencies to visit queue (for transitive deps)
      for (const depId of task.requirements || []) {
        if (!visited.has(depId)) {
          toVisit.push(depId)
        }
      }
    }

    return false
  }, [runs, tasksRef])

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
      // Only update state if component is still mounted
      if (isMountedRef.current) {
        setRuns(data)
      }
    } catch (e) {
      if (isMountedRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [api])

  const pauseRun = useCallback(async (id: string) => {
    const run = await api.pauseRun(id)
    if (isMountedRef.current) {
      setRuns(prev => prev.map(r => r.id === id ? run : r))
    }
    return run
  }, [api])

  const resumeRun = useCallback(async (id: string) => {
    const run = await api.resumeRun(id)
    if (isMountedRef.current) {
      setRuns(prev => prev.map(r => r.id === id ? run : r))
    }
    return run
  }, [api])

  const stopRun = useCallback(async (id: string) => {
    const run = await api.stopRun(id)
    if (isMountedRef.current) {
      setRuns(prev => prev.map(r => r.id === id ? run : r))
    }
    return run
  }, [api])

  const archiveRun = useCallback(async (id: string) => {
    await api.archiveRun(id)
    if (isMountedRef.current) {
      setRuns(prev => prev.filter(r => r.id !== id))
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    runs, activeRuns, staleRuns, hasStaleRuns, consumedRunSlots,
    setTasksReference, isStaleRun, getTaskRunLock, isTaskMutationLocked, getTaskRunColor,
    isTaskInRun, getRunProgressLabel, loadRuns, pauseRun, resumeRun, stopRun, archiveRun,
    updateRunFromWebSocket, removeRun
  ])

  return contextValue
}
