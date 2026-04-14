<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WorkflowRun } from '@/types/api'

const props = defineProps<{
  logs: { ts: string; message: string; variant: 'info' | 'success' | 'error' }[]
  runs: WorkflowRun[]
  staleRuns: WorkflowRun[]
}>()

const collapsed = defineModel<boolean>('collapsed', { default: true })
const activeTab = ref<'runs' | 'logs'>('runs')

const emit = defineEmits<{
  clear: []
  archiveRun: [id: string]
  archiveAllStaleRuns: []
  highlightRun: [runId: string]
  clearHighlight: []
}>()

// Stale runs detection
const safeStaleRuns = computed(() => Array.isArray(props.staleRuns) ? props.staleRuns : [])
const hasStaleRuns = computed(() => safeStaleRuns.value.length > 0)

// Check if a specific run is stale
const isRunStale = (run: WorkflowRun) => {
  return safeStaleRuns.value.some(sr => sr.id === run.id)
}

// Check if run can be archived
const canArchiveRun = (run: WorkflowRun) => {
  return run.status === 'completed' || run.status === 'failed'
}

// Get run status class
const getRunStatusClass = (status: string, isStale = false) => {
  if (isStale) return 'stale'
  switch (status) {
    case 'running': return 'active'
    case 'paused': return 'paused'
    default: return ''
  }
}

// Get run progress percentage
const getRunProgressPercent = (run: WorkflowRun) => {
  const total = run.taskOrder?.length ?? 0
  const completed = Math.min(run.currentTaskIndex ?? 0, total)
  if (total === 0) return 0
  return (completed / total) * 100
}

// Distribute runs into columns for masonry layout (L→R, T→B)
// Column index is 1-based (1, 2, 3, 4)
const getRunsForColumn = (columnIndex: number): WorkflowRun[] => {
  const col = columnIndex - 1 // 0-based
  const allRuns = Array.isArray(props.runs) ? props.runs : []
  
  return allRuns.filter((_, index) => {
    const itemCol = index % 4
    return itemCol === col
  })
}

// Check if any column has runs (for empty state)
const hasAnyRuns = computed(() => {
  const allRuns = Array.isArray(props.runs) ? props.runs : []
  return allRuns.length > 0
})
</script>

<template>
  <div
    :class="[
      'border-t border-dark-border bg-dark-surface flex flex-col transition-all duration-200 shrink-0',
      collapsed ? 'h-auto' : 'h-44 min-h-[120px]'
    ]"
  >
    <!-- Header with Tabs -->
    <div
      class="px-3.5 py-2 text-xs font-semibold text-dark-text-secondary border-b border-dark-border uppercase tracking-wider flex items-center justify-between select-none"
    >
      <div class="flex items-center gap-1">
        <button
          :class="[
            'px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all',
            activeTab === 'runs'
              ? 'bg-dark-surface2 text-accent-primary'
              : 'text-dark-text-secondary hover:text-dark-text hover:bg-dark-surface2/50'
          ]"
          @click="activeTab = 'runs'"
        >
          <span class="flex items-center gap-1.5">
            Workflow Runs
            <span
              v-if="runs.length"
              class="px-1.5 py-0 text-[10px] bg-dark-border rounded-full text-dark-text"
            >
              {{ runs.length }}
            </span>
          </span>
        </button>
        <button
          :class="[
            'px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all',
            activeTab === 'logs'
              ? 'bg-dark-surface2 text-accent-primary'
              : 'text-dark-text-secondary hover:text-dark-text hover:bg-dark-surface2/50'
          ]"
          @click="activeTab = 'logs'"
        >
          <span class="flex items-center gap-1.5">
            Event Log
            <span
              v-if="logs.length"
              class="px-1.5 py-0 text-[10px] bg-dark-border rounded-full text-dark-text"
            >
              {{ logs.length }}
            </span>
          </span>
        </button>
      </div>
      <button
        class="bg-transparent border-0 text-dark-text-secondary cursor-pointer p-1 hover:text-dark-text"
        @click="collapsed = !collapsed"
      >
        <svg v-if="collapsed" class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
        <svg v-else class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
    </div>

    <!-- Tab Content -->
    <div v-if="!collapsed" class="flex-1 overflow-hidden flex flex-col">
      <!-- Workflow Runs Tab -->
      <div v-if="activeTab === 'runs'" class="flex-1 flex flex-col overflow-hidden">
        <!-- Archive All Stale button at top -->
        <div v-if="hasStaleRuns" class="px-3.5 py-2 border-b border-dark-border bg-dark-surface2/30">
          <button
            class="w-auto px-3 py-1.5 bg-dark-surface2 border border-dark-border text-dark-text-secondary rounded-md text-xs flex items-center gap-2 transition-all hover:border-accent-danger hover:text-accent-danger"
            @click="emit('archiveAllStaleRuns')"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <span>Archive {{ safeStaleRuns.length }} Stale Run{{ safeStaleRuns.length > 1 ? 's' : '' }}</span>
          </button>
        </div>

        <!-- 4-Column Grid -->
        <div v-if="hasAnyRuns" class="flex-1 overflow-y-auto p-3">
          <div class="grid grid-cols-4 gap-2 md:grid-cols-2 sm:grid-cols-1">
            <div v-for="col in 4" :key="col" class="flex flex-col gap-2">
              <div
                v-for="run in getRunsForColumn(col)"
                :key="run.id"
                :class="[
                  'p-2.5 bg-dark-surface2 border border-dark-border rounded-md cursor-pointer transition-all',
                  'hover:border-accent-primary',
                  getRunStatusClass(run.status, isRunStale(run)) === 'active' && 'border-accent-success bg-accent-success/5',
                  getRunStatusClass(run.status, isRunStale(run)) === 'stale' && 'border-dark-border-hover opacity-80'
                ]"
                @mouseenter="emit('highlightRun', run.id)"
                @mouseleave="emit('clearHighlight')"
              >
                <div class="flex items-center justify-between mb-1.5">
                  <span class="font-semibold text-xs text-dark-text truncate max-w-[120px]">
                    {{ run.displayName || run.kind }}
                  </span>
                  <div class="flex items-center gap-1.5">
                    <span
                      :class="[
                        'px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase',
                        getRunStatusClass(run.status, isRunStale(run)) === 'active' && 'bg-accent-success/15 text-accent-success',
                        getRunStatusClass(run.status, isRunStale(run)) === 'paused' && 'bg-accent-warning/15 text-accent-warning',
                        getRunStatusClass(run.status, isRunStale(run)) === 'stale' && 'bg-dark-border text-dark-text-secondary',
                        !['active', 'paused', 'stale'].includes(getRunStatusClass(run.status, isRunStale(run))) && 'bg-accent-info/15 text-accent-info'
                      ]"
                    >
                      {{ isRunStale(run) ? 'stale' : run.status }}
                    </span>
                    <button
                      v-if="canArchiveRun(run)"
                      class="w-5 h-5 flex items-center justify-center bg-transparent border-0 text-dark-text-secondary cursor-pointer rounded transition-colors hover:text-accent-danger hover:bg-accent-danger/10"
                      title="Archive this run"
                      @click.stop="emit('archiveRun', run.id)"
                    >
                      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                      </svg>
                    </button>
                  </div>
                </div>
                <div class="flex flex-col gap-1">
                  <span class="text-[10px] text-dark-text-secondary">
                    {{ run.currentTaskIndex || 0 }}/{{ run.taskOrder?.length || 0 }} tasks
                  </span>
                  <div class="h-0.5 bg-dark-border rounded-sm overflow-hidden">
                    <div
                      class="h-full rounded-sm transition-all"
                      :class="{ 'opacity-50 bg-dark-border-hover': isRunStale(run) }"
                      :style="{ 
                        width: getRunProgressPercent(run) + '%', 
                        backgroundColor: isRunStale(run) ? undefined : (run.color || '#00ff88')
                      }"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div v-else class="flex-1 flex flex-col items-center justify-center p-4 text-dark-text-muted">
          <svg class="w-6 h-6 mb-2 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          <p class="text-xs font-medium text-dark-text-secondary mb-0.5">No active workflow runs</p>
          <p class="text-[10px]">Start a workflow to see runs here</p>
        </div>
      </div>

      <!-- Event Log Tab -->
      <div v-if="activeTab === 'logs'" class="flex-1 flex flex-col overflow-hidden">
        <div class="px-3.5 py-1.5 border-b border-dark-border bg-dark-surface2/30 flex justify-end">
          <button 
            class="px-2 py-1 bg-dark-surface2 border border-dark-border text-dark-text-secondary rounded text-[10px] transition-all hover:text-dark-text hover:border-dark-border-hover"
            @click="emit('clear')"
          >
            Clear
          </button>
        </div>
        <div class="flex-1 overflow-y-auto px-3.5 py-2 font-mono text-xs leading-relaxed">
          <div
            v-for="(log, idx) in logs"
            :key="idx"
            class="mb-1"
            :class="{
              'text-dark-text-secondary': log.variant === 'info',
              'text-accent-success': log.variant === 'success',
              'text-accent-danger': log.variant === 'error'
            }"
          >
            <span class="text-dark-text-muted">[{{ log.ts }}]</span> {{ log.message }}
          </div>
          <div v-if="logs.length === 0" class="text-dark-text-muted italic text-center py-4">
            No events yet...
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Responsive grid columns */
@media (max-width: 1200px) {
  .grid-cols-4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .grid-cols-4 {
    grid-template-columns: repeat(1, minmax(0, 1fr));
  }
}

/* Ensure proper layout at large screens */
@media (min-width: 1201px) {
  .grid-cols-4 {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
