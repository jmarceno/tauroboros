import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDragDrop } from './useDragDrop'

describe('useDragDrop', () => {
  const mockOnDrop = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('initializes with null drag state', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      expect(result.current.dragTaskId).toBeNull()
      expect(result.current.dragSourceContext).toBeNull()
      expect(result.current.dragSourceGroupId).toBeNull()
      expect(result.current.dragOverTarget).toBeNull()
      expect(result.current.dragOverStatus).toBeNull()
    })
  })

  describe('handleDragStart', () => {
    it('sets drag state for column source', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'backlog' })
      })

      expect(result.current.dragTaskId).toBe('task-1')
      expect(result.current.dragSourceContext).toBe('column')
      expect(result.current.dragSourceGroupId).toBeNull()
    })

    it('sets drag state for group source', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-2', { source: 'group', groupId: 'group-1' })
      })

      expect(result.current.dragTaskId).toBe('task-2')
      expect(result.current.dragSourceContext).toBe('group')
      expect(result.current.dragSourceGroupId).toBe('group-1')
    })

    it('clears group ID when source is column', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      // First start with group context
      act(() => {
        result.current.handleDragStart('task-1', { source: 'group', groupId: 'group-1' })
      })

      expect(result.current.dragSourceGroupId).toBe('group-1')

      // Then switch to column context
      act(() => {
        result.current.handleDragStart('task-2', { source: 'column', status: 'backlog' })
      })

      expect(result.current.dragSourceGroupId).toBeNull()
    })
  })

  describe('handleDragEnd', () => {
    it('clears all drag state', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      // Set some drag state
      act(() => {
        result.current.handleDragStart('task-1', { source: 'group', groupId: 'group-1' })
      })

      // Set drag over - need proper mock event with preventDefault
      const mockEvent1 = { preventDefault: vi.fn() } as unknown as React.DragEvent
      act(() => {
        result.current.handleDragOver('backlog', mockEvent1)
      })

      const mockEvent2 = { preventDefault: vi.fn() } as unknown as React.DragEvent
      act(() => {
        result.current.handleDragOverGroup('group-2', mockEvent2)
      })

      expect(result.current.dragTaskId).toBe('task-1')
      expect(result.current.dragSourceContext).toBe('group')
      expect(result.current.dragOverStatus).not.toBeNull()

      // End drag
      act(() => {
        result.current.handleDragEnd()
      })

      expect(result.current.dragTaskId).toBeNull()
      expect(result.current.dragSourceContext).toBeNull()
      expect(result.current.dragSourceGroupId).toBeNull()
      expect(result.current.dragOverTarget).toBeNull()
      expect(result.current.dragOverStatus).toBeNull()
    })
  })

  describe('handleDragOver', () => {
    it('sets dragOverStatus to target column', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragOver('backlog', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(result.current.dragOverStatus).toBe('backlog')
      expect(result.current.dragOverTarget).toEqual({ type: 'column', id: 'backlog' })
    })

    it('prevents default on drag over', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      const mockEvent = {
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent

      act(() => {
        result.current.handleDragOver('executing', mockEvent)
      })

      expect(mockEvent.preventDefault).toHaveBeenCalled()
    })

    it('updates dragOverTarget when moving to different column', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragOver('backlog', { preventDefault: vi.fn() } as unknown as React.DragEvent)
      })

      expect(result.current.dragOverStatus).toBe('backlog')

      act(() => {
        result.current.handleDragOver('review', { preventDefault: vi.fn() } as unknown as React.DragEvent)
      })

      expect(result.current.dragOverStatus).toBe('review')
      expect(result.current.dragOverTarget).toEqual({ type: 'column', id: 'review' })
    })
  })

  describe('handleDragOverGroup', () => {
    it('sets dragOverTarget to group', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragOverGroup('group-1', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(result.current.dragOverTarget).toEqual({ type: 'group', id: 'group-1' })
      // Column dragOverStatus should be cleared
      expect(result.current.dragOverStatus).toBeNull()
    })

    it('prevents default on drag over group', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      const mockEvent = {
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent

      act(() => {
        result.current.handleDragOverGroup('group-1', mockEvent)
      })

      expect(mockEvent.preventDefault).toHaveBeenCalled()
    })
  })

  describe('handleDragLeave', () => {
    it('clears dragOverStatus', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragOver('backlog', { preventDefault: vi.fn() } as unknown as React.DragEvent)
      })

      expect(result.current.dragOverStatus).toBe('backlog')

      act(() => {
        result.current.handleDragLeave()
      })

      expect(result.current.dragOverStatus).toBeNull()
    })

    it('clears dragOverTarget', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragOverGroup('group-1', { preventDefault: vi.fn() } as unknown as React.DragEvent)
      })

      expect(result.current.dragOverTarget).toEqual({ type: 'group', id: 'group-1' })

      act(() => {
        result.current.handleDragLeave()
      })

      expect(result.current.dragOverTarget).toBeNull()
    })
  })

  describe('handleDrop', () => {
    it('does nothing when no dragTaskId', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDrop('backlog', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).not.toHaveBeenCalled()
    })

    it('calls onDrop with move-to-review when dropping on review from column', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'backlog' })
      })

      act(() => {
        result.current.handleDrop('review', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).toHaveBeenCalledWith('task-1', 'review', 'move-to-review')
    })

    it('calls onDrop with reset-to-backlog when dropping on backlog from column', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'executing' })
      })

      act(() => {
        result.current.handleDrop('backlog', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).toHaveBeenCalledWith('task-1', 'backlog', 'reset-to-backlog')
    })

    it('calls onDrop with move-to-done when dropping on done', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'review' })
      })

      act(() => {
        result.current.handleDrop('done', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).toHaveBeenCalledWith('task-1', 'done', 'move-to-done')
    })

    it('calls onDrop with remove-from-group when dropping from group to backlog', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'group', groupId: 'group-1' })
      })

      act(() => {
        result.current.handleDrop('backlog', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).toHaveBeenCalledWith('task-1', 'backlog', 'remove-from-group')
    })

    it('clears drag state after successful drop', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'backlog' })
      })

      expect(result.current.dragTaskId).toBe('task-1')

      act(() => {
        result.current.handleDrop('review', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(result.current.dragTaskId).toBeNull()
      expect(result.current.dragSourceContext).toBeNull()
      expect(result.current.dragSourceGroupId).toBeNull()
    })

    it('defaults to reset-to-backlog for unknown column targets', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'backlog' })
      })

      act(() => {
        result.current.handleDrop('stuck', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).toHaveBeenCalledWith('task-1', 'stuck', 'reset-to-backlog')
    })
  })

  describe('handleDropOnGroup', () => {
    it('does nothing when no dragTaskId', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDropOnGroup('group-1', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).not.toHaveBeenCalled()
    })

    it('calls onDrop with add-to-group action', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'backlog' })
      })

      act(() => {
        result.current.handleDropOnGroup('group-1', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(mockOnDrop).toHaveBeenCalledWith('task-1', 'group-1', 'add-to-group')
    })

    it('clears drag state after successful drop', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'backlog' })
      })

      act(() => {
        result.current.handleDropOnGroup('group-1', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      expect(result.current.dragTaskId).toBeNull()
      expect(result.current.dragSourceContext).toBeNull()
      expect(result.current.dragSourceGroupId).toBeNull()
      expect(result.current.dragOverTarget).toBeNull()
    })

    it('works when dragging from another group', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'group', groupId: 'group-1' })
      })

      act(() => {
        result.current.handleDropOnGroup('group-2', {
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent)
      })

      // Should still add to group (though validation may prevent this)
      expect(mockOnDrop).toHaveBeenCalledWith('task-1', 'group-2', 'add-to-group')
    })
  })

  describe('group context state management', () => {
    it('tracks drag from group correctly', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      act(() => {
        result.current.handleDragStart('task-1', { source: 'group', groupId: 'group-1' })
      })

      expect(result.current.dragSourceContext).toBe('group')
      expect(result.current.dragSourceGroupId).toBe('group-1')
    })

    it('allows transitioning from column drag to group drag', () => {
      const { result } = renderHook(() => useDragDrop(mockOnDrop))

      // Start from column
      act(() => {
        result.current.handleDragStart('task-1', { source: 'column', status: 'backlog' })
      })

      expect(result.current.dragSourceContext).toBe('column')

      // Switch to group
      act(() => {
        result.current.handleDragStart('task-2', { source: 'group', groupId: 'group-1' })
      })

      expect(result.current.dragSourceContext).toBe('group')
      expect(result.current.dragSourceGroupId).toBe('group-1')
    })
  })
})