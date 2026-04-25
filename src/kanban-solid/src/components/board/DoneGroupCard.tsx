import { For, Show, createMemo, createSignal } from 'solid-js'
import type { TaskGroup, Task, BestOfNSummary } from '@/types'
import { TaskCard } from './TaskCard'
import type { createDragDropStore } from '@/stores'
import type { createSessionUsageStore } from '@/stores/sessionUsageStore'
import type { createTaskLastUpdateStore } from '@/stores/taskLastUpdateStore'
import type { Options } from '@/types'

interface DoneGroupCardProps {
  group: TaskGroup
  tasks: Task[]
  fullyCompleted: boolean
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof createDragDropStore>
  sessionUsage: ReturnType<typeof createSessionUsageStore>
  taskLastUpdate: ReturnType<typeof createTaskLastUpdateStore>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  allTasks: Task[]
  options?: Options | null
  onOpenTask: (id: string, e?: MouseEvent) => void
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
  onViewRuns: (id: string) => void
  onContinueReviews: (id: string) => void
}

export function DoneGroupCard(props: DoneGroupCardProps) {
  const groupColor = () => props.group.color || '#6366f1'

  const [collapsed, setCollapsed] = createSignal(true)

  const totalMembers = createMemo(() => {
    return props.allTasks.filter(t => t.groupId === props.group.id).length
  })

  const doneCount = createMemo(() => props.tasks.length)

  const progressLabel = createMemo(() => {
    if (props.fullyCompleted) {
      return `${doneCount()} task${doneCount() !== 1 ? 's' : ''} completed`
    }
    return `${doneCount()}/${totalMembers()} task${totalMembers() !== 1 ? 's' : ''} complete`
  })

  const toggleCollapse = (e: MouseEvent) => {
    e.stopPropagation()
    setCollapsed(c => !c)
  }

  return (
    <div
      class="done-group-card"
      data-group-color={props.group.color}
      classList={{ 'collapsed': collapsed() }}
      style={{
        'border-left-color': props.group.color,
        '--group-color': `${props.group.color}44`,
      }}
    >
      <div class="done-group-card-header" onClick={toggleCollapse} role="button" tabindex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(e as any) } }}>
        <svg
          class="done-group-card-chevron"
          classList={{ 'collapsed': collapsed() }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <Show when={props.fullyCompleted}>
          <svg class="done-group-card-icon text-accent-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </Show>
        <Show when={!props.fullyCompleted}>
          <svg class="done-group-card-icon text-accent-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </Show>
        <span class="done-group-card-title">{props.group.name}</span>
        <span class="done-group-card-badge">{progressLabel()}</span>
      </div>

      <Show when={!collapsed()}>
        <div class="done-group-card-tasks">
          <For each={props.tasks}>
            {(task) => (
              <TaskCard
                task={task}
                bonSummary={props.bonSummaries[task.id]}
                runColor={props.getTaskRunColor(task.id)}
                isLocked={props.isTaskMutationLocked(task.id)}
                canDrag={false}
                dragDrop={props.dragDrop}
                sessionUsage={props.sessionUsage}
                taskLastUpdate={props.taskLastUpdate}
                tasks={props.allTasks}
                options={props.options ?? undefined}
                isSelected={props.getIsSelected?.(task.id)}
                isMultiSelecting={props.isMultiSelecting}
                isHighlighted={false}
                group={{ id: props.group.id, name: props.group.name, color: groupColor() }}
                showGroupIndicator={false}
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
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
