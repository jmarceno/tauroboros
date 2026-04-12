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
  const allTasks = inject<ReturnType<typeof useTasks>>('tasks')!.tasks.value
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

// Get cost for this task's session if available
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
  ;(e.target as HTMLElement).classList.add('opacity-50')
  e.dataTransfer!.effectAllowed = 'move'
}

const handleDragEnd = (e: DragEvent) => {
  props.dragDrop.handleDragEnd()
  ;(e.target as HTMLElement).classList.remove('opacity-50')
}

const bestOfNStageMap: Record<string, string> = {
  workers_running: 'workers running',
  reviewers_running: 'reviewers running',
  final_apply_running: 'final apply',
  blocked_for_manual_review: 'manual review',
  completed: 'completed',
}

// Thinking level display helpers
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
</script>

<template>
  <div
    class="card"
    :class="{
      'ring-2 ring-accent-primary ring-offset-1 ring-offset-dark-surface': isSelected,
      'opacity-80': isMultiSelecting && !isSelected
    }"
    :style="runColor ? { borderLeft: `3px solid ${runColor}`, paddingLeft: '9px' } : undefined"
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
    <div class="flex items-center gap-2 mb-1 min-w-0">
      <span
        v-if="task.status === 'executing'"
        class="spinner flex-shrink-0"
      />
      <template v-if="task.status === 'review' && task.reviewActivity === 'running'">
        <span class="text-xs text-accent-success flex-shrink-0">reviewing</span>
        <span class="spinner flex-shrink-0" />
      </template>

      <span
        class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold block"
        :class="{ 'text-dark-text cursor-pointer hover:underline': hasLocalSession }"
        :title="task.name"
        @click="hasLocalSession ? emit('openSession') : undefined"
      >
        {{ task.name }}
      </span>

      <span class="text-xs bg-dark-surface2/80 rounded px-1.5 py-0.5 text-dark-text-muted flex-shrink-0 border border-dark-surface3">
        #{{ task.idx + 1 }}
      </span>

      <span v-if="task.status === 'stuck'" class="text-accent-danger flex-shrink-0 text-sm">
        ⚠
      </span>
    </div>

    <!-- Actions -->
    <div class="flex gap-1 justify-end mb-2">
      <button
        class="bg-transparent border-0 text-dark-text-muted cursor-pointer text-base px-1.5 py-1 rounded hover:text-dark-text hover:bg-dark-surface"
        :title="task.status === 'template' ? 'Edit Template' : (task.status === 'backlog' ? 'Edit Task' : 'View Task')"
        @click="emit('open')"
      >
        ✏
      </button>

      <button
        v-if="task.status === 'template'"
        class="bg-transparent border-0 text-dark-text-muted cursor-pointer text-xs px-2 py-1 rounded border border-dark-surface3 bg-dark-surface hover:border-accent-primary hover:text-accent-primary"
        title="Deploy to Backlog"
        @click="emit('deploy')"
      >
        Deploy
      </button>

      <button
        v-if="!showInlineActionBar && !isLocked && (task.status === 'stuck' || task.status === 'failed' || task.status === 'done' || task.status === 'review')"
        class="bg-transparent border-0 text-dark-text-muted cursor-pointer text-base px-1.5 py-1 rounded hover:text-dark-text hover:bg-dark-surface"
        title="Reset to Backlog"
        @click="emit('reset')"
      >
        ↻
      </button>

      <button
        v-if="!showInlineActionBar && (((!isLocked && task.status !== 'executing')) || task.status === 'done')"
        class="bg-transparent border-0 text-dark-text-muted cursor-pointer text-base px-1.5 py-1 rounded hover:text-dark-text hover:bg-dark-surface"
        title="Archive Task"
        @click="emit('archive')"
      >
        ✕
      </button>

      <button
        v-if="task.status === 'stuck'"
        class="bg-transparent border-0 text-green-400 cursor-pointer text-base px-1.5 py-1 rounded hover:text-green-300"
        title="Mark as Done"
        @click="emit('markDone')"
      >
        ✓
      </button>

      <button
        v-if="!isLocked && isAnomalousReviewTask"
        class="bg-transparent border-0 text-green-400 cursor-pointer text-base px-1.5 py-1 rounded hover:text-green-300"
        title="Mark as Done"
        @click="emit('markDone')"
      >
        ✓
      </button>

      <button
        v-if="task.status === 'backlog' && !isLocked"
        class="bg-transparent border-0 text-green-400 cursor-pointer text-base px-1.5 py-1 rounded hover:text-green-300"
        title="Start this task and its dependencies"
        @click="emit('startSingle')"
      >
        ▶
      </button>

      <button
        v-if="task.status === 'backlog' && !isLocked"
        class="bg-transparent border-0 text-dark-text-muted cursor-pointer text-xs px-2 py-1 rounded border border-dark-surface3 bg-dark-surface hover:border-accent-primary hover:text-accent-primary"
        title="Convert to Template"
        @click="emit('convertToTemplate')"
      >
        📖
      </button>
    </div>

    <!-- Meta badges -->
    <div class="flex flex-wrap gap-1 mb-2">
      <span v-if="task.planmode" class="badge bg-purple-500/15 text-purple-400">
        plan
      </span>

      <span
        v-if="task.status === 'review' && task.awaitingPlanApproval && task.executionPhase === 'plan_complete_waiting_approval'"
        class="badge bg-amber-500/15 text-amber-400"
      >
        plan approval pending
      </span>

      <span v-if="task.planRevisionCount > 0" class="badge bg-amber-500/15 text-amber-400">
        revision {{ task.planRevisionCount }}
      </span>

      <span v-if="task.status === 'template'" class="badge bg-accent-primary/15 text-accent-primary">
        template
      </span>

      <span
        v-if="task.review"
        :class="[
          'badge',
          (task.status === 'stuck' || isAtReviewLimit) ? 'bg-red-400/15 text-red-400' :
          isNearReviewLimit ? 'bg-amber-500/15 text-amber-400' :
          'bg-amber-500/15 text-amber-400'
        ]"
      >
        review {{ task.reviewCount }}/{{ effectiveMaxReviews }}
      </span>

      <span
        v-if="task.status === 'review' && task.reviewActivity === 'idle' && !task.awaitingPlanApproval"
        class="badge bg-purple-500/15 text-purple-400"
      >
        waiting for human
      </span>

      <span v-if="depIds.length > 0" class="badge bg-accent-primary/15 text-accent-primary">
        deps: {{ depIds.join(', ') }}
      </span>

      <span v-if="task.errorMessage" class="badge bg-red-400/15 text-red-400">
        error
      </span>

      <span v-if="task.branch" class="badge">
        branch: {{ task.branch }}
      </span>

      <span v-if="hasNonDefaultThinkingLevel" class="badge" :title="thinkingLevelTooltip">
        thinking: {{ thinkingLevelSummary }}
      </span>

      <span v-if="task.deleteWorktree === false" class="badge">
        keep worktree
      </span>

      <span v-if="task.executionStrategy === 'best_of_n'" class="badge bg-orange-500/15 text-orange-400">
        best-of-n
      </span>

      <span
        v-if="task.executionStrategy === 'best_of_n' && task.bestOfNSubstage && task.bestOfNSubstage !== 'idle'"
        :class="[
          'badge',
          task.bestOfNSubstage === 'completed' ? 'bg-green-500/15 text-green-400' : 'bg-cyan-500/15 text-cyan-400'
        ]"
      >
        {{ bestOfNStageMap[task.bestOfNSubstage] || task.bestOfNSubstage }}
      </span>

      <template v-if="task.executionStrategy === 'best_of_n'">
        <template v-if="bonSummary">
          <span class="badge bg-cyan-500/15 text-cyan-400">
            workers {{ bonSummary.workersDone }}/{{ bonSummary.workersTotal }}
          </span>
          <span class="badge bg-purple-500/15 text-purple-400">
            reviewers {{ bonSummary.reviewersDone }}/{{ bonSummary.reviewersTotal }}
          </span>
        </template>
        <template v-else-if="task.bestOfNConfig">
          <span v-if="bonTotalWorkers > 0" class="badge bg-cyan-500/15 text-cyan-400">
            workers {{ bonTotalWorkers }}
          </span>
          <span v-if="bonTotalReviewers > 0" class="badge bg-purple-500/15 text-purple-400">
            reviewers {{ bonTotalReviewers }}
          </span>
        </template>
      </template>
    </div>

    <!-- View Runs button for best-of-n tasks -->
    <button
      v-if="task.executionStrategy === 'best_of_n' && task.status !== 'template' && task.status !== 'backlog'"
      class="btn btn-sm mb-2"
      @click="emit('viewRuns')"
    >
      View Runs
    </button>

    <!-- Warnings -->
    <div
      v-if="task.status === 'review' && task.awaitingPlanApproval && task.executionPhase === 'plan_complete_waiting_approval' && !hasPlanOutput"
      class="text-xs text-red-400 mt-2"
    >
      Plan approval is unavailable because no captured [plan] block exists. Use Smart Repair or Reset.
    </div>

    <div
      v-if="isOrphanExecutingTask"
      class="text-xs text-red-400 mt-2"
    >
      Session may have dropped. Click on card title to verify. If the session is no longer active, use Send to Exec, Repair Done, Smart Repair, or Reset.
    </div>

    <!-- Inline action bar -->
    <div v-if="showInlineActionBar" class="flex flex-wrap gap-1.5 mt-2">
      <template v-if="task.status === 'review' && task.awaitingPlanApproval && task.executionPhase === 'plan_complete_waiting_approval' && hasPlanOutput">
        <button class="btn btn-sm btn-primary" @click="emit('approvePlan')">
          Approve Plan
        </button>
        <button
          class="btn btn-sm"
          style="border-color: var(--orange); color: var(--orange);"
          @click="emit('requestRevision')"
        >
          Request Changes
        </button>
      </template>

      <button
        v-if="task.status === 'review' && isAnomalousReviewTask"
        class="btn btn-sm btn-primary"
        @click="emit('markDone')"
      >
        Mark Done
      </button>

      <button
        v-if="canSendToExecution"
        class="btn btn-sm btn-primary"
        @click="emit('repair', 'queue_implementation')"
      >
        Send to Execution
      </button>

      <button
        v-if="canRepairToDone && task.status !== 'stuck'"
        class="btn btn-sm"
        @click="emit('repair', 'mark_done')"
      >
        Repair Done
      </button>

      <button class="btn btn-sm" @click="emit('repair', 'smart')">
        Smart Repair
      </button>

      <template v-if="task.status === 'stuck'">
        <button
          class="btn btn-sm btn-primary"
          @click="emit('continueReviews')"
        >
          Continue with More Reviews
        </button>
        <button
          class="btn btn-sm btn-success"
          @click="emit('markDone')"
        >
          Mark Done
        </button>
      </template>
    </div>

    <!-- Collapsible output -->
    <div v-if="task.agentOutput && (task.status === 'executing' || task.status === 'review' || task.status === 'done' || task.status === 'stuck' || task.status === 'failed')">
      <button
        class="text-accent-primary text-xs bg-transparent border-0 cursor-pointer py-1 hover:underline"
        @click="showOutput = !showOutput"
      >
        {{ showOutput ? '▼' : '▶' }} Agent Output
      </button>
      <div
        v-if="showOutput"
        class="text-xs text-dark-text-muted bg-dark-bg rounded p-2 mt-1.5 max-h-52 overflow-y-auto whitespace-pre-wrap break-words"
      >
        {{ task.agentOutput.slice(-5000) }}
      </div>
    </div>

    <!-- Cost badge -->
    <div v-if="taskCost" class="flex items-center gap-2 mt-1 text-xs">
      <span 
        class="cost-badge" 
        :title="`${taskCost.formattedTokens} tokens`"
      >
        💰 {{ taskCost.formattedCost }}
      </span>
    </div>

    <!-- Completed date -->
    <div v-if="task.completedAt" class="text-xs text-dark-text-muted mt-1">
      Completed: {{ new Date(task.completedAt * 1000).toLocaleString() }}
    </div>
  </div>
</template>

<style scoped>
.cost-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  background-color: var(--color-surface2);
  border: 1px solid var(--color-surface3);
  border-radius: 9999px;
  color: var(--color-text-muted);
  font-weight: 500;
}

.cost-badge:hover {
  background-color: var(--color-surface3);
  color: var(--color-text);
}
</style>
