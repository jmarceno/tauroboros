import { ref, computed } from 'vue'
import type { Task, TaskStatus, BestOfNSummary, ColumnSortOption, ColumnSortPreferences } from '@/types/api'
import { useApi } from './useApi'

export function useTasks(columnSorts?: { value: ColumnSortPreferences | undefined }) {
  const api = useApi()
  const tasks = ref<Task[]>([])
  const bonSummaries = ref<Record<string, BestOfNSummary>>({})
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const sortFns: Record<ColumnSortOption, (a: Task, b: Task) => number> = {
    'manual': (a, b) => a.idx - b.idx,
    'name-asc': (a, b) => a.name.localeCompare(b.name),
    'name-desc': (a, b) => b.name.localeCompare(a.name),
    'created-asc': (a, b) => a.createdAt - b.createdAt,
    'created-desc': (a, b) => b.createdAt - a.createdAt,
    'updated-asc': (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
    'updated-desc': (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  }

  const getSortForColumn = (status: TaskStatus): ColumnSortOption => {
    const sorts = columnSorts?.value
    if (!sorts) return 'manual'
    return (sorts as Record<string, ColumnSortOption>)[status] || 'manual'
  }

  // Function to get grouped tasks (called on demand from template)
  const getGroupedTasks = (): Record<TaskStatus | 'failed' | 'stuck', Task[]> => {
    // Default empty groups
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

    // Handle case where tasks might not be loaded yet
    if (!tasks.value || !Array.isArray(tasks.value)) {
      return groups
    }

    for (const task of tasks.value) {
      if (!task) continue
      if (task.status === 'failed' || task.status === 'stuck') {
        groups.review.push(task)
      } else if (task.status && task.status in groups) {
        groups[task.status as TaskStatus].push(task)
      }
    }

    return groups
  }

  // Keep computed for backward compatibility but use the function internally
  const groupedTasks = computed(getGroupedTasks)

  const getTaskById = (id: string) => tasks.value.find(t => t.id === id)
  const getTaskName = (id: string) => getTaskById(id)?.name || id

  const loadTasks = async () => {
    isLoading.value = true
    error.value = null
    try {
      tasks.value = await api.getTasks()
      await refreshBonSummaries()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading.value = false
    }
  }

  const refreshBonSummaries = async (taskIds?: string[]) => {
    const targetIds = taskIds ?? tasks.value
      .filter(t => t.executionStrategy === 'best_of_n')
      .map(t => t.id)

    if (targetIds.length === 0) {
      bonSummaries.value = {}
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

    for (const { id, summary } of results) {
      if (summary) {
        bonSummaries.value[id] = summary
      }
    }
  }

  const createTask = async (data: Parameters<typeof api.createTask>[0]) => {
    const task = await api.createTask(data)
    // Check if task already exists (WebSocket may have added it first)
    if (!getTaskById(task.id)) {
      tasks.value.push(task)
    }
    return task
  }

  const updateTask = async (id: string, data: Parameters<typeof api.updateTask>[1]) => {
    const task = await api.updateTask(id, data)
    const idx = tasks.value.findIndex(t => t.id === id)
    if (idx >= 0) {
      tasks.value[idx] = task
    }
    if (task.executionStrategy === 'best_of_n') {
      await refreshBonSummaries([task.id])
    }
    return task
  }

  const deleteTask = async (id: string) => {
    const result = await api.deleteTask(id)
    delete bonSummaries.value[id]
    tasks.value = tasks.value.filter(t => t.id !== id)
    return result
  }

  const reorderTask = async (id: string, newIdx: number) => {
    await api.reorderTask(id, newIdx)
    await loadTasks()
  }

  const archiveAllDone = async () => {
    const result = await api.archiveAllDone()
    await loadTasks()
    return result
  }

  const resetTask = async (id: string) => {
    const task = await api.resetTask(id)
    const idx = tasks.value.findIndex(t => t.id === id)
    if (idx >= 0) {
      tasks.value[idx] = task
    }
    return task
  }

  const approvePlan = async (id: string, message?: string) => {
    const task = await api.approvePlan(id, message)
    const idx = tasks.value.findIndex(t => t.id === id)
    if (idx >= 0) {
      tasks.value[idx] = task
    }
    return task
  }

  const requestPlanRevision = async (id: string, feedback: string) => {
    const task = await api.requestPlanRevision(id, feedback)
    const idx = tasks.value.findIndex(t => t.id === id)
    if (idx >= 0) {
      tasks.value[idx] = task
    }
    return task
  }

  const repairTask = async (id: string, action: string, options?: Parameters<typeof api.repairTask>[2]) => {
    const result = await api.repairTask(id, action, options)
    const idx = tasks.value.findIndex(t => t.id === id)
    if (idx >= 0) {
      tasks.value[idx] = result.task
    }
    return result
  }

  const startSingleTask = async (id: string) => {
    return await api.startSingleTask(id)
  }

  return {
    tasks,
    groupedTasks,
    bonSummaries,
    isLoading,
    error,
    api,
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
  }
}
