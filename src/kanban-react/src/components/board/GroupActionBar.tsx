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
}: GroupActionBarProps): React.ReactElement | null {
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
      aria-label={`${selectedCount} tasks selected. Create group or batch edit.`}
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
          aria-label={`Create group from ${selectedCount} selected tasks`}
        >
          <svg className="w-3.5 h-3.5 inline-block mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          Create Group
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onBatchEdit}
          disabled={selectedCount === 0}
          aria-label={`Batch edit ${selectedCount} selected tasks`}
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
