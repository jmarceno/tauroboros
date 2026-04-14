<script setup lang="ts">
import type { Task, TaskStatus, BestOfNSummary } from '@/types/api'
import type { useDragDrop } from '@/composables/useDragDrop'
import TaskCard from './TaskCard.vue'

const props = withDefaults(defineProps<{
  status: TaskStatus
  title: string
  helpText: string
  iconSvg?: string
  iconColor?: string
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  dragDrop: ReturnType<typeof useDragDrop>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  currentSort?: string
  highlightedRunId?: string | null
  isTaskInRun?: (taskId: string, runId: string | null) => boolean
}>(), {
  tasks: () => [],
  isMultiSelecting: false,
  currentSort: 'manual',
  iconSvg: '',
  iconColor: 'text-dark-text',
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
  changeSort: [sort: string]
}>()

const canDrop = (status: string) => {
  // Only allow drop in manual sort mode
  if (status === 'backlog' && props.currentSort !== 'manual') return false
  return status === 'backlog' || status === 'review' || status === 'done'
}

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
  <div class="kanban-column" :data-status="status">
    <div class="kanban-column-header">
      <div class="kanban-column-title" :class="iconColor">
        <span v-if="iconSvg" class="w-4 h-4" v-html="iconSvg" />
        <span>{{ title }}</span>
        <button
          class="help-btn"
          :title="helpText"
          :aria-label="title + ' column help'"
        >
          ?
        </button>
      </div>
      <div class="flex items-center gap-2">
        <select
          :value="currentSort"
          class="text-xs bg-dark-input border border-dark-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
          @change="(e) => emit('changeSort', (e.target as HTMLSelectElement).value)"
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
          {{ tasks?.length ?? 0 }}
        </span>
      </div>
    </div>
    <div
      class="kanban-column-body"
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
        :can-drag="status === 'backlog' && !isTaskMutationLocked(task.id) && currentSort === 'manual'"
        :drag-drop="dragDrop"
        :is-selected="getIsSelected?.(task.id)"
        :is-multi-selecting="isMultiSelecting"
        :is-highlighted="isTaskInRun?.(task.id, highlightedRunId) ?? false"
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
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
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
        class="add-task-btn mt-auto"
        @click="emit('archiveAllDone')"
      >
        Archive All
      </button>
    </div>
  </div>
</template>
