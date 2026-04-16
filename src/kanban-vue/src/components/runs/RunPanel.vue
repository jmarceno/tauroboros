<script setup lang="ts">
import { computed } from 'vue'
import type { WorkflowRun } from '@/types/api'

const props = defineProps<{
  runs: WorkflowRun[]
  consumedSlots: number
  parallelTasks: number
  getTaskName: (id: string) => string
}>()

const emit = defineEmits<{
  pause: [id: string]
  resume: [id: string]
  stop: [id: string]
  archive: [id: string]
}>()

const safeRuns = computed(() => Array.isArray(props.runs) ? props.runs : [])
const visibleRuns = computed(() => safeRuns.value.slice(0, 10))
const hasRuns = computed(() => safeRuns.value.length > 0)

const getStatusClass = (status: string) => {
  switch (status) {
    case 'running': return 'text-green-400'
    case 'stopping': return 'text-amber-400'
    case 'paused': return 'text-blue-400'
    case 'failed': return 'text-red-400'
    default: return 'text-dark-text-muted'
  }
}

const getRunProgressLabel = (run: WorkflowRun) => {
  const total = run.taskOrder?.length ?? 0
  const completed = Math.min(run.currentTaskIndex ?? 0, total)
  if (total === 0) return 'No tasks'
  return `${completed}/${total} tasks complete`
}
</script>

<template>
  <details class="mx-4 mt-3 border border-dark-surface3 rounded-xl bg-dark-surface overflow-hidden" open>
    <summary class="list-none cursor-pointer px-4 py-3 flex items-center justify-between gap-3 text-sm font-semibold">
      <span>Workflow Runs</span>
      <span class="text-dark-text-muted text-xs font-medium">
        {{ consumedSlots }}/{{ parallelTasks }} active
      </span>
    </summary>
    <div class="px-4 pb-4 flex flex-col gap-2.5">
      <div v-if="!hasRuns" class="text-dark-text-muted text-sm pt-1">
        No workflow runs yet.
      </div>
      <div
        v-for="run in visibleRuns"
        :key="run.id"
        class="border border-dark-surface3 rounded-lg bg-dark-surface2 p-3 flex items-start justify-between gap-3"
      >
        <div class="flex flex-col gap-1.5 min-w-0">
          <div class="text-sm font-semibold truncate">
            {{ run.displayName || `${run.kind} (${run.id})` }}
          </div>
          <div class="text-xs text-dark-text-muted flex flex-wrap gap-2">
            <span :class="['uppercase tracking-wider text-xs font-bold', getStatusClass(run.status)]">
              <span
                class="inline-block w-2 h-2 rounded-full mr-1.5"
                :style="{ backgroundColor: run.color || '#888888' }"
              />
              {{ run.status }}
            </span>
            <span>{{ run.kind }}</span>
            <span>{{ getRunProgressLabel(run) }}</span>
            <span>Current: {{ run.currentTaskId ? getTaskName(run.currentTaskId) : 'idle' }}</span>
          </div>
          <div v-if="run.errorMessage" class="text-xs text-red-400 whitespace-pre-wrap">
            {{ run.errorMessage }}
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <template v-if="run.status === 'running' || run.status === 'stopping'">
            <button
              class="btn btn-sm"
              :disabled="run.status === 'stopping'"
              @click="emit('pause', run.id)"
            >
              Pause
            </button>
            <button
              class="btn btn-sm btn-danger"
              :disabled="run.status === 'stopping'"
              @click="emit('stop', run.id)"
            >
              Stop
            </button>
          </template>
          <template v-else-if="run.status === 'paused'">
            <button
              class="btn btn-sm btn-primary"
              @click="emit('resume', run.id)"
            >
              Resume
            </button>
            <button
              class="btn btn-sm btn-danger"
              @click="emit('stop', run.id)"
            >
              Stop
            </button>
          </template>
          <template v-else-if="run.status === 'completed' || run.status === 'failed'">
            <button
              class="btn btn-sm"
              @click="emit('archive', run.id)"
            >
              Archive
            </button>
          </template>
        </div>
      </div>
    </div>
  </details>
</template>
