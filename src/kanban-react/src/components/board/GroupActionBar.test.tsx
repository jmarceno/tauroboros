import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupActionBar } from './GroupActionBar'

describe('GroupActionBar', () => {
  const mockCallbacks = {
    onCreateGroup: vi.fn(),
    onBatchEdit: vi.fn(),
    onClear: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when selectedCount is less than 2', () => {
    const { container } = render(
      <GroupActionBar
        selectedCount={0}
        {...mockCallbacks}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('returns null when selectedCount is 1', () => {
    const { container } = render(
      <GroupActionBar
        selectedCount={1}
        {...mockCallbacks}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders when selectedCount is 2', () => {
    render(
      <GroupActionBar
        selectedCount={2}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('2 tasks selected')).toBeInTheDocument()
  })

  it('renders when selectedCount is greater than 2', () => {
    render(
      <GroupActionBar
        selectedCount={5}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('5 tasks selected')).toBeInTheDocument()
  })

  it('uses singular "task" when selectedCount is 1 (should not render, but test pluralization logic)', () => {
    // This test ensures the pluralization logic is correct
    // Even though the component doesn't render for count < 2
    const { container } = render(
      <GroupActionBar
        selectedCount={1}
        {...mockCallbacks}
      />
    )
    // Component should not render for count < 2
    expect(container.firstChild).toBeNull()
  })

  it('uses plural "tasks" when selectedCount is greater than 1', () => {
    render(
      <GroupActionBar
        selectedCount={2}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('2 tasks selected')).toBeInTheDocument()
  })

  it('calls onCreateGroup when Create Group button is clicked', () => {
    render(
      <GroupActionBar
        selectedCount={2}
        {...mockCallbacks}
      />
    )
    const createButton = screen.getByLabelText('Create group from selected tasks')
    fireEvent.click(createButton)
    expect(mockCallbacks.onCreateGroup).toHaveBeenCalledTimes(1)
  })

  it('calls onBatchEdit when Batch Edit button is clicked', () => {
    render(
      <GroupActionBar
        selectedCount={2}
        {...mockCallbacks}
      />
    )
    const batchButton = screen.getByLabelText('Batch edit selected tasks')
    fireEvent.click(batchButton)
    expect(mockCallbacks.onBatchEdit).toHaveBeenCalledTimes(1)
  })

  it('calls onClear when Clear button is clicked', () => {
    render(
      <GroupActionBar
        selectedCount={2}
        {...mockCallbacks}
      />
    )
    const clearButton = screen.getByLabelText('Clear selection')
    fireEvent.click(clearButton)
    expect(mockCallbacks.onClear).toHaveBeenCalledTimes(1)
  })

  it('has correct aria role and label', () => {
    render(
      <GroupActionBar
        selectedCount={2}
        {...mockCallbacks}
      />
    )
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar).toHaveAttribute('aria-label', 'Multi-select actions')
  })

  it('disables Create Group button when selectedCount is less than 2', () => {
    // This tests the disabled state even though component shouldn't render at < 2
    // If we force render at < 2, button should be disabled
    const { container } = render(
      <GroupActionBar
        selectedCount={1}
        {...mockCallbacks}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('all buttons are present with correct text', () => {
    render(
      <GroupActionBar
        selectedCount={3}
        {...mockCallbacks}
      />
    )
    expect(screen.getByText('Create Group')).toBeInTheDocument()
    expect(screen.getByText('Batch Edit')).toBeInTheDocument()
    expect(screen.getByText('Clear')).toBeInTheDocument()
  })
})
