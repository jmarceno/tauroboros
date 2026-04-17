import { useMemo, memo } from 'react'
import type { Task, TaskStatus, BestOfNSummary } from '@/types'
import { KanbanColumn } from './KanbanColumn'
import type { useDragDrop } from '@/hooks/useDragDrop'

interface KanbanBoardProps {
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof useDragDrop>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  columnSorts?: Record<string, string>
  highlightedRunId?: string | null
  isTaskInRun?: (taskId: string, runId: string | null) => boolean
  onOpenTask: (id: string, e?: React.MouseEvent) => void
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
  onChangeColumnSort: (status: string, sort: string) => void
}

const columns: { status: TaskStatus; title: string }[] = [
  { status: 'template', title: 'Templates' },
  { status: 'backlog', title: 'Backlog' },
  { status: 'executing', title: 'Executing' },
  { status: 'review', title: 'Review' },
  { status: 'code-style', title: 'Code Style' },
  { status: 'done', title: 'Done' },
]

const columnHelpText: Record<string, string> = {
  template: 'Reusable task blueprints. Keep common prompts and settings here, then deploy them into the backlog when you need a new task.',
  backlog: 'Ready-to-run tasks waiting for execution. Add, edit, reorder, and set dependencies here before starting work.',
  executing: 'Tasks currently being worked on by the agent. Use this column to monitor active runs and open their live sessions.',
  review: 'Tasks that need human attention. Review outputs here, approve plans, or inspect stuck and failed work before deciding the next step.',
  'code-style': 'Tasks that need code style and formatting fixes. Apply linting, formatting, and style improvements here before marking as done.',
  done: 'Completed tasks. Use this column as the final state once the work and any needed review are finished.',
}

const columnIcons: Record<string, string> = {
  template: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
  backlog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>`,
  executing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  review: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`,
  'code-style': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>`,
  done: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
}

const columnColors: Record<string, string> = {
  template: 'text-column-template',
  backlog: 'text-column-backlog',
  executing: 'text-column-executing',
  review: 'text-column-review',
  'code-style': 'text-column-code-style',
  done: 'text-column-done',
}

export const KanbanBoard = memo(function KanbanBoard({
  tasks,
  bonSummaries,
  getTaskRunColor,
  isTaskMutationLocked,
  dragDrop,
  isMultiSelecting,
  getIsSelected,
  columnSorts,
  highlightedRunId,
  isTaskInRun,
  onOpenTask,
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
  onChangeColumnSort,
}: KanbanBoardProps) {
  const groupedTasks = useMemo(() => {
    if (!tasks || !Array.isArray(tasks)) {
      return {
        template: [],
        backlog: [],
        executing: [],
        review: [],
        'code-style': [],
        done: [],
      } as Record<TaskStatus, Task[]>
    }

    const groups: Record<TaskStatus, Task[]> = {
      template: [],
      backlog: [],
      executing: [],
      review: [],
      'code-style': [],
      done: [],
    }

    for (const task of tasks) {
      if (!task) continue
      if (task.status === 'failed' || task.status === 'stuck') {
        groups.review.push(task)
      } else if (task.status && task.status in groups) {
        groups[task.status as TaskStatus].push(task)
      }
    }

    return groups
  }, [tasks])

  return (
    <div className="kanban-wrapper">
      <div className="kanban-scroll">
        <div className="kanban-container">
          {columns.map(column => (
            <KanbanColumn
              key={`${column.status}-${groupedTasks[column.status].length}`}
              status={column.status}
              title={column.title}
              helpText={columnHelpText[column.status]}
              iconSvg={columnIcons[column.status]}
              iconColor={columnColors[column.status]}
              tasks={groupedTasks[column.status]}
              bonSummaries={bonSummaries}
              getTaskRunColor={getTaskRunColor}
              isTaskMutationLocked={isTaskMutationLocked}
              dragDrop={dragDrop}
              isMultiSelecting={isMultiSelecting}
              getIsSelected={getIsSelected}
              currentSort={columnSorts?.[column.status] || 'manual'}
              highlightedRunId={highlightedRunId}
              isTaskInRun={isTaskInRun}
              onOpenTask={onOpenTask}
              onChangeSort={(sort) => onChangeColumnSort(column.status, sort)}
              onOpenTemplateModal={onOpenTemplateModal}
              onOpenTaskModal={onOpenTaskModal}
              onDeployTemplate={onDeployTemplate}
              onOpenTaskSessions={onOpenTaskSessions}
              onApprovePlan={onApprovePlan}
              onRequestRevision={onRequestRevision}
              onStartSingle={onStartSingle}
              onRepairTask={onRepairTask}
              onMarkDone={onMarkDone}
              onResetTask={onResetTask}
              onConvertToTemplate={onConvertToTemplate}
              onArchiveTask={onArchiveTask}
              onArchiveAllDone={onArchiveAllDone}
              onViewRuns={onViewRuns}
              onContinueReviews={onContinueReviews}
            />
          ))}
        </div>
      </div>
    </div>
  )
})
