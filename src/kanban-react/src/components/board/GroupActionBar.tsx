import { memo } from 'react'

export interface GroupActionBarProps {
  selectedCount: number
  onCreateGroup: () => void
  onBatchEdit: () => void
  onClear: () => void
}

/**
 * Floating action bar for multi-select group creation.
 * Appears at the bottom center when 2+ tasks are selected.
 */
export const GroupActionBar = memo(function GroupActionBar({
  selectedCount,
  onCreateGroup,
  onBatchEdit,
  onClear,
}: GroupActionBarProps): JSX.Element | null {
  // Conditional rendering: only show when 2+ tasks selected
  if (selectedCount < 2) {
    return null
  }

  const taskWord = selectedCount === 1 ? 'task' : 'tasks'

  return (
    <div
      className="
        fixed bottom-6 left-1/2 -translate-x-1/2
        bg-dark-surface border border-dark-border rounded-xl
        shadow-2xl
        px-5 py-3
        flex items-center justify-between gap-6
        z-50
        animate-fade-in-up
      "
      role="toolbar"
      aria-label="Multi-select actions"
    >
      {/* Left side: Selected count */}
      <span className="text-sm font-medium text-dark-text whitespace-nowrap">
        {selectedCount} {taskWord} selected
      </span>

      {/* Right side: Action buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onCreateGroup}
          disabled={selectedCount < 2}
          aria-label="Create group from selected tasks"
        >
          Create Group
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onBatchEdit}
          disabled={selectedCount === 0}
          aria-label="Batch edit selected tasks"
        >
          Batch Edit
        </button>
        <button
          type="button"
          className="text-sm text-dark-text-muted hover:text-dark-text transition-colors px-2 py-1"
          onClick={onClear}
          aria-label="Clear selection"
        >
          Clear
        </button>
      </div>
    </div>
  )
})
