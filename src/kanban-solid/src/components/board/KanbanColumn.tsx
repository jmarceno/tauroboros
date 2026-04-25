/**
 * KanbanColumn Component - Individual kanban column
 * Ported from React to SolidJS - Full feature parity
 */

import { For, Show, createMemo } from 'solid-js'
import type { Task, TaskStatus, BestOfNSummary, ColumnSortOption, TaskGroup } from '@/types'
import { TaskCard } from './TaskCard'
import { HelpButton } from '@/components/common/HelpButton'
import type { createDragDropStore } from '@/stores'
import type { createSessionUsageStore } from '@/stores/sessionUsageStore'
import type { createTaskLastUpdateStore } from '@/stores/taskLastUpdateStore'
import type { Options } from '@/types'

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
  dragDrop: ReturnType<typeof createDragDropStore>
  sessionUsage: ReturnType<typeof createSessionUsageStore>
  taskLastUpdate: ReturnType<typeof createTaskLastUpdateStore>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  currentSort: ColumnSortOption
  highlightedRunId?: string | null
  isTaskInRun?: (taskId: string, runId: string | null) => boolean
  groups?: TaskGroup[]
  allTasks: Task[]
  options?: Options | null
  footerContent?: JSX.Element
  onOpenTask: (id: string, e?: MouseEvent) => void
  onChangeSort: (sort: ColumnSortOption) => void
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
  children?: JSX.Element
}

export function KanbanColumn(props: KanbanColumnProps) {
  const isDragOver = createMemo(() => props.dragDrop.dragOverTarget() === props.status)

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    props.dragDrop.handleDragOver(props.status)
  }

  const handleDragLeave = () => {
    props.dragDrop.handleDragLeave()
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    const sourceContext = props.dragDrop.dragSourceContext()
    const action = sourceContext === 'group' ? 'remove-from-group' : 'move-to-status'
    props.dragDrop.handleDrop(props.status, action)
  }

  const taskCount = createMemo(() => props.tasks.length)

  // Group map for looking up task groups
  const groupMap = createMemo(() => {
    const groups = props.groups || []
    return new Map(groups.map(g => [g.id, g]))
  })

  return (
    <div
      class="kanban-column"
      classList={{ 'drag-over': isDragOver() }}
      data-status={props.status}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div class="kanban-column-header">
        <div class={`kanban-column-title ${props.iconColor}`}>
          <span innerHTML={props.iconSvg} />
          <span>{props.title}</span>
          <HelpButton tooltip={props.helpText} aria-label={`${props.title} column help`} />
        </div>
        <div class="flex items-center gap-2">
          <select
            class="text-xs bg-dark-input border border-dark-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
            value={props.currentSort}
            onChange={(e) => props.onChangeSort(e.currentTarget.value as ColumnSortOption)}
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
          <span class="kanban-column-count">
            {taskCount()}
          </span>
        </div>
      </div>

      <div class="kanban-column-body">
        {props.children}

        <For each={props.tasks}>
          {(task) => {
            const taskGroup = task.groupId ? groupMap().get(task.groupId) : undefined
            return (
              <TaskCard
                task={task}
                runColor={props.getTaskRunColor(task.id)}
                isLocked={props.isTaskMutationLocked(task.id)}
                canDrag={(props.status === 'backlog' || props.status === 'code-style') && !props.isTaskMutationLocked(task.id) && props.currentSort === 'manual'}
                isSelected={props.getIsSelected?.(task.id)}
                isMultiSelecting={props.isMultiSelecting}
                bonSummary={props.bonSummaries[task.id]}
                isHighlighted={props.highlightedRunId ? props.isTaskInRun?.(task.id, props.highlightedRunId) : false}
                group={taskGroup ? { id: taskGroup.id, name: taskGroup.name, color: taskGroup.color } : undefined}
                showGroupIndicator={!!taskGroup}
                dragDrop={props.dragDrop}
                sessionUsage={props.sessionUsage}
                taskLastUpdate={props.taskLastUpdate}
                tasks={props.allTasks}
                options={props.options}
                onOpen={(e) => props.onOpenTask(task.id, e)}
                onDeploy={(e) => props.onDeployTemplate(task.id, e)}
                onOpenTaskSessions={() => props.onOpenTaskSessions(task.id)}
                onApprovePlan={() => props.onApprovePlan(task.id)}
                onRequestRevision={() => props.onRequestRevision(task.id)}
                onStartSingle={() => props.onStartSingle(task.id)}
                onRepair={(action) => props.onRepairTask(task.id, action)}
                onMarkDone={() => props.onMarkDone(task.id)}
                onReset={() => props.onResetTask(task.id)}
                onConvertToTemplate={(e) => props.onConvertToTemplate(task.id, e)}
                onArchive={(e) => props.onArchiveTask(task.id, e)}
                onViewRuns={() => props.onViewRuns(task.id)}
                onContinueReviews={() => props.onContinueReviews(task.id)}
              />
            )
          }}
        </For>

        <Show when={props.footerContent}>
          <div class="mt-auto">
            {props.footerContent}
          </div>
        </Show>

        {/* Add buttons at the end */}
        <Show when={props.status === 'template'}>
          <button
            class="add-task-btn flex items-center justify-center gap-2"
            onClick={props.onOpenTemplateModal}
            title="Add Template"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Add Template
          </button>
        </Show>

        <Show when={props.status === 'backlog'}>
          <button class="add-task-btn" onClick={props.onOpenTaskModal}>
            + Add Task
          </button>
        </Show>

        <Show when={props.status === 'done' && taskCount() > 0}>
          <button class="add-task-btn mt-auto" onClick={props.onArchiveAllDone}>
            Archive All
          </button>
        </Show>
      </div>
    </div>
  )
}
