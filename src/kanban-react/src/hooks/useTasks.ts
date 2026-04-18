/**
 * Tasks Hook - TanStack Query Wrapper
 * 
 * This hook provides a simplified interface over TanStack Query for task management.
 * It eliminates all manual state management, race conditions, and stale closures.
 */

import { useMemo, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useTasksQuery,
  useBestOfNSummariesQuery,
  useCreateTaskMutation,
  useUpdateTaskMutation,
  useDeleteTaskMutation,
  useReorderTaskMutation,
  useArchiveAllDoneMutation,
  useResetTaskMutation,
  useResetTaskToGroupMutation,
  useMoveTaskToGroupMutation,
  useApprovePlanMutation,
  useRequestPlanRevisionMutation,
  useRepairTaskMutation,
  useStartSingleTaskMutation,
  useSelectCandidateMutation,
  useAbortBestOfNMutation,
  queryKeys,
  type ResetTaskResult,
} from '@/queries'
import type { Task, TaskStatus, BestOfNSummary, ColumnSortPreferences, ColumnSortOption, UpdateTaskDTO } from '@/types'

// Static sort functions
const sortFns: Record<ColumnSortOption, (a: Task, b: Task) => number> = {
  'manual': (a, b) => a.idx - b.idx,
  'name-asc': (a, b) => a.name.localeCompare(b.name),
  'name-desc': (a, b) => b.name.localeCompare(a.name),
  'created-asc': (a, b) => a.createdAt - b.createdAt,
  'created-desc': (a, b) => b.createdAt - a.createdAt,
  'updated-asc': (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
  'updated-desc': (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
}

export function useTasks(columnSorts?: ColumnSortPreferences) {
  const queryClient = useQueryClient()
  
  // Use TanStack Query for tasks
  const { data: tasks = [], isLoading, error } = useTasksQuery()

  // Get BestOfN summaries for relevant tasks
  const bonTaskIds = useMemo(() => 
    tasks.filter(t => t.executionStrategy === 'best_of_n').map(t => t.id),
    [tasks]
  )
  
  const { data: bonSummaries = {} } = useBestOfNSummariesQuery(bonTaskIds)

  // Mutations
  const createTaskMutation = useCreateTaskMutation()
  const updateTaskMutation = useUpdateTaskMutation()
  const deleteTaskMutation = useDeleteTaskMutation()
  const reorderTaskMutation = useReorderTaskMutation()
  const archiveAllDoneMutation = useArchiveAllDoneMutation()
  const resetTaskMutation = useResetTaskMutation()
  const resetTaskToGroupMutation = useResetTaskToGroupMutation()
  const moveTaskToGroupMutation = useMoveTaskToGroupMutation()
  const approvePlanMutation = useApprovePlanMutation()
  const requestPlanRevisionMutation = useRequestPlanRevisionMutation()
  const repairTaskMutation = useRepairTaskMutation()
  const startSingleTaskMutation = useStartSingleTaskMutation()
  const selectCandidateMutation = useSelectCandidateMutation()
  const abortBestOfNMutation = useAbortBestOfNMutation()

  // Memoized grouped tasks
  const groupedTasks = useMemo((): Record<TaskStatus | 'failed' | 'stuck', Task[]> => {
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
      const sortKey = columnSorts?.[status as TaskStatus] ?? 'manual'
      const sortFn = sortFns[sortKey]
      if (sortFn) {
        groups[status].sort(sortFn)
      }
    }

    return groups
  }, [tasks, columnSorts])

  // Simple lookup functions
  const getTaskById = useCallback((id: string) => tasks.find(t => t.id === id), [tasks])
  const getTaskName = useCallback((id: string) => getTaskById(id)?.name || id, [getTaskById])

  // Refresh functions - just invalidate queries
  const loadTasks = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
  }, [queryClient])

  const refreshBonSummaries = useCallback(async (taskList?: Task[], specificTaskIds?: string[]) => {
    const targetIds = specificTaskIds ?? taskList
      ?.filter(t => t.executionStrategy === 'best_of_n')
      .map(t => t.id) ?? []
    
    if (targetIds.length > 0) {
      await queryClient.invalidateQueries({ 
        queryKey: [...queryKeys.tasks.all, 'bestOfNSummaries', targetIds.sort()]
      })
    }
  }, [queryClient])

  // Action wrappers with same interface as before
  const createTask = useCallback(async (data: Parameters<typeof createTaskMutation.mutateAsync>[0]) => {
    return await createTaskMutation.mutateAsync(data)
  }, [createTaskMutation])

  const updateTask = useCallback(async (id: string, data: UpdateTaskDTO) => {
    return await updateTaskMutation.mutateAsync({ id, data })
  }, [updateTaskMutation])

  const deleteTask = useCallback(async (id: string) => {
    return await deleteTaskMutation.mutateAsync(id)
  }, [deleteTaskMutation])

  const reorderTask = useCallback(async (id: string, newIdx: number) => {
    await reorderTaskMutation.mutateAsync({ id, newIdx })
  }, [reorderTaskMutation])

  const archiveAllDone = useCallback(async () => {
    return await archiveAllDoneMutation.mutateAsync()
  }, [archiveAllDoneMutation])

  const resetTask = useCallback(async (id: string): Promise<ResetTaskResult> => {
    return await resetTaskMutation.mutateAsync(id)
  }, [resetTaskMutation])

  const resetTaskToGroup = useCallback(async (id: string): Promise<Task> => {
    return await resetTaskToGroupMutation.mutateAsync(id)
  }, [resetTaskToGroupMutation])

  const moveTaskToGroup = useCallback(async (id: string, groupId: string | null): Promise<Task> => {
    return await moveTaskToGroupMutation.mutateAsync({ id, groupId })
  }, [moveTaskToGroupMutation])

  const approvePlan = useCallback(async (id: string, message?: string) => {
    return await approvePlanMutation.mutateAsync({ id, message })
  }, [approvePlanMutation])

  const requestPlanRevision = useCallback(async (id: string, feedback: string) => {
    return await requestPlanRevisionMutation.mutateAsync({ id, feedback })
  }, [requestPlanRevisionMutation])

  const repairTask = useCallback(async (id: string, action: string, options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number }) => {
    return await repairTaskMutation.mutateAsync({ id, action, options })
  }, [repairTaskMutation])

  const startSingleTask = useCallback(async (id: string) => {
    return await startSingleTaskMutation.mutateAsync(id)
  }, [startSingleTaskMutation])

  const setTasksDirectly = useCallback((newTasks: Task[]) => {
    // For direct state setting, update the query cache
    queryClient.setQueryData(queryKeys.tasks.lists(), newTasks)
  }, [queryClient])

  const removeBonSummary = useCallback((id: string) => {
    // Remove from cache
    queryClient.setQueryData<Record<string, BestOfNSummary>>(
      [...queryKeys.tasks.all, 'bestOfNSummaries'],
      (old) => {
        if (!old) return {}
        const next = { ...old }
        delete next[id]
        return next
      }
    )
  }, [queryClient])

  return {
    tasks,
    setTasks: setTasksDirectly,
    groupedTasks,
    bonSummaries,
    isLoading,
    error: error?.message ?? null,
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
    resetTaskToGroup,
    moveTaskToGroup,
    approvePlan,
    requestPlanRevision,
    repairTask,
    startSingleTask,
    removeBonSummary,
  }
}
