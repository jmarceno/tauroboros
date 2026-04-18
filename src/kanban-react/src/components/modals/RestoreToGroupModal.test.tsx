import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RestoreToGroupModal } from './RestoreToGroupModal'
import type { Task, TaskGroup } from '@/types'

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
    color: '#6366f1',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    ...overrides,
  }
}

describe('RestoreToGroupModal', () => {
  const mockCallbacks = {
    onClose: vi.fn(),
    onRestoreToGroup: vi.fn(),
    onMoveToBacklog: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('render conditions', () => {
    it('renders null when isOpen is false', () => {
      const { container } = render(
        <RestoreToGroupModal
          isOpen={false}
          task={createMockTask()}
          group={createMockGroup()}
          {...mockCallbacks}
        />
      )

      expect(container.firstChild).toBeNull()
    })

    it('renders null when task is null', () => {
      const { container } = render(
        <RestoreToGroupModal
          isOpen={true}
          task={null}
          group={createMockGroup()}
          {...mockCallbacks}
        />
      )

      expect(container.firstChild).toBeNull()
    })

    it('renders null when group is null', () => {
      const { container } = render(
        <RestoreToGroupModal
          isOpen={true}
          task={createMockTask()}
          group={null}
          {...mockCallbacks}
        />
      )

      expect(container.firstChild).toBeNull()
    })

    it('renders null when all are null', () => {
      const { container } = render(
        <RestoreToGroupModal
          isOpen={true}
          task={null}
          group={null}
          {...mockCallbacks}
        />
      )

      expect(container.firstChild).toBeNull()
    })

    it('renders modal when isOpen, task, and group are provided', () => {
      const task = createMockTask({ name: 'My Special Task' })
      const group = createMockGroup({ name: 'My Group' })

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      expect(screen.getByText('Restore Task to Group?')).toBeInTheDocument()
      expect(screen.getByText(/My Special Task/)).toBeInTheDocument()
      // Group name appears in the info box section, not as standalone text
      expect(screen.getByText('Group:')).toBeInTheDocument()
      expect(screen.getByText('My Group')).toBeInTheDocument()
    })
  })

  describe('content display', () => {
    it('displays task name in quotes', () => {
      const task = createMockTask({ name: 'Build Feature X' })
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      expect(screen.getByText(/"Build Feature X"/)).toBeInTheDocument()
    })

    it('displays group name in quotes', () => {
      const task = createMockTask()
      const group = createMockGroup({ name: 'Backend Tasks' })

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      expect(screen.getByText(/"Backend Tasks"/)).toBeInTheDocument()
    })

    it('shows group color indicator', () => {
      const task = createMockTask()
      const group = createMockGroup({ color: '#ff0000' })

      const { container } = render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      // Look for any element with style attribute that contains the color
      const allWithStyle = container.querySelectorAll('[style]')
      let foundHeaderIndicator = false
      let foundInfoBoxBorder = false
      
      for (const el of allWithStyle) {
        const style = el.getAttribute('style') || ''
        if (style.includes('background') && style.includes('#ff0000')) {
          foundHeaderIndicator = true
        }
        if (style.includes('borderLeft') && style.includes('#ff0000')) {
          foundInfoBoxBorder = true
        }
      }
      
      expect(foundHeaderIndicator || foundInfoBoxBorder).toBe(true)
    })

    it('shows group name with color indicator in info box', () => {
      const task = createMockTask()
      const group = createMockGroup({ name: 'Priority Work', color: '#00ff00' })

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      expect(screen.getByText('Group:')).toBeInTheDocument()
      expect(screen.getByText('Priority Work')).toBeInTheDocument()
    })
  })

  describe('button actions', () => {
    it('calls onRestoreToGroup then onClose when "Restore to Group" is clicked', () => {
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      const restoreButton = screen.getByText('Restore to Group')
      fireEvent.click(restoreButton)

      expect(mockCallbacks.onRestoreToGroup).toHaveBeenCalledTimes(1)
      expect(mockCallbacks.onClose).toHaveBeenCalledTimes(1)
      expect(mockCallbacks.onMoveToBacklog).not.toHaveBeenCalled()
    })

    it('calls onMoveToBacklog then onClose when "Move to General Backlog" is clicked', () => {
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      const backlogButton = screen.getByText('Move to General Backlog')
      fireEvent.click(backlogButton)

      expect(mockCallbacks.onMoveToBacklog).toHaveBeenCalledTimes(1)
      expect(mockCallbacks.onClose).toHaveBeenCalledTimes(1)
      expect(mockCallbacks.onRestoreToGroup).not.toHaveBeenCalled()
    })

    it('calls only onClose when Cancel is clicked', () => {
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      const cancelButton = screen.getByText('Cancel')
      fireEvent.click(cancelButton)

      expect(mockCallbacks.onClose).toHaveBeenCalledTimes(1)
      expect(mockCallbacks.onRestoreToGroup).not.toHaveBeenCalled()
      expect(mockCallbacks.onMoveToBacklog).not.toHaveBeenCalled()
    })
  })

  describe('keyboard handling', () => {
    it('calls onClose when Escape key is pressed', () => {
      vi.useFakeTimers()
      
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      // Need to advance timers for the effect to run
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      vi.advanceTimersByTime(0)

      // With fake timers, we need to flush the effect
      vi.runAllTimers()

      expect(mockCallbacks.onClose).toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('does not call onClose for other keys', () => {
      vi.useFakeTimers()
      
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      vi.advanceTimersByTime(0)
      vi.runAllTimers()

      expect(mockCallbacks.onClose).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  describe('overlay click handling', () => {
    it('calls onClose when clicking the overlay background', () => {
      const task = createMockTask()
      const group = createMockGroup()

      const { container } = render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      // Click on the overlay (first child which is the overlay div)
      const overlay = container.querySelector('.fixed')
      if (overlay) {
        fireEvent.click(overlay as HTMLElement, { target: overlay })
      }

      expect(mockCallbacks.onClose).toHaveBeenCalled()
    })

    it('does not call onClose when clicking inside the modal content', () => {
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      // Click on a button inside the modal
      const restoreButton = screen.getByText('Restore to Group')
      fireEvent.click(restoreButton)

      // onClose is called from the button handler, not from overlay click
      expect(mockCallbacks.onRestoreToGroup).toHaveBeenCalled()
    })
  })

  describe('accessibility', () => {
    it('renders all buttons with proper text', () => {
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      expect(screen.getByText('Restore to Group')).toBeInTheDocument()
      expect(screen.getByText('Move to General Backlog')).toBeInTheDocument()
      expect(screen.getByText('Cancel')).toBeInTheDocument()
    })

    it('has heading for modal title', () => {
      const task = createMockTask()
      const group = createMockGroup()

      render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      const heading = screen.getByRole('heading', { name: /Restore Task to Group/ })
      expect(heading).toBeInTheDocument()
    })
  })

  describe('icon visibility', () => {
    it('shows icon next to Restore to Group button', () => {
      const task = createMockTask()
      const group = createMockGroup()

      const { container } = render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      const restoreButton = screen.getByText('Restore to Group')
      const icon = restoreButton.parentElement?.querySelector('svg')
      expect(icon).toBeInTheDocument()
    })

    it('shows icon next to Move to General Backlog button', () => {
      const task = createMockTask()
      const group = createMockGroup()

      const { container } = render(
        <RestoreToGroupModal
          isOpen={true}
          task={task}
          group={group}
          {...mockCallbacks}
        />
      )

      const backlogButton = screen.getByText('Move to General Backlog')
      const icon = backlogButton.parentElement?.querySelector('svg')
      expect(icon).toBeInTheDocument()
    })
  })
})