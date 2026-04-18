import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTaskGroups } from './useTaskGroups'
import type { TaskGroup, WorkflowRun } from '@/types'

// Mock the dependent hooks
vi.mock('./useApi', () => ({
  useApi: vi.fn(),
}))

vi.mock('./useToasts', () => ({
  useToasts: vi.fn(),
}))

import { useApi } from './useApi'
import { useToasts } from './useToasts'

function createMockGroup(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    id: 'group-1',
    name: 'Test Group',
    color: '#6366f1',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    ...overrides,
  }
}

interface MockToastsHook {
  showToast: ReturnType<typeof vi.fn>
}

interface MockApiHook {
  getTaskGroups: ReturnType<typeof vi.fn>
  getTaskGroup: ReturnType<typeof vi.fn>
  createTaskGroup: ReturnType<typeof vi.fn>
  updateTaskGroup: ReturnType<typeof vi.fn>
  deleteTaskGroup: ReturnType<typeof vi.fn>
  addTasksToGroup: ReturnType<typeof vi.fn>
  removeTasksFromGroup: ReturnType<typeof vi.fn>
  startGroup: ReturnType<typeof vi.fn>
}

describe.skip('useTaskGroups', () => {
  it('uses passed showToast when provided', async () => {
    const passedShowToast = vi.fn()
    const localShowToast = vi.fn()
    
    vi.mocked(useToasts).mockReturnValue({ showToast: localShowToast } as MockToastsHook)
    
    mockApi.startGroup.mockRejectedValue(new Error('Test error'))
    mockApi.getTaskGroups.mockResolvedValue([createMockGroup({ id: 'group-1' })])

    const { result } = renderHook(() => useTaskGroups({ showToast: passedShowToast }))

    await act(async () => {
      await result.current.loadGroups()
    })

    await act(async () => {
      try {
        await result.current.startGroup('group-1')
      } catch {
        // Expected to throw
      }
    })

    expect(passedShowToast).toHaveBeenCalled()
    expect(localShowToast).not.toHaveBeenCalled()
  })

  it('falls back to local showToast when not provided', async () => {
    mockApi.startGroup.mockRejectedValue(new Error('Test error'))
    mockApi.getTaskGroups.mockResolvedValue([createMockGroup({ id: 'group-1' })])

    const { result } = renderHook(() => useTaskGroups())

    await act(async () => {
      await result.current.loadGroups()
    })

    await act(async () => {
      try {
        await result.current.startGroup('group-1')
      } catch {
        // Expected to throw
      }
    })

    expect(mockShowToast).toHaveBeenCalled()
  })

  const mockApi = {
    getTaskGroups: vi.fn(),
    getTaskGroup: vi.fn(),
    createTaskGroup: vi.fn(),
    updateTaskGroup: vi.fn(),
    deleteTaskGroup: vi.fn(),
    addTasksToGroup: vi.fn(),
    removeTasksFromGroup: vi.fn(),
    startGroup: vi.fn(),
  }

  const mockShowToast = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useApi).mockReturnValue(mockApi as MockApiHook)
    vi.mocked(useToasts).mockReturnValue({ showToast: mockShowToast } as MockToastsHook)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('initial state', () => {
    it('initializes with empty groups array', () => {
      const { result } = renderHook(() => useTaskGroups())

      expect(result.current.groups).toEqual([])
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(result.current.activeGroupId).toBeNull()
    })

    it('initializes with null activeGroup', () => {
      const { result } = renderHook(() => useTaskGroups())

      expect(result.current.activeGroup).toBeNull()
    })

    it('initializes with empty active and completed groups', () => {
      const { result } = renderHook(() => useTaskGroups())

      expect(result.current.activeGroups).toEqual([])
      expect(result.current.completedGroups).toEqual([])
    })
  })

  describe('loadGroups', () => {
    it('fetches groups and updates state on success', async () => {
      const mockGroups = [createMockGroup({ id: 'group-1', name: 'Group 1' })]
      mockApi.getTaskGroups.mockResolvedValue(mockGroups)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        const data = await result.current.loadGroups()
        expect(data).toEqual(mockGroups)
      })

      expect(result.current.groups).toEqual(mockGroups)
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('sets loading state while fetching', async () => {
      let resolvePromise: (value: TaskGroup[]) => void
      const promise = new Promise<TaskGroup[]>((resolve) => {
        resolvePromise = resolve
      })
      mockApi.getTaskGroups.mockReturnValue(promise)

      const { result } = renderHook(() => useTaskGroups())

      act(() => {
        result.current.loadGroups()
      })

      expect(result.current.loading).toBe(true)

      await act(async () => {
        resolvePromise!([createMockGroup()])
        await promise
      })

      expect(result.current.loading).toBe(false)
    })

    it('handles error and shows toast on failure', async () => {
      const errorMessage = 'Network error'
      mockApi.getTaskGroups.mockRejectedValue(new Error(errorMessage))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        try {
          await result.current.loadGroups()
        } catch {
          // Expected to throw
        }
      })

      expect(result.current.error).toBe(errorMessage)
      expect(result.current.loading).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith(
        `Failed to load groups: ${errorMessage}`,
        'error'
      )
    })

    it('handles non-Error rejection', async () => {
      mockApi.getTaskGroups.mockRejectedValue('string error')

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        try {
          await result.current.loadGroups()
        } catch {
          // Expected to throw
        }
      })

      expect(result.current.error).toBe('string error')
      expect(mockShowToast).toHaveBeenCalledWith(
        'Failed to load groups: string error',
        'error'
      )
    })
  })

  describe('createGroup', () => {
    it('creates group with optimistic update and replaces temp ID on success', async () => {
      const realGroup = createMockGroup({ id: 'real-group-id', name: 'New Group' })
      mockApi.createTaskGroup.mockResolvedValue(realGroup)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        const group = await result.current.createGroup(['task-1', 'task-2'], 'New Group')
        expect(group).toEqual(realGroup)
      })

      expect(result.current.groups).toHaveLength(1)
      expect(result.current.groups[0].id).toBe('real-group-id')
      expect(result.current.groups[0].name).toBe('New Group')
      expect(mockShowToast).toHaveBeenCalledWith(
        'Group "New Group" created',
        'success'
      )
    })

    it('generates default name when not provided', async () => {
      const realGroup = createMockGroup({ id: 'real-id', name: 'Group 1' })
      mockApi.createTaskGroup.mockResolvedValue(realGroup)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.createGroup(['task-1'])
      })

      expect(mockApi.createTaskGroup).toHaveBeenCalledWith({
        name: 'Group 1',
        taskIds: ['task-1'],
      })
    })

    it('reverts optimistic update on failure', async () => {
      const errorMessage = 'Create failed'
      mockApi.createTaskGroup.mockRejectedValue(new Error(errorMessage))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        try {
          await result.current.createGroup(['task-1'])
        } catch {
          // Expected to throw
        }
      })

      expect(result.current.groups).toHaveLength(0)
      expect(mockShowToast).toHaveBeenCalledWith(
        `Failed to create group: ${errorMessage}`,
        'error'
      )
    })

    it('includes temp group immediately with optimistic update', async () => {
      let resolvePromise: (value: TaskGroup) => void
      const promise = new Promise<TaskGroup>((resolve) => {
        resolvePromise = resolve
      })
      mockApi.createTaskGroup.mockReturnValue(promise)

      const { result } = renderHook(() => useTaskGroups())

      // Start creation but don't await yet
      act(() => {
        result.current.createGroup(['task-1'], 'Test Group')
      })

      // Should have temp group immediately
      expect(result.current.groups).toHaveLength(1)
      expect(result.current.groups[0].id.startsWith('temp-')).toBe(true)
      expect(result.current.groups[0].name).toBe('Test Group')

      // Resolve the promise
      await act(async () => {
        resolvePromise!(createMockGroup({ id: 'real-id', name: 'Test Group' }))
        await promise
      })

      // Should be replaced with real group
      expect(result.current.groups[0].id).toBe('real-id')
    })
  })

  describe('openGroup', () => {
    it('sets active group ID', () => {
      const { result } = renderHook(() => useTaskGroups())

      act(() => {
        result.current.openGroup('group-1')
      })

      expect(result.current.activeGroupId).toBe('group-1')
    })

    it('clears active group when null is passed', () => {
      const { result } = renderHook(() => useTaskGroups())

      act(() => {
        result.current.openGroup('group-1')
      })
      expect(result.current.activeGroupId).toBe('group-1')

      act(() => {
        result.current.openGroup(null)
      })
      expect(result.current.activeGroupId).toBeNull()
    })
  })

  describe('activeGroup derived value', () => {
    it('returns null when no active group ID is set', () => {
      const { result } = renderHook(() => useTaskGroups())

      expect(result.current.activeGroup).toBeNull()
    })

    it('returns group when activeGroupId matches', async () => {
      const mockGroups = [createMockGroup({ id: 'group-1', name: 'Active Group' })]
      mockApi.getTaskGroups.mockResolvedValue(mockGroups)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      act(() => {
        result.current.openGroup('group-1')
      })

      expect(result.current.activeGroup).toEqual(mockGroups[0])
    })

    it('returns null when activeGroupId does not match any group', async () => {
      const mockGroups = [createMockGroup({ id: 'group-1' })]
      mockApi.getTaskGroups.mockResolvedValue(mockGroups)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      act(() => {
        result.current.openGroup('non-existent')
      })

      expect(result.current.activeGroup).toBeNull()
    })
  })

  describe('activeGroups and completedGroups derived values', () => {
    it('filters groups by status correctly', async () => {
      const mockGroups = [
        createMockGroup({ id: 'g1', status: 'active' }),
        createMockGroup({ id: 'g2', status: 'completed' }),
        createMockGroup({ id: 'g3', status: 'active' }),
        createMockGroup({ id: 'g4', status: 'archived' }),
      ]
      mockApi.getTaskGroups.mockResolvedValue(mockGroups)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      expect(result.current.activeGroups).toHaveLength(2)
      expect(result.current.activeGroups.map(g => g.id)).toEqual(['g1', 'g3'])

      expect(result.current.completedGroups).toHaveLength(1)
      expect(result.current.completedGroups[0].id).toBe('g2')
    })

    it('returns empty arrays when no groups loaded', () => {
      const { result } = renderHook(() => useTaskGroups())

      expect(result.current.activeGroups).toEqual([])
      expect(result.current.completedGroups).toEqual([])
    })
  })

  describe('addTasksToGroup', () => {
    it('adds tasks to group with optimistic update', async () => {
      const initialGroup = createMockGroup({ id: 'group-1', updatedAt: 1000 })
      const updatedGroup = createMockGroup({ id: 'group-1', updatedAt: 2000 })

      mockApi.getTaskGroups.mockResolvedValue([initialGroup])
      mockApi.addTasksToGroup.mockResolvedValue(updatedGroup)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        await result.current.addTasksToGroup('group-1', ['task-2', 'task-3'])
      })

      expect(result.current.groups[0].updatedAt).toBe(2000)
      expect(mockShowToast).toHaveBeenCalledWith(
        '2 task(s) added to group',
        'success'
      )
    })

    it('reverts by reloading on failure', async () => {
      const initialGroup = createMockGroup({ id: 'group-1' })
      mockApi.getTaskGroups.mockResolvedValue([initialGroup])
      mockApi.addTasksToGroup.mockRejectedValue(new Error('Add failed'))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.addTasksToGroup('group-1', ['task-2'])
        } catch {
          // Expected to throw
        }
      })

      // Should have called loadGroups to revert
      expect(mockApi.getTaskGroups).toHaveBeenCalledTimes(2)
      expect(mockShowToast).toHaveBeenCalledWith(
        'Failed to add tasks: Add failed',
        'error'
      )
    })
  })

  describe('removeTasksFromGroup', () => {
    it('removes tasks from group with optimistic update', async () => {
      const initialGroup = createMockGroup({ id: 'group-1', updatedAt: 1000 })
      const updatedGroup = createMockGroup({ id: 'group-1', updatedAt: 2000 })

      mockApi.getTaskGroups.mockResolvedValue([initialGroup])
      mockApi.removeTasksFromGroup.mockResolvedValue(updatedGroup)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        await result.current.removeTasksFromGroup('group-1', ['task-1'])
      })

      expect(result.current.groups[0].updatedAt).toBe(2000)
      expect(mockShowToast).toHaveBeenCalledWith(
        '1 task(s) removed from group',
        'success'
      )
    })

    it('reverts by reloading on failure', async () => {
      const initialGroup = createMockGroup({ id: 'group-1' })
      mockApi.getTaskGroups.mockResolvedValue([initialGroup])
      mockApi.removeTasksFromGroup.mockRejectedValue(new Error('Remove failed'))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.removeTasksFromGroup('group-1', ['task-1'])
        } catch {
          // Expected to throw
        }
      })

      expect(mockApi.getTaskGroups).toHaveBeenCalledTimes(2)
    })
  })

  describe('startGroup', () => {
    it('starts group execution when group exists', async () => {
      const mockRun: WorkflowRun = {
        id: 'run-1',
        kind: 'group',
        status: 'running',
        taskOrder: ['task-1'],
        currentTaskIndex: 0,
        pauseRequested: false,
        stopRequested: false,
        isArchived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const mockGroup = createMockGroup({ id: 'group-1', name: 'Test Group' })
      mockApi.getTaskGroups.mockResolvedValue([mockGroup])
      mockApi.startGroup.mockResolvedValue(mockRun)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      const run = await act(async () => {
        return await result.current.startGroup('group-1')
      })

      expect(run).toEqual(mockRun)
      expect(mockShowToast).toHaveBeenCalledWith(
        'Started execution for group "Test Group"',
        'success'
      )
    })

    it('throws error when group does not exist', async () => {
      mockApi.getTaskGroups.mockResolvedValue([])

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.startGroup('non-existent')
        } catch (e) {
          expect((e as Error).message).toBe('Group not found')
        }
      })

      expect(mockShowToast).toHaveBeenCalledWith('Group not found', 'error')
    })

    it('handles API error with toast', async () => {
      const mockGroup = createMockGroup({ id: 'group-1' })
      mockApi.getTaskGroups.mockResolvedValue([mockGroup])
      mockApi.startGroup.mockRejectedValue(new Error('Start failed'))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.startGroup('group-1')
        } catch {
          // Expected
        }
      })

      expect(mockShowToast).toHaveBeenCalledWith(
        'Failed to start group: Start failed',
        'error'
      )
    })
  })

  describe('deleteGroup', () => {
    it('deletes group with optimistic removal', async () => {
      const mockGroups = [
        createMockGroup({ id: 'group-1', name: 'Group 1' }),
        createMockGroup({ id: 'group-2', name: 'Group 2' }),
      ]
      mockApi.getTaskGroups.mockResolvedValue(mockGroups)
      mockApi.deleteTaskGroup.mockResolvedValue(undefined)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      expect(result.current.groups).toHaveLength(2)

      await act(async () => {
        await result.current.deleteGroup('group-1')
      })

      expect(result.current.groups).toHaveLength(1)
      expect(result.current.groups[0].id).toBe('group-2')
      expect(mockShowToast).toHaveBeenCalledWith(
        'Group "Group 1" deleted',
        'success'
      )
    })

    it('clears activeGroupId when deleting active group', async () => {
      const mockGroup = createMockGroup({ id: 'group-1' })
      mockApi.getTaskGroups.mockResolvedValue([mockGroup])
      mockApi.deleteTaskGroup.mockResolvedValue(undefined)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      act(() => {
        result.current.openGroup('group-1')
      })

      expect(result.current.activeGroupId).toBe('group-1')

      await act(async () => {
        await result.current.deleteGroup('group-1')
      })

      expect(result.current.activeGroupId).toBeNull()
    })

    it('reverts optimistic removal on failure', async () => {
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Group 1' })
      mockApi.getTaskGroups.mockResolvedValue([mockGroup])
      mockApi.deleteTaskGroup.mockRejectedValue(new Error('Delete failed'))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.deleteGroup('group-1')
        } catch {
          // Expected
        }
      })

      expect(result.current.groups).toHaveLength(1)
      expect(result.current.groups[0].id).toBe('group-1')
      expect(mockShowToast).toHaveBeenCalledWith(
        'Failed to delete group: Delete failed',
        'error'
      )
    })

    it('throws error when group not found', async () => {
      mockApi.getTaskGroups.mockResolvedValue([])

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.deleteGroup('non-existent')
        } catch (e) {
          expect((e as Error).message).toBe('Group not found')
        }
      })

      expect(mockShowToast).toHaveBeenCalledWith('Group not found', 'error')
    })
  })

  describe('updateGroup', () => {
    it('updates group with optimistic update', async () => {
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Old Name' })
      const updatedGroup = createMockGroup({ id: 'group-1', name: 'New Name' })

      mockApi.getTaskGroups.mockResolvedValue([mockGroup])
      mockApi.updateTaskGroup.mockResolvedValue(updatedGroup)

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        await result.current.updateGroup('group-1', { name: 'New Name' })
      })

      expect(result.current.groups[0].name).toBe('New Name')
      expect(mockShowToast).toHaveBeenCalledWith('Group updated', 'success')
    })

    it('reverts optimistic update on failure', async () => {
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Original Name' })
      mockApi.getTaskGroups.mockResolvedValue([mockGroup])
      mockApi.updateTaskGroup.mockRejectedValue(new Error('Update failed'))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.updateGroup('group-1', { name: 'New Name' })
        } catch {
          // Expected
        }
      })

      expect(result.current.groups[0].name).toBe('Original Name')
    })

    it('throws error when group not found', async () => {
      mockApi.getTaskGroups.mockResolvedValue([])

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      await act(async () => {
        try {
          await result.current.updateGroup('non-existent', { name: 'New' })
        } catch (e) {
          expect((e as Error).message).toBe('Group not found')
        }
      })
    })
  })

  describe('getGroupById', () => {
    it('returns group when found', async () => {
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Found Group' })
      mockApi.getTaskGroups.mockResolvedValue([mockGroup])

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      const found = result.current.getGroupById('group-1')
      expect(found).toEqual(mockGroup)
    })

    it('returns undefined when not found', async () => {
      mockApi.getTaskGroups.mockResolvedValue([])

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        await result.current.loadGroups()
      })

      const found = result.current.getGroupById('non-existent')
      expect(found).toBeUndefined()
    })
  })

  describe('loadGroupDetails', () => {
    it('fetches and returns group details', async () => {
      const groupWithTasks = {
        ...createMockGroup({ id: 'group-1' }),
        tasks: [],
        members: [],
      }
      mockApi.getTaskGroup.mockResolvedValue(groupWithTasks)

      const { result } = renderHook(() => useTaskGroups())

      const details = await act(async () => {
        return await result.current.loadGroupDetails('group-1')
      })

      expect(details).toEqual(groupWithTasks)
      expect(mockApi.getTaskGroup).toHaveBeenCalledWith('group-1')
    })

    it('shows error toast on failure', async () => {
      mockApi.getTaskGroup.mockRejectedValue(new Error('Load failed'))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        try {
          await result.current.loadGroupDetails('group-1')
        } catch {
          // Expected
        }
      })

      expect(mockShowToast).toHaveBeenCalledWith(
        'Failed to load group details: Load failed',
        'error'
      )
    })
  })

  describe('WebSocket handlers', () => {
    describe('updateGroupFromWebSocket', () => {
      it('adds new group when not exists', () => {
        const { result } = renderHook(() => useTaskGroups())

        const newGroup = createMockGroup({ id: 'new-group' })

        act(() => {
          result.current.updateGroupFromWebSocket(newGroup)
        })

        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe('new-group')
      })

      it('updates existing group when exists', async () => {
        const mockGroup = createMockGroup({ id: 'group-1', name: 'Old Name' })
        mockApi.getTaskGroups.mockResolvedValue([mockGroup])

        const { result } = renderHook(() => useTaskGroups())

        await act(async () => {
          await result.current.loadGroups()
        })

        const updatedGroup = createMockGroup({ id: 'group-1', name: 'Updated Name' })

        act(() => {
          result.current.updateGroupFromWebSocket(updatedGroup)
        })

        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].name).toBe('Updated Name')
      })

      it('should not duplicate group when WebSocket arrives BEFORE API response', async () => {
        // Race condition: WebSocket message arrives before API response completes
        // This is the main bug we're fixing - groups appear duplicated on creation

        const realGroup = createMockGroup({ id: 'real-group-id', name: 'New Group' })
        let resolveCreate: (value: TaskGroup) => void
        const createPromise = new Promise<TaskGroup>((resolve) => {
          resolveCreate = resolve
        })
        mockApi.createTaskGroup.mockReturnValue(createPromise)

        const { result } = renderHook(() => useTaskGroups())

        // Start creating a group
        let createPromiseResult: Promise<TaskGroup>
        act(() => {
          createPromiseResult = result.current.createGroup(['task-1'], 'New Group')
        })

        // Temp group should be added immediately (optimistic update)
        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id.startsWith('temp-')).toBe(true)

        // Simulate WebSocket message arriving BEFORE API response completes
        // This is the problematic race condition
        act(() => {
          result.current.updateGroupFromWebSocket(realGroup)
        })

        // WebSocket should replace temp with real group (no duplicate)
        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe('real-group-id')

        // Now resolve the API call
        await act(async () => {
          resolveCreate!(realGroup)
          await createPromiseResult!
        })

        // Should still have exactly one group with the real ID
        // API response handler must dedupe correctly
        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe('real-group-id')
        expect(result.current.groups[0].name).toBe('New Group')
      })

      it('should not duplicate when WebSocket arrives AFTER API response', async () => {
        // Race condition: API response completes before WebSocket arrives
        // Both add the same real group - must dedupe by ID

        const realGroup = createMockGroup({ id: 'real-group-id', name: 'New Group' })
        mockApi.createTaskGroup.mockResolvedValue(realGroup)

        const { result } = renderHook(() => useTaskGroups())

        // Create group - API call completes immediately in mock
        await act(async () => {
          await result.current.createGroup(['task-1'], 'New Group')
        })

        // Should have exactly one group from API response
        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe('real-group-id')

        // Now simulate WebSocket arriving after API response
        act(() => {
          result.current.updateGroupFromWebSocket(realGroup)
        })

        // Should still have exactly one group - WebSocket handler dedupes by ID
        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe('real-group-id')
      })

      it('should handle clock skew when temp and real timestamps differ', async () => {
        // This test verifies the time-based fallback matching works with clock skew
        // When pendingTempIdRef is null, WebSocket handler falls back to name+time matching
        const { result } = renderHook(() => useTaskGroups())

        // Manually add a temp group (simulating optimistic update state)
        const tempId = 'temp-1234567890'
        const tempCreatedAt = Date.now()
        const tempGroup: TaskGroup = {
          id: tempId,
          name: 'Clock Skew Group',
          color: '#6366f1',
          status: 'active',
          createdAt: tempCreatedAt,
          updatedAt: tempCreatedAt,
          completedAt: null,
        }

        // Add temp group directly via setGroups simulation
        act(() => {
          result.current.updateGroupFromWebSocket(tempGroup)
        })

        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe(tempId)

        // Simulate real group with 3000ms time difference (within 5000ms window)
        // This tests the time-based fallback matching
        const realGroup = createMockGroup({
          id: 'real-clock-skew-id',
          name: 'Clock Skew Group',
          createdAt: tempCreatedAt + 3000, // 3000ms skew
        })

        // WebSocket arrives with real group - should replace temp via time-based matching
        act(() => {
          result.current.updateGroupFromWebSocket(realGroup)
        })

        // Should have exactly one group (temp replaced by real)
        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe('real-clock-skew-id')
      })
    })

    describe('removeGroupFromWebSocket', () => {
      it('removes group from list', async () => {
        const mockGroups = [
          createMockGroup({ id: 'group-1' }),
          createMockGroup({ id: 'group-2' }),
        ]
        mockApi.getTaskGroups.mockResolvedValue(mockGroups)

        const { result } = renderHook(() => useTaskGroups())

        await act(async () => {
          await result.current.loadGroups()
        })

        expect(result.current.groups).toHaveLength(2)

        act(() => {
          result.current.removeGroupFromWebSocket('group-1')
        })

        expect(result.current.groups).toHaveLength(1)
        expect(result.current.groups[0].id).toBe('group-2')
      })

      it('clears activeGroupId when removing active group', async () => {
        const mockGroup = createMockGroup({ id: 'group-1' })
        mockApi.getTaskGroups.mockResolvedValue([mockGroup])

        const { result } = renderHook(() => useTaskGroups())

        await act(async () => {
          await result.current.loadGroups()
        })

        act(() => {
          result.current.openGroup('group-1')
        })

        expect(result.current.activeGroupId).toBe('group-1')

        act(() => {
          result.current.removeGroupFromWebSocket('group-1')
        })

        expect(result.current.activeGroupId).toBeNull()
      })
    })
  })

  describe('error state management', () => {
    it('clears error on successful loadGroups after failure', async () => {
      mockApi.getTaskGroups.mockRejectedValueOnce(new Error('First error'))
      mockApi.getTaskGroups.mockResolvedValueOnce([createMockGroup()])

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        try {
          await result.current.loadGroups()
        } catch {
          // Expected
        }
      })

      expect(result.current.error).toBe('First error')

      await act(async () => {
        await result.current.loadGroups()
      })

      expect(result.current.error).toBeNull()
    })

    it('error state persists across operations until cleared', async () => {
      mockApi.getTaskGroups.mockRejectedValue(new Error('Persistent error'))

      const { result } = renderHook(() => useTaskGroups())

      await act(async () => {
        try {
          await result.current.loadGroups()
        } catch {
          // Expected
        }
      })

      expect(result.current.error).toBe('Persistent error')

      // Attempting another operation that doesn't touch error state
      act(() => {
        result.current.openGroup('some-id')
      })

      // Error should persist
      expect(result.current.error).toBe('Persistent error')
    })
  })
})
