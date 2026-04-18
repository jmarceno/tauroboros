/**
 * Task Groups Hook - TanStack Query Wrapper
 */

import { useState, useMemo, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useTaskGroupsQuery,
  useTaskGroupQuery,
  useCreateTaskGroupMutation,
  useUpdateTaskGroupMutation,
  useDeleteTaskGroupMutation,
  useAddTasksToGroupMutation,
  useRemoveTasksFromGroupMutation,
  useStartGroupMutation,
  queryKeys,
} from '@/queries'
import type { TaskGroup, TaskGroupWithTasks } from '@/types'
import type { ToastVariant } from '@/types'

export type GroupState = {
  groups: TaskGroup[]
  loading: boolean
  error: string | null
  activeGroupId: string | null
}

export function useTaskGroups(opts: { showToast?: (message: string, variant?: ToastVariant, duration?: number) => number } = {}) {
  const queryClient = useQueryClient()
  const showToast = opts.showToast

  // Local state for active group selection
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  // Use TanStack Query for groups
  const { data: groups = [], isLoading, error } = useTaskGroupsQuery()

  // Mutations
  const createGroupMutation = useCreateTaskGroupMutation({
    onSuccess: (group) => {
      showToast?.(`Group "${group.name}" created`, 'success')
    },
    onError: (error) => {
      showToast?.(`Failed to create group: ${error.message}`, 'error')
    },
  })

  const updateGroupMutation = useUpdateTaskGroupMutation({
    onSuccess: () => {
      showToast?.('Group updated', 'success')
    },
    onError: (error) => {
      showToast?.(`Failed to update group: ${error.message}`, 'error')
    },
  })

  const deleteGroupMutation = useDeleteTaskGroupMutation({
    onSuccess: () => {
      showToast?.('Group deleted', 'success')
    },
    onError: (error) => {
      showToast?.(`Failed to delete group: ${error.message}`, 'error')
    },
  })

  const addTasksToGroupMutation = useAddTasksToGroupMutation({
    onSuccess: (_, vars) => {
      showToast?.(`${vars.taskIds.length} task(s) added to group`, 'success')
    },
    onError: (error) => {
      showToast?.(`Failed to add tasks: ${error.message}`, 'error')
    },
  })

  const removeTasksFromGroupMutation = useRemoveTasksFromGroupMutation({
    onSuccess: (_, vars) => {
      showToast?.(`${vars.taskIds.length} task(s) removed from group`, 'success')
    },
    onError: (error) => {
      showToast?.(`Failed to remove tasks: ${error.message}`, 'error')
    },
  })

  const startGroupMutation = useStartGroupMutation({
    onSuccess: (_, groupId) => {
      const group = groups.find(g => g.id === groupId)
      showToast?.(`Started execution for group "${group?.name ?? groupId}"`, 'success')
    },
    onError: (error) => {
      showToast?.(`Failed to start group: ${error.message}`, 'error')
    },
  })

  // Computed values
  const activeGroup = useMemo(() => {
    if (!activeGroupId) return null
    return groups.find(g => g.id === activeGroupId) || null
  }, [groups, activeGroupId])

  const activeGroups = useMemo(() =>
    groups.filter(g => g.status === 'active'),
    [groups]
  )

  const completedGroups = useMemo(() =>
    groups.filter(g => g.status === 'completed'),
    [groups]
  )

  // Actions
  const loadGroups = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
    return groups
  }, [queryClient, groups])

  const createGroup = useCallback(async (taskIds: string[], name?: string) => {
    return await createGroupMutation.mutateAsync({ name, taskIds })
  }, [createGroupMutation])

  const openGroup = useCallback((groupId: string | null) => {
    setActiveGroupId(groupId)
  }, [])

  const loadGroupDetails = useCallback(async (groupId: string) => {
    // Fetch detailed group info
    const result = await queryClient.fetchQuery({
      queryKey: queryKeys.taskGroups.detail(groupId),
      queryFn: () => {
        const { useTaskGroupQuery } = require('@/queries')
        const { taskGroupsApi } = require('@/api')
        return taskGroupsApi.getById(groupId)
      },
    })
    return result as TaskGroupWithTasks
  }, [queryClient])

  const addTasksToGroup = useCallback(async (groupId: string, taskIds: string[]) => {
    return await addTasksToGroupMutation.mutateAsync({ groupId, taskIds })
  }, [addTasksToGroupMutation])

  const removeTasksFromGroup = useCallback(async (groupId: string, taskIds: string[]) => {
    return await removeTasksFromGroupMutation.mutateAsync({ groupId, taskIds })
  }, [removeTasksFromGroupMutation])

  const startGroup = useCallback(async (groupId: string) => {
    return await startGroupMutation.mutateAsync(groupId)
  }, [startGroupMutation])

  const deleteGroup = useCallback(async (groupId: string) => {
    await deleteGroupMutation.mutateAsync(groupId)
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
    }
  }, [deleteGroupMutation, activeGroupId])

  const updateGroup = useCallback(async (groupId: string, updates: { name?: string; color?: string }) => {
    return await updateGroupMutation.mutateAsync({ id: groupId, data: { ...updates, status: 'active' } })
  }, [updateGroupMutation])

  const getGroupById = useCallback((id: string) => {
    return groups.find(g => g.id === id)
  }, [groups])

  // WebSocket cache helpers
  const updateGroupFromWebSocket = useCallback((group: TaskGroup) => {
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
  }, [queryClient])

  const removeGroupFromWebSocket = useCallback((groupId: string) => {
    queryClient.removeQueries({ queryKey: queryKeys.taskGroups.detail(groupId) })
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
    }
    queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups.lists(), (old) => {
      if (!old) return []
      return old.filter(g => g.id !== groupId)
    })
  }, [queryClient, activeGroupId])

  return {
    groups,
    loading: isLoading,
    error: error?.message ?? null,
    activeGroupId,
    activeGroup,
    activeGroups,
    completedGroups,
    loadGroups,
    createGroup,
    openGroup,
    loadGroupDetails,
    addTasksToGroup,
    removeTasksFromGroup,
    startGroup,
    deleteGroup,
    updateGroup,
    getGroupById,
    updateGroupFromWebSocket,
    removeGroupFromWebSocket,
  }
}
