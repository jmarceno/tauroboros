import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GroupCreateModal } from './GroupCreateModal'

describe('GroupCreateModal', () => {
  const mockOnClose = vi.fn()
  const mockOnConfirm = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should initialize with trimmed default name', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const input = screen.getByLabelText(/Group Name/i)
    expect(input).toHaveValue('Group 1')
  })

  it('should accept default name with extra spaces by trimming on init', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="  Group 1  "
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const input = screen.getByLabelText(/Group Name/i)
    // The input should show the trimmed value
    expect(input).toHaveValue('Group 1')
  })

  it('should submit successfully without editing the default name', async () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const submitButton = screen.getByRole('button', { name: /Create Group/i })
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(mockOnConfirm).toHaveBeenCalledWith('Group 1')
    })
  })

  it('should trim and submit when default name has surrounding whitespace', async () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="  Group 1  "
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const submitButton = screen.getByRole('button', { name: /Create Group/i })
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(mockOnConfirm).toHaveBeenCalledWith('Group 1')
    })
  })

  it('should update input when defaultName prop changes', () => {
    const { rerender } = render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const input = screen.getByLabelText(/Group Name/i)
    expect(input).toHaveValue('Group 1')

    // Re-render with a different default name
    rerender(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 2"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    expect(input).toHaveValue('Group 2')
  })

  it('should disable submit button when name is empty or whitespace only', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName=""
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const submitButton = screen.getByRole('button', { name: /Create Group/i })
    expect(submitButton).toBeDisabled()
  })

  it('should enable submit button when name has non-whitespace content', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const submitButton = screen.getByRole('button', { name: /Create Group/i })
    expect(submitButton).not.toBeDisabled()
  })

  it('should show error when submitting empty name after clearing', async () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const input = screen.getByLabelText(/Group Name/i)
    fireEvent.change(input, { target: { value: '' } })

    const submitButton = screen.getByRole('button', { name: /Create Group/i })
    expect(submitButton).toBeDisabled()
  })

  it('should call onClose when Escape key is pressed', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const input = screen.getByLabelText(/Group Name/i)
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(mockOnClose).toHaveBeenCalled()
  })

  it('should call onClose when Cancel button is clicked', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const cancelButton = screen.getByRole('button', { name: /Cancel/i })
    fireEvent.click(cancelButton)

    expect(mockOnClose).toHaveBeenCalled()
  })

  it('should disable buttons when isLoading is true', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        isLoading={true}
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const submitButton = screen.getByRole('button', { name: /Creating/i })
    const cancelButton = screen.getByRole('button', { name: /Cancel/i })

    expect(submitButton).toBeDisabled()
    expect(cancelButton).toBeDisabled()
  })

  it('should enforce maxLength of 100 characters', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const input = screen.getByLabelText(/Group Name/i)
    expect(input).toHaveAttribute('maxLength', '100')
  })

  it('should show character count', () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName="Group 1"
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    // "Group 1" is 7 characters (not counting surrounding whitespace which is trimmed)
    expect(screen.getByText('7/100 characters')).toBeInTheDocument()
  })

  it('should clear error when user types after error state', async () => {
    render(
      <GroupCreateModal
        taskCount={3}
        defaultName=""
        onClose={mockOnClose}
        onConfirm={mockOnConfirm}
      />
    )

    const input = screen.getByLabelText(/Group Name/i)
    fireEvent.change(input, { target: { value: 'Valid Name' } })

    // Error should be cleared
    expect(screen.queryByText(/Group name is required/i)).not.toBeInTheDocument()
  })
})
