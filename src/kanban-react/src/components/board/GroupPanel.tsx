import { memo, useCallback, useRef, useState, useEffect } from 'react'
import type { TaskGroup, Task, BestOfNSummary } from '@/types'
import type { useDragDrop } from '@/hooks/useDragDrop'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { TaskCard } from './TaskCard'

export interface GroupPanelProps {
  group: TaskGroup
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  isOpen: boolean
  onClose: () => void
  onRemoveTask: (taskId: string) => void
  onAddTasks: (taskIds: string[]) => void
  onStartGroup: () => void
  onOpenTask: (id: string, e?: React.MouseEvent) => void
  onDeployTemplate: (id: string, e: React.MouseEvent) => void
  onOpenTaskSessions: (id: string) => void
  onApprovePlan: (id: string) => void
  onRequestRevision: (id: string) => void
  onStartSingle: (id: string) => void
  onRepairTask: (id: string, action: string) => void
  onMarkDone: (id: string) => void
  onResetTask: (id: string) => void
  onConvertToTemplate: (id: string, event?: React.MouseEvent) => void
  onArchiveTask: (id: string, event?: React.MouseEvent) => void
  onViewRuns: (id: string) => void
  onContinueReviews: (id: string) => void
  onDeleteGroup: () => void
  dragDrop: ReturnType<typeof useDragDrop>
}

export const GroupPanel = memo(function GroupPanel({
  group,
  tasks,
  bonSummaries,
  getTaskRunColor,
  isTaskMutationLocked,
  isOpen,
  onClose,
  onRemoveTask,
  onAddTasks,
  onStartGroup,
  onOpenTask,
  onDeployTemplate,
  onOpenTaskSessions,
  onApprovePlan,
  onRequestRevision,
  onStartSingle,
  onRepairTask,
  onMarkDone,
  onResetTask,
  onConvertToTemplate,
  onArchiveTask,
  onViewRuns,
  onContinueReviews,
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

  const handleRemoveTask = useCallback((taskId: string) => {
    onRemoveTask(taskId)
  }, [onRemoveTask])

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
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
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

        {/* Task list - using TaskCard directly */}
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
            /* Task cards - using TaskCard component directly */
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                bonSummary={bonSummaries[task.id]}
                runColor={getTaskRunColor(task.id)}
                isLocked={isTaskMutationLocked(task.id)}
                canDrag={false}
                dragDrop={dragDrop}
                isSelected={false}
                isMultiSelecting={false}
                isHighlighted={false}
                group={{ id: group.id, name: group.name, color: group.color }}
                showGroupIndicator={true}
                onOpen={(e) => onOpenTask(task.id, e)}
                onDeploy={(e) => onDeployTemplate(task.id, e)}
                onOpenTaskSessions={() => onOpenTaskSessions(task.id)}
                onApprovePlan={() => onApprovePlan(task.id)}
                onRequestRevision={() => onRequestRevision(task.id)}
                onStartSingle={() => onStartSingle(task.id)}
                onRepair={(action) => onRepairTask(task.id, action)}
                onMarkDone={() => onMarkDone(task.id)}
                onReset={() => onResetTask(task.id)}
                onConvertToTemplate={(e) => onConvertToTemplate(task.id, e)}
                onArchive={(e) => onArchiveTask(task.id, e)}
                onViewRuns={() => onViewRuns(task.id)}
                onContinueReviews={() => onContinueReviews(task.id)}
              />
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
