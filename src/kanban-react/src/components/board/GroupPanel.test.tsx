import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupPanel } from './GroupPanel'
import type { TaskGroup, Task } from '@/types'

// Mock dragDrop hook return type
const createMockDragDrop = () => ({
  dragTaskId: null as string | null,
  dragOverStatus: null as string | null,
  handleDragStart: vi.fn(),
  handleDragEnd: vi.fn(),
  handleDragOver: vi.fn(),
  handleDragLeave: vi.fn(),
  handleDrop: vi.fn(),
})

describe('GroupPanel', () => {
  const mockGroup: TaskGroup = {
    id: 'group-1',
    name: 'Test Group',
    color: '#00d4ff',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
  }

  const mockTasks: Task[] = [
    {
      id: 'task-1',
      idx: 0,
      name: 'First Task',
      prompt: 'Do something',
      status: 'backlog',
      branch: 'main',
      planmode: false,
      autoApprovePlan: false,
      review: false,
      codeStyleReview: false,
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
    },
    {
      id: 'task-2',
      idx: 1,
      name: 'Second Task',
      prompt: 'Do something else',
      status: 'executing',
      branch: 'main',
      planmode: true,
      autoApprovePlan: false,
      review: true,
      codeStyleReview: false,
      autoCommit: false,
      deleteWorktree: false,
      skipPermissionAsking: false,
      requirements: [],
      thinkingLevel: 'default',
      planThinkingLevel: 'default',
      executionThinkingLevel: 'default',
      executionStrategy: 'standard',
      reviewCount: 1,
      jsonParseRetryCount: 0,
      planRevisionCount: 0,
      executionPhase: 'plan_complete_waiting_approval',
      awaitingPlanApproval: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]

  const mockCallbacks = {
    onClose: vi.fn(),
    onRemoveTask: vi.fn(),
    onAddTasks: vi.fn(),
    onStartGroup: vi.fn(),
    onOpenTask: vi.fn(),
    onDeleteGroup: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when isOpen is false', () => {
    const { container } = render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={false}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders when isOpen is true', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('Test Group')).toBeInTheDocument()
  })

  it('displays group name and task count', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('Test Group')).toBeInTheDocument()
    expect(screen.getByText('2 tasks')).toBeInTheDocument()
  })

  it('uses singular "task" when count is 1', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={[mockTasks[0]]}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('1 task')).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    const closeButton = screen.getByLabelText('Close group panel')
    fireEvent.click(closeButton)
    expect(mockCallbacks.onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onDeleteGroup when delete button is clicked', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    const deleteButton = screen.getByLabelText('Delete group')
    fireEvent.click(deleteButton)
    expect(mockCallbacks.onDeleteGroup).toHaveBeenCalledTimes(1)
  })

  it('renders empty state when no tasks', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={[]}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('No tasks in this group')).toBeInTheDocument()
    expect(screen.getByText('Drag tasks here to add them')).toBeInTheDocument()
  })

  it('renders task cards when tasks exist', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('First Task')).toBeInTheDocument()
    expect(screen.getByText('Second Task')).toBeInTheDocument()
  })

  it('displays task ID badges correctly', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
  })

  it('displays task status correctly', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('backlog')).toBeInTheDocument()
    expect(screen.getByText('executing')).toBeInTheDocument()
  })

  it('calls onOpenTask when task card is clicked', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    const taskCard = screen.getByText('First Task').closest('.group')
    fireEvent.click(taskCard!)
    expect(mockCallbacks.onOpenTask).toHaveBeenCalledWith('task-1')
  })

  it('calls onRemoveTask when remove button is clicked', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    // Find all remove buttons (they have aria-label with "Remove task")
    const removeButtons = screen.getAllByLabelText(/Remove task/)
    expect(removeButtons.length).toBe(2)

    // Click first remove button
    fireEvent.click(removeButtons[0])
    expect(mockCallbacks.onRemoveTask).toHaveBeenCalledWith('task-1')
  })

  it('calls onRemoveTask with correct task ID', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    const removeButtons = screen.getAllByLabelText(/Remove task/)
    fireEvent.click(removeButtons[1])
    expect(mockCallbacks.onRemoveTask).toHaveBeenCalledWith('task-2')
  })

  it('handles drop events with valid task ID', () => {
    const mockDragDrop = createMockDragDrop()
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    // Find the drop zone container
    const dropZone = screen.getByText('Drag tasks here').closest('div')?.parentElement
    expect(dropZone).toBeDefined()

    // Create a mock drag event with dataTransfer
    const mockDataTransfer = {
      getData: vi.fn().mockReturnValue('dropped-task-id'),
      setData: vi.fn(),
      dropEffect: 'none',
      effectAllowed: 'none',
    }

    // Simulate drop
    fireEvent.drop(dropZone!, { dataTransfer: mockDataTransfer })

    expect(mockCallbacks.onAddTasks).toHaveBeenCalledWith(['dropped-task-id'])
    expect(mockDragDrop.handleDragEnd).toHaveBeenCalled()
  })

  it('handles drop events without calling onAddTasks for empty task ID', () => {
    const mockDragDrop = createMockDragDrop()
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    const dropZone = screen.getByText('Drag tasks here').closest('div')?.parentElement

    const mockDataTransfer = {
      getData: vi.fn().mockReturnValue(''),
      setData: vi.fn(),
      dropEffect: 'none',
      effectAllowed: 'none',
    }

    fireEvent.drop(dropZone!, { dataTransfer: mockDataTransfer })

    expect(mockCallbacks.onAddTasks).not.toHaveBeenCalled()
  })

  it('updates visual state on drag over', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )

    // Find the drop zone container that has the drag handlers
    const dragText = screen.getByText('Drag tasks here')
    const innerBox = dragText.closest('div')
    const dropZone = innerBox?.parentElement

    expect(dropZone).toBeDefined()

    // Initial state - no highlight class
    expect(dropZone).not.toHaveClass('bg-accent-primary/10')

    // Drag over
    fireEvent.dragOver(dropZone!, {
      dataTransfer: { dropEffect: 'move' },
      preventDefault: vi.fn(),
    })

    // Visual state should update - container gets highlight class
    expect(dropZone).toHaveClass('bg-accent-primary/10')
  })

  it('calls onStartGroup when start button is clicked', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )

    const startButton = screen.getByText('Start Group Workflow')
    fireEvent.click(startButton)

    expect(mockCallbacks.onStartGroup).toHaveBeenCalledTimes(1)
  })

  it('disables start button when no tasks', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={[]}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )

    const startButton = screen.getByText('Start Group Workflow')
    expect(startButton).toBeDisabled()
  })

  it('enables start button when tasks exist', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )

    const startButton = screen.getByText('Start Group Workflow')
    expect(startButton).not.toBeDisabled()
  })

  it('renders color indicator with correct color', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )

    // Find the color indicator - it's the div with background-color style
    // Use case-insensitive attribute selector for better cross-browser compatibility
    const colorIndicator = document.querySelector('div[style*="background"]') ||
                          document.querySelector('[style*="#00d4ff"]')
    expect(colorIndicator).toBeInTheDocument()
    expect(colorIndicator).toHaveAttribute('style', expect.stringContaining('#00d4ff'))
  })

  it('does not call onOpenTask when remove button is clicked (event stops propagation)', () => {
    render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )

    const removeButtons = screen.getAllByLabelText(/Remove task/)
    fireEvent.click(removeButtons[0])

    // onOpenTask should NOT be called because we stop propagation
    expect(mockCallbacks.onOpenTask).not.toHaveBeenCalled()
    // onRemoveTask should be called
    expect(mockCallbacks.onRemoveTask).toHaveBeenCalledWith('task-1')
  })
})
