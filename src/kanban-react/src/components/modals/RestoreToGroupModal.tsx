import { useCallback, useEffect } from 'react'
import type { Task, TaskGroup } from '@/types'

interface RestoreToGroupModalProps {
  isOpen: boolean
  onClose: () => void
  task: Task | null
  group: TaskGroup | null
  onRestoreToGroup: () => void
  onMoveToBacklog: () => void
}

export function RestoreToGroupModal({
  isOpen,
  onClose,
  task,
  group,
  onRestoreToGroup,
  onMoveToBacklog,
}: RestoreToGroupModalProps) {
  const handleRestore = useCallback(() => {
    onRestoreToGroup()
    onClose()
  }, [onRestoreToGroup, onClose])

  const handleBacklog = useCallback(() => {
    onMoveToBacklog()
    onClose()
  }, [onMoveToBacklog, onClose])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen || !task || !group) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-dark-surface border border-dark-border rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-dark-border">
          <div className="flex items-center gap-3">
            <div
              className="group-color-indicator"
              data-indicator-color={group.color}
            />
            <h2 className="text-lg font-semibold text-dark-text">
              Restore Task to Group?
            </h2>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4">
          <p className="text-dark-text-secondary">
            Task <strong className="text-dark-text">&quot;{task.name}&quot;</strong> was previously
            a member of group <strong className="text-dark-text">&quot;{group.name}&quot;</strong>.
          </p>

          <div
            className="p-3 rounded-md border border-dark-border bg-dark-surface2 border-l-4"
            data-group-tag-color={group.color}
          >
            <div className="flex items-center gap-2 text-sm text-dark-text-secondary">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              <span>Group: <strong className="text-dark-text">{group.name}</strong></span>
            </div>
          </div>

          <p className="text-sm text-dark-text-muted">
            Choose where to restore this task:
          </p>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-dark-border flex flex-col gap-2">
          <button
            className="btn btn-primary w-full justify-center"
            onClick={handleRestore}
          >
            <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            Restore to Group
          </button>
          <button
            className="btn w-full justify-center border-dark-border hover:bg-dark-surface2"
            onClick={handleBacklog}
          >
            <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Move to General Backlog
          </button>
          <button
            className="btn w-full justify-center text-dark-text-muted hover:text-dark-text"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
