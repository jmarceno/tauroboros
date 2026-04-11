<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue'
import type { TaskRun, Candidate, BestOfNSummary, Task } from '@/types/api'
import type { useTasks } from '@/composables/useTasks'
import type { useToasts } from '@/composables/useToasts'

const props = defineProps<{
  taskId: string
}>()

const emit = defineEmits<{
  close: []
  openSession: [sessionId: string]
}>()

const tasks = inject<ReturnType<typeof useTasks>>('tasks')!
const toasts = inject<ReturnType<typeof useToasts>>('toasts')!

const activeTab = ref<'overview' | 'workers' | 'reviewers' | 'final'>('overview')
const runs = ref<TaskRun[]>([])
const candidates = ref<Candidate[]>([])
const summary = ref<BestOfNSummary | null>(null)
const isLoading = ref(true)

const task = computed(() => tasks.getTaskById(props.taskId))

onMounted(async () => {
  try {
    const [runsData, candidatesData, summaryData] = await Promise.all([
      tasks.api.getTaskRuns(props.taskId),
      tasks.api.getTaskCandidates(props.taskId),
      tasks.api.getBestOfNSummary(props.taskId),
    ])
    runs.value = runsData
    candidates.value = candidatesData
    summary.value = summaryData
  } catch (e) {
    toasts.showToast('Failed to load best-of-n details: ' + (e instanceof Error ? e.message : String(e)), 'error')
  } finally {
    isLoading.value = false
  }
})

const workers = computed(() => runs.value.filter(r => r.phase === 'worker'))
const reviewers = computed(() => runs.value.filter(r => r.phase === 'reviewer'))
const finalAppliers = computed(() => runs.value.filter(r => r.phase === 'final_applier'))

const statusMap: Record<string, string> = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
}

const closeOnOverlay = (e: MouseEvent) => {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}
</script>

<template>
  <div class="modal-overlay" @mousedown="closeOnOverlay">
    <div class="modal w-[700px] max-h-[85vh]">
      <div class="modal-header">
        <h2>Best-of-N Details</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div v-if="isLoading" class="text-dark-text-muted">
          Loading best-of-n details...
        </div>

        <div v-else-if="task">
          <!-- Summary -->
          <div class="mb-4">
            <div class="text-sm"><strong>Task:</strong> {{ task.name }}</div>
            <div class="text-sm"><strong>Substage:</strong> {{ task.bestOfNSubstage || 'idle' }}</div>
            <div class="text-sm" v-if="summary">
              <strong>Successful Workers:</strong> {{ summary.successfulCandidateCount || 0 }} / {{ summary.expandedWorkerCount || 0 }}
            </div>
          </div>

          <!-- Tabs -->
          <div class="flex gap-1 border-b border-dark-surface3 mb-3">
            <button
              :class="['px-4 py-2 text-sm border-b-2 transition-colors', activeTab === 'overview' ? 'text-accent-primary border-accent-primary' : 'text-dark-text-muted border-transparent hover:text-dark-text']"
              @click="activeTab = 'overview'"
            >
              Overview
            </button>
            <button
              :class="['px-4 py-2 text-sm border-b-2 transition-colors', activeTab === 'workers' ? 'text-accent-primary border-accent-primary' : 'text-dark-text-muted border-transparent hover:text-dark-text']"
              @click="activeTab = 'workers'"
            >
              Workers ({{ workers.length }})
            </button>
            <button
              :class="['px-4 py-2 text-sm border-b-2 transition-colors', activeTab === 'reviewers' ? 'text-accent-primary border-accent-primary' : 'text-dark-text-muted border-transparent hover:text-dark-text']"
              @click="activeTab = 'reviewers'"
            >
              Reviewers ({{ reviewers.length }})
            </button>
            <button
              :class="['px-4 py-2 text-sm border-b-2 transition-colors', activeTab === 'final' ? 'text-accent-primary border-accent-primary' : 'text-dark-text-muted border-transparent hover:text-dark-text']"
              @click="activeTab = 'final'"
            >
              Final Applier ({{ finalAppliers.length }})
            </button>
          </div>

          <!-- Tab content -->
          <div v-if="activeTab === 'overview'">
            <h4 class="text-sm font-semibold mb-3">Execution Summary</h4>
            <div v-if="summary" class="text-xs text-dark-text-muted mb-4 p-2 border border-dark-surface3 rounded bg-dark-bg">
              Workers completed: {{ summary.workersDone || 0 }}/{{ summary.workersTotal || 0 }}<br>
              Reviewers completed: {{ summary.reviewersDone || 0 }}/{{ summary.reviewersTotal || 0 }}<br>
              Final applier completed: {{ summary.finalApplierDone ? 'yes' : 'no' }}
            </div>

            <h4 class="text-sm font-semibold mb-2">Candidates</h4>
            <div class="flex flex-col gap-2">
              <div
                v-for="c in candidates"
                :key="c.id"
                :class="['border rounded-lg p-2.5 bg-dark-bg', c.status === 'selected' ? 'border-green-500' : 'border-dark-surface3']"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-xs text-dark-text-muted">{{ c.id }}</span>
                  <span :class="['text-xs px-1.5 py-0.5 rounded', c.status === 'selected' ? 'bg-green-500/15 text-green-400' : 'bg-dark-surface text-dark-text-muted']">
                    {{ c.status }}
                  </span>
                </div>
                <div class="text-xs text-dark-text-muted">
                  {{ c.summary ? c.summary.substring(0, 300) : 'No summary' }}
                </div>
                <div class="text-xs text-dark-text-muted mt-1">
                  Files: {{ (c.changedFilesJson || []).join(', ') || 'None' }}
                </div>
              </div>
              <div v-if="candidates.length === 0" class="text-xs text-dark-text-muted">
                No successful candidates yet.
              </div>
            </div>
          </div>

          <div v-else-if="activeTab === 'workers'">
            <h4 class="text-sm font-semibold mb-3">Worker Runs</h4>
            <div class="flex flex-col gap-2">
              <div
                v-for="run in workers"
                :key="run.id"
                class="border border-dark-surface3 rounded-lg p-2.5 bg-dark-bg"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-xs font-semibold uppercase text-cyan-400">
                    Worker Slot {{ run.slotIndex + 1 }}
                  </span>
                  <span class="text-xs text-dark-text-muted">{{ run.model }}</span>
                  <span :class="['text-xs px-1.5 py-0.5 rounded', statusMap[run.status] === 'running' ? 'bg-accent-primary/15 text-accent-primary' : statusMap[run.status] === 'done' ? 'bg-green-500/15 text-green-400' : statusMap[run.status] === 'failed' ? 'bg-red-400/15 text-red-400' : 'bg-dark-surface text-dark-text-muted']">
                    {{ run.status }}
                  </span>
                </div>
                <div v-if="run.summary" class="text-xs text-dark-text-muted">
                  {{ run.summary.substring(0, 300) }}
                </div>
                <div v-if="run.errorMessage" class="text-xs text-red-400">
                  Error: {{ run.errorMessage }}
                </div>
                <div v-if="run.worktreeDir" class="text-xs text-dark-text-muted">
                  Worktree: {{ run.worktreeDir }}
                </div>
                <div v-if="run.sessionId" class="mt-2">
                  <button class="btn btn-sm" @click="emit('openSession', run.sessionId)">
                    View Session
                  </button>
                </div>
              </div>
              <div v-if="workers.length === 0" class="text-xs text-dark-text-muted">
                No worker runs yet.
              </div>
            </div>
          </div>

          <div v-else-if="activeTab === 'reviewers'">
            <h4 class="text-sm font-semibold mb-3">Reviewer Runs</h4>
            <div class="flex flex-col gap-2">
              <div
                v-for="run in reviewers"
                :key="run.id"
                class="border border-dark-surface3 rounded-lg p-2.5 bg-dark-bg"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-xs font-semibold uppercase text-purple-400">
                    Reviewer Slot {{ run.slotIndex + 1 }}
                  </span>
                  <span class="text-xs text-dark-text-muted">{{ run.model }}</span>
                  <span :class="['text-xs px-1.5 py-0.5 rounded', statusMap[run.status] === 'running' ? 'bg-accent-primary/15 text-accent-primary' : statusMap[run.status] === 'done' ? 'bg-green-500/15 text-green-400' : statusMap[run.status] === 'failed' ? 'bg-red-400/15 text-red-400' : 'bg-dark-surface text-dark-text-muted']">
                    {{ run.status }}
                  </span>
                </div>
                <div v-if="run.summary" class="text-xs text-dark-text-muted">
                  {{ run.summary.substring(0, 300) }}
                </div>
                <div v-if="run.errorMessage" class="text-xs text-red-400">
                  Error: {{ run.errorMessage }}
                </div>
                <div v-if="run.sessionId" class="mt-2">
                  <button class="btn btn-sm" @click="emit('openSession', run.sessionId)">
                    View Session
                  </button>
                </div>
              </div>
              <div v-if="reviewers.length === 0" class="text-xs text-dark-text-muted">
                No reviewer runs yet.
              </div>
            </div>
          </div>

          <div v-else-if="activeTab === 'final'">
            <h4 class="text-sm font-semibold mb-3">Final Applier</h4>
            <div class="flex flex-col gap-2">
              <div
                v-for="run in finalAppliers"
                :key="run.id"
                class="border border-dark-surface3 rounded-lg p-2.5 bg-dark-bg"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-xs font-semibold uppercase text-green-400">
                    Final Applier
                  </span>
                  <span class="text-xs text-dark-text-muted">{{ run.model }}</span>
                  <span :class="['text-xs px-1.5 py-0.5 rounded', statusMap[run.status] === 'running' ? 'bg-accent-primary/15 text-accent-primary' : statusMap[run.status] === 'done' ? 'bg-green-500/15 text-green-400' : statusMap[run.status] === 'failed' ? 'bg-red-400/15 text-red-400' : 'bg-dark-surface text-dark-text-muted']">
                    {{ run.status }}
                  </span>
                </div>
                <div v-if="run.summary" class="text-xs text-dark-text-muted">
                  {{ run.summary.substring(0, 300) }}
                </div>
                <div v-if="run.errorMessage" class="text-xs text-red-400">
                  Error: {{ run.errorMessage }}
                </div>
                <div v-if="run.sessionId" class="mt-2">
                  <button class="btn btn-sm" @click="emit('openSession', run.sessionId)">
                    View Session
                  </button>
                </div>
              </div>
              <div v-if="finalAppliers.length === 0" class="text-xs text-dark-text-muted">
                Final applier has not started yet.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>
