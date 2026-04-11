<script setup lang="ts">
import { ref, computed, provide, onMounted } from 'vue'
import type { Task, WorkflowRun, Session } from '@/types/api'
import { useTasks } from '@/composables/useTasks'
import { useRuns } from '@/composables/useRuns'
import { useOptions } from '@/composables/useOptions'
import { useModelSearch } from '@/composables/useModelSearch'
import { useToasts } from '@/composables/useToasts'
import { useKeyboard } from '@/composables/useKeyboard'
import { useWebSocket } from '@/composables/useWebSocket'
import { useSession } from '@/composables/useSession'
import { useDragDrop } from '@/composables/useDragDrop'
import { useMultiSelect } from '@/composables/useMultiSelect'
import { useSessionUsage } from '@/composables/useSessionUsage'

// Components
import TopBar from '@/components/board/TopBar.vue'
import RunPanel from '@/components/runs/RunPanel.vue'
import KanbanBoard from '@/components/board/KanbanBoard.vue'
import LogPanel from '@/components/common/LogPanel.vue'
import ToastContainer from '@/components/common/ToastContainer.vue'

// Modals
import TaskModal from '@/components/modals/TaskModal.vue'
import OptionsModal from '@/components/modals/OptionsModal.vue'
import ExecutionGraphModal from '@/components/modals/ExecutionGraphModal.vue'
import ApproveModal from '@/components/modals/ApproveModal.vue'
import RevisionModal from '@/components/modals/RevisionModal.vue'
import StartSingleModal from '@/components/modals/StartSingleModal.vue'
import SessionModal from '@/components/modals/SessionModal.vue'
import BestOfNDetailModal from '@/components/modals/BestOfNDetailModal.vue'
import BatchEditModal from '@/components/modals/BatchEditModal.vue'

// State
const optionsComposable = useOptions()
const tasksComposable = useTasks(optionsComposable.options)
const runsComposable = useRuns()
const modelSearch = useModelSearch()
const toasts = useToasts()
const session = useSession()
const ws = useWebSocket()
const multiSelect = useMultiSelect()
const sessionUsage = useSessionUsage()

// Computed unwrappers for props (ensuring primitive values)
const consumedSlotsValue = computed(() => runsComposable.consumedRunSlots.value ?? 0)
const parallelTasksValue = computed(() => optionsComposable.options?.parallelTasks ?? 1)
const isConnectedValue = computed(() => ws.isConnected.value ?? false)

// Modal state
const activeModal = ref<string | null>(null)
const modalData = ref<Record<string, unknown>>({})

// Log panel state
const logPanelCollapsed = ref(true)

// Computed
const isAnyModalOpen = computed(() => activeModal.value !== null)
const openModalIds = computed(() => activeModal.value ? [activeModal.value] : [])

// Provide state to child components
provide('tasks', tasksComposable)
provide('runs', runsComposable)
provide('options', optionsComposable)
provide('modelSearch', modelSearch)
provide('toasts', toasts)
provide('session', session)
provide('multiSelect', multiSelect)
provide('sessionUsage', sessionUsage)

// Modal helpers
const openModal = (name: string, data?: Record<string, unknown>) => {
  activeModal.value = name
  modalData.value = data || {}
}

const closeModal = () => {
  activeModal.value = null
  modalData.value = {}
}

const closeTopmostModal = () => {
  if (activeModal.value) {
    closeModal()
    return true
  }
  return false
}

const clearSelectionAndCloseModal = () => {
  multiSelect.clearSelection()
  return closeTopmostModal()
}

// Drag and drop
const dragDrop = useDragDrop(async (taskId, targetStatus) => {
  const task = tasksComposable.getTaskById(taskId)
  if (!task) return

  if (runsComposable.isTaskMutationLocked(taskId)) {
    toasts.showToast('This task is currently executing and cannot be moved.', 'error')
    return
  }

  if (task.status === targetStatus) return

  const canMoveToDone = ['stuck', 'review'].includes(task.status)
  const canMoveToBacklog = ['stuck', 'failed', 'done', 'review'].includes(task.status)
  const canMoveToReview = ['backlog', 'stuck', 'failed'].includes(task.status)

  try {
    if (targetStatus === 'done' && canMoveToDone) {
      if (task.status === 'stuck') {
        await tasksComposable.updateTask(taskId, {
          status: 'done',
          completedAt: Math.floor(Date.now() / 1000),
        })
      } else {
        await tasksComposable.updateTask(taskId, {
          status: 'done',
          completedAt: Math.floor(Date.now() / 1000),
        })
      }
      toasts.showToast('Task moved to Done', 'success')
    } else if (targetStatus === 'backlog' && canMoveToBacklog) {
      await tasksComposable.resetTask(taskId)
    } else if (targetStatus === 'review' && canMoveToReview) {
      await tasksComposable.updateTask(taskId, { status: 'review' })
      toasts.showToast('Task moved to Review', 'success')
    } else {
      toasts.showToast(`Cannot move task from ${task.status} to ${targetStatus}`, 'error')
    }
    await tasksComposable.loadTasks()
  } catch (e) {
    toasts.showToast('Move failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
  }
})

// Keyboard shortcuts
useKeyboard({
  onCreateTemplate: () => openModal('task', { mode: 'create', createStatus: 'template' }),
  onCreateBacklog: () => openModal('task', { mode: 'create', createStatus: 'backlog' }),
  onStartWorkflow: async () => {
    if (optionsComposable.options.showExecutionGraph) {
      openModal('executionGraph')
    } else {
      try {
        await optionsComposable.startExecution()
        await runsComposable.loadRuns()
        await tasksComposable.loadTasks()
        toasts.showToast('Workflow run started', 'success')
      } catch (e) {
        toasts.showToast('Execution control failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
      }
    }
  },
  onArchiveDone: async () => {
    const doneTasks = tasksComposable.groupedTasks.done
    if (doneTasks.length === 0) {
      toasts.showToast('No done tasks to archive', 'error')
      return
    }
    if (!confirm(`Archive all ${doneTasks.length} done task(s)? Task history will be preserved.`)) return
    try {
      await tasksComposable.archiveAllDone()
      toasts.showToast('All done tasks archived', 'success')
    } catch (e) {
      toasts.showToast('Archive failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  },
  onEscape: () => {
    // First clear selection if active, then close modals
    if (multiSelect.isSelecting.value) {
      multiSelect.clearSelection()
      return true
    }
    return closeTopmostModal()
  },
  isModalOpen: () => isAnyModalOpen.value,
})

// WebSocket handlers
ws.on('task_created', (payload) => {
  tasksComposable.tasks.push(payload as Task)
  toasts.addLog(`Task created: ${(payload as Task).name}`, 'info')
})

ws.on('task_updated', (payload) => {
  const task = payload as Task
  const idx = tasksComposable.tasks.findIndex(t => t.id === task.id)
  const prev = idx >= 0 ? tasksComposable.tasks[idx] : null
  if (idx >= 0) {
    tasksComposable.tasks[idx] = task
  } else {
    tasksComposable.tasks.push(task)
  }

  // Log transitions
  if (!prev || prev.status !== task.status) {
    if (task.status === 'executing') toasts.addLog(`Task started: ${task.name}`, 'info')
    if (task.status === 'done') toasts.addLog(`Task completed: ${task.name}`, 'success')
    if (task.status === 'failed' || task.status === 'stuck') {
      toasts.addLog(`Task failed: ${task.name}${task.errorMessage ? ' - ' + task.errorMessage : ''}`, 'error')
    }
  }

  // Refresh best-of-n summaries
  if (task.executionStrategy === 'best_of_n') {
    tasksComposable.refreshBonSummaries([task.id])
  }
})

ws.on('task_deleted', (payload) => {
  const { id } = payload as { id: string }
  const task = tasksComposable.getTaskById(id)
  delete tasksComposable.bonSummaries[id]
  tasksComposable.tasks = tasksComposable.tasks.filter(t => t.id !== id)
  toasts.addLog(`Task deleted: ${task?.name || id}`, 'info')
})

ws.on('task_archived', (payload) => {
  const { id } = payload as { id: string }
  const task = tasksComposable.getTaskById(id)
  delete tasksComposable.bonSummaries[id]
  tasksComposable.tasks = tasksComposable.tasks.filter(t => t.id !== id)
  toasts.addLog(`Task archived: ${task?.name || id}`, 'info')
})

ws.on('task_reordered', () => {
  toasts.addLog('Task order updated', 'info')
  tasksComposable.loadTasks()
})

ws.on('options_updated', () => {
  toasts.addLog('Options updated', 'info')
  optionsComposable.loadOptions()
})

ws.on('run_created', (payload) => {
  runsComposable.updateRunFromWebSocket(payload as WorkflowRun)
})

ws.on('run_updated', (payload) => {
  runsComposable.updateRunFromWebSocket(payload as WorkflowRun)
})

ws.on('run_archived', (payload) => {
  const { id } = payload as { id: string }
  toasts.addLog(`Workflow run archived: ${id}`, 'info')
  runsComposable.removeRun(id)
})

ws.on('session_started', (payload) => {
  const data = payload as Session
  if (data.taskId && data.id) {
    const idx = tasksComposable.tasks.findIndex(t => t.id === data.taskId)
    if (idx >= 0) {
      tasksComposable.tasks[idx] = {
        ...tasksComposable.tasks[idx],
        sessionId: data.id,
        sessionUrl: `/#session/${encodeURIComponent(data.id)}`,
      }
    }
  }
  if (session.sessionId === data.id) {
    session.updateSession(data)
  }
})

ws.on('session_message_created', (payload) => {
  const msg = payload as { sessionId: string }
  if (msg.sessionId === session.sessionId) {
    session.addMessage(msg as unknown as Session)
  }
})

ws.on('session_status_changed', (payload) => {
  const data = payload as Session
  if (session.sessionId === data.id) {
    session.updateSession(data)
  }
})

ws.on('session_completed', (payload) => {
  const data = payload as Session
  if (session.sessionId === data.id) {
    session.updateSession(data)
  }
})

ws.on('task_run_updated', (payload) => {
  const data = payload as { taskId: string }
  if (data.taskId) {
    tasksComposable.refreshBonSummaries([data.taskId])
  }
})

ws.on('task_candidate_updated', (payload) => {
  const data = payload as { taskId: string }
  if (data.taskId) {
    tasksComposable.refreshBonSummaries([data.taskId])
  }
})

ws.on('image_status', (payload) => {
  const data = payload as { status: string; message: string; errorMessage?: string }
  if (data.status === 'preparing') {
    toasts.addLog(`⏳ ${data.message}`, 'info')
  } else if (data.status === 'ready') {
    toasts.addLog(`✅ ${data.message}`, 'success')
  } else if (data.status === 'error') {
    toasts.addLog(`❌ ${data.message}${data.errorMessage ? ': ' + data.errorMessage : ''}`, 'error')
    toasts.showToast(`Container image error: ${data.errorMessage || data.message}`, 'error')
  }
})

ws.on('error', (payload) => {
  const data = payload as { message: string }
  toasts.showToast(data.message, 'error')
})

// Initialize
onMounted(async () => {
  await optionsComposable.loadOptions()
  await modelSearch.loadModels()
  await runsComposable.loadRuns()
  await tasksComposable.loadTasks()

  // Check for session in hash
  const hashMatch = location.hash.match(/^#session\/(.+)$/)
  if (hashMatch) {
    const sessionId = decodeURIComponent(hashMatch[1])
    openModal('session', { sessionId })
  }

  toasts.addLog('Kanban UI ready', 'info')
})

// Handle hash changes
window.addEventListener('hashchange', () => {
  const hashMatch = location.hash.match(/^#session\/(.+)$/)
  if (hashMatch) {
    const sessionId = decodeURIComponent(hashMatch[1])
    if (activeModal.value !== 'session') {
      openModal('session', { sessionId })
    }
  } else if (activeModal.value === 'session') {
    closeModal()
  }
})
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden bg-dark-bg text-dark-text">
    <!-- Top Bar -->
    <TopBar
      :consumed-slots="consumedSlotsValue"
      :parallel-tasks="parallelTasksValue"
      :is-connected="isConnectedValue"
      @toggle-execution="() => {
        if (optionsComposable.options.showExecutionGraph) {
          openModal('executionGraph')
        } else {
          optionsComposable.startExecution().then(() => {
            runsComposable.loadRuns()
            tasksComposable.loadTasks()
            toasts.showToast('Workflow run started', 'success')
          }).catch(e => toasts.showToast('Execution control failed: ' + e.message, 'error'))
        }
      }"
      @open-options="openModal('options')"
    />

    <!-- Run Panel -->
    <RunPanel
      :runs="runsComposable.runs.value"
      :consumed-slots="consumedSlotsValue"
      :parallel-tasks="parallelTasksValue"
      :get-task-name="tasksComposable.getTaskName"
      @pause="runsComposable.pauseRun"
      @resume="runsComposable.resumeRun"
      @stop="runsComposable.stopRun"
      @archive="runsComposable.archiveRun"
    />

    <!-- Kanban Board -->
    <KanbanBoard
      :grouped-tasks="tasksComposable.groupedTasks"
      :bon-summaries="tasksComposable.bonSummaries"
      :get-task-run-color="runsComposable.getTaskRunColor"
      :is-task-mutation-locked="runsComposable.isTaskMutationLocked"
      :drag-drop="dragDrop"
      :is-multi-selecting="multiSelect.isSelecting.value"
      :get-is-selected="multiSelect.isSelected"
      :column-sorts="optionsComposable.options.columnSorts"
      @open-task="(id: string) => openModal('task', { taskId: id })"
      @open-template-modal="openModal('task', { mode: 'create', createStatus: 'template' })"
      @open-task-modal="openModal('task', { mode: 'create', createStatus: 'backlog' })"
      @deploy-template="(id: string) => openModal('task', { mode: 'deploy', seedTaskId: id })"
      @open-session="(id: string) => openModal('session', { sessionId: id })"
      @approve-plan="(id: string) => openModal('approve', { taskId: id })"
      @request-revision="(id: string) => openModal('revision', { taskId: id })"
      @start-single="(id: string) => openModal('startSingle', { taskId: id })"
      @repair-task="(id: string, action: string) => tasksComposable.repairTask(id, action)"
      @mark-done="(id: string) => tasksComposable.updateTask(id, { status: 'done', completedAt: Math.floor(Date.now() / 1000) })"
      @reset-task="tasksComposable.resetTask"
      @convert-to-template="(id: string) => tasksComposable.updateTask(id, { status: 'template' })"
      @archive-task="tasksComposable.deleteTask"
      @archive-all-done="async () => {
        if (!confirm(`Archive all ${tasksComposable.groupedTasks.done.length} done task(s)?`)) return
        await tasksComposable.archiveAllDone()
        toasts.showToast('All done tasks archived', 'success')
      }"
      @view-runs="(id: string) => openModal('bestOfNDetail', { taskId: id })"
      @continue-reviews="(id: string) => openModal('continueReviews', { taskId: id })"
      @change-column-sort="(status: string, sort: string) => {
        const newSorts = { ...(optionsComposable.options.columnSorts || {}), [status]: sort }
        optionsComposable.updateOptions({ columnSorts: newSorts })
      }"
    />

    <!-- Log Panel -->
    <LogPanel
      v-model:collapsed="logPanelCollapsed"
      :logs="toasts.logs.value"
      @clear="toasts.clearLogs"
    />

    <!-- Toast Container -->
    <ToastContainer
      :toasts="toasts.toasts.value"
      :bottom-offset="logPanelCollapsed ? 16 : 200"
      @remove="toasts.removeToast"
    />

    <!-- Multi-Select Floating Action Bar -->
    <div
      v-if="multiSelect.isSelecting.value"
      class="fixed bottom-20 left-1/2 -translate-x-1/2 bg-dark-surface border border-dark-surface3 rounded-lg shadow-lg px-4 py-3 flex items-center gap-4 z-50"
    >
      <span class="text-sm font-medium">
        {{ multiSelect.selectedCount.value }} task{{ multiSelect.selectedCount.value === 1 ? '' : 's' }} selected
      </span>
      <div class="flex items-center gap-2">
        <button
          class="btn btn-primary btn-sm"
          @click="openModal('batchEdit', { taskIds: multiSelect.getSelectedIds() })"
        >
          Edit
        </button>
        <button
          class="btn btn-sm"
          @click="multiSelect.clearSelection()"
        >
          Clear
        </button>
      </div>
    </div>

    <!-- Modals -->
    <TaskModal
      v-if="activeModal === 'task'"
      :mode="(modalData.mode as string) || 'create'"
      :task-id="modalData.taskId as string | undefined"
      :create-status="(modalData.createStatus as 'template' | 'backlog') || 'backlog'"
      :seed-task-id="modalData.seedTaskId as string | undefined"
      @close="closeModal"
    />

    <OptionsModal
      v-if="activeModal === 'options'"
      @close="closeModal"
    />

    <ExecutionGraphModal
      v-if="activeModal === 'executionGraph'"
      @close="closeModal"
    />

    <ApproveModal
      v-if="activeModal === 'approve'"
      :task-id="modalData.taskId as string"
      @close="closeModal"
    />

    <RevisionModal
      v-if="activeModal === 'revision'"
      :task-id="modalData.taskId as string"
      @close="closeModal"
    />

    <StartSingleModal
      v-if="activeModal === 'startSingle'"
      :task-id="modalData.taskId as string"
      @close="closeModal"
    />

    <SessionModal
      v-if="activeModal === 'session'"
      :session-id="modalData.sessionId as string"
      @close="() => {
        closeModal()
        if (location.hash.startsWith('#session/')) {
          history.pushState(null, '', location.pathname + location.search)
        }
      }"
    />

    <BestOfNDetailModal
      v-if="activeModal === 'bestOfNDetail'"
      :task-id="modalData.taskId as string"
      @close="closeModal"
    />

    <BatchEditModal
      v-if="activeModal === 'batchEdit'"
      :task-ids="(modalData.taskIds as string[]) || []"
      @close="closeModal"
    />
  </div>
</template>
