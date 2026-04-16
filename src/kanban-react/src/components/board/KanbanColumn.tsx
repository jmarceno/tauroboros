import { TaskCard } from './TaskCard'
import type { Task, TaskStatus, BestOfNSummary } from '@/types'
import type { useDragDrop } from '@/hooks/useDragDrop'

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
  onOpenTask: (id: string) => void
  onChangeSort: (sort: string) => void
  onOpenTemplateModal: () => void
  onOpenTaskModal: () => void
  onDeployTemplate: (id: string) => void
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

const sortOptions = [
  { value: 'manual', label: 'Manual' },
  { value: 'name-asc', label: 'Name (A-Z)' },
  { value: 'name-desc', label: 'Name (Z-A)' },
  { value: 'created-asc', label: 'Created (oldest)' },
  { value: 'created-desc', label: 'Created (newest)' },
  { value: 'updated-asc', label: 'Updated (oldest)' },
  { value: 'updated-desc', label: 'Updated (newest)' },
]

export function KanbanColumn({
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
      onDragOver={(e) => dragDrop.handleDragOver(status, e)}
      onDragLeave={dragDrop.handleDragLeave}
      onDrop={(e) => dragDrop.handleDrop(status, e)}
    >
      <div className="kanban-column-header">
        <div className="kanban-column-title">
          <span className={iconColor} dangerouslySetInnerHTML={{ __html: iconSvg }} />
          <span>{title}</span>
          <span className="kanban-column-count" title={helpText}>
            {tasks.length}
          </span>
        </div>
        <select
          value={currentSort}
          onChange={(e) => onChangeSort(e.target.value)}
          className="text-xs bg-dark-bg border border-dark-border rounded px-2 py-1"
        >
          {sortOptions.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="kanban-column-body">
        {status === 'template' && (
          <button className="add-task-btn" onClick={onOpenTemplateModal}>
            + Add Template
          </button>
        )}
        {status === 'backlog' && (
          <button className="add-task-btn" onClick={onOpenTaskModal}>
            + Add Task
          </button>
        )}

        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            bonSummary={bonSummaries[task.id]}
            runColor={getTaskRunColor(task.id)}
            isLocked={isTaskMutationLocked(task.id)}
            isDragging={dragDrop.dragTaskId === task.id}
            isMultiSelecting={isMultiSelecting}
            isSelected={getIsSelected?.(task.id) || false}
            isHighlighted={highlightedRunId ? isTaskInRun?.(task.id, highlightedRunId) || false : false}
            onDragStart={() => dragDrop.handleDragStart(task.id)}
            onDragEnd={dragDrop.handleDragEnd}
            onClick={() => onOpenTask(task.id)}
            onDeploy={() => onDeployTemplate(task.id)}
            onOpenSessions={() => onOpenTaskSessions(task.id)}
            onApprove={() => onApprovePlan(task.id)}
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

        {status === 'done' && tasks.length > 0 && (
          <button className="add-task-btn mt-2" onClick={onArchiveAllDone}>
            Archive All Done
          </button>
        )}
      </div>
    </div>
  )
}
