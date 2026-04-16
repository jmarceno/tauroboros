<script setup lang="ts">
import { ref, computed, provide, onMounted, onUnmounted, nextTick } from 'vue'
import type { Task, WorkflowRun, Session, SessionMessage } from '@/types/api'
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
import { usePlanningChat } from '@/composables/usePlanningChat'
import { useWorkflowControl } from '@/composables/useWorkflowControl'
import { useWorkflowStatus } from '@/composables/useWorkflowStatus'

// Components
import Sidebar from '@/components/board/Sidebar.vue'
import TopBar from '@/components/board/TopBar.vue'
import KanbanBoard from '@/components/board/KanbanBoard.vue'
import TabbedLogPanel from '@/components/common/TabbedLogPanel.vue'
import ToastContainer from '@/components/common/ToastContainer.vue'
import ChatContainer from '@/components/chat/ChatContainer.vue'

// Modals
import TaskModal from '@/components/modals/TaskModal.vue'
import OptionsModal from '@/components/modals/OptionsModal.vue'
import ExecutionGraphModal from '@/components/modals/ExecutionGraphModal.vue'
import ApproveModal from '@/components/modals/ApproveModal.vue'
import RevisionModal from '@/components/modals/RevisionModal.vue'
import StartSingleModal from '@/components/modals/StartSingleModal.vue'
import SessionModal from '@/components/modals/SessionModal.vue'
import TaskSessionsModal from '@/components/modals/TaskSessionsModal.vue'
import BestOfNDetailModal from '@/components/modals/BestOfNDetailModal.vue'
import BatchEditModal from '@/components/modals/BatchEditModal.vue'
import PlanningPromptModal from '@/components/modals/PlanningPromptModal.vue'
import ContainerConfigModal from '@/components/modals/ContainerConfigModal.vue'
import StopConfirmModal from '@/components/modals/StopConfirmModal.vue'
import ConfirmModal from '@/components/modals/ConfirmModal.vue'

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
const planningChat = usePlanningChat()
const workflowStatus = useWorkflowStatus()

// Container status
const containerStatus = ref<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)
const isContainerEnabled = computed(() => containerStatus.value?.enabled ?? false)

const loadContainerStatus = async () => {
  try {
    const response = await fetch('/api/container/status')
    containerStatus.value = await response.json()
  } catch {
    containerStatus.value = { enabled: false, available: false, hasRunningWorkflows: false, message: 'Failed to load status' }
  }
}

  // Workflow control with pause/resume/stop
const workflowControl = useWorkflowControl(
  (state) => {
    toasts.addLog(`Workflow state: ${state}`, 'info')
  },
  (run) => {
    runsComposable.updateRunFromWebSocket(run)
  }
)

// Modal state
const activeModal = ref<string | null>(null)
const modalData = ref<Record<string, unknown>>({})

// Workflow highlight state
const highlightedRunId = ref<string | null>(null)

// Container config modal state
const showContainerConfigModal = ref(false)
const logPanelCollapsed = ref(false)

// Stop confirm modal state
const showStopConfirmModal = ref(false)

// Confirm modal state for delete/convert actions
const showConfirmModal = ref(false)
const confirmModalAction = ref<'delete' | 'convertToTemplate'>('delete')
const confirmModalTaskId = ref<string | null>(null)
const confirmModalTaskName = ref<string>('')

// Computed
const isAnyModalOpen = computed(() => {
  return activeModal.value !== null || showContainerConfigModal.value || showStopConfirmModal.value || showConfirmModal.value
})

const consumedSlotsValue = computed(() => runsComposable.consumedRunSlots.value)
const parallelTasksValue = computed(() => optionsComposable.options.parallelTasks ?? 1)
const isConnectedValue = computed(() => ws.isConnected.value)

// Get the current active run for workflow control
const currentActiveRun = computed(() => {
  return runsComposable.activeRuns.value[0] || null
})

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
    if (showContainerConfigModal.value) {
      showContainerConfigModal.value = false
      return true
    }
    if (showStopConfirmModal.value) {
      showStopConfirmModal.value = false
      return true
    }
    if (showConfirmModal.value) {
      showConfirmModal.value = false
      confirmModalTaskId.value = null
      return true
    }
    return false
  }

// Confirmation modal helpers
const showConfirmation = (action: 'delete' | 'convertToTemplate', taskId: string, taskName: string, ctrlHeld: boolean) => {
  // If Ctrl is held, bypass confirmation for delete and convert actions
  if (ctrlHeld) {
    executeConfirmedAction(action, taskId)
    return
  }
  // Otherwise, show the confirmation modal
  confirmModalAction.value = action
  confirmModalTaskId.value = taskId
  confirmModalTaskName.value = taskName
  showConfirmModal.value = true
}

const executeConfirmedAction = async (action: 'delete' | 'convertToTemplate', taskId: string) => {
  try {
    if (action === 'delete') {
      await tasksComposable.deleteTask(taskId)
      toasts.showToast('Task deleted', 'success')
    } else if (action === 'convertToTemplate') {
      await tasksComposable.updateTask(taskId, { status: 'template' })
      toasts.showToast('Task converted to template', 'success')
    }
  } catch (e) {
    toasts.showToast(`${action === 'delete' ? 'Delete' : 'Convert'} failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

const handleConfirmModalConfirm = () => {
  if (confirmModalTaskId.value) {
    executeConfirmedAction(confirmModalAction.value, confirmModalTaskId.value)
  }
  showConfirmModal.value = false
  confirmModalTaskId.value = null
}

const clearSelectionAndCloseModal = () => {
  multiSelect.clearSelection()
  return closeTopmostModal()
}

// Provide state to child components
provide('tasks', tasksComposable)
provide('runs', runsComposable)
provide('options', optionsComposable)
provide('modelSearch', modelSearch)
provide('toasts', toasts)
provide('session', session)
provide('multiSelect', multiSelect)
provide('sessionUsage', sessionUsage)
provide('planningChat', planningChat)
provide('workflowRunning', workflowStatus)
provide('workflowControl', workflowControl)
provide('containerStatus', { containerStatus, isContainerEnabled, loadContainerStatus })
provide('openModal', openModal)
provide('closeModal', closeModal)
provide('highlightedRunId', highlightedRunId)

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
      await tasksComposable.updateTask(taskId, {
        status: 'done',
        completedAt: Math.floor(Date.now() / 1000),
      })
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
  onTogglePlanningChat: () => planningChat.togglePanel(),
  onStartWorkflow: async () => {
    // Check if there are any tasks to execute
    const grouped = tasksComposable.groupedTasks.value
    const executableTasks = (grouped?.backlog?.length ?? 0) + 
                            (grouped?.review?.length ?? 0) +
                            (grouped?.executing?.length ?? 0)
    if (executableTasks === 0) {
      toasts.showToast('No tasks available to execute. Create some tasks first.', 'error')
      return
    }
    if (optionsComposable.options.value?.showExecutionGraph) {
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
    const doneTasks = tasksComposable.groupedTasks.value?.done ?? []
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
    if (multiSelect.isSelecting.value) {
      multiSelect.clearSelection()
      return true
    }
    return closeTopmostModal()
  },
  isModalOpen: () => isAnyModalOpen.value,
})

// WebSocket handlers
ws.on('task_created', async (payload) => {
  try {
    const task = payload as Task
    if (!task || !task.id) {
      console.error('[WebSocket] Invalid task payload:', payload)
      return
    }

    // Check if task already exists to prevent duplicates from race condition
    const existingTask = tasksComposable.getTaskById(task.id)
    if (existingTask) {
      console.log(`[WebSocket] task_created: Task ${task.id} already exists, skipping`)
      return
    }

    // Use reactive assignment instead of push to ensure Vue detects change
    tasksComposable.tasks.value = [...tasksComposable.tasks.value, task]
    // Wait for Vue to update
    await nextTick()
    // Debug: show task status in log
    toasts.addLog(`Task created: ${task.name} (status: ${task.status || 'undefined'})`, 'info')
  } catch (err) {
    console.error('[WebSocket] Error in task_created handler:', err)
  }
})

ws.on('task_updated', async (payload) => {
  const task = payload as Task
  const idx = tasksComposable.tasks.value.findIndex(t => t.id === task.id)
  const prev = idx >= 0 ? tasksComposable.tasks.value[idx] : null

  // Stale update protection: skip if incoming update is older than current
  if (prev && task.updatedAt && prev.updatedAt && task.updatedAt < prev.updatedAt) {
    console.log(`[WebSocket] Skipping stale task_updated for ${task.name} (incoming ${task.updatedAt} < current ${prev.updatedAt})`)
    return
  }

  // Merge: if incoming update lacks fields present in current, preserve them
  const mergedTask = prev ? { ...prev, ...task } : task

  if (idx >= 0) {
    tasksComposable.tasks.value = tasksComposable.tasks.value.map((t, i) => i === idx ? mergedTask : t)
  }
  // Note: We intentionally do NOT add new tasks here - task_updated should only update existing tasks.
  // If task doesn't exist yet, it will be added via task_created event or loadTasks().
  // Phase 3: Keep runs composable tasks ref synchronized
  runsComposable.setTasksRef(tasksComposable.tasks.value)

  if (!prev || prev.status !== task.status) {
    if (task.status === 'executing') toasts.addLog(`Task started: ${task.name}`, 'info')
    if (task.status === 'done') toasts.addLog(`Task completed: ${task.name}`, 'success')
    if (task.status === 'failed' || task.status === 'stuck') {
      toasts.addLog(`Task failed: ${task.name}${task.errorMessage ? ' - ' + task.errorMessage : ''}`, 'error')
    }
  }

  if (task.executionStrategy === 'best_of_n') {
    tasksComposable.refreshBonSummaries([task.id])
  }
})

ws.on('task_deleted', (payload) => {
  const { id } = payload as { id: string }
  const task = tasksComposable.getTaskById(id)
  delete tasksComposable.bonSummaries.value[id]
  tasksComposable.tasks.value = tasksComposable.tasks.value.filter(t => t.id !== id)
  // Phase 3: Keep runs composable tasks ref synchronized
  runsComposable.setTasksRef(tasksComposable.tasks.value)
  toasts.addLog(`Task deleted: ${task?.name || id}`, 'info')
})

ws.on('task_archived', (payload) => {
  const { id } = payload as { id: string }
  const task = tasksComposable.getTaskById(id)
  delete tasksComposable.bonSummaries.value[id]
  tasksComposable.tasks.value = tasksComposable.tasks.value.filter(t => t.id !== id)
  // Phase 3: Keep runs composable tasks ref synchronized
  runsComposable.setTasksRef(tasksComposable.tasks.value)
  toasts.addLog(`Task archived: ${task?.name || id}`, 'info')
})

ws.on('task_reordered', () => {
  toasts.addLog('Task order updated', 'info')
  tasksComposable.loadTasks().then(() => {
    // Phase 3: Keep runs composable tasks ref synchronized
    runsComposable.setTasksRef(tasksComposable.tasks.value)
  })
})

ws.on('options_updated', () => {
  toasts.addLog('Options updated', 'info')
  optionsComposable.loadOptions()
})

ws.on('run_created', (payload) => {
  const run = payload as WorkflowRun
  runsComposable.updateRunFromWebSocket(run)
  workflowControl.handleRunUpdate(run)
})

ws.on('run_updated', (payload) => {
  const run = payload as WorkflowRun
  runsComposable.updateRunFromWebSocket(run)
  workflowControl.handleRunUpdate(run)
})

ws.on('run_archived', (payload) => {
  const { id } = payload as { id: string }
  toasts.addLog(`Workflow run archived: ${id}`, 'info')
  runsComposable.removeRun(id)
  workflowControl.clearRun()
})

ws.on('execution_paused', (payload) => {
  const data = payload as { runId: string }
  toasts.showToast('Workflow paused', 'info')
  toasts.addLog(`Workflow paused: ${data.runId}`, 'info')
  // Update from runs array per plan
  workflowControl.updateStateFromRuns(runsComposable.runs.value)
})

ws.on('execution_resumed', (payload) => {
  const data = payload as { runId: string }
  toasts.showToast('Workflow resumed', 'success')
  toasts.addLog(`Workflow resumed: ${data.runId}`, 'success')
  // Update from runs array per plan
  workflowControl.updateStateFromRuns(runsComposable.runs.value)
})

ws.on('run_paused', (payload) => {
  const data = payload as { runId: string }
  toasts.showToast('Workflow run paused', 'info')
  toasts.addLog(`Workflow run paused: ${data.runId}`, 'info')
  // Update from runs array per plan
  workflowControl.updateStateFromRuns(runsComposable.runs.value)
})

ws.on('run_resumed', (payload) => {
  const data = payload as { runId: string }
  toasts.showToast('Workflow run resumed', 'success')
  toasts.addLog(`Workflow run resumed: ${data.runId}`, 'success')
  // Update from runs array per plan
  workflowControl.updateStateFromRuns(runsComposable.runs.value)
})

ws.on('run_stopped', (payload) => {
  const data = payload as { runId: string; destructive?: boolean }
  const message = data.destructive ? 'Workflow force stopped' : 'Workflow stopped'
  toasts.showToast(message, data.destructive ? 'error' : 'info')
  toasts.addLog(`${message}: ${data.runId}`, data.destructive ? 'error' : 'info')
  runsComposable.loadRuns()
})

ws.on('session_started', (payload) => {
  const data = payload as Session
  if (data.taskId && data.id) {
    const idx = tasksComposable.tasks.value.findIndex(t => t.id === data.taskId)
    if (idx >= 0) {
      tasksComposable.tasks.value[idx] = {
        ...tasksComposable.tasks.value[idx],
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
  const msg = payload as SessionMessage
  if (msg.sessionId === session.sessionId) {
    session.addMessage(msg)
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

// Planning chat WebSocket handlers
ws.on('planning_prompt_updated', (payload) => {
  planningChat.planningPrompt.value = payload as typeof planningChat.planningPrompt.value
  toasts.addLog('Planning prompt updated', 'info')
})

ws.on('planning_session_created', (payload) => {
  planningChat.handlePlanningSessionCreated(payload as Session)
  toasts.addLog('Planning session created', 'info')
})

ws.on('planning_session_updated', (payload) => {
  planningChat.handlePlanningSessionUpdated(payload as Session)
})

ws.on('planning_session_closed', (payload) => {
  planningChat.handlePlanningSessionClosed(payload as { id: string })
  toasts.addLog('Planning session closed', 'info')
})

ws.on('planning_session_message', (payload: { sessionId: string; message: SessionMessage }) => {
  planningChat.handlePlanningSessionMessage(payload)
})

// Container configuration WebSocket handlers
ws.on('container_config_updated', () => {
  toasts.addLog('Container configuration updated', 'info')
})

ws.on('container_package_added', (payload) => {
  toasts.addLog(`Package '${payload.name}' added to container config`, 'info')
})

ws.on('container_package_removed', () => {
  toasts.addLog(`Package removed from container config`, 'info')
})

ws.on('container_build_started', (payload) => {
  toasts.showToast('Container build started', 'info')
  toasts.addLog(`Container build #${payload.buildId} started (${payload.imageTag})`, 'info')
})

ws.on('container_build_progress', () => {
  // Progress updates handled within modal
})

ws.on('container_build_completed', (payload) => {
  if (payload.status === 'success') {
    toasts.showToast('Container build completed successfully!', 'success')
    toasts.addLog(`Container build #${payload.buildId} completed successfully`, 'success')
  } else if (payload.status === 'failed') {
    toasts.showToast('Container build failed', 'error')
    toasts.addLog(`Container build #${payload.buildId} failed`, 'error')
  }
})

ws.on('container_build_cancelled', (payload) => {
  toasts.addLog(`Container build #${payload.buildId} cancelled`, 'info')
})

ws.on('container_profile_created', (payload) => {
  toasts.showToast(`New profile "${payload.name}" created`, 'success')
})

// Handle orchestration-level events
ws.on('execution_started', () => {
  toasts.addLog('Workflow execution started', 'info')
})

ws.on('execution_stopped', () => {
  toasts.addLog('Workflow execution stopped', 'info')
  workflowControl.updateStateFromRuns(runsComposable.runs.value)
})

ws.on('execution_complete', () => {
  toasts.addLog('Workflow execution completed', 'success')
  workflowControl.updateStateFromRuns(runsComposable.runs.value)
})

// State resync on WebSocket reconnection
ws.onReconnect(() => {
  console.log('[App] Reconnected - syncing state from server')
  Promise.all([
    tasksComposable.loadTasks(),
    runsComposable.loadRuns(),
    optionsComposable.loadOptions(),
  ]).catch(err => {
    console.error('[App] State resync failed:', err)
  })
})

// Initialize
onMounted(async () => {
  await optionsComposable.loadOptions()
  await modelSearch.loadModels()
  await runsComposable.loadRuns()
  await tasksComposable.loadTasks()

  // Load container status to determine if container features should be enabled
  await loadContainerStatus()

  // Phase 3: Connect tasks to runs composable for stale run detection
  runsComposable.setTasksRef(tasksComposable.tasks.value)

  // Check for paused runs and sync workflow control state
  const hasPaused = await workflowControl.checkPausedState()
  if (hasPaused) {
    toasts.showToast('Found paused workflow. Click Resume to continue.', 'info')
  }

  // Sync with any active runs
  if (runsComposable.activeRuns?.value?.length > 0) {
    const activeRun = runsComposable.activeRuns.value[0]
    workflowControl.setRun(activeRun)
  }

  const hashMatch = location.hash.match(/^#session\/(.+)$/)
  if (hashMatch) {
    const sessionId = decodeURIComponent(hashMatch[1])
    openModal('session', { sessionId })
  }

  toasts.addLog('Kanban UI ready', 'info')
})

// Periodic state sync as safety net (every 30s when connected)
// This ensures eventual consistency even if WebSocket events are missed
const SYNC_INTERVAL = 30000
let syncIntervalId: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  syncIntervalId = setInterval(() => {
    if (ws.isConnected.value) {
      tasksComposable.loadTasks().catch(() => {})
      runsComposable.loadRuns().catch(() => {})
    }
  }, SYNC_INTERVAL)
})

onUnmounted(() => {
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
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
  <div class="app-layout bg-dark-bg text-dark-text">
    <!-- Sidebar -->
    <Sidebar
      :consumed-slots="consumedSlotsValue"
      :parallel-tasks="parallelTasksValue"
      :is-connected="isConnectedValue"
      :control-state="workflowControl.controlState.value"
      :can-pause="workflowControl.canPause.value"
      :can-resume="workflowControl.canResume.value"
      :can-stop="workflowControl.canStop.value"
      :is-control-loading="workflowControl.isLoading.value"
      :is-paused="workflowControl.isPaused.value"
      :active-run-id="currentActiveRun?.id ?? null"
      @toggle-execution="async () => {
        // Check for paused run first
        const hasPaused = await workflowControl.checkPausedState()
        if (hasPaused) {
          toasts.showToast('Resuming paused workflow...', 'info')
          await workflowControl.resume()
          runsComposable.loadRuns()
          return
        }

        const isRunning = consumedSlotsValue > 0 || workflowControl.isRunning.value
        if (isRunning) {
          // Show graceful stop
          optionsComposable.stopExecution().then(() => {
            runsComposable.loadRuns()
            toasts.showToast('Workflow stopped', 'success')
          }).catch(e => toasts.showToast('Failed to stop workflow: ' + e.message, 'error'))
        } else {
          // Check if there are any tasks to execute
          const grouped = tasksComposable.groupedTasks.value
          const executableTasks = (grouped?.backlog?.length ?? 0) +
                                  (grouped?.review?.length ?? 0) +
                                  (grouped?.executing?.length ?? 0)
          if (executableTasks === 0) {
            toasts.showToast('No tasks available to execute. Create some tasks first.', 'error')
            return
          }
          if (optionsComposable.options.value?.showExecutionGraph) {
            openModal('executionGraph')
          } else {
            optionsComposable.startExecution().then(() => {
              runsComposable.loadRuns()
              tasksComposable.loadTasks()
              toasts.showToast('Workflow run started', 'success')
            }).catch(e => toasts.showToast('Execution control failed: ' + e.message, 'error'))
          }
        }
      }"
      @pause-execution="async (runId: string) => {
        toasts.showToast('Pausing workflow...', 'info')
        const success = await workflowControl.pause(runId)
        if (success) {
          toasts.showToast('Workflow paused', 'success')
          runsComposable.loadRuns()
        } else {
          toasts.showToast(workflowControl.error.value || 'Failed to pause workflow', 'error')
        }
      }"
      @resume-execution="async (runId: string) => {
        toasts.showToast('Resuming workflow...', 'info')
        const success = await workflowControl.resume(runId)
        if (success) {
          toasts.showToast('Workflow resumed', 'success')
          runsComposable.loadRuns()
        } else {
          toasts.showToast(workflowControl.error.value || 'Failed to resume workflow', 'error')
        }
      }"
      @stop-execution="(type: 'graceful' | 'destructive') => {
        workflowControl.requestStop(type)
      }"
      @pause-workflow="async () => {
        // Legacy handler - delegates to pause-execution with current run
        if (workflowControl.currentRunId.value) {
          toasts.showToast('Pausing workflow...', 'info')
          const success = await workflowControl.pause()
          if (success) {
            toasts.showToast('Workflow paused', 'success')
            runsComposable.loadRuns()
          } else {
            toasts.showToast(workflowControl.error.value || 'Failed to pause workflow', 'error')
          }
        }
      }"
      @resume-workflow="async () => {
        // Legacy handler - delegates to resume-execution with current run
        toasts.showToast('Resuming workflow...', 'info')
        const success = await workflowControl.resume()
        if (success) {
          toasts.showToast('Workflow resumed', 'success')
          runsComposable.loadRuns()
        } else {
          toasts.showToast(workflowControl.error.value || 'Failed to resume workflow', 'error')
        }
      }"
      @force-stop-workflow="() => {
        workflowControl.requestStop('destructive')
      }"
      @stop-workflow="() => {
        workflowControl.requestStop('graceful')
      }"
      @open-options="openModal('options')"
      @open-container-config="showContainerConfigModal = true"
      @open-template-modal="openModal('task', { mode: 'create', createStatus: 'template' })"
      @open-task-modal="openModal('task', { mode: 'create', createStatus: 'backlog' })"
      @archive-all-done="async () => {
        if (!confirm(`Archive all ${tasksComposable.groupedTasks?.done?.length ?? 0} done task(s)?`)) return
        await tasksComposable.archiveAllDone()
        toasts.showToast('All done tasks archived', 'success')
      }"
      @toggle-planning-chat="planningChat.togglePanel()"
    />

    <!-- Main Content -->
    <main class="main-content">
      <!-- Top Bar -->
      <TopBar />

      <!-- Kanban Board -->
      <KanbanBoard
        :tasks="tasksComposable.tasks"
        :bon-summaries="tasksComposable.bonSummaries"
        :get-task-run-color="runsComposable.getTaskRunColor"
        :is-task-mutation-locked="runsComposable.isTaskMutationLocked"
        :drag-drop="dragDrop"
        :is-multi-selecting="multiSelect.isSelecting.value"
        :get-is-selected="multiSelect.isSelected"
        :column-sorts="optionsComposable.options.columnSorts"
        :highlighted-run-id="highlightedRunId"
        :is-task-in-run="runsComposable.isTaskInRun"
        @open-task="(id: string) => openModal('task', { taskId: id, mode: 'edit' })"
        @open-template-modal="openModal('task', { mode: 'create', createStatus: 'template' })"
        @open-task-modal="openModal('task', { mode: 'create', createStatus: 'backlog' })"
        @deploy-template="(id: string) => openModal('task', { mode: 'deploy', seedTaskId: id })"
        @open-task-sessions="(id: string) => openModal('taskSessions', { taskId: id })"
        @approve-plan="(id: string) => openModal('approve', { taskId: id })"
        @request-revision="(id: string) => openModal('revision', { taskId: id })"
        @start-single="(id: string) => openModal('startSingle', { taskId: id })"
        @repair-task="(id: string, action: string) => tasksComposable.repairTask(id, action)"
        @mark-done="(id: string) => tasksComposable.updateTask(id, { status: 'done', completedAt: Math.floor(Date.now() / 1000) })"
        @reset-task="tasksComposable.resetTask"
        @convert-to-template="(id: string, event?: MouseEvent) => {
          const task = tasksComposable.getTaskById(id)
          const taskName = task?.name || 'this task'
          const ctrlHeld = event?.ctrlKey || event?.metaKey || false
          showConfirmation('convertToTemplate', id, taskName, ctrlHeld)
        }"
        @archive-task="(id: string, event?: MouseEvent) => {
          const task = tasksComposable.getTaskById(id)
          const taskName = task?.name || 'this task'
          const ctrlHeld = event?.ctrlKey || event?.metaKey || false
          showConfirmation('delete', id, taskName, ctrlHeld)
        }"
        @archive-all-done="async () => {
          if (!confirm(`Archive all ${tasksComposable.groupedTasks?.done?.length ?? 0} done task(s)?`)) return
          await tasksComposable.archiveAllDone()
          toasts.showToast('All done tasks archived', 'success')
        }"
        @view-runs="(id: string) => openModal('bestOfNDetail', { taskId: id })"
        @continue-reviews="(id: string) => tasksComposable.repairTask(id, 'continue_with_more_reviews')"
        @change-column-sort="(status: string, sort: string) => {
          const newSorts = { ...(optionsComposable.options.columnSorts || {}), [status]: sort }
          optionsComposable.updateOptions({ columnSorts: newSorts })
        }"
      />

      <!-- Tabbed Log Panel with Workflow Runs -->
      <TabbedLogPanel
        v-model:collapsed="logPanelCollapsed"
        :logs="toasts.logs.value"
        :runs="runsComposable.runs.value"
        :stale-runs="runsComposable.staleRuns.value"
        @clear="toasts.clearLogs"
        @archive-run="async (id: string) => {
          try {
            await runsComposable.archiveRun(id)
            toasts.showToast('Run archived', 'success')
          } catch (e) {
            toasts.showToast('Failed to archive run: ' + (e instanceof Error ? e.message : String(e)), 'error')
          }
        }"
        @archive-all-stale-runs="async () => {
          const staleCount = runsComposable.staleRuns?.value?.length ?? 0
          if (staleCount === 0) return
          if (!confirm(`Archive ${staleCount} stale workflow run${staleCount > 1 ? 's' : ''}?`)) return
          try {
            await Promise.all(runsComposable.staleRuns.value.map(run => runsComposable.archiveRun(run.id)))
            toasts.showToast(`${staleCount} stale run${staleCount > 1 ? 's' : ''} archived`, 'success')
          } catch (e) {
            toasts.showToast('Failed to archive runs: ' + (e instanceof Error ? e.message : String(e)), 'error')
          }
        }"
        @highlight-run="(runId: string) => highlightedRunId = runId"
        @clear-highlight="highlightedRunId = null"
      />
    </main>

    <!-- Toast Container -->
    <ToastContainer
      :toasts="toasts.toasts.value"
      :bottom-offset="logPanelCollapsed ? 16 : 200"
      @remove="toasts.removeToast"
    />

    <!-- Chat Container (Slide-out Panel) -->
    <ChatContainer />

    <!-- Multi-Select Floating Action Bar -->
    <div
      v-if="multiSelect.isSelecting.value"
      class="fixed bottom-20 left-1/2 -translate-x-1/2 bg-dark-surface border border-dark-border rounded-lg shadow-lg px-4 py-3 flex items-center gap-4 z-50"
    >
      <span class="text-sm font-medium text-dark-text">
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

    <TaskSessionsModal
      v-if="activeModal === 'taskSessions'"
      :task-id="modalData.taskId as string"
      @close="closeModal"
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

    <PlanningPromptModal
      v-if="activeModal === 'planningPrompt'"
      @close="closeModal"
    />

    <ContainerConfigModal
      v-if="showContainerConfigModal"
      @close="showContainerConfigModal = false"
    />

    <StopConfirmModal
      :is-open="showStopConfirmModal || workflowControl.isConfirmingStop.value"
      :run-name="currentActiveRun?.displayName"
      :is-stopping="workflowControl.isStopping.value"
      @close="() => {
        showStopConfirmModal = false
        workflowControl.cancelStop()
      }"
      @confirm-graceful="async () => {
        toasts.showToast('Pausing workflow gracefully...', 'info')
        // User clicked PAUSE option in the modal - switch to graceful stop
        workflowControl.requestStop('graceful')
        const success = await workflowControl.confirmStop()
        if (success) {
          toasts.showToast('Workflow paused gracefully - work preserved', 'success')
          runsComposable.loadRuns()
        } else {
          toasts.showToast(workflowControl.error.value || 'Failed to pause workflow', 'error')
        }
      }"
      @confirm-destructive="async () => {
        toasts.showToast('STOPPING workflow - killing all containers...', 'info')
        // stopType is already 'destructive' from when modal opened
        const success = await workflowControl.confirmStop()
        if (success) {
          const result = workflowControl.lastResult.value
          toasts.showToast(`Workflow STOPPED. Killed ${result?.killed || 0} processes, deleted ${result?.cleaned || 0} containers.`, 'warning')
          runsComposable.loadRuns()
          tasksComposable.loadTasks()
        } else {
          toasts.showToast(workflowControl.error.value || 'Failed to stop workflow', 'error')
        }
      }"
    />

    <ConfirmModal
      :is-open="showConfirmModal"
      :action="confirmModalAction"
      :task-name="confirmModalTaskName"
      @close="() => {
        showConfirmModal = false
        confirmModalTaskId = null
      }"
      @confirm="handleConfirmModalConfirm"
    />
  </div>
</template>
