/**
 * Task Groups Store - Task group management
 * Replaces: TaskGroupsContext
 */

import { createSignal, createMemo } from 'solid-js'
import { createQuery, useQueryClient, createMutation } from '@tanstack/solid-query'
import type { TaskGroup, TaskGroupWithTasks } from '@/types'
import * as api from '@/api'

const queryKeys = {
  groups: {
    all: ['groups'] as const,
    lists: () => [...queryKeys.groups.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.groups.all, 'detail', id] as const,
  },
}

export function createTaskGroupsStore() {
  const queryClient = useQueryClient()
  const runApi = api.runApiEffect
  const [activeGroupId, setActiveGroupId] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Query
  const groupsQuery = createQuery(() => ({
    queryKey: queryKeys.groups.lists(),
    queryFn: () => runApi(api.taskGroupsApi.getAll()),
    staleTime: 5000,
  }))

  const groups = createMemo(() => groupsQuery.data || [])

  // Derived state
  const activeGroup = createMemo(() => {
    const id = activeGroupId()
    if (!id) return null
    return groups().find(g => g.id === id) || null
  })

  const activeGroups = createMemo(() => groups().filter(g => g.status === 'active'))
  const completedGroups = createMemo(() => groups().filter(g => g.status === 'completed'))

  // Actions
  const loadGroups = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.groups.lists() })
    return groups()
  }

  const openGroup = (groupId: string | null) => {
    setActiveGroupId(groupId)
  }

  const getGroupById = (id: string) => groups().find(g => g.id === id)

  const updateGroupFromWebSocket = (group: TaskGroup) => {
    queryClient.setQueryData(queryKeys.groups.lists(), (old: TaskGroup[] | undefined) => {
      if (!old) return [group]
      const index = old.findIndex(g => g.id === group.id)
      if (index >= 0) {
        const next = [...old]
        next[index] = group
        return next
      }
      return [...old, group]
    })
  }

  const removeGroupFromWebSocket = (groupId: string) => {
    queryClient.setQueryData(queryKeys.groups.lists(), (old: TaskGroup[] | undefined) => {
      if (!old) return []
      return old.filter(g => g.id !== groupId)
    })
  }

  // Mutations
  const createGroupMutation = createMutation(() => ({
    mutationFn: ({ taskIds, name }: { taskIds: string[]; name?: string }) => 
      runApi(api.taskGroupsApi.create({ taskIds, name })),
    onSuccess: (group, variables) => {
      queryClient.setQueryData(['tasks', 'list'], (old: Array<{ id: string; groupId?: string }> | undefined) => {
        if (!old) {
          return old
        }

        return old.map((task) =>
          variables.taskIds.includes(task.id)
            ? { ...task, groupId: group.id }
            : task
        )
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.groups.lists() })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  }))

  const updateGroupMutation = createMutation(() => ({
    mutationFn: ({ groupId, updates }: { groupId: string; updates: Partial<TaskGroup> }) => 
      runApi(api.taskGroupsApi.update(groupId, updates)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups.lists() })
    },
  }))

  const deleteGroupMutation = createMutation(() => ({
    mutationFn: (groupId: string) => runApi(api.taskGroupsApi.delete(groupId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups.lists() })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      if (activeGroupId()) {
        setActiveGroupId(null)
      }
    },
  }))

  const addTasksToGroupMutation = createMutation(() => ({
    mutationFn: ({ groupId, taskIds }: { groupId: string; taskIds: string[] }) => 
      runApi(api.taskGroupsApi.addTasks(groupId, taskIds)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups.lists() })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  }))

  const removeTasksFromGroupMutation = createMutation(() => ({
    mutationFn: ({ groupId, taskIds }: { groupId: string; taskIds: string[] }) => 
      runApi(api.taskGroupsApi.removeTasks(groupId, taskIds)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups.lists() })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  }))

  const startGroupMutation = createMutation(() => ({
    mutationFn: (groupId: string) => runApi(api.taskGroupsApi.start(groupId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups.lists() })
    },
  }))

  // Wrappers
  const createGroup = async (taskIds: string[], name?: string) => {
    return await createGroupMutation.mutateAsync({ taskIds, name })
  }

  const updateGroup = async (groupId: string, updates: Partial<TaskGroup>) => {
    return await updateGroupMutation.mutateAsync({ groupId, updates })
  }

  const deleteGroup = async (groupId: string) => {
    await deleteGroupMutation.mutateAsync(groupId)
  }

  const addTasksToGroup = async (groupId: string, taskIds: string[]) => {
    return await addTasksToGroupMutation.mutateAsync({ groupId, taskIds })
  }

  const removeTasksFromGroup = async (groupId: string, taskIds: string[]) => {
    return await removeTasksFromGroupMutation.mutateAsync({ groupId, taskIds })
  }

  const startGroup = async (groupId: string) => {
    return await startGroupMutation.mutateAsync(groupId)
  }

  const loadGroupDetails = (groupId: string) => runApi(api.taskGroupsApi.getById(groupId))

  return {
    groups,
    loading,
    error,
    activeGroupId,
    activeGroup,
    activeGroups,
    completedGroups,
    loadGroups,
    openGroup,
    getGroupById,
    updateGroupFromWebSocket,
    removeGroupFromWebSocket,
    createGroup,
    updateGroup,
    deleteGroup,
    addTasksToGroup,
    removeTasksFromGroup,
    startGroup,
    loadGroupDetails,
  }
}
