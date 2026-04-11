<script setup lang="ts">
import type { Task, TaskStatus, BestOfNSummary } from '@/types/api'
import type { useDragDrop } from '@/composables/useDragDrop'
import KanbanColumn from './KanbanColumn.vue'

const props = defineProps<{
  groupedTasks: Record<TaskStatus | 'failed' | 'stuck', Task[]>
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof useDragDrop>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  columnSorts?: Record<string, string>
}>()

const emit = defineEmits<{
  openTask: [id: string]
  openTemplateModal: []
  openTaskModal: []
  deployTemplate: [id: string]
  openSession: [id: string]
  approvePlan: [id: string]
  requestRevision: [id: string]
  startSingle: [id: string]
  repairTask: [id: string, action: string]
  markDone: [id: string]
  resetTask: [id: string]
  convertToTemplate: [id: string]
  archiveTask: [id: string]
  archiveAllDone: []
  viewRuns: [id: string]
  continueReviews: [id: string]
  changeColumnSort: [status: string, sort: string]
}>()

const columns: { status: TaskStatus; title: string }[] = [
  { status: 'template', title: 'Templates' },
  { status: 'backlog', title: 'Backlog' },
  { status: 'executing', title: 'Executing' },
  { status: 'review', title: 'Review' },
  { status: 'done', title: 'Done' },
]

const columnHelpText: Record<string, string> = {
  template: 'Reusable task blueprints. Keep common prompts and settings here, then deploy them into the backlog when you need a new task.',
  backlog: 'Ready-to-run tasks waiting for execution. Add, edit, reorder, and set dependencies here before starting work.',
  executing: 'Tasks currently being worked on by the agent. Use this column to monitor active runs and open their live sessions.',
  review: 'Tasks that need human attention. Review outputs here, approve plans, or inspect stuck and failed work before deciding the next step.',
  done: 'Completed tasks. Use this column as the final state once the work and any needed review are finished.',
}
</script>

<template>
  <div class="flex-1 grid grid-cols-5 gap-3 p-4 min-h-0 min-w-0 max-w-full overflow-x-auto overflow-y-hidden">
    <KanbanColumn
      v-for="column in columns"
      :key="column.status"
      :status="column.status"
      :title="column.title"
      :help-text="columnHelpText[column.status]"
      :tasks="groupedTasks?.[column.status] ?? []"
      :bon-summaries="bonSummaries"
      :get-task-run-color="getTaskRunColor"
      :is-task-mutation-locked="isTaskMutationLocked"
      :drag-drop="dragDrop"
      :is-multi-selecting="isMultiSelecting"
      :get-is-selected="getIsSelected"
      :current-sort="columnSorts?.[column.status] || 'manual'"
      @open-task="(id) => emit('openTask', id)"
      @change-sort="(sort) => emit('changeColumnSort', column.status, sort)"
      @open-template-modal="emit('openTemplateModal')"
      @open-task-modal="emit('openTaskModal')"
      @deploy-template="(id) => emit('deployTemplate', id)"
      @open-session="(id) => emit('openSession', id)"
      @approve-plan="(id) => emit('approvePlan', id)"
      @request-revision="(id) => emit('requestRevision', id)"
      @start-single="(id) => emit('startSingle', id)"
      @repair-task="(id, action) => emit('repairTask', id, action)"
      @mark-done="(id) => emit('markDone', id)"
      @reset-task="(id) => emit('resetTask', id)"
      @convert-to-template="(id) => emit('convertToTemplate', id)"
      @archive-task="(id) => emit('archiveTask', id)"
      @archive-all-done="emit('archiveAllDone')"
      @view-runs="(id) => emit('viewRuns', id)"
      @continue-reviews="(id) => emit('continueReviews', id)"
    />
  </div>
</template>
