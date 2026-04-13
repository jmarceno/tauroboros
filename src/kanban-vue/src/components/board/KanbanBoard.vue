<script setup lang="ts">
import type { Task, TaskStatus, BestOfNSummary } from '@/types/api'
import type { useDragDrop } from '@/composables/useDragDrop'
import KanbanColumn from './KanbanColumn.vue'

import { computed, type Ref, toValue } from 'vue'

const props = defineProps<{
  tasks: Task[] | Ref<Task[]>
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

// Computed property for all grouped tasks - ensures proper reactivity
const groupedTasks = computed(() => {
  // Use toValue to unwrap ref if needed, or use the array directly
  const taskArray = toValue(props.tasks)
  
  if (!taskArray || !Array.isArray(taskArray)) {
    return {
      template: [],
      backlog: [],
      executing: [],
      review: [],
      done: [],
    } as Record<TaskStatus, Task[]>
  }

  const groups: Record<TaskStatus, Task[]> = {
    template: [],
    backlog: [],
    executing: [],
    review: [],
    done: [],
  }

  for (const task of taskArray) {
    if (!task) continue
    if (task.status === 'failed' || task.status === 'stuck') {
      groups.review.push(task)
    } else if (task.status && task.status in groups) {
      groups[task.status as TaskStatus].push(task)
    }
  }

  return groups
})

// Helper to get tasks for a specific status from the computed groups
const getTasksForStatus = (status: TaskStatus): Task[] => {
  return groupedTasks.value[status] || []
}

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

const columnIcons: Record<string, string> = {
  template: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
  backlog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>`,
  executing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  review: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`,
  done: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
}

const columnColors: Record<string, string> = {
  template: 'text-column-template',
  backlog: 'text-column-backlog',
  executing: 'text-column-executing',
  review: 'text-column-review',
  done: 'text-column-done',
}
</script>

<template>
  <div class="kanban-wrapper">
    <div class="kanban-scroll">
      <div class="kanban-container">
        <KanbanColumn
          v-for="column in columns"
          :key="`${column.status}-${getTasksForStatus(column.status).length}`"
          :status="column.status"
          :title="column.title"
          :help-text="columnHelpText[column.status]"
          :icon-svg="columnIcons[column.status]"
          :icon-color="columnColors[column.status]"
          :tasks="getTasksForStatus(column.status)"
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
    </div>
  </div>
</template>
