<script setup lang="ts">
import { ref, computed, inject } from 'vue'
import type { Task, BestOfNSummary } from '@/types/api'
import type { useDragDrop } from '@/composables/useDragDrop'
import type { useOptions } from '@/composables/useOptions'
import type { useTasks } from '@/composables/useTasks'
import type { useSessionUsage } from '@/composables/useSessionUsage'

const props = defineProps<{
  task: Task
  bonSummary?: BestOfNSummary
  runColor: string | null
  isLocked: boolean
  canDrag: boolean
  dragDrop: ReturnType<typeof useDragDrop>
  isSelected?: boolean
  isMultiSelecting?: boolean
}>()

const multiSelect = inject<ReturnType<typeof import('@/composables/useMultiSelect').useMultiSelect>>('multiSelect')

const emit = defineEmits<{
  open: []
  deploy: []
  openSession: []
  approvePlan: []
  requestRevision: []
  startSingle: []
  repair: [action: string]
  markDone: []
  reset: []
  convertToTemplate: []
  archive: []
  viewRuns: []
  continueReviews: []
  toggleSelection: [event: MouseEvent]
}>()

const options = inject<ReturnType<typeof useOptions>>('options')!
const sessionUsage = inject<ReturnType<typeof useSessionUsage>>('sessionUsage')
const tasksComposable = inject<ReturnType<typeof useTasks>>('tasks')!

const showOutput = ref(false)

const hasLocalSession = computed(() =>
  !!props.task.sessionId &&
  props.task.status !== 'backlog' &&
  props.task.status !== 'template'
)

const isAnomalousReviewTask = computed(() =>
  props.task.status === 'review' &&
  !props.task.awaitingPlanApproval &&
  props.task.executionStrategy !== 'best_of_n' &&
  !!(props.task.agentOutput?.trim())
)

const isOrphanExecutingTask = computed(() =>
  !props.isLocked && props.task.status === 'executing'
)

const canSendToExecution = computed(() =>
  props.task.planmode === true &&
  hasPlanOutput.value &&
  props.task.executionPhase !== 'implementation_done' &&
  (props.task.status === 'review' || props.task.status === 'executing' || props.task.status === 'failed' || props.task.status === 'stuck')
)

const canRepairToDone = computed(() =>
  props.task.status !== 'done' &&
  props.task.executionStrategy !== 'best_of_n' &&
  props.task.awaitingPlanApproval !== true &&
  !!(props.task.agentOutput?.trim())
)

const hasPlanOutput = computed(() =>
  /\[plan\]\s*[\s\S]*?(?=\n\[[a-z0-9-]+\]|$)/.test(props.task.agentOutput || '')
)

const showInlineActionBar = computed(() =>
  !props.isLocked &&
  (props.task.status === 'review' || props.task.status === 'executing' || props.task.status === 'failed' || props.task.status === 'stuck')
)

const effectiveMaxReviews = computed(() =>
  props.task.maxReviewRunsOverride ?? options.options?.maxReviews ?? 2
)

const isNearReviewLimit = computed(() =>
  props.task.reviewCount >= effectiveMaxReviews.value - 1
)

const isAtReviewLimit = computed(() =>
  props.task.reviewCount >= effectiveMaxReviews.value
)

const depIds = computed(() => {
  const allTasks = tasksComposable.tasks.value
  return (props.task.requirements || [])
    .map(id => allTasks.find(t => t.id === id))
    .filter((dep): dep is Task => dep !== undefined && typeof dep.idx === 'number')
    .map(dep => `#${dep.idx + 1}`)
})

const bonTotalWorkers = computed(() =>
  props.task.bestOfNConfig?.workers?.reduce((sum, w) => sum + w.count, 0) ?? 0
)

const bonTotalReviewers = computed(() =>
  props.task.bestOfNConfig?.reviewers?.reduce((sum, r) => sum + r.count, 0) ?? 0
)

const taskCost = computed(() => {
  if (!props.task.sessionId || !sessionUsage) return null
  const usage = sessionUsage.getCachedUsage(props.task.sessionId)
  if (!usage || usage.totalCost === 0) return null
  return {
    cost: usage.totalCost,
    tokens: usage.totalTokens,
    formattedCost: sessionUsage.formatCost(usage.totalCost),
    formattedTokens: sessionUsage.formatTokenCount(usage.totalTokens),
  }
})

const handleDragStart = (e: DragEvent) => {
  if (!props.canDrag) return
  props.dragDrop.handleDragStart(props.task.id)
  ;(e.target as HTMLElement).classList.add('dragging')
  e.dataTransfer!.effectAllowed = 'move'
}

const handleDragEnd = (e: DragEvent) => {
  props.dragDrop.handleDragEnd()
  ;(e.target as HTMLElement).classList.remove('dragging')
}

const bestOfNStageMap: Record<string, string> = {
  workers_running: 'workers running',
  reviewers_running: 'reviewers running',
  final_apply_running: 'final apply',
  blocked_for_manual_review: 'manual review',
  completed: 'completed',
}

const hasNonDefaultThinkingLevel = computed(() => {
  return props.task.thinkingLevel !== 'default' ||
    props.task.planThinkingLevel !== 'default' ||
    props.task.executionThinkingLevel !== 'default'
})

const thinkingLevelSummary = computed(() => {
  const levels: string[] = []
  if (props.task.thinkingLevel !== 'default') levels.push(props.task.thinkingLevel)
  if (props.task.planThinkingLevel !== 'default') levels.push(`plan:${props.task.planThinkingLevel}`)
  if (props.task.executionThinkingLevel !== 'default') levels.push(`exec:${props.task.executionThinkingLevel}`)
  return levels.join(', ') || 'default'
})

const thinkingLevelTooltip = computed(() => {
  const parts: string[] = []
  parts.push(`Global: ${props.task.thinkingLevel}`)
  parts.push(`Plan: ${props.task.planThinkingLevel}`)
  parts.push(`Execution: ${props.task.executionThinkingLevel}`)
  return parts.join('\n')
})

// Status color for the task indicator
const statusColor = computed(() => {
  switch (props.task.status) {
    case 'stuck':
    case 'failed':
      return 'high'
    case 'review':
      return 'medium'
    default:
      return 'low'
  }
})
</script>

<template>
  <div
    :class="['task-card', { dragging: isSelected }]"
    :data-task-id="task.id"
    :data-task-status="task.status"
    :style="runColor ? { borderLeft: `3px solid ${runColor}` } : undefined"
    :draggable="canDrag && !isMultiSelecting"
    @dragstart="handleDragStart"
    @dragend="handleDragEnd"
    @click="(e) => {
      if (multiSelect?.toggleSelection(task.id, e)) {
        e.stopPropagation()
      }
    }"
  >
    <!-- Header -->
    <div class="task-header">
      <svg
        v-if="task.status === 'executing'"
        class="task-icon animate-spin text-accent-success"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20" />
      </svg>
      <svg
        v-else-if="task.status === 'template'"
        class="task-icon text-column-template"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
      <svg
        v-else-if="task.status === 'backlog'"
        class="task-icon text-column-backlog"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
      </svg>
      <svg
        v-else-if="task.status === 'review'"
        class="task-icon text-column-review"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
        <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
      </svg>
      <svg
        v-else-if="task.status === 'done'"
        class="task-icon text-column-done"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <svg
        v-else-if="task.status === 'stuck' || task.status === 'failed'"
        class="task-icon text-accent-danger"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 8v4M12 16h.01"/>
      </svg>
      <span
        :class="['task-title', { 'cursor-pointer hover:text-accent-primary': hasLocalSession }]"
        :title="task.name"
        @click="hasLocalSession ? emit('openSession') : undefined"
      >
        {{ task.name }}
      </span>
    </div>

    <!-- Tags -->
    <div class="task-tags mb-2">
      <span v-if="task.planmode" class="task-tag border-accent-secondary/30 text-accent-secondary">
        plan
      </span>
      <span
        v-if="task.status === 'review' && task.awaitingPlanApproval"
        class="task-tag border-accent-warning/30 text-accent-warning"
      >
        plan approval
      </span>
      <span
        v-if="task.review"
        :class="[
          'task-tag',
          (task.status === 'stuck' || isAtReviewLimit) ? 'border-accent-danger/30 text-accent-danger' :
          isNearReviewLimit ? 'border-accent-warning/30 text-accent-warning' :
          'border-accent-warning/30 text-accent-warning'
        ]"
      >
        review {{ task.reviewCount }}/{{ effectiveMaxReviews }}
      </span>
      <span
        v-if="task.executionStrategy === 'best_of_n'"
        class="task-tag border-accent-info/30 text-accent-info"
      >
        best-of-n
      </span>
      <span v-if="depIds.length > 0" class="task-tag">
        deps: {{ depIds.join(', ') }}
      </span>
      <span
        v-if="hasNonDefaultThinkingLevel"
        class="task-tag"
        :title="thinkingLevelTooltip"
      >
        {{ thinkingLevelSummary }}
      </span>
      <span v-if="task.branch" class="task-tag">
        {{ task.branch }}
      </span>
      <span
        v-if="task.errorMessage"
        class="task-tag border-accent-danger/30 text-accent-danger"
      >
        error
      </span>
    </div>

    <!-- Actions -->
    <div class="task-footer">
      <div class="flex items-center gap-1">
        <button
          class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-dark-text transition-colors"
          :title="task.status === 'template' ? 'Edit Template' : 'Edit Task'"
          @click="emit('open')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
          </svg>
        </button>

        <button
          v-if="task.status === 'template'"
          class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-primary transition-colors"
          title="Deploy to Backlog"
          @click="emit('deploy')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 10l7-7m0 0l7 7m-7-7v18"/>
          </svg>
        </button>

        <button
          v-if="!showInlineActionBar && !isLocked && (task.status === 'stuck' || task.status === 'failed' || task.status === 'done' || task.status === 'review')"
          class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-warning transition-colors"
          title="Reset to Backlog"
          @click="emit('reset')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>

        <button
          v-if="!showInlineActionBar && (((!isLocked && task.status !== 'executing')) || task.status === 'done')"
          class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-danger transition-colors"
          title="Archive Task"
          @click="emit('archive')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>

        <button
          v-if="task.status === 'stuck' || (!isLocked && isAnomalousReviewTask)"
          class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
          title="Mark as Done"
          @click="emit('markDone')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 13l4 4L19 7"/>
          </svg>
        </button>

        <button
          v-if="task.status === 'backlog' && !isLocked"
          class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
          title="Start this task"
          @click="emit('startSingle')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        </button>

        <button
          v-if="task.status === 'backlog' && !isLocked"
          class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-primary transition-colors"
          title="Convert to Template"
          @click="emit('convertToTemplate')"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </button>
      </div>

      <!-- Status Indicator -->
      <div :class="['task-indicator', statusColor]" />
    </div>

    <!-- Inline Action Bar -->
    <div v-if="showInlineActionBar" class="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-dark-border">
      <template v-if="task.status === 'review' && task.awaitingPlanApproval && task.executionPhase === 'plan_complete_waiting_approval' && hasPlanOutput">
        <button class="btn btn-primary btn-xs" @click="emit('approvePlan')">
          Approve Plan
        </button>
        <button class="btn btn-xs border-accent-warning/50 text-accent-warning" @click="emit('requestRevision')">
          Request Changes
        </button>
      </template>

      <button
        v-if="task.status === 'review' && isAnomalousReviewTask"
        class="btn btn-primary btn-xs"
        @click="emit('markDone')"
      >
        Mark Done
      </button>

      <button
        v-if="canSendToExecution"
        class="btn btn-primary btn-xs"
        @click="emit('repair', 'queue_implementation')"
      >
        Send to Execution
      </button>

      <button
        v-if="canRepairToDone && task.status !== 'stuck'"
        class="btn btn-xs"
        @click="emit('repair', 'mark_done')"
      >
        Repair Done
      </button>

      <button class="btn btn-xs" @click="emit('repair', 'smart')">
        Smart Repair
      </button>

      <template v-if="task.status === 'stuck'">
        <button
          class="btn btn-primary btn-xs"
          @click="emit('continueReviews')"
        >
          Continue Reviews
        </button>
      </template>
    </div>

    <!-- View Runs button for best-of-n -->
    <button
      v-if="task.executionStrategy === 'best_of_n' && task.status !== 'template' && task.status !== 'backlog'"
      class="btn btn-xs mt-2"
      @click="emit('viewRuns')"
    >
      View Runs
    </button>

    <!-- Collapsible output -->
    <div v-if="task.agentOutput && (task.status === 'executing' || task.status === 'review' || task.status === 'done' || task.status === 'stuck' || task.status === 'failed')">
      <button
        class="text-accent-primary text-xs bg-transparent border-0 cursor-pointer py-1 hover:underline flex items-center gap-1"
        @click="showOutput = !showOutput"
      >
        <svg v-if="showOutput" class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
        <svg v-else class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 5l7 7-7 7"/>
        </svg>
        Agent Output
      </button>
      <div
        v-if="showOutput"
        class="text-xs text-dark-text-secondary bg-dark-bg rounded p-2 mt-1.5 max-h-52 overflow-y-auto whitespace-pre-wrap break-words border border-dark-border"
      >
        {{ task.agentOutput.slice(-5000) }}
      </div>
    </div>

    <!-- Cost badge -->
    <div v-if="taskCost" class="flex items-center gap-2 mt-1 text-xs">
      <span 
        class="px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded-full text-dark-text-secondary flex items-center gap-1"
        :title="`${taskCost.formattedTokens} tokens`"
      >
        💰 {{ taskCost.formattedCost }}
      </span>
    </div>

    <!-- Completed date -->
    <div v-if="task.completedAt" class="text-xs text-dark-text-muted mt-1">
      Completed: {{ new Date(task.completedAt * 1000).toLocaleString() }}
    </div>

    <!-- Warnings -->
    <div
      v-if="task.status === 'review' && task.awaitingPlanApproval && task.executionPhase === 'plan_complete_waiting_approval' && !hasPlanOutput"
      class="text-xs text-accent-danger mt-2"
    >
      Plan approval is unavailable - no [plan] block exists
    </div>

    <div
      v-if="isOrphanExecutingTask"
      class="text-xs text-accent-danger mt-2"
    >
      Session may have dropped - click title to verify
    </div>
  </div>
</template>
