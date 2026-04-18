import { useState, useCallback, useMemo } from "react"
import type { Task, TaskStatus, BestOfNSummary, ColumnSortOption, ColumnSortPreferences } from "@/types"
import { useApi } from "./useApi"

export function useTasks(columnSorts?: ColumnSortPreferences) {
  const api = useApi()
  const [tasks, setTasks] = useState<Task[]>([])
  const [bonSummaries, setBonSummaries] = useState<Record<string, BestOfNSummary>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sortFns: Record<ColumnSortOption, (a: Task, b: Task) => number> = useMemo(() => ({
    'manual': (a, b) => a.idx - b.idx,
    'name-asc': (a, b) => a.name.localeCompare(b.name),
    'name-desc': (a, b) => b.name.localeCompare(a.name),
    'created-asc': (a, b) => a.createdAt - b.createdAt,
    'created-desc': (a, b) => b.createdAt - a.createdAt,
    'updated-asc': (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
    'updated-desc': (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  }), [])

  const getSortForColumn = useCallback((status: TaskStatus): ColumnSortOption => {
    if (!columnSorts) return 'manual'
    return columnSorts[status] || 'manual'
  }, [columnSorts])

  const getGroupedTasks = useCallback((): Record<TaskStatus | 'failed' | 'stuck', Task[]> => {
    const groups: Record<TaskStatus | 'failed' | 'stuck', Task[]> = {
      template: [],
      backlog: [],
      executing: [],
      review: [],
      'code-style': [],
      done: [],
      failed: [],
      stuck: [],
    }

    if (!tasks || !Array.isArray(tasks)) {
      return groups
    }

    for (const task of tasks) {
      if (!task) continue
      if (task.status === 'failed' || task.status === 'stuck') {
        groups.review.push(task)
      } else if (task.status && task.status in groups) {
        groups[task.status as TaskStatus].push(task)
      }
    }

    // Apply column-specific sorting
    for (const status of Object.keys(groups) as Array<keyof typeof groups>) {
      const sortKey = getSortForColumn(status as TaskStatus)
      const sortFn = sortFns[sortKey]
      if (sortFn) {
        groups[status].sort(sortFn)
      }
    }

    return groups
  }, [tasks, sortFns, getSortForColumn])

  const groupedTasks = useMemo(() => getGroupedTasks(), [getGroupedTasks])

  const getTaskById = useCallback((id: string) => tasks.find(t => t.id === id), [tasks])
  const getTaskName = useCallback((id: string) => getTaskById(id)?.name || id, [getTaskById])

  const loadTasks = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await api.getTasks()
      setTasks(data)
      await refreshBonSummaries(data)
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [api])

  const refreshBonSummaries = useCallback(async (taskList?: Task[], specificTaskIds?: string[]) => {
    const targetIds = specificTaskIds ?? taskList
      ?.filter(t => t.executionStrategy === 'best_of_n')
      .map(t => t.id) ?? []

    if (targetIds.length === 0) {
      setBonSummaries({})
      return
    }

    const results = await Promise.all(
      targetIds.map(async (id) => {
        try {
          const summary = await api.getBestOfNSummary(id)
          return { id, summary }
        } catch {
          return { id, summary: null }
        }
      })
    )

    setBonSummaries(prev => {
      const next = { ...prev }
      for (const { id, summary } of results) {
        if (summary) {
          next[id] = summary
        }
      }
      return next
    })
  }, [api])

  /**
   * Creates a new task. Supports codeStyleReview field and all valid TaskStatus values
   * including 'code-style' for workflow-managed code style review state.
   */
  const createTask = useCallback(async (data: Parameters<typeof api.createTask>[0]) => {
    const task = await api.createTask(data)
    setTasks(prev => {
      if (prev.find(t => t.id === task.id)) return prev
      return [...prev, task]
    })
    return task
  }, [api])

  /**
   * Updates a task. Supports status transitions to/from 'code-style' and updates
   * to the codeStyleReview configuration field.
   */
  const updateTask = useCallback(async (id: string, data: Parameters<typeof api.updateTask>[1]) => {
    const task = await api.updateTask(id, data)
    setTasks(prev => prev.map(t => t.id === id ? task : t))
    if (task.executionStrategy === 'best_of_n') {
      await refreshBonSummaries(undefined, [task.id])
    }
    return task
  }, [api, refreshBonSummaries])

  const deleteTask = useCallback(async (id: string) => {
    const result = await api.deleteTask(id)
    setBonSummaries(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setTasks(prev => prev.filter(t => t.id !== id))
    return result
  }, [api])

  const reorderTask = useCallback(async (id: string, newIdx: number) => {
    await api.reorderTask(id, newIdx)
    await loadTasks()
  }, [api, loadTasks])

  const archiveAllDone = useCallback(async () => {
    const result = await api.archiveAllDone()
    await loadTasks()
    return result
  }, [api, loadTasks])

  /**
   * Resets a task to backlog status. Preserves configuration fields including
   * codeStyleReview. Can be called on tasks in any status including 'code-style'.
   */
  const resetTask = useCallback(async (id: string) => {
    const task = await api.resetTask(id)
    setTasks(prev => prev.map(t => t.id === id ? task : t))
    return task
  }, [api])

  const approvePlan = useCallback(async (id: string, message?: string) => {
    const task = await api.approvePlan(id, message)
    setTasks(prev => prev.map(t => t.id === id ? task : t))
    return task
  }, [api])

  const requestPlanRevision = useCallback(async (id: string, feedback: string) => {
    const task = await api.requestPlanRevision(id, feedback)
    setTasks(prev => prev.map(t => t.id === id ? task : t))
    return task
  }, [api])

  const repairTask = useCallback(async (id: string, action: string, options?: Parameters<typeof api.repairTask>[2]) => {
    const result = await api.repairTask(id, action, options)
    setTasks(prev => prev.map(t => t.id === id ? result.task : t))
    return result
  }, [api])

  const startSingleTask = useCallback(async (id: string) => {
    return await api.startSingleTask(id)
  }, [api])

  const setTasksDirectly = useCallback((newTasks: Task[]) => {
    setTasks(newTasks)
  }, [])

  const removeBonSummary = useCallback((id: string) => {
    setBonSummaries(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const contextValue = useMemo(() => ({
    tasks,
    setTasks: setTasksDirectly,
    groupedTasks,
    bonSummaries,
    isLoading,
    error,
    getTaskById,
    getTaskName,
    loadTasks,
    refreshBonSummaries,
    createTask,
    updateTask,
    deleteTask,
    reorderTask,
    archiveAllDone,
    resetTask,
    approvePlan,
    requestPlanRevision,
    repairTask,
    startSingleTask,
    removeBonSummary,
  }), [
    tasks, setTasksDirectly, groupedTasks, bonSummaries, isLoading, error,
    getTaskById, getTaskName, loadTasks, refreshBonSummaries, createTask, updateTask,
    deleteTask, reorderTask, archiveAllDone, resetTask, approvePlan, requestPlanRevision,
    repairTask, startSingleTask, removeBonSummary
  ])

  return contextValue
}
