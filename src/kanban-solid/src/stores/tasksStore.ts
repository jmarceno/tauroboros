/**
 * Tasks Store - Task data management with TanStack Query
 * Replaces: TasksContext
 */

import { createSignal, createMemo, batch } from 'solid-js'
import { createQuery, useQueryClient, createMutation } from '@tanstack/solid-query'
import type { Task, TaskStatus, BestOfNSummary, ColumnSortPreferences, ColumnSortOption, UpdateTaskDTO } from '@/types'
import * as api from '@/api'

const sortFns: Record<ColumnSortOption, (a: Task, b: Task) => number> = {
  'manual': (a, b) => a.idx - b.idx,
  'name-asc': (a, b) => a.name.localeCompare(b.name),
  'name-desc': (a, b) => b.name.localeCompare(a.name),
  'created-asc': (a, b) => a.createdAt - b.createdAt,
  'created-desc': (a, b) => b.createdAt - a.createdAt,
  'updated-asc': (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
  'updated-desc': (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
}

// Query keys
const queryKeys = {
  tasks: {
    all: ['tasks'] as const,
    lists: () => [...queryKeys.tasks.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.tasks.all, 'detail', id] as const,
  },
  bonSummaries: (taskIds: string[]) => ['tasks', 'bestOfNSummaries', taskIds.sort()] as const,
}

export function createTasksStore(columnSorts?: ColumnSortPreferences) {
  const queryClient = useQueryClient()

  // Queries
  const tasksQuery = createQuery(() => ({
    queryKey: queryKeys.tasks.lists(),
    queryFn: () => api.tasksApi.getAll(),
    staleTime: 5000,
  }))

  const tasks = createMemo(() => tasksQuery.data || [])
  const isLoading = () => tasksQuery.isLoading
  const error = () => tasksQuery.error?.message || null

  // BestOfN summaries query
  const bonTaskIds = createMemo(() => 
    tasks().filter(t => t.executionStrategy === 'best_of_n').map(t => t.id)
  )

  const bonSummariesQuery = createQuery(() => ({
    queryKey: queryKeys.bonSummaries(bonTaskIds()),
    queryFn: () => api.fetchBestOfNSummaries(bonTaskIds()),
    enabled: bonTaskIds().length > 0,
    staleTime: 3000,
  }))

  const bonSummaries = createMemo(() => bonSummariesQuery.data || {})

  // Grouped tasks with sorting
  const groupedTasks = createMemo(() => {
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

    for (const task of tasks()) {
      if (!task) continue
      if (task.status === 'failed' || task.status === 'stuck') {
        groups.review.push(task)
      } else if (task.status && task.status in groups) {
        groups[task.status as TaskStatus].push(task)
      }
    }

    // Apply column-specific sorting
    for (const status of Object.keys(groups) as Array<keyof typeof groups>) {
      const sortKey = columnSorts?.[status as TaskStatus] ?? 'manual'
      const sortFn = sortFns[sortKey]
      if (sortFn) {
        groups[status].sort(sortFn)
      }
    }

    return groups
  })

  // Actions
  const loadTasks = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
  }

  const getTaskById = (id: string) => tasks().find(t => t.id === id)
  const getTaskName = (id: string) => getTaskById(id)?.name || id

  // Mutations
  const createTaskMutation = createMutation(() => ({
    mutationFn: (data: Parameters<typeof api.tasksApi.create>[0]) => api.tasksApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const updateTaskMutation = createMutation(() => ({
    mutationFn: ({ id, data }: { id: string; data: UpdateTaskDTO }) => api.tasksApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const deleteTaskMutation = createMutation(() => ({
    mutationFn: (id: string) => api.tasksApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const resetTaskMutation = createMutation(() => ({
    mutationFn: (id: string) => api.tasksApi.reset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const resetTaskToGroupMutation = createMutation(() => ({
    mutationFn: (id: string) => api.tasksApi.resetToGroup(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const moveTaskToGroupMutation = createMutation(() => ({
    mutationFn: ({ id, groupId }: { id: string; groupId: string | null }) => api.tasksApi.moveToGroup(id, groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const approvePlanMutation = createMutation(() => ({
    mutationFn: ({ id, message }: { id: string; message?: string }) => api.tasksApi.approvePlan(id, message),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const requestPlanRevisionMutation = createMutation(() => ({
    mutationFn: ({ id, feedback }: { id: string; feedback: string }) => api.tasksApi.requestPlanRevision(id, feedback),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const repairTaskMutation = createMutation(() => ({
    mutationFn: ({ id, action, options }: { id: string; action: string; options?: Record<string, unknown> }) => api.tasksApi.repair(id, action, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const startSingleTaskMutation = createMutation(() => ({
    mutationFn: (id: string) => api.tasksApi.startSingle(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const archiveAllDoneMutation = createMutation(() => ({
    mutationFn: () => api.tasksApi.archiveAllDone(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const batchUpdateTasksMutation = createMutation(() => ({
    mutationFn: ({ ids, data }: { ids: string[]; data: UpdateTaskDTO }) => 
      Promise.all(ids.map(id => api.tasksApi.update(id, data))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const restoreTaskMutation = createMutation(() => ({
    mutationFn: ({ id, groupId }: { id: string; groupId?: string }) => {
      if (groupId) {
        return api.tasksApi.moveToGroup(id, groupId)
      }
      return api.tasksApi.resetToGroup(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  const selectWinnerSessionMutation = createMutation(() => ({
    mutationFn: ({ taskId, candidateId }: { taskId: string; candidateId: string }) => 
      api.tasksApi.selectCandidate(taskId, candidateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
  }))

  // Wrappers
  const createTask = async (data: Parameters<typeof api.tasksApi.create>[0]) => {
    return await createTaskMutation.mutateAsync(data)
  }

  const updateTask = async (id: string, data: UpdateTaskDTO) => {
    return await updateTaskMutation.mutateAsync({ id, data })
  }

  const deleteTask = async (id: string) => {
    return await deleteTaskMutation.mutateAsync(id)
  }

  const resetTask = async (id: string) => {
    return await resetTaskMutation.mutateAsync(id)
  }

  const resetTaskToGroup = async (id: string) => {
    return await resetTaskToGroupMutation.mutateAsync(id)
  }

  const moveTaskToGroup = async (id: string, groupId: string | null) => {
    return await moveTaskToGroupMutation.mutateAsync({ id, groupId })
  }

  const approvePlan = async (id: string, message?: string) => {
    return await approvePlanMutation.mutateAsync({ id, message })
  }

  const requestPlanRevision = async (id: string, feedback: string) => {
    return await requestPlanRevisionMutation.mutateAsync({ id, feedback })
  }

  const repairTask = async (id: string, action: string, options?: Record<string, unknown>) => {
    return await repairTaskMutation.mutateAsync({ id, action, options })
  }

  const startSingleTask = async (id: string) => {
    return await startSingleTaskMutation.mutateAsync(id)
  }

  const archiveAllDone = async () => {
    return await archiveAllDoneMutation.mutateAsync()
  }

  const batchUpdateTasks = async (ids: string[], data: UpdateTaskDTO) => {
    return await batchUpdateTasksMutation.mutateAsync({ ids, data })
  }

  const restoreTask = async (id: string, groupId?: string) => {
    return await restoreTaskMutation.mutateAsync({ id, groupId })
  }

  const selectWinnerSession = async (taskId: string, candidateId: string) => {
    return await selectWinnerSessionMutation.mutateAsync({ taskId, candidateId })
  }

  const refreshBonSummaries = async (taskIds?: string[]) => {
    const targetIds = taskIds ?? bonTaskIds()
    if (targetIds.length > 0) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.bonSummaries(targetIds) })
    }
  }

  const removeBonSummary = (id: string) => {
    queryClient.setQueryData<Record<string, BestOfNSummary>>(
      queryKeys.bonSummaries(bonTaskIds()),
      (old) => {
        if (!old) return {}
        const next = { ...old }
        delete next[id]
        return next
      }
    )
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
    resetTask,
    resetTaskToGroup,
    moveTaskToGroup,
    approvePlan,
    requestPlanRevision,
    repairTask,
    startSingleTask,
    archiveAllDone,
    batchUpdateTasks,
    restoreTask,
    selectWinnerSession,
    removeBonSummary,
  }
}
