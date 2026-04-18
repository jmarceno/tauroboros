import { useState, useCallback, useMemo, useRef } from "react"
import type { TaskGroup } from "@/types"
import type { ToastVariant } from "@/types"
import { useApi } from "./useApi"
import { useToasts } from "./useToasts"

type ShowToastFn = (message: string, variant?: ToastVariant, duration?: number) => number

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Network/fetch errors
    if (
      error.message.includes('fetch') ||
      error.message.includes('network') ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ENOTFOUND')
    ) {
      return 'Connection failed. Check your network and try again.'
    }
    // Server errors (5xx)
    if (error.message.includes('500') || error.message.includes('502') || error.message.includes('503')) {
      return 'Server error. Please try again in a moment.'
    }
    // Validation errors (4xx)
    if (error.message.includes('400') || error.message.includes('404') || error.message.includes('409')) {
      return error.message
    }
    return error.message
  }
  // Handle non-Error types (strings, objects, etc.)
  return String(error)
}

export type GroupState = {
  groups: TaskGroup[]
  loading: boolean
  error: string | null
  activeGroupId: string | null
}

export function useTaskGroups(opts: { showToast?: ShowToastFn } = {}) {
  const api = useApi()
  const localToasts = useToasts()
  // Use passed-in showToast if provided, otherwise fall back to local instance
  const showToast = opts.showToast ?? localToasts.showToast
  const [groups, setGroups] = useState<TaskGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  
  // Track pending group creation for deterministic temp group matching
  // This prevents race conditions between API response and WebSocket messages
  const pendingTempIdRef = useRef<string | null>(null)
  // Store the temp group name to avoid depending on groups state
  const pendingTempNameRef = useRef<string | null>(null)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getTaskGroups()
      setGroups(data)
      return data
    } catch (e) {
      const message = parseErrorMessage(e)
      setError(message)
      showToast(`Failed to load groups: ${message}`, 'error')
      throw e
    } finally {
      setLoading(false)
    }
  }, [api, showToast])

  const createGroup = useCallback(async (taskIds: string[], name?: string) => {
    const tempId = `temp-${Date.now()}`
    // Track this tempId for deterministic matching in WebSocket handler
    pendingTempIdRef.current = tempId
    
    // Create temp group with functional update to avoid dependency on groups.length
    setGroups(prev => {
      const tempGroupName = name || `Group ${prev.length + 1}`
      // Store name in ref for API call (outside React's render flow)
      pendingTempNameRef.current = tempGroupName
      const tempGroup: TaskGroup = {
        id: tempId,
        name: tempGroupName,
        color: '#6366f1',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
      }
      return [...prev, tempGroup]
    })

    try {
      // Use the name captured in the ref during setGroups
      const groupName = pendingTempNameRef.current ?? name ?? 'Group 1'
      
      const group = await api.createTaskGroup({
        name: groupName,
        taskIds,
      })

      // Replace temp with real group atomically
      // Also dedupe if WebSocket already added the real group
      setGroups(prev => {
        const groupMap = new Map<string, TaskGroup>()
        
        for (const g of prev) {
          // Skip the temp group (always replace it)
          if (g.id === tempId) {
            continue
          }
          // Skip existing real group with same ID (from WebSocket)
          if (g.id === group.id) {
            continue
          }
          groupMap.set(g.id, g)
        }
        
        // Add the real group from API response
        groupMap.set(group.id, group)
        
        return Array.from(groupMap.values())
      })
      
      showToast(`Group "${group.name}" created`, 'success')
      return group
    } catch (e) {
      setGroups(prev => prev.filter(g => g.id !== tempId))
      const message = parseErrorMessage(e)
      showToast(`Failed to create group: ${message}`, 'error')
      throw new Error(`Failed to create task group: ${message}`, { cause: e instanceof Error ? e : undefined })
    } finally {
      pendingTempIdRef.current = null
      pendingTempNameRef.current = null
    }
  }, [api, showToast])

  const openGroup = useCallback((groupId: string | null) => {
    setActiveGroupId(groupId)
  }, [])

  const loadGroupDetails = useCallback(async (groupId: string) => {
    try {
      const group = await api.getTaskGroup(groupId)
      return group
    } catch (e) {
      const message = parseErrorMessage(e)
      showToast(`Failed to load group details: ${message}`, 'error')
      throw e
    }
  }, [api, showToast])

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
      const message = parseErrorMessage(e)
      showToast(`Failed to add tasks: ${message}`, 'error')
      throw e
    }
  }, [api, loadGroups, showToast])

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
      const message = parseErrorMessage(e)
      showToast(`Failed to remove tasks: ${message}`, 'error')
      throw e
    }
  }, [api, loadGroups, showToast])

  const startGroup = useCallback(async (groupId: string) => {
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
      const message = parseErrorMessage(e)
      showToast(`Failed to start group: ${message}`, 'error')
      throw new Error(`Failed to start group: ${message}`, { cause: e instanceof Error ? e : undefined })
    }
  }, [api, groups, showToast])

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
      const message = parseErrorMessage(e)
      showToast(`Failed to delete group: ${message}`, 'error')
      throw e
    }
  }, [api, groups, activeGroupId, showToast])

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
      const message = parseErrorMessage(e)
      showToast(`Failed to update group: ${message}`, 'error')
      throw e
    }
  }, [api, groups, showToast])

  const getGroupById = useCallback((id: string) => {
    return groups.find(g => g.id === id)
  }, [groups])

  const updateGroupFromWebSocket = useCallback((group: TaskGroup) => {
    setGroups(prev => {
      // Use Map for deterministic deduplication - last occurrence wins
      const groupMap = new Map<string, TaskGroup>()
      
      // Check if we have a pending temp group that matches this WebSocket group
      const pendingTempId = pendingTempIdRef.current
      
      for (const g of prev) {
        // PRIMARY: Skip if we already have this group ID (idempotent update)
        // This handles the case where API response already added the real group
        // and WebSocket arrives afterwards. Must check FIRST before temp logic.
        if (g.id === group.id) {
          continue
        }
        
        // SECONDARY: Skip temp groups that match the incoming real group
        // Match by: deterministic pendingTempId check first, then fallback to name+time
        if (g.id.startsWith('temp-')) {
          // Deterministic match: if this is the currently pending temp group
          if (pendingTempId && g.id === pendingTempId && g.name === group.name) {
            continue
          }
          
          // Fallback: match by name and similar creation time (within 5 second window)
          // This handles edge cases where tempId tracking might be out of sync
          const gCreatedAt = g.createdAt ?? 0
          const groupCreatedAt = group.createdAt ?? 0
          const timeDiff = Math.abs(gCreatedAt - groupCreatedAt)
          const TIME_WINDOW_MS = 5000
          
          if (
            g.name === group.name &&
            timeDiff < TIME_WINDOW_MS
          ) {
            // Found matching temp group - skip it, we'll add the real group
            continue
          }
        }
        
        groupMap.set(g.id, g)
      }
      
      // Set/update the group from WebSocket
      groupMap.set(group.id, group)
      
      return Array.from(groupMap.values())
    })
  }, [])

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
