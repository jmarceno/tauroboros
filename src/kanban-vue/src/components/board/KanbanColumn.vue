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
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  currentSort?: string
}>(), {
  tasks: () => [],
  isMultiSelecting: false,
  currentSort: 'manual'
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

const columnColors: Record<string, { bg: string; text: string; border: string }> = {
  template: { bg: 'bg-[rgba(80,80,120,0.2)]', text: 'text-[#a0a0d0]', border: 'border-[rgba(100,100,150,0.4)]' },
  backlog: { bg: 'bg-[rgba(150,120,60,0.2)]', text: 'text-[#d0b080]', border: 'border-[rgba(180,140,70,0.4)]' },
  executing: { bg: 'bg-[rgba(60,150,80,0.2)]', text: 'text-[#80d0a0]', border: 'border-[rgba(70,180,100,0.4)]' },
  review: { bg: 'bg-[rgba(140,80,140,0.2)]', text: 'text-[#d080d0]', border: 'border-[rgba(160,90,160,0.4)]' },
  done: { bg: 'bg-[rgba(60,140,160,0.2)]', text: 'text-[#80d0e0]', border: 'border-[rgba(70,160,180,0.4)]' },
}

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
  <div class="column min-w-[280px] sm:min-w-0" :data-status="status">
    <div
      class="column-header border-b flex-col sm:flex-row items-start sm:items-center gap-2"
      :class="[columnColors[status].bg, columnColors[status].text, columnColors[status].border]"
    >
      <div class="flex items-center gap-2 w-full sm:w-auto min-w-0">
        <span class="font-bold tracking-wider truncate sm:whitespace-normal">{{ title }}</span>
        <button
          class="help-btn flex-shrink-0"
          :title="helpText"
          :aria-label="title + ' column help'"
        >
          ?
        </button>
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
        <select
          :value="currentSort"
          class="text-xs bg-[#1a1a1a] border rounded px-1.5 py-0.5 cursor-pointer outline-none flex-shrink-0"
          :class="[columnColors[status].border, columnColors[status].text]"
          @change="(e) => emit('changeSort', (e.target as HTMLSelectElement).value)"
          title="Sort tasks"
        >
          <option value="manual" class="bg-[#1a1a1a]">Manual</option>
          <option value="name-asc" class="bg-[#1a1a1a]">Name ↑</option>
          <option value="name-desc" class="bg-[#1a1a1a]">Name ↓</option>
          <option value="created-asc" class="bg-[#1a1a1a]">Created ↑</option>
          <option value="created-desc" class="bg-[#1a1a1a]">Created ↓</option>
          <option value="updated-asc" class="bg-[#1a1a1a]">Updated ↑</option>
          <option value="updated-desc" class="bg-[#1a1a1a]">Updated ↓</option>
        </select>
        <span class="bg-[#1a1a1a] rounded-full px-2 py-0.5 text-xs border flex-shrink-0" :class="[columnColors[status].border, columnColors[status].text]">
          {{ tasks?.length ?? 0 }}
        </span>
      </div>
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
        :can-drag="status === 'backlog' && !isTaskMutationLocked(task.id) && currentSort === 'manual'"
        :drag-drop="dragDrop"
        :is-selected="getIsSelected?.(task.id)"
        :is-multi-selecting="isMultiSelecting"
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
