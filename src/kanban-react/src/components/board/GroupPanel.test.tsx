import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupPanel } from './GroupPanel'
import type { TaskGroup, Task } from '@/types'

// Mock dragDrop hook return type
const createMockDragDrop = () => ({
  dragTaskId: null as string | null,
  dragSourceContext: null as string | null,
  dragSourceGroupId: null as string | null,
  dragOverTarget: null as { type: string; id: string } | null,
  dragOverStatus: null as string | null,
  handleDragStart: vi.fn(),
  handleDragEnd: vi.fn(),
  handleDragOver: vi.fn(),
  handleDragOverGroup: vi.fn(),
  handleDragLeave: vi.fn(),
  handleDrop: vi.fn(),
  handleDropOnGroup: vi.fn(),
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
    const { container } = render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={createMockDragDrop()}
        {...mockCallbacks}
      />
    )
    const closeButton = screen.getByLabelText('Close group panel (Escape)')
    fireEvent.click(closeButton)
    // Trigger animation end to complete the exit animation
    const panel = container.querySelector('.group-panel')
    fireEvent.animationEnd(panel!)
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
    expect(screen.getByText('Drag tasks here to add')).toBeInTheDocument()
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
    const taskCard = screen.getByText('First Task').closest('.group-task-item')
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

  it('calls handleDropOnGroup when drop occurs on the drop zone', () => {
    const mockDragDrop = createMockDragDrop()
    // Set up the drag state to simulate a task being dragged
    mockDragDrop.dragTaskId = 'dropped-task-id'
    
    const { container } = render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    // Find the drop zone container by aria-label
    const dropZone = container.querySelector('[aria-label*="Drop zone"]')
    expect(dropZone).toBeDefined()

    // Simulate drop - the component's onDrop handler calls handleDropOnGroup
    fireEvent.drop(dropZone!, {
      dataTransfer: {
        getData: vi.fn().mockReturnValue('dropped-task-id'),
      },
      preventDefault: vi.fn(),
    })

    // The component should call handleDropOnGroup from the dragDrop hook
    expect(mockDragDrop.handleDropOnGroup).toHaveBeenCalled()
  })

  it('handleDropOnGroup is still invoked even when dragTaskId is null', () => {
    const mockDragDrop = createMockDragDrop()
    // Ensure no drag task is set - but the handler is still called
    mockDragDrop.dragTaskId = null
    
    const { container } = render(
      <GroupPanel
        group={mockGroup}
        tasks={mockTasks}
        isOpen={true}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    const dropZone = container.querySelector('[aria-label*="Drop zone"]')
    expect(dropZone).toBeDefined()

    fireEvent.drop(dropZone!, {
      dataTransfer: {
        getData: vi.fn().mockReturnValue(''),
      },
      preventDefault: vi.fn(),
    })

    // The handler is still called (the component calls it), even if the hook
    // internally doesn't invoke the onDrop callback when dragTaskId is null
    expect(mockDragDrop.handleDropOnGroup).toHaveBeenCalled()
  })

  it('updates visual state on drag over', () => {
    const mockDragDrop = createMockDragDrop()
    // Set dragOverTarget to simulate being over this group
    mockDragDrop.dragOverTarget = { type: 'group', id: 'group-1' }
    
    // Use empty tasks to show the drop zone text
    const { container } = render(
      <GroupPanel
        group={mockGroup}
        tasks={[]}
        isOpen={true}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    // Find the drop zone container by looking for the aria-label
    const dropZone = container.querySelector('[aria-label*="Drop zone"]')
    expect(dropZone).toBeDefined()

    // When dragOverTarget is set to this group, the highlight class should be applied
    expect(dropZone).toHaveClass('bg-accent-primary/10')
  })

  it('removes visual highlight when drag leaves', () => {
    const mockDragDrop = createMockDragDrop()
    // Simulate drag over this group first
    mockDragDrop.dragOverTarget = { type: 'group', id: 'group-1' }
    
    // Use empty tasks to show the drop zone
    const { container, rerender } = render(
      <GroupPanel
        group={mockGroup}
        tasks={[]}
        isOpen={true}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    // Find the drop zone container
    const dropZone = container.querySelector('[aria-label*="Drop zone"]')
    expect(dropZone).toBeDefined()

    // Verify highlight is shown
    expect(dropZone).toHaveClass('bg-accent-primary/10')

    // Now simulate drag leave by clearing the target
    mockDragDrop.dragOverTarget = null
    
    // Re-render to reflect state change
    rerender(
      <GroupPanel
        group={mockGroup}
        tasks={[]}
        isOpen={true}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    // After leaving, highlight should be removed
    expect(dropZone).not.toHaveClass('bg-accent-primary/10')
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
