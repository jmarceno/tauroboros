import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KanbanBoard } from './KanbanBoard'
import type { Task, TaskGroup, TaskStatus, BestOfNSummary } from '@/types'
import type { useDragDrop } from '@/hooks/useDragDrop'

// Mock the child components - use any types to avoid hoisting issues
vi.mock('./KanbanColumn', () => ({
  KanbanColumn: (props: any) => (
    <div data-testid={`column-${props.status}`}>
      <span data-testid={`column-${props.status}-count`}>{props.tasks?.length ?? 0}</span>
      {props.children}
    </div>
  ),
}))

vi.mock('./VirtualCard', () => ({
  VirtualCard: (props: any) => (
    <div data-testid={`virtual-card-${props.group.id}`} onClick={props.onClick}>
      <span data-testid={`virtual-card-${props.group.id}-name`}>{props.group.name}</span>
      <span data-testid={`virtual-card-${props.group.id}-count`}>{props.taskCount}</span>
    </div>
  ),
}))

vi.mock('./GroupPanel', () => ({
  GroupPanel: (props: any) => (
    props.isOpen ? <div data-testid="group-panel" onClick={props.onClose}>Group Panel</div> : null
  ),
}))

describe('KanbanBoard', () => {
  const mockDragDrop = {
    draggedId: null as string | null,
    dragOverStatus: null as TaskStatus | null,
    handleDragStart: vi.fn(),
    handleDragEnd: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    handleCardDragStart: vi.fn(),
    handleCardDragEnd: vi.fn(),
  } as unknown as ReturnType<typeof useDragDrop>

  const mockTasks: Task[] = [
    { id: 'task-1', name: 'Task 1', status: 'backlog', prompt: '', idx: 1, branch: 'main', planmode: false, autoApprovePlan: false, review: false, codeStyleReview: false, autoCommit: false, deleteWorktree: false, skipPermissionAsking: false, requirements: [], thinkingLevel: 'default', planThinkingLevel: 'default', executionThinkingLevel: 'default', executionStrategy: 'standard', reviewCount: 0, jsonParseRetryCount: 0, planRevisionCount: 0, executionPhase: '', awaitingPlanApproval: false, createdAt: 1000, updatedAt: 1000 },
    { id: 'task-2', name: 'Task 2', status: 'backlog', prompt: '', idx: 2, branch: 'main', planmode: false, autoApprovePlan: false, review: false, codeStyleReview: false, autoCommit: false, deleteWorktree: false, skipPermissionAsking: false, requirements: [], thinkingLevel: 'default', planThinkingLevel: 'default', executionThinkingLevel: 'default', executionStrategy: 'standard', reviewCount: 0, jsonParseRetryCount: 0, planRevisionCount: 0, executionPhase: '', awaitingPlanApproval: false, createdAt: 1000, updatedAt: 1000, groupId: 'group-1' },
    { id: 'task-3', name: 'Task 3', status: 'backlog', prompt: '', idx: 3, branch: 'main', planmode: false, autoApprovePlan: false, review: false, codeStyleReview: false, autoCommit: false, deleteWorktree: false, skipPermissionAsking: false, requirements: [], thinkingLevel: 'default', planThinkingLevel: 'default', executionThinkingLevel: 'default', executionStrategy: 'standard', reviewCount: 0, jsonParseRetryCount: 0, planRevisionCount: 0, executionPhase: '', awaitingPlanApproval: false, createdAt: 1000, updatedAt: 1000, groupId: 'group-1' },
    { id: 'task-4', name: 'Task 4', status: 'executing', prompt: '', idx: 4, branch: 'main', planmode: false, autoApprovePlan: false, review: false, codeStyleReview: false, autoCommit: false, deleteWorktree: false, skipPermissionAsking: false, requirements: [], thinkingLevel: 'default', planThinkingLevel: 'default', executionThinkingLevel: 'default', executionStrategy: 'standard', reviewCount: 0, jsonParseRetryCount: 0, planRevisionCount: 0, executionPhase: '', awaitingPlanApproval: false, createdAt: 1000, updatedAt: 1000 },
    { id: 'task-5', name: 'Task 5', status: 'done', prompt: '', idx: 5, branch: 'main', planmode: false, autoApprovePlan: false, review: false, codeStyleReview: false, autoCommit: false, deleteWorktree: false, skipPermissionAsking: false, requirements: [], thinkingLevel: 'default', planThinkingLevel: 'default', executionThinkingLevel: 'default', executionStrategy: 'standard', reviewCount: 0, jsonParseRetryCount: 0, planRevisionCount: 0, executionPhase: '', awaitingPlanApproval: false, createdAt: 1000, updatedAt: 1000, completedAt: 2000 },
  ]

  const mockGroups: TaskGroup[] = [
    { id: 'group-1', name: 'Test Group', color: '#6366f1', status: 'active', createdAt: 1000, updatedAt: 1000, completedAt: null },
    { id: 'group-2', name: 'Completed Group', color: '#10b981', status: 'completed', createdAt: 1000, updatedAt: 2000, completedAt: 2000 },
  ]

  const mockGroupMembers: Record<string, string[]> = {
    'group-1': ['task-2', 'task-3'],
    'group-2': [],
  }

  const mockBonSummaries: Record<string, BestOfNSummary> = {}

  const mockCallbacks = {
    onOpenTask: vi.fn(),
    onOpenTemplateModal: vi.fn(),
    onOpenTaskModal: vi.fn(),
    onDeployTemplate: vi.fn(),
    onOpenTaskSessions: vi.fn(),
    onApprovePlan: vi.fn(),
    onRequestRevision: vi.fn(),
    onStartSingle: vi.fn(),
    onRepairTask: vi.fn(),
    onMarkDone: vi.fn(),
    onResetTask: vi.fn(),
    onConvertToTemplate: vi.fn(),
    onArchiveTask: vi.fn(),
    onArchiveAllDone: vi.fn(),
    onViewRuns: vi.fn(),
    onContinueReviews: vi.fn(),
    onChangeColumnSort: vi.fn(),
    onVirtualCardClick: vi.fn(),
    onDeleteGroup: vi.fn(),
    onStartGroup: vi.fn(),
    onCloseGroupPanel: vi.fn(),
    onRemoveTaskFromGroup: vi.fn(),
    onAddTasksToGroup: vi.fn(),
    onCreateGroupFromSelection: vi.fn(),
  }

  const getTaskRunColor = vi.fn(() => null)
  const isTaskMutationLocked = vi.fn(() => false)
  const getIsSelected = vi.fn(() => false)

  it('renders all columns', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        {...mockCallbacks}
      />
    )

    expect(screen.getByTestId('column-template')).toBeInTheDocument()
    expect(screen.getByTestId('column-backlog')).toBeInTheDocument()
    expect(screen.getByTestId('column-executing')).toBeInTheDocument()
    expect(screen.getByTestId('column-review')).toBeInTheDocument()
    expect(screen.getByTestId('column-code-style')).toBeInTheDocument()
    expect(screen.getByTestId('column-done')).toBeInTheDocument()
  })

  it('filters grouped tasks from backlog column', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        {...mockCallbacks}
      />
    )

    // Backlog should only show 1 task (task-1, since task-2 and task-3 are in group-1)
    expect(screen.getByTestId('column-backlog-count')).toHaveTextContent('1')
  })

  it('renders virtual cards in backlog column for active groups', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        {...mockCallbacks}
      />
    )

    // Only active groups show as virtual cards (group-1 is active, group-2 is completed)
    expect(screen.getByTestId('virtual-card-group-1')).toBeInTheDocument()
    expect(screen.getByTestId('virtual-card-group-1-name')).toHaveTextContent('Test Group')
    expect(screen.getByTestId('virtual-card-group-1-count')).toHaveTextContent('2')

    // Completed group should not appear as virtual card
    expect(screen.queryByTestId('virtual-card-group-2')).not.toBeInTheDocument()
  })

  it('does not render virtual cards section when no active groups', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={[]}
        groupMembers={{}}
        {...mockCallbacks}
      />
    )

    expect(screen.queryByTestId('virtual-card-group-1')).not.toBeInTheDocument()
  })

  it('calls onVirtualCardClick when virtual card is clicked', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        {...mockCallbacks}
      />
    )

    const virtualCard = screen.getByTestId('virtual-card-group-1')
    fireEvent.click(virtualCard)

    expect(mockCallbacks.onVirtualCardClick).toHaveBeenCalledTimes(1)
    expect(mockCallbacks.onVirtualCardClick).toHaveBeenCalledWith('group-1')
  })

  it('renders GroupPanel when activeGroupId is set', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        activeGroupId="group-1"
        {...mockCallbacks}
      />
    )

    expect(screen.getByTestId('group-panel')).toBeInTheDocument()
  })

  it('does not render GroupPanel when no active group', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        activeGroupId={null}
        {...mockCallbacks}
      />
    )

    expect(screen.queryByTestId('group-panel')).not.toBeInTheDocument()
  })

  it('calls onCloseGroupPanel when group panel close is triggered', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        activeGroupId="group-1"
        {...mockCallbacks}
      />
    )

    const groupPanel = screen.getByTestId('group-panel')
    fireEvent.click(groupPanel)

    expect(mockCallbacks.onCloseGroupPanel).toHaveBeenCalledTimes(1)
  })

  it('handles empty tasks array', () => {
    render(
      <KanbanBoard
        tasks={[]}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        {...mockCallbacks}
      />
    )

    // All columns should render with 0 tasks
    expect(screen.getByTestId('column-template')).toBeInTheDocument()
    expect(screen.getByTestId('column-backlog-count')).toHaveTextContent('0')
  })

  it('correctly counts ungrouped tasks in backlog', () => {
    // task-1 is not in any group, task-2 and task-3 are in group-1
    const backlogTasks = mockTasks.filter(t => t.status === 'backlog')
    expect(backlogTasks).toHaveLength(3)

    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        {...mockCallbacks}
      />
    )

    // Only task-1 should appear in backlog (not grouped)
    expect(screen.getByTestId('column-backlog-count')).toHaveTextContent('1')
  })

  it('correctly handles tasks without groupId field', () => {
    const tasksWithoutGroupId: Task[] = [
      { id: 'task-6', name: 'Task 6', status: 'backlog', prompt: '', idx: 6, branch: 'main', planmode: false, autoApprovePlan: false, review: false, codeStyleReview: false, autoCommit: false, deleteWorktree: false, skipPermissionAsking: false, requirements: [], thinkingLevel: 'default', planThinkingLevel: 'default', executionThinkingLevel: 'default', executionStrategy: 'standard', reviewCount: 0, jsonParseRetryCount: 0, planRevisionCount: 0, executionPhase: '', awaitingPlanApproval: false, createdAt: 1000, updatedAt: 1000 },
    ]

    render(
      <KanbanBoard
        tasks={tasksWithoutGroupId}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        groups={mockGroups}
        groupMembers={mockGroupMembers}
        {...mockCallbacks}
      />
    )

    // Task without groupId should appear in backlog
    expect(screen.getByTestId('column-backlog-count')).toHaveTextContent('1')
  })

  it('passes columnSorts to KanbanColumn', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        columnSorts={{ backlog: 'name-asc', executing: 'updated-desc' }}
        {...mockCallbacks}
      />
    )

    // Columns should render with the provided sort preferences
    expect(screen.getByTestId('column-backlog')).toBeInTheDocument()
    expect(screen.getByTestId('column-executing')).toBeInTheDocument()
  })

  it('passes multi-select state to columns', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        isMultiSelecting={true}
        getIsSelected={getIsSelected}
        {...mockCallbacks}
      />
    )

    // Columns should render in multi-select mode
    expect(screen.getByTestId('column-backlog')).toBeInTheDocument()
  })

  it('accepts onCreateGroupFromSelection callback', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        bonSummaries={mockBonSummaries}
        getTaskRunColor={getTaskRunColor}
        isTaskMutationLocked={isTaskMutationLocked}
        dragDrop={mockDragDrop}
        isMultiSelecting={true}
        getIsSelected={getIsSelected}
        {...mockCallbacks}
      />
    )

    // Component should render without error with the new prop (already included in mockCallbacks)
    expect(screen.getByTestId('column-backlog')).toBeInTheDocument()
  })
})
