import { ref, computed } from 'vue'
import type { Task, TaskStatus, BestOfNSummary } from '@/types/api'
import { useApi } from './useApi'

export function useTasks() {
  const api = useApi()
  const tasks = ref<Task[]>([])
  const bonSummaries = ref<Record<string, BestOfNSummary>>({})
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const groupedTasks = computed(() => {
    const groups: Record<TaskStatus | 'failed' | 'stuck', Task[]> = {
      template: [],
      backlog: [],
      executing: [],
      review: [],
      done: [],
      failed: [],
      stuck: [],
    }

    for (const task of tasks.value) {
      if (task.status === 'failed' || task.status === 'stuck') {
        groups.review.push(task)
      } else if (task.status in groups) {
        groups[task.status].push(task)
      }
    }

    // Sort backlog and template by idx
    groups.backlog.sort((a, b) => a.idx - b.idx)
    groups.template.sort((a, b) => a.idx - b.idx)

    // Sort done by completedAt descending
    groups.done.sort((a, b) => {
      const aCompleted = a.completedAt ?? 0
      const bCompleted = b.completedAt ?? 0
      if (bCompleted !== aCompleted) return bCompleted - aCompleted
      const aUpdated = a.updatedAt ?? 0
      const bUpdated = b.updatedAt ?? 0
      if (bUpdated !== aUpdated) return bUpdated - aUpdated
      return a.idx - b.idx
    })

    return groups
  })

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
    tasks.value.push(task)
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
