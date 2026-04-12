<script setup lang="ts">
import { computed, inject } from 'vue'
import type { WorkflowRun } from '@/types/api'
import type { useTasks } from '@/composables/useTasks'
import { useVersion } from '@/composables/useVersion'

const props = defineProps<{
  runs: WorkflowRun[]
  staleRuns: WorkflowRun[]
  consumedSlots: number
  parallelTasks: number
  isConnected: boolean
}>()

const emit = defineEmits<{
  toggleExecution: []
  openOptions: []
  openContainerConfig: []
  openTemplateModal: []
  openTaskModal: []
  archiveAllDone: []
  togglePlanningChat: []
  archiveRun: [id: string]
  archiveAllStaleRuns: []
}>()

const tasks = inject<ReturnType<typeof useTasks>>('tasks')!

// Version
const { version } = useVersion()

// Stats
const totalTasks = computed(() => tasks.tasks.value.length)
const doneCount = computed(() => tasks.groupedTasks.done?.length || 0)
const activeCount = computed(() => tasks.groupedTasks.executing?.length || 0)
const reviewCount = computed(() => tasks.groupedTasks.review?.length || 0)

// Active runs
const safeRuns = computed(() => Array.isArray(props.runs) ? props.runs : [])
const visibleRuns = computed(() => safeRuns.value.slice(0, 5))
const hasRuns = computed(() => safeRuns.value.length > 0)

// Stale runs (Phase 3)
const safeStaleRuns = computed(() => Array.isArray(props.staleRuns) ? props.staleRuns : [])
const hasStaleRuns = computed(() => safeStaleRuns.value.length > 0)

const getRunStatusClass = (status: string, isStale = false) => {
  if (isStale) return 'stale'
  switch (status) {
    case 'running': return 'active'
    case 'paused': return 'paused'
    default: return ''
  }
}

const getRunProgressPercent = (run: WorkflowRun) => {
  const total = run.taskOrder?.length ?? 0
  const completed = Math.min(run.currentTaskIndex ?? 0, total)
  if (total === 0) return 0
  return (completed / total) * 100
}

const isRunning = computed(() => props.consumedSlots > 0)
const freeSlots = computed(() => props.parallelTasks - props.consumedSlots)

// Phase 3: Check if run can be archived (completed or failed status)
const canArchiveRun = (run: WorkflowRun) => {
  return run.status === 'completed' || run.status === 'failed'
}

// Phase 3: Check if a specific run is stale
const isRunStale = (run: WorkflowRun) => {
  return safeStaleRuns.value.some(sr => sr.id === run.id)
}
</script>

<template>
  <aside class="sidebar">
    <!-- Header -->
    <div class="sidebar-header">
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 bg-accent-primary rounded-md flex items-center justify-center flex-shrink-0">
          <svg class="w-4 h-4 text-dark-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M3 9h18M9 21V9"/>
          </svg>
        </div>
        <span class="sidebar-title text-sm font-bold text-accent-primary whitespace-nowrap">PI WORKFLOW</span>
      </div>
    </div>

    <!-- Content -->
    <div class="sidebar-content">
      <!-- Scrollable main content -->
      <div class="flex-1 overflow-y-auto">
        <!-- Overview Stats -->
        <div class="sidebar-section">
          <div class="sidebar-section-title">Overview</div>
          <div class="grid grid-cols-2 gap-2">
            <div class="stat-card">
              <div class="stat-value">{{ totalTasks }}</div>
              <div class="stat-label">Total</div>
            </div>
            <div class="stat-card">
              <div class="stat-value text-accent-success">{{ doneCount }}</div>
              <div class="stat-label">Done</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" style="color: theme('colors.column.executing')">{{ activeCount }}</div>
              <div class="stat-label">Active</div>
            </div>
            <div class="stat-card">
              <div class="stat-value text-accent-warning">{{ reviewCount }}</div>
              <div class="stat-label">Review</div>
            </div>
          </div>
        </div>

        <!-- Active Runs -->
        <div v-if="hasRuns" class="sidebar-section">
          <div class="sidebar-section-title">
            Active Runs
            <span v-if="hasStaleRuns" class="stale-badge" title="Stale runs detected">
              {{ safeStaleRuns.length }} stale
            </span>
          </div>
          <div
            v-for="run in visibleRuns"
            :key="run.id"
            :class="['run-card', getRunStatusClass(run.status, isRunStale(run))]"
          >
            <div class="run-header">
              <span class="run-id">{{ run.displayName || run.kind }}</span>
              <div class="run-header-actions">
                <span :class="['run-status', getRunStatusClass(run.status, isRunStale(run))]">
                  {{ isRunStale(run) ? 'stale' : run.status }}
                </span>
                <!-- Phase 3: Archive button for completed/failed runs -->
                <button
                  v-if="canArchiveRun(run)"
                  class="archive-run-btn"
                  title="Archive this run"
                  @click.stop="emit('archiveRun', run.id)"
                >
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="run-meta">
              <span>{{ run.currentTaskIndex || 0 }}/{{ run.taskOrder?.length || 0 }} tasks</span>
              <div class="run-progress">
                <div
                  class="run-progress-fill"
                  :class="{ 'stale-progress': isRunStale(run) }"
                  :style="{ width: getRunProgressPercent(run) + '%', '--progress-color': run.color || '#00ff88' }"
                />
              </div>
            </div>
          </div>
          <!-- Phase 3: Archive All Stale button -->
          <button
            v-if="hasStaleRuns"
            class="sidebar-btn archive-stale-btn"
            @click="emit('archiveAllStaleRuns')"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <span class="sidebar-label">Archive {{ safeStaleRuns.length }} Stale Run{{ safeStaleRuns.length > 1 ? 's' : '' }}</span>
          </button>
        </div>

        <!-- Quick Actions -->
        <div class="sidebar-section">
          <div class="sidebar-section-title">Actions</div>
          <button
            :class="['sidebar-btn', isRunning ? 'border-accent-danger text-accent-danger' : 'primary']"
            @click="emit('toggleExecution')"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <template v-if="isRunning">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </template>
              <template v-else>
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </template>
            </svg>
            <span class="sidebar-label">{{ isRunning ? 'Stop Workflow' : 'Start Workflow' }}</span>
          </button>

          <button class="sidebar-btn" @click="emit('openTemplateModal')">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            <span class="sidebar-label">New Template</span>
          </button>

          <button class="sidebar-btn" @click="emit('openTaskModal')">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 4v16m8-8H4"/>
            </svg>
            <span class="sidebar-label">New Task</span>
          </button>

          <button class="sidebar-btn" @click="emit('archiveAllDone')">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <span class="sidebar-label">Archive Done</span>
          </button>

          <button class="sidebar-btn" @click="emit('togglePlanningChat')">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span class="sidebar-label">Planning Chat</span>
          </button>
        </div>

        <!-- Configuration -->
        <div class="sidebar-section">
          <div class="sidebar-section-title">Configuration</div>
          <button class="sidebar-btn" @click="emit('openOptions')">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v6m0 6v6m4.22-10.22l4.24-4.24M6.34 17.66l-4.24 4.24M23 12h-6m-6 0H1m20.24 4.24l-4.24-4.24M6.34 6.34L2.1 2.1"/>
            </svg>
            <span class="sidebar-label">Options</span>
          </button>

          <button class="sidebar-btn" @click="emit('openContainerConfig')">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
              <path d="M4 12h16M12 4v16"/>
            </svg>
            <span class="sidebar-label">Containers</span>
          </button>
        </div>

        <!-- System Status -->
        <div class="sidebar-section">
          <div class="sidebar-section-title">Status</div>
          <div class="system-badge">
            <div
              class="status-dot"
              :class="{ pulse: isRunning }"
              :style="{ '--status-color': isRunning ? '#00ff88' : '#6a6a80' }"
            />
            <span class="text-xs" :class="isRunning ? 'text-accent-success' : 'text-dark-text-muted'">
              {{ freeSlots }}/{{ parallelTasks }} Slots Free
            </span>
          </div>
        </div>
      </div>

      <!-- Version (fixed at bottom) -->
      <div v-if="version" class="sidebar-section version-section">
        <div class="version-display">
          {{ version }}
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* Phase 3: Stale run indicators */
.stale-badge {
  font-size: 0.65rem;
  padding: 2px 6px;
  background-color: #6a6a80;
  color: #e2e2e5;
  border-radius: 4px;
  margin-left: 8px;
  font-weight: 500;
}

.run-card.stale {
  border-color: #6a6a80;
  opacity: 0.8;
}

.run-status.stale {
  background-color: #6a6a80;
  color: #e2e2e5;
}

.run-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.archive-run-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  background: transparent;
  border: none;
  color: #8a8a9a;
  cursor: pointer;
  border-radius: 3px;
  transition: all 0.15s ease;
}

.archive-run-btn:hover {
  color: #ff6b6b;
  background-color: rgba(255, 107, 107, 0.1);
}

.run-progress-fill.stale-progress {
  opacity: 0.5;
  background-color: #6a6a80 !important;
}

.archive-stale-btn {
  margin-top: 8px;
  font-size: 0.8rem;
  color: #8a8a9a;
  border-color: #6a6a80;
}

.archive-stale-btn:hover {
  color: #ff6b6b;
  border-color: #ff6b6b;
  background-color: rgba(255, 107, 107, 0.05);
}

/* Version display */
.version-section {
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
}

.version-display {
  font-size: 10px;
  color: rgba(140, 140, 154, 0.6);
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  letter-spacing: 0.025em;
}
</style>
