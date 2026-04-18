import { useMemo, memo } from "react"
import type { Task, TaskStatus, BestOfNSummary, TaskGroup, ColumnSortPreferences } from "@/types"
import { KanbanColumn } from "./KanbanColumn"
import { VirtualCard } from "./VirtualCard"
import { GroupPanel } from "./GroupPanel"
import type { useDragDrop } from "@/hooks/useDragDrop"

interface KanbanBoardProps {
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof useDragDrop>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  columnSorts?: ColumnSortPreferences
  highlightedRunId?: string | null
  isTaskInRun?: (taskId: string, runId: string | null) => boolean
  // Group-related props
  groups?: TaskGroup[]
  groupMembers?: Record<string, string[]>
  activeGroupId?: string | null
  onOpenTask: (id: string, e?: React.MouseEvent) => void
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
  onChangeColumnSort: (status: string, sort: string) => void
  // Group handlers
  onVirtualCardClick?: (groupId: string) => void
  onDeleteGroup?: (groupId: string) => void
  onStartGroup?: (groupId: string) => void
  onCloseGroupPanel?: () => void
  onRemoveTaskFromGroup?: (taskId: string) => void
  onAddTasksToGroup?: (taskIds: string[]) => void
  onCreateGroupFromSelection?: () => void
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
  'code-style': 'Automated code style enforcement. The agent reviews code and applies fixes immediately to comply with the configured style prompt.',
  done: 'Completed tasks. Use this column as the final state once the work and any needed review are finished.',
}

const columnIcons: Record<string, string> = {
  template: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
  backlog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>`,
  executing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  review: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`,
  'code-style': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>`,
  done: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
}

const columnColors: Record<string, string> = {
  template: 'text-column-template',
  backlog: 'text-column-backlog',
  executing: 'text-column-executing',
  review: 'text-column-review',
  'code-style': 'text-column-codestyle',
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
  // Group props
  groups = [],
  groupMembers = {},
  activeGroupId = null,
  // Handlers
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
  // Group handlers
  onVirtualCardClick,
  onDeleteGroup,
  onStartGroup,
  onCloseGroupPanel,
  onRemoveTaskFromGroup,
  onAddTasksToGroup,
  onCreateGroupFromSelection,
}: KanbanBoardProps) {
  const groupedTaskIds = useMemo(() => {
    const ids = new Set<string>()
    for (const taskIds of Object.values(groupMembers)) {
      for (const taskId of taskIds) {
        ids.add(taskId)
      }
    }
    return ids
  }, [groupMembers])

  const groupedTasks = useMemo(() => {
    const groups = {
      template: [] as Task[],
      backlog: [] as Task[],
      executing: [] as Task[],
      review: [] as Task[],
      'code-style': [] as Task[],
      done: [] as Task[],
      failed: [] as Task[],
      stuck: [] as Task[],
    }

    for (const task of tasks) {
      if (task.status === 'backlog' && groupedTaskIds.has(task.id)) {
        continue
      }

      if (task.status === 'failed' || task.status === 'stuck') {
        groups.review.push(task)
      } else if (task.status === 'code-style') {
        groups['code-style'].push(task)
      } else if (task.status && task.status in groups) {
        groups[task.status as TaskStatus].push(task)
      }
    }

    return groups
  }, [tasks, groupedTaskIds])

  const activeGroup = useMemo(() => {
    if (!activeGroupId) return null
    return groups.find(g => g.id === activeGroupId) || null
  }, [groups, activeGroupId])

  const activeGroupTasks = useMemo(() => {
    if (!activeGroupId || !groupMembers[activeGroupId]) return []
    const memberIds = new Set(groupMembers[activeGroupId])
    return tasks.filter(t => memberIds.has(t.id))
  }, [activeGroupId, groupMembers, tasks])

  const activeGroups = useMemo(() =>
    groups.filter(g => g.status === 'active'),
    [groups]
  )

  return (
    <div className="kanban-wrapper">
      <div className="kanban-scroll">
        <div className="kanban-container">
          {columns.map(column => (
            <KanbanColumn
              key={column.status}
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
              groups={groups}
              footerContent={
                column.status === 'backlog' && activeGroups.length === 0 ? (
                  <div className="virtual-cards-empty-footer" aria-live="polite">
                    <p className="text-xs text-dark-text-muted italic">
                      No groups yet. Select 2+ tasks and press{' '}
                      <kbd className="px-1 py-0.5 bg-dark-surface2 border border-dark-border rounded text-[10px] font-mono">Ctrl+G</kbd>{' '}
                      to create one.
                    </p>
                  </div>
                ) : undefined
              }
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
            >
              {column.status === 'backlog' && activeGroups.length > 0 && (
                <div className="virtual-cards-section">
                  <div className="virtual-cards-header">
                    <span className="text-xs font-medium text-dark-text-muted uppercase tracking-wider">
                      Virtual Workflows
                    </span>
                  </div>
                  <div className="virtual-cards-list">
                    {activeGroups.map(group => (
                      <VirtualCard
                        key={group.id}
                        group={group}
                        taskCount={groupMembers[group.id]?.length ?? 0}
                        onClick={() => onVirtualCardClick?.(group.id)}
                        onDelete={() => onDeleteGroup?.(group.id)}
                        onStart={() => onStartGroup?.(group.id)}
                      />
                    ))}
                  </div>
                  <div className="virtual-cards-divider" />
                </div>
              )}
            </KanbanColumn>
          ))}
        </div>
      </div>

      {/* Group Panel - slides in from right when active */}
      {activeGroup && (
        <GroupPanel
          group={activeGroup}
          tasks={activeGroupTasks}
          isOpen={!!activeGroupId}
          onClose={() => onCloseGroupPanel?.()}
          onRemoveTask={(taskId) => onRemoveTaskFromGroup?.(taskId)}
          onAddTasks={(taskIds) => onAddTasksToGroup?.(taskIds)}
          onStartGroup={() => onStartGroup?.(activeGroup.id)}
          onOpenTask={(id) => onOpenTask(id)}
          onDeleteGroup={() => onDeleteGroup?.(activeGroup.id)}
          dragDrop={dragDrop}
        />
      )}
    </div>
  )
})
