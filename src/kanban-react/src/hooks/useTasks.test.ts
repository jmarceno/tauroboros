import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useTasks } from './useTasks'
import type { Task, TaskGroup } from '@/types'

// Create mock API functions
const mockApiFunctions = {
  getTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  reorderTask: vi.fn(),
  archiveAllDone: vi.fn(),
  resetTaskWithGroupInfo: vi.fn(),
  resetTaskToGroup: vi.fn(),
  moveTaskToGroup: vi.fn(),
  approvePlan: vi.fn(),
  requestPlanRevision: vi.fn(),
  repairTask: vi.fn(),
  startSingleTask: vi.fn(),
  getBestOfNSummary: vi.fn(),
}

// Mock the useApi hook
vi.mock('./useApi', () => ({
  useApi: () => mockApiFunctions,
}))

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    idx: 1,
    name: 'Test Task',
    prompt: 'Test prompt',
    status: 'backlog',
    branch: 'main',
    planmode: false,
    autoApprovePlan: false,
    review: false,
    autoCommit: false,
    deleteWorktree: false,
    skipPermissionAsking: false,
    requirements: [],
    thinkingLevel: 'default',
    planThinkingLevel: 'default',
    executionThinkingLevel: 'default',
    executionStrategy: 'standard',
    reviewCount: 0,
    jsonParseRetryCount: 0,
    planRevisionCount: 0,
    executionPhase: 'not_started',
    awaitingPlanApproval: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function createMockGroup(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    id: 'group-1',
    name: 'Test Group',
    color: '#FF5733',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe.skip('useTasks hook - restore to group functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('resetTask', () => {
    it('returns wasInGroup true and group info when task was in a group', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'done', groupId: 'group-1' })
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Original Group' })

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.resetTaskWithGroupInfo.mockResolvedValue({
        task: { ...mockTask, status: 'backlog', completedAt: null },
        group: mockGroup,
        wasInGroup: true,
      })

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      // Reset the task
      let resetResult: { task: Task; group?: TaskGroup; wasInGroup: boolean } | undefined
      await act(async () => {
        resetResult = await result.current.resetTask('task-1')
      })

      expect(mockApiFunctions.resetTaskWithGroupInfo).toHaveBeenCalledWith('task-1')
      expect(resetResult).toBeDefined()
      expect(resetResult!.wasInGroup).toBe(true)
      expect(resetResult!.group).toEqual(mockGroup)
      expect(resetResult!.task.status).toBe('backlog')
    })

    it('returns wasInGroup false when task was not in a group', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'done', groupId: undefined })

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.resetTaskWithGroupInfo.mockResolvedValue({
        task: { ...mockTask, status: 'backlog', completedAt: null },
        wasInGroup: false,
      })

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      let resetResult: { task: Task; group?: TaskGroup; wasInGroup: boolean } | undefined
      await act(async () => {
        resetResult = await result.current.resetTask('task-1')
      })

      expect(mockApiFunctions.resetTaskWithGroupInfo).toHaveBeenCalledWith('task-1')
      expect(resetResult).toBeDefined()
      expect(resetResult!.wasInGroup).toBe(false)
      expect(resetResult!.group).toBeUndefined()
    })

    it('updates local task state after reset', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'done' })
      const resetTask = { ...mockTask, status: 'backlog', completedAt: null }

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.resetTaskWithGroupInfo.mockResolvedValue({
        task: resetTask,
        wasInGroup: false,
      })

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      await act(async () => {
        await result.current.resetTask('task-1')
      })

      // Task should be updated in the local state
      expect(result.current.getTaskById('task-1')?.status).toBe('backlog')
    })
  })

  describe('resetTaskToGroup', () => {
    it('restores task to its previous group and updates local state', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'done' })
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Original Group' })
      const restoredTask = { ...mockTask, status: 'backlog', groupId: 'group-1', completedAt: null }

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.resetTaskToGroup.mockResolvedValue({
        task: restoredTask,
        group: mockGroup,
        restoredToGroup: true,
      })

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      let returnedTask: Task | undefined
      await act(async () => {
        returnedTask = await result.current.resetTaskToGroup('task-1')
      })

      expect(mockApiFunctions.resetTaskToGroup).toHaveBeenCalledWith('task-1')
      expect(returnedTask).toBeDefined()
      expect(returnedTask!.status).toBe('backlog')
      expect(returnedTask!.groupId).toBe('group-1')

      // Local state should be updated
      expect(result.current.getTaskById('task-1')?.status).toBe('backlog')
      expect(result.current.getTaskById('task-1')?.groupId).toBe('group-1')
    })
  })

  describe('moveTaskToGroup', () => {
    it('adds task to group when valid groupId is provided', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'backlog', groupId: undefined })
      const updatedTask = { ...mockTask, groupId: 'group-1' }

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.moveTaskToGroup.mockResolvedValue(updatedTask)

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      let returnedTask: Task | undefined
      await act(async () => {
        returnedTask = await result.current.moveTaskToGroup('task-1', 'group-1')
      })

      expect(mockApiFunctions.moveTaskToGroup).toHaveBeenCalledWith('task-1', 'group-1')
      expect(returnedTask).toBeDefined()
      expect(returnedTask!.groupId).toBe('group-1')

      // Local state should be updated
      expect(result.current.getTaskById('task-1')?.groupId).toBe('group-1')
    })

    it('removes task from group when null groupId is provided', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'backlog', groupId: 'group-1' })
      const updatedTask = { ...mockTask, groupId: null }

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.moveTaskToGroup.mockResolvedValue(updatedTask)

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      let returnedTask: Task | undefined
      await act(async () => {
        returnedTask = await result.current.moveTaskToGroup('task-1', null)
      })

      expect(mockApiFunctions.moveTaskToGroup).toHaveBeenCalledWith('task-1', null)
      expect(returnedTask).toBeDefined()
      expect(returnedTask!.groupId).toBeNull()

      // Local state should be updated
      expect(result.current.getTaskById('task-1')?.groupId).toBeNull()
    })

    it('propagates API errors', async () => {
      const mockTask = createMockTask({ id: 'task-1' })
      const mockError = new Error('Group not found')

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.moveTaskToGroup.mockRejectedValue(mockError)

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      await expect(result.current.moveTaskToGroup('task-1', 'invalid-group')).rejects.toThrow('Group not found')
    })
  })

  describe('integration: restore flow', () => {
    it('complete flow: reset task, then restore to group', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'done', groupId: 'group-1' })
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Original Group' })
      const resetTask = { ...mockTask, status: 'backlog', completedAt: null, groupId: undefined }
      const restoredTask = { ...mockTask, status: 'backlog', groupId: 'group-1', completedAt: null }

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.resetTaskWithGroupInfo.mockResolvedValue({
        task: resetTask,
        group: mockGroup,
        wasInGroup: true,
      })
      mockApiFunctions.resetTaskToGroup.mockResolvedValue({
        task: restoredTask,
        group: mockGroup,
        restoredToGroup: true,
      })

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      // Step 1: Reset the task and check if it was in a group
      let resetResult: { task: Task; group?: TaskGroup; wasInGroup: boolean } | undefined
      await act(async () => {
        resetResult = await result.current.resetTask('task-1')
      })

      expect(resetResult!.wasInGroup).toBe(true)
      expect(resetResult!.group).toBeDefined()

      // Step 2: User chooses to restore to group
      let restoredTaskResult: Task | undefined
      await act(async () => {
        restoredTaskResult = await result.current.resetTaskToGroup('task-1')
      })

      expect(restoredTaskResult!.status).toBe('backlog')
      expect(restoredTaskResult!.groupId).toBe('group-1')
    })

    it('complete flow: reset task, then move to general backlog (remove from group)', async () => {
      const mockTask = createMockTask({ id: 'task-1', status: 'done', groupId: 'group-1' })
      const mockGroup = createMockGroup({ id: 'group-1', name: 'Original Group' })
      const resetTask = { ...mockTask, status: 'backlog', completedAt: null, groupId: undefined }
      const movedTask = { ...mockTask, status: 'backlog', groupId: null, completedAt: null }

      mockApiFunctions.getTasks.mockResolvedValue([mockTask])
      mockApiFunctions.resetTaskWithGroupInfo.mockResolvedValue({
        task: resetTask,
        group: mockGroup,
        wasInGroup: true,
      })
      mockApiFunctions.moveTaskToGroup.mockResolvedValue(movedTask)

      const { result } = renderHook(() => useTasks())

      // Load tasks first
      await act(async () => {
        await result.current.loadTasks()
      })

      // Step 1: Reset the task and check if it was in a group
      let resetResult: { task: Task; group?: TaskGroup; wasInGroup: boolean } | undefined
      await act(async () => {
        resetResult = await result.current.resetTask('task-1')
      })

      expect(resetResult!.wasInGroup).toBe(true)

      // Step 2: User chooses to move to general backlog - remove from group
      let movedTaskResult: Task | undefined
      await act(async () => {
        movedTaskResult = await result.current.moveTaskToGroup('task-1', null)
      })

      expect(mockApiFunctions.moveTaskToGroup).toHaveBeenCalledWith('task-1', null)
      expect(movedTaskResult!.status).toBe('backlog')
      expect(movedTaskResult!.groupId).toBeNull()

      // Local state should reflect the change
      expect(result.current.getTaskById('task-1')?.groupId).toBeNull()
    })
  })
})
