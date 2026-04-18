import { useState, useCallback, useMemo } from 'react'
import type { TaskGroup } from '@/types'
import { useApi } from './useApi'
import { useToasts } from './useToasts'

export type GroupState = {
  groups: TaskGroup[]
  loading: boolean
  error: string | null
  activeGroupId: string | null
}

export function useTaskGroups() {
  const api = useApi()
  const { showToast } = useToasts()
  const [groups, setGroups] = useState<TaskGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  /**
   * Fetch all task groups from the API
   */
  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getTaskGroups()
      setGroups(data)
      return data
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      showToast(`Failed to load groups: ${message}`, 'error')
      throw e
    } finally {
      setLoading(false)
    }
  }, [api, showToast])

  /**
   * Create a new task group with optional tasks
   */
  const createGroup = useCallback(async (taskIds: string[], name?: string) => {
    const tempId = `temp-${Date.now()}`
    const tempGroup: TaskGroup = {
      id: tempId,
      name: name || `Group ${groups.length + 1}`,
      color: '#6366f1',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    }

    // Optimistic update
    setGroups(prev => [...prev, tempGroup])

    try {
      const group = await api.createTaskGroup({
        name: tempGroup.name,
        taskIds,
      })

      // Replace temp with real group
      setGroups(prev => prev.map(g => g.id === tempId ? group : g))
      showToast(`Group "${group.name}" created`, 'success')
      return group
    } catch (e) {
      // Revert optimistic update
      setGroups(prev => prev.filter(g => g.id !== tempId))
      const message = e instanceof Error ? e.message : String(e)
      showToast(`Failed to create group: ${message}`, 'error')
      throw e
    }
  }, [api, groups.length, showToast])

  /**
   * Set the active group for panel display
   */
  const openGroup = useCallback((groupId: string | null) => {
    setActiveGroupId(groupId)
  }, [])

  /**
   * Load full group details with tasks
   */
  const loadGroupDetails = useCallback(async (groupId: string) => {
    try {
      const group = await api.getTaskGroup(groupId)
      return group
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      showToast(`Failed to load group details: ${message}`, 'error')
      throw e
    }
  }, [api, showToast])

  /**
   * Add tasks to an existing group
   */
  const addTasksToGroup = useCallback(async (groupId: string, taskIds: string[]) => {
    // Optimistic update - update member count or store pending state
    setGroups(prev => prev.map(g => {
      if (g.id === groupId) {
        return { ...g, updatedAt: Date.now() }
      }
      return g
    }))

    try {
      const group = await api.addTasksToGroup(groupId, taskIds)
      setGroups(prev => prev.map(g => g.id === groupId ? group : g))
      showToast(`${taskIds.length} task(s) added to group`, 'success')
      return group
    } catch (e) {
      // Revert by reloading
      await loadGroups()
      const message = e instanceof Error ? e.message : String(e)
      showToast(`Failed to add tasks: ${message}`, 'error')
      throw e
    }
  }, [api, loadGroups, showToast])

  /**
   * Remove tasks from a group
   */
  const removeTasksFromGroup = useCallback(async (groupId: string, taskIds: string[]) => {
    // Optimistic update
    setGroups(prev => prev.map(g => {
      if (g.id === groupId) {
        return { ...g, updatedAt: Date.now() }
      }
      return g
    }))

    try {
      const group = await api.removeTasksFromGroup(groupId, taskIds)
      setGroups(prev => prev.map(g => g.id === groupId ? group : g))
      showToast(`${taskIds.length} task(s) removed from group`, 'success')
      return group
    } catch (e) {
      // Revert by reloading
      await loadGroups()
      const message = e instanceof Error ? e.message : String(e)
      showToast(`Failed to remove tasks: ${message}`, 'error')
      throw e
    }
  }, [api, loadGroups, showToast])

  /**
   * Start executing a group
   */
  const startGroup = useCallback(async (groupId: string) => {
    // Validate group has tasks
    const group = groups.find(g => g.id === groupId)
    if (!group) {
      const error = 'Group not found'
      showToast(error, 'error')
      throw new Error(error)
    }

    try {
      const run = await api.startGroup(groupId)
      showToast(`Started execution for group "${group.name}"`, 'success')
      return run
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      showToast(`Failed to start group: ${message}`, 'error')
      throw e
    }
  }, [api, groups, showToast])

  /**
   * Delete a group
   */
  const deleteGroup = useCallback(async (groupId: string) => {
    const group = groups.find(g => g.id === groupId)
    if (!group) {
      const error = 'Group not found'
      showToast(error, 'error')
      throw new Error(error)
    }

    // Optimistic removal
    setGroups(prev => prev.filter(g => g.id !== groupId))

    // Clear active group if it was the deleted one
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
    }

    try {
      await api.deleteTaskGroup(groupId)
      showToast(`Group "${group.name}" deleted`, 'success')
    } catch (e) {
      // Revert optimistic removal
      setGroups(prev => [...prev, group])
      const message = e instanceof Error ? e.message : String(e)
      showToast(`Failed to delete group: ${message}`, 'error')
      throw e
    }
  }, [api, groups, activeGroupId, showToast])

  /**
   * Update a group's properties
   */
  const updateGroup = useCallback(async (groupId: string, updates: { name?: string; color?: string }) => {
    const previousGroup = groups.find(g => g.id === groupId)
    if (!previousGroup) {
      const error = 'Group not found'
      showToast(error, 'error')
      throw new Error(error)
    }

    // Optimistic update
    setGroups(prev => prev.map(g => {
      if (g.id === groupId) {
        return { ...g, ...updates, updatedAt: Date.now() }
      }
      return g
    }))

    try {
      const group = await api.updateTaskGroup(groupId, updates)
      setGroups(prev => prev.map(g => g.id === groupId ? group : g))
      showToast('Group updated', 'success')
      return group
    } catch (e) {
      // Revert optimistic update
      setGroups(prev => prev.map(g => g.id === groupId ? previousGroup : g))
      const message = e instanceof Error ? e.message : String(e)
      showToast(`Failed to update group: ${message}`, 'error')
      throw e
    }
  }, [api, groups, showToast])

  /**
   * Get a group by ID
   */
  const getGroupById = useCallback((id: string) => {
    return groups.find(g => g.id === id)
  }, [groups])

  /**
   * Update or add a group from WebSocket message
   */
  const updateGroupFromWebSocket = useCallback((group: TaskGroup) => {
    setGroups(prev => {
      const idx = prev.findIndex(g => g.id === group.id)
      if (idx >= 0) {
        return prev.map(g => g.id === group.id ? group : g)
      }
      return [...prev, group]
    })
  }, [])

  /**
   * Remove a group from WebSocket message
   */
  const removeGroupFromWebSocket = useCallback((groupId: string) => {
    setGroups(prev => prev.filter(g => g.id !== groupId))
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
    }
  }, [activeGroupId])

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

  const contextValue = useMemo(() => ({
    groups,
    loading,
    error,
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
  }), [
    groups, loading, error, activeGroupId, activeGroup, activeGroups, completedGroups,
    loadGroups, createGroup, openGroup, loadGroupDetails, addTasksToGroup,
    removeTasksFromGroup, startGroup, deleteGroup, updateGroup, getGroupById,
    updateGroupFromWebSocket, removeGroupFromWebSocket
  ])

  return contextValue
}
