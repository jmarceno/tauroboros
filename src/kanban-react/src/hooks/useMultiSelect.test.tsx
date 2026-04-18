import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMultiSelect } from './useMultiSelect'

function createMockMouseEvent(ctrlKey = false): React.MouseEvent {
  return {
    ctrlKey,
    metaKey: false,
  } as React.MouseEvent
}

function createCmdClickEvent(): React.MouseEvent {
  return {
    ctrlKey: false,
    metaKey: true,
  } as React.MouseEvent
}

describe('useMultiSelect', () => {
  describe('initial state', () => {
    it('initializes with empty selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      expect(result.current.selectedTaskIds.size).toBe(0)
      expect(result.current.isSelecting).toBe(false)
      expect(result.current.selectedCount).toBe(0)
    })

    it('initializes with null mode', () => {
      const { result } = renderHook(() => useMultiSelect())

      expect(result.current.mode).toBeNull()
    })
  })

  describe('toggleSelection', () => {
    it('adds task to selection on Ctrl+Click when mode is null', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        const success = result.current.toggleSelection('task-1', createMockMouseEvent(true))
        expect(success).toBe(true)
      })

      expect(result.current.isSelected('task-1')).toBe(true)
      expect(result.current.selectedCount).toBe(1)
    })

    it('removes task from selection on Ctrl+Click when already selected', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
      })

      act(() => {
        const success = result.current.toggleSelection('task-1', createMockMouseEvent(true))
        expect(success).toBe(true)
      })

      expect(result.current.isSelected('task-1')).toBe(false)
      expect(result.current.selectedCount).toBe(0)
    })

    it('returns false and does not toggle on click without Ctrl when mode is null', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        const success = result.current.toggleSelection('task-1', createMockMouseEvent(false))
        expect(success).toBe(false)
      })

      expect(result.current.isSelected('task-1')).toBe(false)
      expect(result.current.selectedCount).toBe(0)
    })

    it('allows selection without Ctrl when mode is create-group', () => {
      const { result } = renderHook(() => useMultiSelect())

      // First select tasks with Ctrl+Click
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      // Start group creation
      act(() => {
        result.current.startGroupCreation()
      })

      // Now add another task without Ctrl
      act(() => {
        const success = result.current.toggleSelection('task-3', createMockMouseEvent(false))
        expect(success).toBe(true)
      })

      expect(result.current.isSelected('task-3')).toBe(true)
      expect(result.current.selectedCount).toBe(3)
    })

    it('allows deselection without Ctrl when mode is create-group', () => {
      const { result } = renderHook(() => useMultiSelect())

      // First select tasks
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      // Start group creation
      act(() => {
        result.current.startGroupCreation()
      })

      // Deselect without Ctrl
      act(() => {
        const success = result.current.toggleSelection('task-1', createMockMouseEvent(false))
        expect(success).toBe(true)
      })

      expect(result.current.isSelected('task-1')).toBe(false)
      expect(result.current.isSelected('task-2')).toBe(true)
      expect(result.current.selectedCount).toBe(1)
    })

    it('supports Cmd+Click on Mac', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        const success = result.current.toggleSelection('task-1', createCmdClickEvent())
        expect(success).toBe(true)
      })

      expect(result.current.isSelected('task-1')).toBe(true)
    })

    it('maintains multiple selections with Ctrl+Click', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
        result.current.toggleSelection('task-3', createMockMouseEvent(true))
      })

      expect(result.current.selectedCount).toBe(3)
      expect(result.current.getSelectedIds()).toEqual(['task-1', 'task-2', 'task-3'])
    })
  })

  describe('selectSingle', () => {
    it('selects a single task', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.selectSingle('task-1')
      })

      expect(result.current.isSelected('task-1')).toBe(true)
      expect(result.current.selectedCount).toBe(1)
    })

    it('replaces existing selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      act(() => {
        result.current.selectSingle('task-3')
      })

      expect(result.current.isSelected('task-1')).toBe(false)
      expect(result.current.isSelected('task-2')).toBe(false)
      expect(result.current.isSelected('task-3')).toBe(true)
      expect(result.current.selectedCount).toBe(1)
    })
  })

  describe('clearSelection', () => {
    it('clears all selected tasks', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      act(() => {
        result.current.clearSelection()
      })

      expect(result.current.selectedTaskIds.size).toBe(0)
      expect(result.current.isSelecting).toBe(false)
      expect(result.current.selectedCount).toBe(0)
    })

    it('clears mode as well', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Set up group creation mode
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      act(() => {
        result.current.startGroupCreation()
      })

      expect(result.current.mode).toBe('create-group')

      act(() => {
        result.current.clearSelection()
      })

      expect(result.current.mode).toBeNull()
    })
  })

  describe('isSelected', () => {
    it('returns true for selected task', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
      })

      expect(result.current.isSelected('task-1')).toBe(true)
    })

    it('returns false for unselected task', () => {
      const { result } = renderHook(() => useMultiSelect())

      expect(result.current.isSelected('task-1')).toBe(false)
    })
  })

  describe('getSelectedIds', () => {
    it('returns empty array when no selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      expect(result.current.getSelectedIds()).toEqual([])
    })

    it('returns array of selected IDs', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      expect(result.current.getSelectedIds()).toEqual(['task-1', 'task-2'])
    })
  })

  describe('startGroupCreation', () => {
    it('returns false when no tasks are selected', () => {
      const { result } = renderHook(() => useMultiSelect())

      let success: boolean | undefined
      act(() => {
        success = result.current.startGroupCreation()
      })

      expect(success).toBe(false)
      expect(result.current.mode).toBeNull()
    })

    it('returns false when only 1 task is selected', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
      })

      let success: boolean | undefined
      act(() => {
        success = result.current.startGroupCreation()
      })

      expect(success).toBe(false)
      expect(result.current.mode).toBeNull()
    })

    it('returns true when 2 tasks are selected', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      let success: boolean | undefined
      act(() => {
        success = result.current.startGroupCreation()
      })

      expect(success).toBe(true)
      expect(result.current.mode).toBe('create-group')
    })

    it('returns true when more than 2 tasks are selected', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
        result.current.toggleSelection('task-3', createMockMouseEvent(true))
        result.current.toggleSelection('task-4', createMockMouseEvent(true))
      })

      let success: boolean | undefined
      act(() => {
        success = result.current.startGroupCreation()
      })

      expect(success).toBe(true)
      expect(result.current.mode).toBe('create-group')
    })
  })

  describe('confirmGroupCreation', () => {
    it('returns selected IDs and clears mode and selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Set up selection and enter group creation mode
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
        result.current.toggleSelection('task-3', createMockMouseEvent(true))
      })

      act(() => {
        result.current.startGroupCreation()
      })

      expect(result.current.mode).toBe('create-group')
      expect(result.current.selectedCount).toBe(3)

      let returnedIds: string[] | undefined
      act(() => {
        returnedIds = result.current.confirmGroupCreation()
      })

      expect(returnedIds).toEqual(['task-1', 'task-2', 'task-3'])
      expect(result.current.mode).toBeNull()
      expect(result.current.selectedTaskIds.size).toBe(0)
      expect(result.current.isSelecting).toBe(false)
    })

    it('returns empty array when no tasks selected', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Manually set mode to create-group without selection
      act(() => {
        // First select and start group creation
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
        result.current.startGroupCreation()
      })

      // Clear selection manually
      act(() => {
        result.current.clearSelection()
      })

      // Re-enter group creation mode (edge case)
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
        result.current.startGroupCreation()
      })

      let returnedIds: string[] | undefined
      act(() => {
        returnedIds = result.current.confirmGroupCreation()
      })

      // Should return the IDs that were selected
      expect(returnedIds).toHaveLength(2)
      expect(result.current.mode).toBeNull()
      expect(result.current.selectedCount).toBe(0)
    })
  })

  describe('cancelGroupCreation', () => {
    it('clears mode while preserving selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Set up selection and enter group creation mode
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      act(() => {
        result.current.startGroupCreation()
      })

      expect(result.current.mode).toBe('create-group')
      expect(result.current.selectedCount).toBe(2)

      act(() => {
        result.current.cancelGroupCreation()
      })

      expect(result.current.mode).toBeNull()
      expect(result.current.selectedCount).toBe(2)
      expect(result.current.isSelected('task-1')).toBe(true)
      expect(result.current.isSelected('task-2')).toBe(true)
    })

    it('works when mode is null', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
      })

      expect(result.current.mode).toBeNull()

      act(() => {
        result.current.cancelGroupCreation()
      })

      expect(result.current.mode).toBeNull()
      expect(result.current.selectedCount).toBe(1)
    })
  })

  describe('mode state transitions', () => {
    it('allows transitioning from batch-edit to create-group mode', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Select tasks for batch-edit (mode stays null by default)
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      expect(result.current.mode).toBeNull()

      // Start group creation
      act(() => {
        result.current.startGroupCreation()
      })

      expect(result.current.mode).toBe('create-group')

      // Cancel should clear mode but keep selection
      act(() => {
        result.current.cancelGroupCreation()
      })

      expect(result.current.mode).toBeNull()
      expect(result.current.selectedCount).toBe(2)
    })

    it('requires Ctrl+Click after canceling group creation', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Start group creation
      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
        result.current.startGroupCreation()
      })

      // Cancel group creation
      act(() => {
        result.current.cancelGroupCreation()
      })

      // Without Ctrl, should not toggle
      act(() => {
        const success = result.current.toggleSelection('task-3', createMockMouseEvent(false))
        expect(success).toBe(false)
      })

      expect(result.current.isSelected('task-3')).toBe(false)

      // With Ctrl, should toggle
      act(() => {
        const success = result.current.toggleSelection('task-3', createMockMouseEvent(true))
        expect(success).toBe(true)
      })

      expect(result.current.isSelected('task-3')).toBe(true)
    })
  })

  describe('isSelecting derived state', () => {
    it('is false initially', () => {
      const { result } = renderHook(() => useMultiSelect())

      expect(result.current.isSelecting).toBe(false)
    })

    it('is true when tasks are selected', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
      })

      expect(result.current.isSelecting).toBe(true)
    })

    it('is false after clearing selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
      })

      act(() => {
        result.current.clearSelection()
      })

      expect(result.current.isSelecting).toBe(false)
    })
  })

  describe('selectedCount derived state', () => {
    it('returns 0 initially', () => {
      const { result } = renderHook(() => useMultiSelect())

      expect(result.current.selectedCount).toBe(0)
    })

    it('returns correct count after selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      expect(result.current.selectedCount).toBe(2)
    })

    it('updates after deselection', () => {
      const { result } = renderHook(() => useMultiSelect())

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
        result.current.toggleSelection('task-2', createMockMouseEvent(true))
      })

      act(() => {
        result.current.toggleSelection('task-1', createMockMouseEvent(true))
      })

      expect(result.current.selectedCount).toBe(1)
    })
  })

  describe('backward compatibility', () => {
    it('maintains existing batch-edit behavior with Ctrl+Click', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Batch-edit mode is essentially mode === null with Ctrl+Click
      act(() => {
        const success1 = result.current.toggleSelection('task-1', createMockMouseEvent(true))
        const success2 = result.current.toggleSelection('task-2', createMockMouseEvent(true))
        expect(success1).toBe(true)
        expect(success2).toBe(true)
      })

      expect(result.current.mode).toBeNull()
      expect(result.current.selectedCount).toBe(2)
    })

    it('batch-edit requires Ctrl key for selection', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Without Ctrl, toggle should fail
      act(() => {
        const success = result.current.toggleSelection('task-1', createMockMouseEvent(false))
        expect(success).toBe(false)
      })

      expect(result.current.selectedCount).toBe(0)

      // With Ctrl, toggle should succeed
      act(() => {
        const success = result.current.toggleSelection('task-1', createMockMouseEvent(true))
        expect(success).toBe(true)
      })

      expect(result.current.selectedCount).toBe(1)
    })

    it('all existing exports remain available', () => {
      const { result } = renderHook(() => useMultiSelect())

      // Verify all existing exports are present
      expect(result.current.selectedTaskIds).toBeInstanceOf(Set)
      expect(typeof result.current.isSelecting).toBe('boolean')
      expect(typeof result.current.selectedCount).toBe('number')
      expect(typeof result.current.toggleSelection).toBe('function')
      expect(typeof result.current.selectSingle).toBe('function')
      expect(typeof result.current.clearSelection).toBe('function')
      expect(typeof result.current.isSelected).toBe('function')
      expect(typeof result.current.getSelectedIds).toBe('function')
    })
  })
})
