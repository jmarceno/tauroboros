import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VirtualCard } from './VirtualCard'
import type { TaskGroup, TaskGroupStatus } from '@/types'

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

describe('VirtualCard', () => {
  it('renders with correct group name and task count', () => {
    const group = createMockGroup({ name: 'My Virtual Group' })

    render(
      <VirtualCard
        group={group}
        taskCount={5}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.getByText('My Virtual Group')).toBeInTheDocument()
    expect(screen.getByText('5 tasks')).toBeInTheDocument()
    expect(screen.getByText('Virtual Workflow')).toBeInTheDocument()
  })

  it('applies correct border color from group.color', () => {
    const group = createMockGroup({ color: '#ff0000' })

    const { container } = render(
      <VirtualCard
        group={group}
        taskCount={3}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const card = container.querySelector('.virtual-card')
    expect(card).toHaveStyle({ borderLeftColor: '#ff0000' })
  })

  it('shows correct status icon for active status', () => {
    const group = createMockGroup({ status: 'active' })

    const { container } = render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const icon = container.querySelector('.virtual-card-icon')
    expect(icon).toHaveClass('text-accent-info')
  })

  it('shows correct status icon for running status', () => {
    const group = createMockGroup({ status: 'running' })

    const { container } = render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const icon = container.querySelector('.virtual-card-icon')
    expect(icon).toHaveClass('text-accent-success', 'animate-spin')
  })

  it('shows correct status icon for completed status', () => {
    const group = createMockGroup({ status: 'completed' })

    const { container } = render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const icon = container.querySelector('.virtual-card-icon')
    expect(icon).toHaveClass('text-accent-success')
  })

  it('shows correct status icon for archived status', () => {
    const group = createMockGroup({ status: 'archived' as TaskGroupStatus })

    const { container } = render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const icon = container.querySelector('.virtual-card-icon')
    expect(icon).toHaveClass('text-dark-text-muted')
  })

  it('calls onClick when card is clicked', () => {
    const group = createMockGroup()
    const onClick = vi.fn()

    const { container } = render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={onClick}
        onDelete={vi.fn()}
      />
    )

    const card = container.querySelector('.virtual-card')
    fireEvent.click(card!)

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('shows confirmation dialog on delete click without Ctrl', () => {
    const group = createMockGroup()
    const onDelete = vi.fn()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={onDelete}
      />
    )

    const deleteButton = screen.getByTitle('Delete group')
    fireEvent.click(deleteButton)

    expect(screen.getByText('Delete Group')).toBeInTheDocument()
    expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('calls onDelete directly with Ctrl+click', () => {
    const group = createMockGroup()
    const onDelete = vi.fn()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={onDelete}
      />
    )

    const deleteButton = screen.getByTitle('Delete group')
    fireEvent.click(deleteButton, { ctrlKey: true })

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Delete Group')).not.toBeInTheDocument()
  })

  it('calls onDelete directly with Meta/Cmd+click', () => {
    const group = createMockGroup()
    const onDelete = vi.fn()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={onDelete}
      />
    )

    const deleteButton = screen.getByTitle('Delete group')
    fireEvent.click(deleteButton, { metaKey: true })

    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('confirms delete when clicking Delete button in modal', () => {
    const group = createMockGroup()
    const onDelete = vi.fn()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={onDelete}
      />
    )

    // Open confirmation
    const deleteButton = screen.getByTitle('Delete group')
    fireEvent.click(deleteButton)

    // Click confirm
    const confirmButton = screen.getByRole('button', { name: 'Delete' })
    fireEvent.click(confirmButton)

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Delete Group')).not.toBeInTheDocument()
  })

  it('cancels delete when clicking Cancel button in modal', () => {
    const group = createMockGroup()
    const onDelete = vi.fn()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={onDelete}
      />
    )

    // Open confirmation
    const deleteButton = screen.getByTitle('Delete group')
    fireEvent.click(deleteButton)

    // Click cancel
    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelButton)

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete Group')).not.toBeInTheDocument()
  })

  it('closes modal when clicking overlay', () => {
    const group = createMockGroup()
    const onDelete = vi.fn()

    const { container } = render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={onDelete}
      />
    )

    // Open confirmation
    const deleteButton = screen.getByTitle('Delete group')
    fireEvent.click(deleteButton)

    // Click overlay
    const overlay = container.querySelector('.modal-overlay')
    fireEvent.click(overlay!)

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete Group')).not.toBeInTheDocument()
  })

  it('calls onStart when start button is clicked', () => {
    const group = createMockGroup({ status: 'active' })
    const onStart = vi.fn()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
        onStart={onStart}
      />
    )

    const startButton = screen.getByTitle('Start group execution')
    fireEvent.click(startButton)

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('does not show start button when onStart is not provided', () => {
    const group = createMockGroup({ status: 'active' })

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.queryByTitle('Start group execution')).not.toBeInTheDocument()
  })

  it('does not show start button when status is not active', () => {
    const group = createMockGroup({ status: 'completed' })
    const onStart = vi.fn()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
        onStart={onStart}
      />
    )

    expect(screen.queryByTitle('Start group execution')).not.toBeInTheDocument()
  })

  it('truncates long group names with ellipsis', () => {
    const group = createMockGroup({
      name: 'This is a very long group name that should be truncated with ellipsis',
    })

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const title = screen.getByTitle(group.name)
    expect(title).toHaveClass('virtual-card-title')
  })

  it('handles singular task count correctly', () => {
    const group = createMockGroup()

    render(
      <VirtualCard
        group={group}
        taskCount={1}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.getByText('1 task')).toBeInTheDocument()
  })

  it('handles zero task count correctly', () => {
    const group = createMockGroup()

    render(
      <VirtualCard
        group={group}
        taskCount={0}
        onClick={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(screen.getByText('0 tasks')).toBeInTheDocument()
  })
})
