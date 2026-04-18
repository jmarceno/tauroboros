import { memo, useCallback, useRef, useState, useEffect } from 'react'
import type { TaskGroup, Task, TaskStatus } from '@/types'
import type { useDragDrop } from '@/hooks/useDragDrop'
import { useFocusTrap } from '@/hooks/useFocusTrap'

export interface GroupPanelProps {
  group: TaskGroup
  tasks: Task[]
  isOpen: boolean
  onClose: () => void
  onRemoveTask: (taskId: string) => void
  onAddTasks: (taskIds: string[]) => void
  onStartGroup: () => void
  onOpenTask: (id: string) => void
  onDeleteGroup: () => void
  dragDrop: ReturnType<typeof useDragDrop>
}

// Status color mapping for task indicator
const statusColorMap: Record<TaskStatus, string> = {
  template: 'bg-column-template',
  backlog: 'bg-column-backlog',
  executing: 'bg-column-executing',
  review: 'bg-column-review',
  'code-style': 'bg-column-code-style',
  done: 'bg-column-done',
  failed: 'bg-accent-danger',
  stuck: 'bg-accent-danger',
}

// Status icon mapping for tasks
const getStatusIcon = (status: TaskStatus) => {
  switch (status) {
    case 'executing':
      return (
        <svg className="w-3 h-3 animate-spin text-accent-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
        </svg>
      )
    case 'template':
      return (
        <svg className="w-3 h-3 text-column-template" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      )
    case 'backlog':
      return (
        <svg className="w-3 h-3 text-column-backlog" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
      )
    case 'review':
      return (
        <svg className="w-3 h-3 text-column-review" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      )
    case 'done':
      return (
        <svg className="w-3 h-3 text-column-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    case 'stuck':
    case 'failed':
      return (
        <svg className="w-3 h-3 text-accent-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      )
    case 'code-style':
      return (
        <svg className="w-3 h-3 text-column-code-style" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      )
    default:
      return null
  }
}

export const GroupPanel = memo(function GroupPanel({
  group,
  tasks,
  isOpen,
  onClose,
  onRemoveTask,
  onAddTasks,
  onStartGroup,
  onOpenTask,
  onDeleteGroup,
  dragDrop,
}: GroupPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [isExiting, setIsExiting] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)

  // Store the element that triggered the panel open
  useEffect(() => {
    if (isOpen) {
      triggerRef.current = document.activeElement as HTMLElement
    }
  }, [isOpen])

  const handleClose = useCallback(() => {
    setIsExiting(true)
  }, [])

  // Focus trap for accessibility
  useFocusTrap({
    isActive: isOpen,
    containerRef,
    restoreFocusTo: triggerRef.current,
    onEscape: handleClose,
  })

  // Use dragOverTarget from hook for precise state tracking
  const isDragOver = dragDrop.dragOverTarget?.type === 'group' && dragDrop.dragOverTarget?.id === group.id

  const handleAnimationEnd = useCallback(() => {
    if (isExiting) {
      setIsExiting(false)
      onClose()
    }
  }, [isExiting, onClose])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDrop.handleDragOverGroup(group.id, e)
  }, [dragDrop, group.id])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      dragDrop.handleDragLeave()
    }
  }, [dragDrop])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDrop.handleDropOnGroup(group.id, e)
  }, [dragDrop, group.id])

  const handleRemoveTask = useCallback((e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    onRemoveTask(taskId)
  }, [onRemoveTask])

  const handleOpenTask = useCallback((taskId: string) => {
    onOpenTask(taskId)
  }, [onOpenTask])

  const handleTaskKeyDown = useCallback((e: React.KeyboardEvent, taskId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpenTask(taskId)
    }
  }, [onOpenTask])

  const handleStartClick = useCallback(() => {
    onStartGroup()
  }, [onStartGroup])

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDeleteGroup()
  }, [onDeleteGroup])

  const handleBackdropClick = useCallback(() => {
    handleClose()
  }, [handleClose])

  // Don't render anything when closed and animation finished
  if (!isOpen && !isExiting) {
    return null
  }

  const taskCount = tasks.length
  const taskWord = taskCount === 1 ? 'task' : 'tasks'

  return (
    <>
      {/* Backdrop */}
      <div
        className="group-panel-backdrop"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={containerRef}
        className={`group-panel ${isExiting ? 'group-panel-exit' : 'group-panel-enter'}`}
        style={{
          boxShadow: '-4px 0 20px rgba(0,0,0,0.5)',
          '--group-color': `${group.color}66`,
        } as React.CSSProperties}
        role="complementary"
        aria-label={`Group panel: ${group.name}`}
        aria-expanded={isOpen}
        onAnimationEnd={handleAnimationEnd}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 bg-dark-surface2 border-b border-dark-border flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {/* Color indicator */}
            <div
              className="w-3 h-3 rounded-full border border-dark-border flex-shrink-0"
              style={{ backgroundColor: group.color }}
              aria-hidden="true"
            />
            {/* Group name and count */}
            <div className="min-w-0">
              <h3
                className="text-sm font-semibold text-dark-text truncate"
                title={group.name}
              >
                {group.name}
              </h3>
              <span className="text-xs text-dark-text-secondary">
                {taskCount} {taskWord}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Delete group button */}
            <button
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-danger transition-colors"
              title="Delete group"
              onClick={handleDeleteClick}
              aria-label="Delete group"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            {/* Close button */}
            <button
              ref={closeButtonRef}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-dark-text transition-colors"
              onClick={handleClose}
              aria-label="Close group panel (Escape)"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Drag-drop zone */}
        <div
          className={`group-drop-zone ${isDragOver ? 'drag-over bg-accent-primary/10' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="region"
          aria-label={`Drop zone for ${group.name}`}
        >
          <div
            className={`border-2 border-dashed rounded-lg p-3 text-center transition-colors duration-200 ${
              isDragOver
                ? 'border-accent-primary'
                : 'border-dark-border'
            }`}
          >
            <svg
              className={`w-5 h-5 mx-auto mb-1 transition-colors duration-200 ${
                isDragOver ? 'text-accent-primary' : 'text-dark-text-muted'
              }`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            <span
              className={`text-xs transition-colors duration-200 ${
                isDragOver ? 'text-accent-primary' : 'text-dark-text-muted'
              }`}
            >
              {isDragOver ? 'Drop to add' : 'Drag tasks here to add'}
            </span>
          </div>
        </div>

        {/* Task list */}
        <div
          className="flex-1 overflow-y-auto p-3 space-y-2"
          role="list"
          aria-label={`Tasks in ${group.name}`}
        >
          {tasks.length === 0 ? (
            /* Empty state */
            <div className="group-empty-state">
              <svg
                className="group-empty-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                <path d="M12 12v4m0-4l-2 2m2-2l2 2" />
              </svg>
              <p className="text-sm text-dark-text-muted">No tasks in this group</p>
              <p className="group-hint-text">
                Drag tasks from the board or use Ctrl+G with 2+ selected tasks to add them
              </p>
            </div>
          ) : (
            /* Task cards */
            tasks.map((task) => (
              <div
                key={task.id}
                className="group-task-item p-2.5 bg-dark-bg border border-dark-border rounded-md cursor-pointer transition-all hover:border-accent-primary hover:translate-x-0.5"
                onClick={() => handleOpenTask(task.id)}
                onKeyDown={(e) => handleTaskKeyDown(e, task.id)}
                tabIndex={0}
                role="listitem"
                aria-label={`${task.name}, status ${task.status}. Press Enter to open.`}
              >
                <div className="flex items-start gap-2">
                  {/* Status indicator */}
                  <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
                    {getStatusIcon(task.status)}
                  </div>

                  {/* Task info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="px-1.5 py-0 text-[10px] bg-dark-surface2 border border-dark-border rounded text-dark-text-muted font-mono"
                        aria-label={`Task number ${task.idx + 1}`}
                      >
                        #{task.idx + 1}
                      </span>
                      <span
                        className="text-sm text-dark-text truncate"
                        title={task.name}
                      >
                        {task.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${statusColorMap[task.status] || 'bg-dark-text-muted'}`}
                        aria-hidden="true"
                      />
                      <span className="text-xs text-dark-text-secondary capitalize">
                        {task.status}
                      </span>
                    </div>
                  </div>

                  {/* Remove button */}
                  <button
                    className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-danger transition-all"
                    title="Remove from group"
                    onClick={(e) => handleRemoveTask(e, task.id)}
                    aria-label={`Remove task ${task.name} from group`}
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 p-3 bg-dark-surface2 border-t border-dark-border">
          <button
            className="btn btn-primary w-full flex items-center justify-center gap-2"
            disabled={tasks.length === 0}
            onClick={handleStartClick}
            aria-label={tasks.length === 0 ? 'Start group workflow (no tasks available)' : 'Start group workflow'}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Start Group Workflow
          </button>
        </div>
      </div>
    </>
  )
})
