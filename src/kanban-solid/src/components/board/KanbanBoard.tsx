/**
 * KanbanBoard Component - Main kanban board with columns
 */

import { createMemo, For, Show } from 'solid-js'
import type { Task, TaskStatus, BestOfNSummary, TaskGroup, ColumnSortPreferences } from '@/types'
import { KanbanColumn } from './KanbanColumn'
import { VirtualCard } from './VirtualCard'
import { GroupPanel } from './GroupPanel'
import { DoneGroupCard } from './DoneGroupCard'
import type { createDragDropStore } from '@/stores'
import type { createSessionUsageStore } from '@/stores/sessionUsageStore'
import type { createTaskLastUpdateStore } from '@/stores/taskLastUpdateStore'
import type { Options } from '@/types'

interface KanbanBoardProps {
  logPanelCollapsed?: boolean
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof createDragDropStore>
  sessionUsage: ReturnType<typeof createSessionUsageStore>
  taskLastUpdate: ReturnType<typeof createTaskLastUpdateStore>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  columnSorts?: ColumnSortPreferences
  highlightedRunId?: string | null
  isTaskInRun?: (taskId: string, runId: string | null) => boolean
  groups?: TaskGroup[]
  groupMembers?: Record<string, string[]>
  activeGroupId?: string | null
  options?: Options | null
  onOpenTask: (id: string, e?: MouseEvent) => void
  onOpenTemplateModal: () => void
  onOpenTaskModal: () => void
  onDeployTemplate: (id: string, e: MouseEvent) => void
  onOpenTaskSessions: (id: string) => void
  onApprovePlan: (id: string) => void
  onRequestRevision: (id: string) => void
  onStartSingle: (id: string) => void
  onRepairTask: (id: string, action: string) => void
  onMarkDone: (id: string) => void
  onResetTask: (id: string) => void
  onConvertToTemplate: (id: string, event?: MouseEvent) => void
  onArchiveTask: (id: string, event?: MouseEvent) => void
  onArchiveAllDone: () => void
  onViewRuns: (id: string) => void
  onContinueReviews: (id: string) => void
  onChangeColumnSort: (status: string, sort: string) => void
  onVirtualCardClick?: (groupId: string) => void
  onDeleteGroup?: (groupId: string) => void
  onStartGroup?: (groupId: string) => void
  onCloseGroupPanel?: () => void
  onRemoveTaskFromGroup?: (taskId: string) => void
  onAddTasksToGroup?: (taskIds: string[]) => void
  onRenameGroup?: (groupId: string, newName: string) => Promise<unknown>
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

export function KanbanBoard(props: KanbanBoardProps) {
  const groupedTaskIds = createMemo(() => {
    const ids = new Set<string>()
    const members = props.groupMembers || {}
    for (const taskIds of Object.values(members)) {
      for (const taskId of taskIds) {
        ids.add(taskId)
      }
    }
    return ids
  })

  const groupedTasks = createMemo(() => {
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

    for (const task of props.tasks) {
      if (task.status === 'backlog' && groupedTaskIds().has(task.id)) {
        continue
      }

      if (task.status === 'done' && task.groupId) {
        continue
      }

      if (task.status === 'failed' || task.status === 'stuck') {
        groups.review.push(task)
      } else if (task.status === 'code-style') {
        groups['code-style'].push(task)
      } else if (task.status === 'queued') {
        groups.backlog.push(task)
      } else if (task.status && task.status in groups) {
        groups[task.status as TaskStatus].push(task)
      }
    }

    return groups
  })

  const activeGroup = createMemo(() => {
    const groups = props.groups || []
    const id = props.activeGroupId
    if (!id) return null
    return groups.find(group => group.id === id) || null
  })

  const activeGroupTasks = createMemo(() => {
    const id = props.activeGroupId
    const members = props.groupMembers || {}
    if (!id || !members[id]) return []
    const memberIds = new Set(members[id])
    return props.tasks.filter(task => memberIds.has(task.id))
  })

  const fullyCompletedGroupIds = createMemo(() => {
    const allGroups = props.groups || []
    return new Set(
      allGroups
        .filter(group => {
          const memberIds = props.groupMembers?.[group.id] || []
          return memberIds.length > 0 && memberIds.every(id => {
            const task = props.tasks.find(task => task.id === id)
            return task?.status === 'done'
          })
        })
        .map(group => group.id)
    )
  })

  const activeGroups = createMemo(() => {
    const groups = props.groups || []
    return groups.filter(group =>
      group.status === 'active' && !fullyCompletedGroupIds().has(group.id)
    )
  })

  const groupsWithDoneTasks = createMemo(() => {
    const doneGroupIds = new Set(
      props.tasks.filter(task => task.status === 'done' && task.groupId).map(task => task.groupId)
    )
    return (props.groups || []).filter(group => doneGroupIds.has(group.id))
  })

  const doneTasksByGroup = createMemo(() => {
    const grouped: Record<string, Task[]> = {}
    for (const task of props.tasks) {
      if (task.status !== 'done' || !task.groupId) continue
      if (!grouped[task.groupId]) grouped[task.groupId] = []
      grouped[task.groupId].push(task)
    }
    return grouped
  })

  return (
    <div class="kanban-wrapper">
      <div class={`kanban-scroll${props.logPanelCollapsed ? ' pb-10' : ''}`}>
        <div class="kanban-container">
          {columns.map(column => (
            <div
              class={`kanban-column-wrapper ${column.status === 'backlog' ? 'is-relative' : ''}`}
            >
              <KanbanColumn
                status={column.status}
                title={column.title}
                helpText={columnHelpText[column.status]}
                iconSvg={columnIcons[column.status]}
                iconColor={columnColors[column.status]}
                tasks={groupedTasks()[column.status]}
                bonSummaries={props.bonSummaries}
                getTaskRunColor={props.getTaskRunColor}
                isTaskMutationLocked={props.isTaskMutationLocked}
                dragDrop={props.dragDrop}
                sessionUsage={props.sessionUsage}
                taskLastUpdate={props.taskLastUpdate}
                isMultiSelecting={props.isMultiSelecting}
                getIsSelected={props.getIsSelected}
                currentSort={props.columnSorts?.[column.status] || 'manual'}
                highlightedRunId={props.highlightedRunId}
                isTaskInRun={props.isTaskInRun}
                groups={props.groups}
                allTasks={props.tasks}
                options={props.options}
                footerContent={
                  column.status === 'backlog' && activeGroups().length === 0 ? (
                    <div class="virtual-cards-empty-footer" aria-live="polite">
                      <p class="text-xs text-dark-text-muted italic">
                        No groups yet. Select 2+ tasks and press{' '}
                        <kbd class="px-1 py-0.5 bg-dark-surface2 border border-dark-border rounded text-[10px] font-mono">Ctrl+G</kbd>{' '}
                        to create one.
                      </p>
                    </div>
                  ) : undefined
                }
                onOpenTask={props.onOpenTask}
                onChangeSort={(sort) => props.onChangeColumnSort(column.status, sort)}
                onOpenTemplateModal={props.onOpenTemplateModal}
                onOpenTaskModal={props.onOpenTaskModal}
                onDeployTemplate={props.onDeployTemplate}
                onOpenTaskSessions={props.onOpenTaskSessions}
                onApprovePlan={props.onApprovePlan}
                onRequestRevision={props.onRequestRevision}
                onStartSingle={props.onStartSingle}
                onRepairTask={props.onRepairTask}
                onMarkDone={props.onMarkDone}
                onResetTask={props.onResetTask}
                onConvertToTemplate={props.onConvertToTemplate}
                onArchiveTask={props.onArchiveTask}
                onArchiveAllDone={props.onArchiveAllDone}
                onViewRuns={props.onViewRuns}
                onContinueReviews={props.onContinueReviews}
              >
                {column.status === 'backlog' && activeGroups().length > 0 && (
                  <div class="virtual-cards-section">
                    <div class="virtual-cards-header">
                      <span class="text-xs font-medium text-dark-text-muted uppercase tracking-wider">
                        Virtual Workflows
                      </span>
                    </div>
                    <div class="virtual-cards-list">
                      {activeGroups().map(group => (
                        <VirtualCard
                          group={group}
                          taskCount={props.groupMembers?.[group.id]?.length ?? 0}
                          onClick={() => props.onVirtualCardClick?.(group.id)}
                          onDelete={() => props.onDeleteGroup?.(group.id)}
                          onStart={() => props.onStartGroup?.(group.id)}
                        />
                      ))}
                    </div>
                    <div class="virtual-cards-divider" />
                  </div>
                )}
                {column.status === 'done' && groupsWithDoneTasks().length > 0 && (
                  <div class="done-group-cards-section">
                    <div class="done-group-cards-header">
                      <span class="text-xs font-medium text-dark-text-muted uppercase tracking-wider">
                        Completed Groups
                      </span>
                    </div>
                    <div class="done-group-cards-list">
                      {groupsWithDoneTasks().map(group => (
                        <DoneGroupCard
                          group={group}
                          tasks={doneTasksByGroup()[group.id] || []}
                          fullyCompleted={fullyCompletedGroupIds().has(group.id)}
                          bonSummaries={props.bonSummaries}
                          getTaskRunColor={props.getTaskRunColor}
                          isTaskMutationLocked={props.isTaskMutationLocked}
                          dragDrop={props.dragDrop}
                          sessionUsage={props.sessionUsage}
                          taskLastUpdate={props.taskLastUpdate}
                          isMultiSelecting={props.isMultiSelecting}
                          getIsSelected={props.getIsSelected}
                          allTasks={props.tasks}
                          options={props.options}
                          onOpenTask={props.onOpenTask}
                          onDeployTemplate={props.onDeployTemplate}
                          onOpenTaskSessions={props.onOpenTaskSessions}
                          onApprovePlan={props.onApprovePlan}
                          onRequestRevision={props.onRequestRevision}
                          onStartSingle={props.onStartSingle}
                          onRepairTask={props.onRepairTask}
                          onMarkDone={props.onMarkDone}
                          onResetTask={props.onResetTask}
                          onConvertToTemplate={props.onConvertToTemplate}
                          onArchiveTask={props.onArchiveTask}
                          onViewRuns={props.onViewRuns}
                          onContinueReviews={props.onContinueReviews}
                        />
                      ))}
                    </div>
                    <div class="done-group-cards-divider" />
                  </div>
                )}
              </KanbanColumn>

              {/* Floating Group Panel */}
              {column.status === 'backlog' && activeGroup() && (
                <GroupPanel
                  group={activeGroup()!}
                  tasks={activeGroupTasks()}
                  bonSummaries={props.bonSummaries}
                  getTaskRunColor={props.getTaskRunColor}
                  isTaskMutationLocked={props.isTaskMutationLocked}
                  isOpen={!!props.activeGroupId}
                  onClose={() => props.onCloseGroupPanel?.()}
                  onStartGroup={() => props.onStartGroup?.(activeGroup()!.id)}
                  onOpenTask={props.onOpenTask}
                  onDeployTemplate={props.onDeployTemplate}
                  onOpenTaskSessions={props.onOpenTaskSessions}
                  onApprovePlan={props.onApprovePlan}
                  onRequestRevision={props.onRequestRevision}
                  onStartSingle={props.onStartSingle}
                  onRepairTask={props.onRepairTask}
                  onMarkDone={props.onMarkDone}
                  onResetTask={props.onResetTask}
                  onConvertToTemplate={props.onConvertToTemplate}
                  onArchiveTask={props.onArchiveTask}
                  onViewRuns={props.onViewRuns}
                  onContinueReviews={props.onContinueReviews}
                  onDeleteGroup={() => props.onDeleteGroup?.(activeGroup()!.id)}
                  onRenameGroup={props.onRenameGroup}
                  dragDrop={props.dragDrop}
                  sessionUsage={props.sessionUsage}
                  taskLastUpdate={props.taskLastUpdate}
                  isMultiSelecting={props.isMultiSelecting}
                  getIsSelected={props.getIsSelected}
                  allTasks={props.tasks}
                  options={props.options}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
