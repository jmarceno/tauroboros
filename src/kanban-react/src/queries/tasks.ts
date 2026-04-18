/**
 * Tasks Queries - TanStack Query hooks for task management
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { tasksApi, fetchBestOfNSummaries } from '@/api'
import { queryKeys } from './keys.ts'
import type {
  Task,
  CreateTaskDTO,
  CreateTaskAndWaitDTO,
  CreateAndWaitResult,
  UpdateTaskDTO,
  TaskGroup,
  BestOfNSummary,
  TaskStatus,
} from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get all tasks
 */
export function useTasksQuery(options?: Omit<UseQueryOptions<Task[], Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.tasks.lists(),
    queryFn: tasksApi.getAll,
    staleTime: 5000, // Consider data fresh for 5 seconds
    ...options,
  })
}

/**
 * Get a single task by ID
 */
export function useTaskQuery(
  id: string | null,
  options?: Omit<UseQueryOptions<Task, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id ?? ''),
    queryFn: () => tasksApi.getById(id!),
    enabled: !!id,
    staleTime: 5000,
    ...options,
  })
}

/**
 * Get BestOfN summaries for tasks
 */
export function useBestOfNSummariesQuery(
  taskIds: string[],
  options?: Omit<UseQueryOptions<Record<string, BestOfNSummary>, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: [...queryKeys.tasks.all, 'bestOfNSummaries', taskIds.sort()],
    queryFn: () => fetchBestOfNSummaries(taskIds),
    enabled: taskIds.length > 0,
    staleTime: 3000,
    ...options,
  })
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Create a new task
 */
export function useCreateTaskMutation(
  options?: Omit<UseMutationOptions<Task, Error, CreateTaskDTO>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: tasksApi.create,
    onSuccess: () => {
      // Invalidate tasks list to show the new task
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Create a task and wait for completion
 */
export function useCreateTaskAndWaitMutation(
  options?: Omit<UseMutationOptions<CreateAndWaitResult, Error, CreateTaskAndWaitDTO>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: tasksApi.createAndWait,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
    },
    ...options,
  })
}

/**
 * Update a task
 */
export interface UpdateTaskVariables {
  id: string
  data: UpdateTaskDTO
}

export function useUpdateTaskMutation(
  options?: Omit<UseMutationOptions<Task, Error, UpdateTaskVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }) => tasksApi.update(id, data),
    onSuccess: (updatedTask) => {
      // Update the specific task in cache
      queryClient.setQueryData(queryKeys.tasks.detail(updatedTask.id), updatedTask)
      // Invalidate the list to ensure consistency
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Delete a task
 */
export function useDeleteTaskMutation(
  options?: Omit<UseMutationOptions<{ id: string; archived?: boolean }, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: tasksApi.delete,
    onSuccess: (_, id) => {
      // Remove from cache immediately
      queryClient.removeQueries({ queryKey: queryKeys.tasks.detail(id) })
      // Invalidate list
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Reorder a task
 */
export interface ReorderTaskVariables {
  id: string
  newIdx: number
}

export function useReorderTaskMutation(
  options?: Omit<UseMutationOptions<void, Error, ReorderTaskVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, newIdx }) => tasksApi.reorder(id, newIdx),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Archive all done tasks
 */
export function useArchiveAllDoneMutation(
  options?: Omit<UseMutationOptions<{ archived: number; deleted: number }, Error, void>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: tasksApi.archiveAllDone,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Reset task to backlog
 */
export interface ResetTaskResult {
  task: Task
  group?: TaskGroup
  wasInGroup: boolean
}

export function useResetTaskMutation(
  options?: Omit<UseMutationOptions<ResetTaskResult, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string): Promise<ResetTaskResult> => {
      const result = await tasksApi.reset(id)
      // Validate API response
      if (typeof result.wasInGroup !== 'boolean') {
        throw new Error(`Invalid API response: wasInGroup must be a boolean, got ${typeof result.wasInGroup}`)
      }
      return result
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
    },
    ...options,
  })
}

/**
 * Reset task and restore to group
 */
export function useResetTaskToGroupMutation(
  options?: Omit<UseMutationOptions<Task, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string): Promise<Task> => {
      const result = await tasksApi.resetToGroup(id)
      return result.task
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
    },
    ...options,
  })
}

/**
 * Move task to group
 */
export interface MoveTaskToGroupVariables {
  id: string
  groupId: string | null
}

export function useMoveTaskToGroupMutation(
  options?: Omit<UseMutationOptions<Task, Error, MoveTaskToGroupVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, groupId }) => tasksApi.moveToGroup(id, groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
    },
    ...options,
  })
}

/**
 * Approve task plan
 */
export interface ApprovePlanVariables {
  id: string
  message?: string
}

export function useApprovePlanMutation(
  options?: Omit<UseMutationOptions<Task, Error, ApprovePlanVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, message }) => tasksApi.approvePlan(id, message),
    onSuccess: (task) => {
      queryClient.setQueryData(queryKeys.tasks.detail(task.id), task)
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Request plan revision
 */
export interface RequestPlanRevisionVariables {
  id: string
  feedback: string
}

export function useRequestPlanRevisionMutation(
  options?: Omit<UseMutationOptions<Task, Error, RequestPlanRevisionVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, feedback }) => tasksApi.requestPlanRevision(id, feedback),
    onSuccess: (task) => {
      queryClient.setQueryData(queryKeys.tasks.detail(task.id), task)
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Repair task
 */
export interface RepairTaskVariables {
  id: string
  action: string
  options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number }
}

export interface RepairTaskResult {
  ok: boolean
  action: string
  reason?: string
  task: Task
}

export function useRepairTaskMutation(
  options?: Omit<UseMutationOptions<RepairTaskResult, Error, RepairTaskVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, action, options }) => tasksApi.repair(id, action, options),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.tasks.detail(result.task.id), result.task)
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Start single task
 */
export function useStartSingleTaskMutation(
  options?: Omit<UseMutationOptions<unknown, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: tasksApi.startSingle,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
    },
    ...options,
  })
}

/**
 * Select BestOfN candidate
 */
export interface SelectCandidateVariables {
  taskId: string
  candidateId: string
}

export function useSelectCandidateMutation(
  options?: Omit<UseMutationOptions<void, Error, SelectCandidateVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, candidateId }) => tasksApi.selectCandidate(taskId, candidateId),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.bestOfNSummary(taskId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Abort BestOfN
 */
export function useAbortBestOfNMutation(
  options?: Omit<UseMutationOptions<void, Error, { taskId: string; reason: string }>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, reason }) => tasksApi.abortBestOfN(taskId, reason),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.bestOfNSummary(taskId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}
