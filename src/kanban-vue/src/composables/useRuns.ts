import { ref, computed } from 'vue'
import type { WorkflowRun } from '@/types/api'
import { useApi } from './useApi'

export function useRuns() {
  const api = useApi()
  const runs = ref<WorkflowRun[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const activeRuns = computed(() =>
    runs.value.filter(r => r.status === 'running' || r.status === 'stopping' || r.status === 'paused')
  )

  const consumedRunSlots = computed(() =>
    runs.value.filter(r => r.status === 'running' || r.status === 'stopping').length
  )

  const getTaskRunLock = (taskId: string) => {
    return runs.value.find(r =>
      (r.status === 'running' || r.status === 'stopping') &&
      r.currentTaskId === taskId
    ) || null
  }

  const isTaskMutationLocked = (taskId: string) => !!getTaskRunLock(taskId)

  const getTaskRunColor = (taskId: string) => {
    for (const run of runs.value) {
      if (run.status === 'running' || run.status === 'stopping' || run.status === 'paused') {
        if (run.taskOrder?.includes(taskId)) {
          return run.color || '#888888'
        }
      }
    }
    return null
  }

  const getRunProgressLabel = (run: WorkflowRun) => {
    const total = run.taskOrder?.length ?? 0
    const completed = Math.min(run.currentTaskIndex ?? 0, total)
    if (total === 0) return 'No tasks'
    return `${completed}/${total} tasks complete`
  }

  const loadRuns = async () => {
    isLoading.value = true
    error.value = null
    try {
      runs.value = await api.getRuns()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading.value = false
    }
  }

  const pauseRun = async (id: string) => {
    const run = await api.pauseRun(id)
    const idx = runs.value.findIndex(r => r.id === id)
    if (idx >= 0) {
      runs.value[idx] = run
    }
    return run
  }

  const resumeRun = async (id: string) => {
    const run = await api.resumeRun(id)
    const idx = runs.value.findIndex(r => r.id === id)
    if (idx >= 0) {
      runs.value[idx] = run
    }
    return run
  }

  const stopRun = async (id: string) => {
    const run = await api.stopRun(id)
    const idx = runs.value.findIndex(r => r.id === id)
    if (idx >= 0) {
      runs.value[idx] = run
    }
    return run
  }

  const archiveRun = async (id: string) => {
    await api.archiveRun(id)
    runs.value = runs.value.filter(r => r.id !== id)
  }

  const updateRunFromWebSocket = (run: WorkflowRun) => {
    const idx = runs.value.findIndex(r => r.id === run.id)
    if (idx >= 0) {
      runs.value[idx] = run
    } else {
      runs.value.unshift(run)
    }
  }

  const removeRun = (id: string) => {
    runs.value = runs.value.filter(r => r.id !== id)
  }

  return {
    runs,
    activeRuns,
    consumedRunSlots,
    isLoading,
    error,
    getTaskRunLock,
    isTaskMutationLocked,
    getTaskRunColor,
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
