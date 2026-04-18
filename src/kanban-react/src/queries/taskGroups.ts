/**
 * Task Groups Queries - TanStack Query hooks for task groups
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { taskGroupsApi } from '@/api'
import { queryKeys } from './keys.ts'
import type { TaskGroup, TaskGroupWithTasks } from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get all task groups
 */
export function useTaskGroupsQuery(options?: Omit<UseQueryOptions<TaskGroup[], Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.taskGroups.lists(),
    queryFn: taskGroupsApi.getAll,
    staleTime: 5000,
    ...options,
  })
}

/**
 * Get a single task group with its tasks
 */
export function useTaskGroupQuery(
  id: string | null,
  options?: Omit<UseQueryOptions<TaskGroupWithTasks, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.taskGroups.detail(id ?? ''),
    queryFn: () => taskGroupsApi.getById(id!),
    enabled: !!id,
    staleTime: 5000,
    ...options,
  })
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Create a task group
 */
export interface CreateTaskGroupVariables {
  name?: string
  color?: string
  taskIds?: string[]
}

export function useCreateTaskGroupMutation(
  options?: Omit<UseMutationOptions<TaskGroup, Error, CreateTaskGroupVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: taskGroupsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
    },
    ...options,
  })
}

/**
 * Update a task group
 */
export interface UpdateTaskGroupVariables {
  id: string
  data: { name?: string; color?: string; status?: 'active' | 'completed' | 'archived' }
}

export function useUpdateTaskGroupMutation(
  options?: Omit<UseMutationOptions<TaskGroup, Error, UpdateTaskGroupVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }) => taskGroupsApi.update(id, data),
    onSuccess: (group) => {
      queryClient.setQueryData(queryKeys.taskGroups.detail(group.id), (old: TaskGroupWithTasks | undefined) => {
        if (!old) return group as TaskGroupWithTasks
        return { ...old, ...group }
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
    },
    ...options,
  })
}

/**
 * Delete a task group
 */
export function useDeleteTaskGroupMutation(
  options?: Omit<UseMutationOptions<void, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: taskGroupsApi.delete,
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.taskGroups.detail(id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
    },
    ...options,
  })
}

/**
 * Add tasks to a group
 */
export interface AddTasksToGroupVariables {
  groupId: string
  taskIds: string[]
}

export function useAddTasksToGroupMutation(
  options?: Omit<UseMutationOptions<TaskGroup, Error, AddTasksToGroupVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ groupId, taskIds }) => taskGroupsApi.addTasks(groupId, taskIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Remove tasks from a group
 */
export interface RemoveTasksFromGroupVariables {
  groupId: string
  taskIds: string[]
}

export function useRemoveTasksFromGroupMutation(
  options?: Omit<UseMutationOptions<TaskGroup, Error, RemoveTasksFromGroupVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ groupId, taskIds }) => taskGroupsApi.removeTasks(groupId, taskIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Start a group execution
 */
export function useStartGroupMutation(
  options?: Omit<UseMutationOptions<unknown, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: taskGroupsApi.start,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
    },
    ...options,
  })
}

// ============================================================================
// Cache Helpers
// ============================================================================

/**
 * Helper to update a task group in cache (used by WebSocket handlers)
 */
export function updateTaskGroupCache(
  queryClient: ReturnType<typeof useQueryClient>,
  group: TaskGroup
) {
  queryClient.setQueryData(queryKeys.taskGroups.detail(group.id), (old: TaskGroupWithTasks | undefined) => {
    if (!old) return group as TaskGroupWithTasks
    return { ...old, ...group }
  })

  queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups.lists(), (old) => {
    if (!old) return [group]
    const idx = old.findIndex(g => g.id === group.id)
    if (idx >= 0) {
      return old.map(g => g.id === group.id ? { ...g, ...group } : g)
    }
    return [...old, group]
  })
}

/**
 * Helper to remove a task group from cache (used by WebSocket handlers)
 */
export function removeTaskGroupCache(
  queryClient: ReturnType<typeof useQueryClient>,
  groupId: string
) {
  queryClient.removeQueries({ queryKey: queryKeys.taskGroups.detail(groupId) })
  
  queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups.lists(), (old) => {
    if (!old) return []
    return old.filter(g => g.id !== groupId)
  })
}
