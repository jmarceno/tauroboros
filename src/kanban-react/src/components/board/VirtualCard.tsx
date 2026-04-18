import { memo, useCallback, useState } from 'react'
import type { TaskGroup, TaskGroupStatus } from '@/types'
import { formatLocalDate } from '@/utils/date'

interface VirtualCardProps {
  group: TaskGroup
  taskCount: number
  onClick: () => void
  onDelete: () => void
  onStart?: () => void
}

export const VirtualCard = memo(function VirtualCard({
  group,
  taskCount,
  onClick,
  onDelete,
  onStart,
}: VirtualCardProps) {
  const [showConfirm, setShowConfirm] = useState(false)

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey) {
      onDelete()
    } else {
      setShowConfirm(true)
    }
  }, [onDelete])

  const handleConfirmDelete = useCallback(() => {
    setShowConfirm(false)
    onDelete()
  }, [onDelete])

  const handleCancelDelete = useCallback(() => {
    setShowConfirm(false)
  }, [])

  const handleStartClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onStart?.()
  }, [onStart])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }, [onClick])

  const getStatusIcon = useCallback((status: TaskGroupStatus) => {
    switch (status) {
      case 'active':
        return (
          <svg className="virtual-card-icon text-accent-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )
      case 'running':
        return (
          <svg className="virtual-card-icon text-accent-success animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
          </svg>
        )
      case 'completed':
        return (
          <svg className="virtual-card-icon text-accent-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 13l4 4L19 7" />
          </svg>
        )
      default:
        return (
          <svg className="virtual-card-icon text-dark-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )
    }
  }, [])

  return (
    <>
      <div
        className="virtual-card"
        data-group-color={group.color}
        style={{ borderLeftColor: group.color, '--group-color': `${group.color}66` } as React.CSSProperties}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-label={`${group.name} group with ${taskCount} task${taskCount !== 1 ? 's' : ''}, status ${group.status}. Press Enter to open.`}
        title={`Created: ${formatLocalDate(group.createdAt)}\nClick to manage group`}
      >
        {/* Header */}
        <div className="virtual-card-header">
          {getStatusIcon(group.status)}
          <span className="virtual-card-title" title={group.name}>
            {group.name}
          </span>
        </div>

        {/* Body */}
        <div className="virtual-card-body">
          <span className="virtual-card-label">Virtual Workflow</span>
          <span className="text-[11px] text-dark-text-secondary">
            {taskCount} task{taskCount !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Footer */}
        <div className="virtual-card-footer">
          {onStart && group.status === 'active' && (
            <button
              className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
              title="Start group execution"
              onClick={handleStartClick}
              aria-label={`Start execution for ${group.name}`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          )}
          <button
            className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-danger transition-colors ml-auto"
            title="Delete group"
            onClick={handleDeleteClick}
            aria-label={`Delete ${group.name} group`}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showConfirm && (
        <div className="modal-overlay" onClick={handleCancelDelete}>
          <div className="modal max-w-modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete Group</h2>
            </div>
            <div className="modal-body">
              <p className="text-dark-text">
                Are you sure you want to delete &quot;{group.name}&quot;? This action cannot be undone.
              </p>
              <p className="text-sm text-dark-text-muted mt-2">
                Tip: Hold Ctrl/Cmd and click to skip this confirmation in the future.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={handleCancelDelete}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={handleConfirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
})
