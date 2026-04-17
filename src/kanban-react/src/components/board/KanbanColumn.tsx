import { TaskCard } from './TaskCard'
import type { Task, TaskStatus, BestOfNSummary } from '@/types'
import type { useDragDrop } from '@/hooks/useDragDrop'
import { memo } from 'react'

interface KanbanColumnProps {
  status: TaskStatus
  title: string
  helpText: string
  iconSvg: string
  iconColor: string
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof useDragDrop>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  currentSort: string
  highlightedRunId?: string | null
  isTaskInRun?: (taskId: string, runId: string | null) => boolean
  onOpenTask: (id: string, e?: React.MouseEvent) => void
  onChangeSort: (sort: string) => void
  onOpenTemplateModal: () => void
  onOpenTaskModal: () => void
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
  onArchiveAllDone: () => void
  onViewRuns: (id: string) => void
  onContinueReviews: (id: string) => void
}

export const KanbanColumn = memo(function KanbanColumn({
  status,
  title,
  helpText,
  iconSvg,
  iconColor,
  tasks,
  bonSummaries,
  getTaskRunColor,
  isTaskMutationLocked,
  dragDrop,
  isMultiSelecting,
  getIsSelected,
  currentSort,
  highlightedRunId,
  isTaskInRun,
  onOpenTask,
  onChangeSort,
  onOpenTemplateModal,
  onOpenTaskModal,
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
  onArchiveAllDone,
  onViewRuns,
  onContinueReviews,
}: KanbanColumnProps) {
  const isDragOver = dragDrop.dragOverStatus === status

  return (
    <div
      className={`kanban-column ${isDragOver ? 'drag-over' : ''}`}
      data-status={status}
      onDragOver={(e) => dragDrop.handleDragOver(status, e)}
      onDragLeave={dragDrop.handleDragLeave}
      onDrop={(e) => dragDrop.handleDrop(status, e)}
    >
      <div className="kanban-column-header">
        <div className={`kanban-column-title ${iconColor}`}>
          <span dangerouslySetInnerHTML={{ __html: iconSvg }} />
          <span>{title}</span>
          <button
            className="help-btn"
            title={helpText}
            aria-label={`${title} column help`}
          >
            ?
          </button>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={currentSort}
            onChange={(e) => onChangeSort(e.target.value)}
            className="text-xs bg-dark-input border border-dark-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
            title="Sort tasks"
          >
            <option value="manual">Manual</option>
            <option value="name-asc">Name ↑</option>
            <option value="name-desc">Name ↓</option>
            <option value="created-asc">Created ↑</option>
            <option value="created-desc">Created ↓</option>
            <option value="updated-asc">Updated ↑</option>
            <option value="updated-desc">Updated ↓</option>
          </select>
          <span className="kanban-column-count">
            {tasks?.length ?? 0}
          </span>
        </div>
      </div>

      <div className="kanban-column-body">
        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            bonSummary={bonSummaries[task.id]}
            runColor={getTaskRunColor(task.id)}
            isLocked={isTaskMutationLocked(task.id)}
            canDrag={(status === 'backlog' || status === 'code-style') && !isTaskMutationLocked(task.id) && currentSort === 'manual'}
            dragDrop={dragDrop}
            isSelected={getIsSelected?.(task.id) || false}
            isMultiSelecting={isMultiSelecting}
            isHighlighted={highlightedRunId ? isTaskInRun?.(task.id, highlightedRunId) || false : false}
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
        ))}

        {/* Add buttons at the end */}
        {status === 'template' && (
          <button
            className="add-task-btn flex items-center justify-center gap-2"
            onClick={onOpenTemplateModal}
            title="Add Template"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Add Template
          </button>
        )}
        {status === 'backlog' && (
          <button className="add-task-btn" onClick={onOpenTaskModal}>
            + Add Task
          </button>
        )}
        {status === 'done' && (tasks?.length ?? 0) > 0 && (
          <button className="add-task-btn mt-auto" onClick={onArchiveAllDone}>
            Archive All
          </button>
        )}
      </div>
    </div>
  )
})
