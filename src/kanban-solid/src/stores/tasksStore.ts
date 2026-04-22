/**
 * Tasks Store - Task data management with TanStack Query
 * Replaces: TasksContext
 */

import { createMemo } from 'solid-js'
import { createQuery, useQueryClient, createMutation } from '@tanstack/solid-query'
import { Effect } from 'effect'
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
  const runApi = api.runApiEffect

  const upsertTaskInListCache = (task: Task) => {
    queryClient.setQueryData<Task[]>(queryKeys.tasks.lists(), (current) => {
      if (!current) return [task]
      const existingIndex = current.findIndex(existingTask => existingTask.id === task.id)
      if (existingIndex === -1) return [...current, task]

      const next = current.slice()
      next[existingIndex] = task
      return next
    })
  }

  const removeTaskFromListCache = (taskId: string) => {
    queryClient.setQueryData<Task[]>(queryKeys.tasks.lists(), (current) => {
      if (!current) return []
      return current.filter(task => task.id !== taskId)
    })
  }

  // Queries
  const tasksQuery = createQuery(() => ({
    queryKey: queryKeys.tasks.lists(),
    queryFn: () => runApi(api.tasksApi.getAll()),
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
    queryFn: () => runApi(api.fetchBestOfNSummaries(bonTaskIds())),
    enabled: bonTaskIds().length > 0,
    staleTime: 3000,
  }))

  const bonSummaries = createMemo(() => bonSummariesQuery.data || {})

  // Grouped tasks with sorting
  const groupedTasks = createMemo(() => {
    const groups: Record<TaskStatus | 'failed' | 'stuck', Task[]> = {
      template: [],
      backlog: [],
      queued: [],
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
      } else if (task.status === 'queued') {
        groups.executing.push(task)
      } else if (task.status && task.status in groups) {
        groups[task.status as TaskStatus].push(task)
      }
    }

    // Apply column-specific sorting
    for (const status of Object.keys(groups) as Array<keyof typeof groups>) {
      let sortKey: ColumnSortOption
      if (status === 'failed' || status === 'stuck') {
        sortKey = columnSorts?.review ?? 'manual'
      } else {
        sortKey = columnSorts?.[status] ?? 'manual'
      }
      const sortFn = sortFns[sortKey]
      if (sortFn) {
        groups[status].sort(sortFn)
      }
    }

    return groups
  })

  // Actions
  const invalidateTasksList = () =>
    runApi(Effect.promise(() => queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })))

  const loadTasks = () => invalidateTasksList()

  const getTaskById = (id: string) => tasks().find(t => t.id === id)
  const getTaskName = (id: string) => getTaskById(id)?.name || id

  // Mutations
  const createTaskMutation = createMutation(() => ({
    mutationFn: (data: Parameters<typeof api.tasksApi.create>[0]) => runApi(api.tasksApi.create(data)),
    onSuccess: (task) => {
      upsertTaskInListCache(task)
      void invalidateTasksList()
    },
  }))

  const updateTaskMutation = createMutation(() => ({
    mutationFn: ({ id, data }: { id: string; data: UpdateTaskDTO }) => runApi(api.tasksApi.update(id, data)),
    onSuccess: (task) => {
      upsertTaskInListCache(task)
      void invalidateTasksList()
    },
  }))

  const deleteTaskMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.tasksApi.delete(id)),
    onSuccess: (_, id) => {
      removeTaskFromListCache(id)
      void invalidateTasksList()
    },
  }))

  const resetTaskMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.tasksApi.reset(id)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const resetTaskToGroupMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.tasksApi.resetToGroup(id)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const moveTaskToGroupMutation = createMutation(() => ({
    mutationFn: ({ id, groupId }: { id: string; groupId: string | null }) => runApi(api.tasksApi.moveToGroup(id, groupId)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const approvePlanMutation = createMutation(() => ({
    mutationFn: ({ id, message }: { id: string; message?: string }) => runApi(api.tasksApi.approvePlan(id, message)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const requestPlanRevisionMutation = createMutation(() => ({
    mutationFn: ({ id, feedback }: { id: string; feedback: string }) => runApi(api.tasksApi.requestPlanRevision(id, feedback)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const repairTaskMutation = createMutation(() => ({
    mutationFn: ({ id, action, options }: { id: string; action: string; options?: Record<string, unknown> }) => runApi(api.tasksApi.repair(id, action, options)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const startSingleTaskMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.tasksApi.startSingle(id)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const archiveAllDoneMutation = createMutation(() => ({
    mutationFn: () => runApi(api.tasksApi.archiveAllDone()),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const batchUpdateTasksMutation = createMutation(() => ({
    mutationFn: ({ ids, data }: { ids: string[]; data: UpdateTaskDTO }) => 
      runApi(Effect.forEach(ids, (id) => api.tasksApi.update(id, data), { concurrency: 'unbounded' })),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const restoreTaskMutation = createMutation(() => ({
    mutationFn: ({ id, groupId }: { id: string; groupId?: string }) =>
      groupId
        ? runApi(api.tasksApi.moveToGroup(id, groupId))
        : runApi(api.tasksApi.resetToGroup(id).pipe(Effect.map((result) => result.task))),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  const selectWinnerSessionMutation = createMutation(() => ({
    mutationFn: ({ taskId, candidateId }: { taskId: string; candidateId: string }) => 
      runApi(api.tasksApi.selectCandidate(taskId, candidateId)),
    onSuccess: () => {
      void invalidateTasksList()
    },
  }))

  // Wrappers
  const createTask = (data: Parameters<typeof api.tasksApi.create>[0]) => createTaskMutation.mutateAsync(data)

  const updateTask = (id: string, data: UpdateTaskDTO) => updateTaskMutation.mutateAsync({ id, data })

  const deleteTask = (id: string) => deleteTaskMutation.mutateAsync(id)

  const resetTask = (id: string) => resetTaskMutation.mutateAsync(id)

  const resetTaskToGroup = (id: string) => resetTaskToGroupMutation.mutateAsync(id)

  const moveTaskToGroup = (id: string, groupId: string | null) => moveTaskToGroupMutation.mutateAsync({ id, groupId })

  const approvePlan = (id: string, message?: string) => approvePlanMutation.mutateAsync({ id, message })

  const requestPlanRevision = (id: string, feedback: string) => requestPlanRevisionMutation.mutateAsync({ id, feedback })

  const repairTask = (id: string, action: string, options?: Record<string, unknown>) => repairTaskMutation.mutateAsync({ id, action, options })

  const startSingleTask = (id: string) => startSingleTaskMutation.mutateAsync(id)

  const archiveAllDone = () => archiveAllDoneMutation.mutateAsync()

  const batchUpdateTasks = (ids: string[], data: UpdateTaskDTO) => batchUpdateTasksMutation.mutateAsync({ ids, data })

  const restoreTask = (id: string, groupId?: string) => restoreTaskMutation.mutateAsync({ id, groupId })

  const selectWinnerSession = (taskId: string, candidateId: string) => selectWinnerSessionMutation.mutateAsync({ taskId, candidateId })

  const refreshBonSummaries = (taskIds?: string[]) => {
    const targetIds = taskIds ?? bonTaskIds()
    if (targetIds.length > 0) {
      return runApi(Effect.promise(() => queryClient.invalidateQueries({ queryKey: queryKeys.bonSummaries(targetIds) })))
    }

    return Promise.resolve()
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
