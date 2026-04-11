<script setup lang="ts">
import type { Task, TaskStatus, BestOfNSummary } from '@/types/api'
import type { useDragDrop } from '@/composables/useDragDrop'
import TaskCard from './TaskCard.vue'

const props = withDefaults(defineProps<{
  status: TaskStatus
  title: string
  helpText: string
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof useDragDrop>
}>(), {
  tasks: () => []
})

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
}>()

const columnColors: Record<string, { bg: string; text: string }> = {
  template: { bg: 'bg-indigo-500/15', text: 'text-indigo-400' },
  backlog: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  executing: { bg: 'bg-green-500/15', text: 'text-green-400' },
  review: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  done: { bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
}

const canDrop = (status: string) => status === 'backlog' || status === 'review' || status === 'done'

const handleDragOver = (e: DragEvent) => {
  if (!canDrop(props.status)) return
  e.preventDefault()
  props.dragDrop.handleDragOver(props.status, e)
}

const handleDragLeave = () => {
  if (!canDrop(props.status)) return
  props.dragDrop.handleDragLeave()
}

const handleDrop = (e: DragEvent) => {
  if (!canDrop(props.status)) return
  e.preventDefault()
  props.dragDrop.handleDrop(props.status, e)
}
</script>

<template>
  <div class="column" :data-status="status">
    <div
      class="column-header"
      :class="[columnColors[status].bg, columnColors[status].text]"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span>{{ title }}</span>
        <button
          class="help-btn"
          :title="helpText"
          aria-label="{{ title }} column help"
        >
          ?
        </button>
      </div>
      <span class="bg-dark-surface rounded-full px-2 py-0.5 text-xs">
        {{ tasks?.length ?? 0 }}
      </span>
    </div>
    <div
      class="column-body"
      :class="{ 'drag-over': dragDrop.dragOverStatus.value === status }"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <TaskCard
        v-for="task in (tasks || [])"
        :key="task.id"
        :task="task"
        :bon-summary="bonSummaries[task.id]"
        :run-color="getTaskRunColor(task.id)"
        :is-locked="isTaskMutationLocked(task.id)"
        :can-drag="status === 'backlog' && !isTaskMutationLocked(task.id)"
        :drag-drop="dragDrop"
        @open="() => emit('openTask', task.id)"
        @deploy="() => emit('deployTemplate', task.id)"
        @open-session="() => emit('openSession', task.sessionId!)"
        @approve-plan="() => emit('approvePlan', task.id)"
        @request-revision="() => emit('requestRevision', task.id)"
        @start-single="() => emit('startSingle', task.id)"
        @repair="(action) => emit('repairTask', task.id, action)"
        @mark-done="() => emit('markDone', task.id)"
        @reset="() => emit('resetTask', task.id)"
        @convert-to-template="() => emit('convertToTemplate', task.id)"
        @archive="() => emit('archiveTask', task.id)"
        @view-runs="() => emit('viewRuns', task.id)"
        @continue-reviews="() => emit('continueReviews', task.id)"
      />

      <!-- Add buttons -->
      <button
        v-if="status === 'template'"
        class="add-task-btn flex items-center justify-center gap-2"
        @click="emit('openTemplateModal')"
        title="Add Template"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        Add Template
      </button>
      <button
        v-if="status === 'backlog'"
        class="add-task-btn"
        @click="emit('openTaskModal')"
      >
        + Add Task
      </button>
      <button
        v-if="status === 'done' && (tasks?.length ?? 0) > 0"
        class="archive-all-btn"
        @click="emit('archiveAllDone')"
      >
        Archive All
      </button>
    </div>
  </div>
</template>
