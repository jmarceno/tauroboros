<script setup lang="ts">
import { computed, inject } from 'vue'
import type { WorkflowRun } from '@/types/api'
import type { useTasks } from '@/composables/useTasks'
import { useVersion } from '@/composables/useVersion'
import type { WorkflowControlState } from '@/composables/useWorkflowControl'

const props = defineProps<{
  consumedSlots: number
  parallelTasks: number
  isConnected: boolean
  controlState?: WorkflowControlState
  canPause?: boolean
  canResume?: boolean
  canStop?: boolean
  isControlLoading?: boolean
  // New props per plan
  isPaused?: boolean
  activeRunId?: string | null
}>()

const emit = defineEmits<{
  toggleExecution: []
  openOptions: []
  openContainerConfig: []
  openTemplateModal: []
  openTaskModal: []
  archiveAllDone: []
  togglePlanningChat: []
  // New emits per plan with runId parameter
  pauseExecution: [runId: string]
  resumeExecution: [runId: string]
  stopExecution: [type: 'graceful' | 'destructive']
  // Legacy emits for backward compatibility
  pauseWorkflow: []
  resumeWorkflow: []
  stopWorkflow: []
  forceStopWorkflow: []
}>()

const tasks = inject<ReturnType<typeof useTasks>>('tasks')!

// Version
const { version } = useVersion()

// Stats
const totalTasks = computed(() => tasks?.tasks?.value?.length ?? 0)
const doneCount = computed(() => tasks?.groupedTasks?.value?.done?.length ?? 0)
const activeCount = computed(() => tasks?.groupedTasks?.value?.executing?.length ?? 0)
const reviewCount = computed(() => tasks?.groupedTasks?.value?.review?.length ?? 0)

const isRunning = computed(() => props.consumedSlots > 0)
const freeSlots = computed(() => props.parallelTasks - props.consumedSlots)
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
    <div class="sidebar-content overflow-y-auto">
      <!-- Overview Stats -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">Overview ({{ totalTasks }})</div>
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

      <!-- Workflow Controls -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">Workflow Control</div>

        <!-- Main Start/Pause/Resume/Stop Buttons - grouped together -->
        <div class="action-group">
          <!-- Start button (disabled when running or paused) -->
          <button
            :class="['sidebar-btn', 'primary', { 'opacity-50 cursor-not-allowed': isRunning || controlState === 'paused' || isControlLoading }]"
            :disabled="isRunning || controlState === 'paused' || isControlLoading"
            @click="emit('toggleExecution')"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span class="sidebar-label">Start Workflow</span>
          </button>

          <!-- Pause button (disabled when not running or can't pause) -->
          <button
            :class="['sidebar-btn', 'warning', { 'opacity-50 cursor-not-allowed': !canPause || !isRunning || isControlLoading }]"
            :disabled="!canPause || !isRunning || isControlLoading"
            @click="activeRunId ? emit('pauseExecution', activeRunId) : emit('pauseWorkflow')"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="6" y="6" width="4" height="12" rx="1"/>
              <rect x="14" y="6" width="4" height="12" rx="1"/>
            </svg>
            <span class="sidebar-label">Pause</span>
          </button>

          <!-- Resume button (disabled when not paused or can't resume) -->
          <button
            :class="['sidebar-btn', 'primary', { 'opacity-50 cursor-not-allowed': !canResume || (controlState !== 'paused' && !isPaused) || isControlLoading }]"
            :disabled="!canResume || (controlState !== 'paused' && !isPaused) || isControlLoading"
            @click="activeRunId ? emit('resumeExecution', activeRunId) : emit('resumeWorkflow')"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span class="sidebar-label">Resume</span>
          </button>

          <!-- Stop button (disabled when not running/paused or can't stop) -->
          <button
            :class="['sidebar-btn', 'danger', { 'opacity-50 cursor-not-allowed': !canStop || (!isRunning && controlState !== 'paused' && !isPaused) || isControlLoading }]"
            :disabled="!canStop || (!isRunning && controlState !== 'paused' && !isPaused) || isControlLoading"
            @click="emit('stopExecution', 'destructive')"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            <span class="sidebar-label">Stop</span>
          </button>
        </div>

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

      <!-- Version (at bottom of scrollable content) -->
      <div v-if="version" class="sidebar-section version-section mt-auto">
        <div class="version-display">
          {{ version }}
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* Version display */
.version-section {
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
}

/* Webkit scrollbar styling for sidebar content */
.sidebar-content::-webkit-scrollbar {
  width: 6px;
}

.sidebar-content::-webkit-scrollbar-track {
  background: transparent;
}

.sidebar-content::-webkit-scrollbar-thumb {
  background-color: #4a4a5a;
  border-radius: 3px;
}

.sidebar-content::-webkit-scrollbar-thumb:hover {
  background-color: #6a6a7a;
}

.version-display {
  font-size: 10px;
  color: rgba(140, 140, 154, 0.6);
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  letter-spacing: 0.025em;
}

/* Action group for related buttons (pause/resume/stop) */
.action-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

/* Warning button style (for pause) */
.sidebar-btn.warning {
  border-color: #ffc107;
  color: #ffc107;
}

.sidebar-btn.warning:hover {
  background: rgba(255, 193, 7, 0.1);
}

/* Danger button style (for destructive stop) */
.sidebar-btn.danger {
  border-color: #ff6b6b;
  color: #ff6b6b;
}

.sidebar-btn.danger:hover {
  background: rgba(255, 107, 107, 0.1);
}
</style>
