import { useEffect, useState, useCallback, useRef } from 'react'
import './styles/theme.css'
import {
  TasksContext, RunsContext, OptionsContext, ToastContext,
  ModelSearchContext, SessionContext, WebSocketContext,
  WorkflowControlContext, MultiSelectContext, PlanningChatContext,
  ModalContext, ContainerStatusContext, SessionUsageContext,
} from '@/contexts/AppContext'
import {
  useTasks, useRuns, useOptions, useToasts,
  useModelSearch, useSession, useWebSocket,
  useWorkflowControl, useMultiSelect, usePlanningChat,
  useDragDrop, useKeyboard, useSessionUsage,
} from '@/hooks'
import { validateTaskDrop } from '@/utils/dropValidation'
import type { Task, TaskStatus, WorkflowRun } from '@/types'

// Components
import { Sidebar } from '@/components/board/Sidebar'
import { TopBar } from '@/components/board/TopBar'
import { KanbanBoard } from '@/components/board/KanbanBoard'
import { TabbedLogPanel } from '@/components/common/TabbedLogPanel'
import { ToastContainer } from '@/components/common/ToastContainer'
import { ChatContainer } from '@/components/chat/ChatContainer'

// Modals
import { TaskModal } from '@/components/modals/TaskModal'
import { OptionsModal } from '@/components/modals/OptionsModal'
import { ExecutionGraphModal } from '@/components/modals/ExecutionGraphModal'
import { ApproveModal } from '@/components/modals/ApproveModal'
import { RevisionModal } from '@/components/modals/RevisionModal'
import { StartSingleModal } from '@/components/modals/StartSingleModal'
import { SessionModal } from '@/components/modals/SessionModal'
import { TaskSessionsModal } from '@/components/modals/TaskSessionsModal'
import { BestOfNDetailModal } from '@/components/modals/BestOfNDetailModal'
import { BatchEditModal } from '@/components/modals/BatchEditModal'
import { ConfirmModal } from '@/components/modals/ConfirmModal'
import { StopConfirmModal } from '@/components/modals/StopConfirmModal'
import { PlanningPromptModal } from '@/components/modals/PlanningPromptModal'
import { ContainerConfigModal } from '@/components/modals/ContainerConfigModal'

function App() {
  // Container status
  const [containerStatus, setContainerStatus] = useState<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)
  const isContainerEnabled = containerStatus?.enabled ?? false

  const loadContainerStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/container/status')
      setContainerStatus(await response.json())
    } catch {
      setContainerStatus({ enabled: false, available: false, hasRunningWorkflows: false, message: 'Failed to load status' })
    }
  }, [])

  // Initialize hooks (wsHook must come before planningChatHook)
  const optionsHook = useOptions()
  const tasksHook = useTasks(optionsHook.options?.columnSorts)
  const runsHook = useRuns()
  const modelSearchHook = useModelSearch()
  const toastsHook = useToasts()
  const sessionHook = useSession()
  const wsHook = useWebSocket()
  const multiSelectHook = useMultiSelect()
  const planningChatHook = usePlanningChat(wsHook)
  const sessionUsageHook = useSessionUsage()

  // Workflow control
  const workflowControl = useWorkflowControl(
    (state) => {
      toastsHook.addLog(`Workflow state: ${state}`, 'info')
    },
    (run) => {
      runsHook.updateRunFromWebSocket(run)
    }
  )

  // Modal state
  const [activeModal, setActiveModal] = useState<string | null>(null)
  const [modalData, setModalData] = useState<Record<string, unknown>>({})
  const [showContainerConfigModal, setShowContainerConfigModal] = useState(false)
  const [showStopConfirmModal, setShowStopConfirmModal] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [confirmModalAction, setConfirmModalAction] = useState<'delete' | 'convertToTemplate'>('delete')
  const [confirmModalTaskId, setConfirmModalTaskId] = useState<string | null>(null)
  const [confirmModalTaskName, setConfirmModalTaskName] = useState('')
  const [logPanelCollapsed, setLogPanelCollapsed] = useState(false)
  const [highlightedRunId, setHighlightedRunId] = useState<string | null>(null)

  // Computed
  const isAnyModalOpen = activeModal !== null || showContainerConfigModal || showStopConfirmModal || showConfirmModal
  const consumedSlotsValue = runsHook.consumedRunSlots
  const parallelTasksValue = optionsHook.options?.parallelTasks ?? 1
  const isConnectedValue = wsHook.isConnected
  const currentActiveRun = runsHook.activeRuns[0] || null

  // Modal helpers
  const openModal = useCallback((name: string, data?: Record<string, unknown>) => {
    setActiveModal(name)
    setModalData(data || {})
  }, [])

  const closeModal = useCallback(() => {
    setActiveModal(null)
    setModalData({})
  }, [])

  const closeTopmostModal = useCallback(() => {
    if (activeModal) {
      closeModal()
      return true
    }
    if (showContainerConfigModal) {
      setShowContainerConfigModal(false)
      return true
    }
    if (showStopConfirmModal) {
      setShowStopConfirmModal(false)
      return true
    }
    if (showConfirmModal) {
      setShowConfirmModal(false)
      setConfirmModalTaskId(null)
      return true
    }
    return false
  }, [activeModal, showContainerConfigModal, showStopConfirmModal, showConfirmModal, closeModal])

  const showConfirmation = useCallback((action: 'delete' | 'convertToTemplate', taskId: string, taskName: string, ctrlHeld: boolean) => {
    if (ctrlHeld) {
      if (action === 'delete') {
        tasksHook.deleteTask(taskId).then(() => {
          toastsHook.showToast('Task deleted', 'success')
        }).catch(e => {
          toastsHook.showToast(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
        })
      } else {
        tasksHook.updateTask(taskId, { status: 'template' as TaskStatus }).then(() => {
          toastsHook.showToast('Task converted to template', 'success')
        }).catch(e => {
          toastsHook.showToast(`Convert failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
        })
      }
      return
    }
    setConfirmModalAction(action)
    setConfirmModalTaskId(taskId)
    setConfirmModalTaskName(taskName)
    setShowConfirmModal(true)
  }, [tasksHook, toastsHook])

  const executeConfirmedAction = useCallback(async (action: 'delete' | 'convertToTemplate', taskId: string) => {
    try {
      if (action === 'delete') {
        await tasksHook.deleteTask(taskId)
        toastsHook.showToast('Task deleted', 'success')
      } else {
        await tasksHook.updateTask(taskId, { status: 'template' as TaskStatus })
        toastsHook.showToast('Task converted to template', 'success')
      }
    } catch (e) {
      toastsHook.showToast(`${action === 'delete' ? 'Delete' : 'Convert'} failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [tasksHook, toastsHook])

  const handleConfirmModalConfirm = useCallback(() => {
    if (confirmModalTaskId) {
      executeConfirmedAction(confirmModalAction, confirmModalTaskId)
    }
    setShowConfirmModal(false)
    setConfirmModalTaskId(null)
  }, [confirmModalAction, confirmModalTaskId, executeConfirmedAction])

  // Drag and drop
  const dragDrop = useDragDrop(async (taskId, targetStatus) => {
    const task = tasksHook.getTaskById(taskId)
    if (!task) return

    const validation = validateTaskDrop(
      task,
      targetStatus as TaskStatus,
      runsHook.isTaskMutationLocked(taskId)
    )

    if (!validation.allowed) {
      if (validation.reason !== 'no-change') {
        toastsHook.showToast(validation.reason, 'error')
      }
      return
    }

    try {
      switch (validation.action) {
        case 'move-to-done':
          await tasksHook.updateTask(taskId, {
            status: 'done' as TaskStatus,
            completedAt: Math.floor(Date.now() / 1000),
          })
          toastsHook.showToast('Task moved to Done', 'success')
          break
        case 'reset-to-backlog':
          await tasksHook.resetTask(taskId)
          break
        case 'move-to-review':
          await tasksHook.updateTask(taskId, { status: 'review' as TaskStatus })
          toastsHook.showToast('Task moved to Review', 'success')
          break
      }
      await tasksHook.loadTasks()
    } catch (e) {
      toastsHook.showToast('Move failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  })

  // Keyboard shortcuts
  useKeyboard({
    onCreateTemplate: () => openModal('task', { mode: 'create', createStatus: 'template' }),
    onCreateBacklog: () => openModal('task', { mode: 'create', createStatus: 'backlog' }),
    onTogglePlanningChat: () => planningChatHook.togglePanel(),
    onStartWorkflow: async () => {
      const grouped = tasksHook.groupedTasks
      const executableTasks = (grouped?.backlog?.length ?? 0) + 
                            (grouped?.review?.length ?? 0) +
                            (grouped?.executing?.length ?? 0)
      if (executableTasks === 0) {
        toastsHook.showToast('No tasks available to execute. Create some tasks first.', 'error')
        return
      }
      if (optionsHook.options?.showExecutionGraph) {
        openModal('executionGraph')
      } else {
        try {
          await optionsHook.startExecution()
          await runsHook.loadRuns()
          await tasksHook.loadTasks()
          toastsHook.showToast('Workflow run started', 'success')
        } catch (e) {
          toastsHook.showToast('Execution control failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
        }
      }
    },
    onArchiveDone: async () => {
      const doneTasks = tasksHook.groupedTasks?.done ?? []
      if (doneTasks.length === 0) {
        toastsHook.showToast('No done tasks to archive', 'error')
        return
      }
      if (!confirm(`Archive all ${doneTasks.length} done task(s)? Task history will be preserved.`)) return
      try {
        await tasksHook.archiveAllDone()
        toastsHook.showToast('All done tasks archived', 'success')
      } catch (e) {
        toastsHook.showToast('Archive failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
      }
    },
    onEscape: () => {
      if (multiSelectHook.isSelecting) {
        multiSelectHook.clearSelection()
        return true
      }
      return closeTopmostModal()
    },
    isModalOpen: () => isAnyModalOpen,
  })

  const tasksRef = useRef(tasksHook.tasks)
  tasksRef.current = tasksHook.tasks

  const runsRef = useRef(runsHook.runs)
  runsRef.current = runsHook.runs

  // WebSocket handlers
  useEffect(() => {
    const unsubscribers: (() => void)[] = []

    unsubscribers.push(wsHook.on('task_created', async (payload) => {
      const task = payload as Task
      if (!task || !task.id) return
      const existingTask = tasksRef.current.find(t => t.id === task.id)
      if (existingTask) return
      tasksHook.setTasks([...tasksRef.current, task])
      toastsHook.addLog(`Task created: ${task.name} (status: ${task.status || 'undefined'})`, 'info')
    }))

    unsubscribers.push(wsHook.on('task_updated', async (payload) => {
      const task = payload as Task
      const idx = tasksRef.current.findIndex(t => t.id === task.id)
      const prev = idx >= 0 ? tasksRef.current[idx] : null

      if (prev && task.updatedAt && prev.updatedAt && task.updatedAt < prev.updatedAt) {
        console.log(`[WebSocket] Skipping stale task_updated for ${task.name}`)
        return
      }

      const mergedTask = prev ? { ...prev, ...task } : task

      if (idx >= 0) {
        tasksHook.setTasks(tasksRef.current.map((t, i) => i === idx ? mergedTask : t))
      }
      runsHook.setTasksRef(tasksRef.current)

      if (!prev || prev.status !== task.status) {
        if (task.status === 'executing') toastsHook.addLog(`Task started: ${task.name}`, 'info')
        if (task.status === 'done') toastsHook.addLog(`Task completed: ${task.name}`, 'success')
        if (task.status === 'failed' || task.status === 'stuck') {
          toastsHook.addLog(`Task failed: ${task.name}${task.errorMessage ? ' - ' + task.errorMessage : ''}`, 'error')
        }
      }

      if (task.executionStrategy === 'best_of_n') {
        tasksHook.refreshBonSummaries([task.id])
      }
    }))

    unsubscribers.push(wsHook.on('task_deleted', (payload) => {
      const { id } = payload as { id: string }
      const task = tasksRef.current.find(t => t.id === id)
      tasksHook.removeBonSummary(id)
      tasksHook.setTasks(tasksRef.current.filter(t => t.id !== id))
      runsHook.setTasksRef(tasksRef.current.filter(t => t.id !== id))
      toastsHook.addLog(`Task deleted: ${task?.name || id}`, 'info')
    }))

    unsubscribers.push(wsHook.on('task_archived', (payload) => {
      const { id } = payload as { id: string }
      const task = tasksRef.current.find(t => t.id === id)
      tasksHook.removeBonSummary(id)
      tasksHook.setTasks(tasksRef.current.filter(t => t.id !== id))
      runsHook.setTasksRef(tasksRef.current.filter(t => t.id !== id))
      toastsHook.addLog(`Task archived: ${task?.name || id}`, 'info')
    }))

    unsubscribers.push(wsHook.on('task_reordered', () => {
      toastsHook.addLog('Task order updated', 'info')
      tasksHook.loadTasks().then((data) => {
        runsHook.setTasksRef(data || tasksRef.current)
      })
    }))

    unsubscribers.push(wsHook.on('options_updated', () => {
      toastsHook.addLog('Options updated', 'info')
      optionsHook.loadOptions()
    }))

    unsubscribers.push(wsHook.on('run_created', (payload) => {
      const run = payload as WorkflowRun
      runsHook.updateRunFromWebSocket(run)
      workflowControl.handleRunUpdate(run)
    }))

    unsubscribers.push(wsHook.on('run_updated', (payload) => {
      const run = payload as WorkflowRun
      runsHook.updateRunFromWebSocket(run)
      workflowControl.handleRunUpdate(run)
    }))

    unsubscribers.push(wsHook.on('run_archived', (payload) => {
      const { id } = payload as { id: string }
      toastsHook.addLog(`Workflow run archived: ${id}`, 'info')
      runsHook.removeRun(id)
      workflowControl.clearRun()
    }))

    unsubscribers.push(wsHook.on('execution_paused', (payload) => {
      const data = payload as { runId: string }
      toastsHook.showToast('Workflow paused', 'info')
      toastsHook.addLog(`Workflow paused: ${data.runId}`, 'info')
      workflowControl.updateStateFromRuns(runsRef.current)
    }))

    unsubscribers.push(wsHook.on('execution_resumed', (payload) => {
      const data = payload as { runId: string }
      toastsHook.showToast('Workflow resumed', 'success')
      toastsHook.addLog(`Workflow resumed: ${data.runId}`, 'success')
      workflowControl.updateStateFromRuns(runsRef.current)
    }))

    unsubscribers.push(wsHook.on('run_paused', (payload) => {
      const data = payload as { runId: string }
      toastsHook.showToast('Workflow run paused', 'info')
      toastsHook.addLog(`Workflow run paused: ${data.runId}`, 'info')
      workflowControl.updateStateFromRuns(runsRef.current)
    }))

    unsubscribers.push(wsHook.on('run_resumed', (payload) => {
      const data = payload as { runId: string }
      toastsHook.showToast('Workflow run resumed', 'success')
      toastsHook.addLog(`Workflow run resumed: ${data.runId}`, 'success')
      workflowControl.updateStateFromRuns(runsRef.current)
    }))

    unsubscribers.push(wsHook.on('run_stopped', (payload) => {
      const data = payload as { runId: string; destructive?: boolean }
      const message = data.destructive ? 'Workflow force stopped' : 'Workflow stopped'
      toastsHook.showToast(message, data.destructive ? 'error' : 'info')
      toastsHook.addLog(`${message}: ${data.runId}`, data.destructive ? 'error' : 'info')
      runsHook.loadRuns()
    }))

    unsubscribers.push(wsHook.on('session_started', (payload) => {
      const data = payload as Session
      if (data.taskId && data.id) {
        const idx = tasksRef.current.findIndex(t => t.id === data.taskId)
        if (idx >= 0) {
          const updatedTasks = [...tasksRef.current]
          updatedTasks[idx] = {
            ...updatedTasks[idx],
            sessionId: data.id,
            sessionUrl: `/#session/${encodeURIComponent(data.id)}`,
          }
          tasksHook.setTasks(updatedTasks)
        }
      }
      if (sessionHook.sessionId === data.id) {
        sessionHook.updateSession(data)
      }
    }))

    unsubscribers.push(wsHook.on('session_message_created', (payload) => {
      const msg = payload as SessionMessage
      if (msg.sessionId === sessionHook.sessionId) {
        sessionHook.addMessage(msg)
      }
    }))

    unsubscribers.push(wsHook.on('session_status_changed', (payload) => {
      const data = payload as Session
      if (sessionHook.sessionId === data.id) {
        sessionHook.updateSession(data)
      }
    }))

    unsubscribers.push(wsHook.on('session_completed', (payload) => {
      const data = payload as Session
      if (sessionHook.sessionId === data.id) {
        sessionHook.updateSession(data)
      }
    }))

    unsubscribers.push(wsHook.on('task_run_updated', (payload) => {
      const data = payload as { taskId: string }
      if (data.taskId) {
        tasksHook.refreshBonSummaries([data.taskId])
      }
    }))

    unsubscribers.push(wsHook.on('task_candidate_updated', (payload) => {
      const data = payload as { taskId: string }
      if (data.taskId) {
        tasksHook.refreshBonSummaries([data.taskId])
      }
    }))

    unsubscribers.push(wsHook.on('image_status', (payload) => {
      const data = payload as { status: string; message: string; errorMessage?: string }
      if (data.status === 'preparing') {
        toastsHook.addLog(`⏳ ${data.message}`, 'info')
      } else if (data.status === 'ready') {
        toastsHook.addLog(`✅ ${data.message}`, 'success')
      } else if (data.status === 'error') {
        toastsHook.addLog(`❌ ${data.message}${data.errorMessage ? ': ' + data.errorMessage : ''}`, 'error')
        toastsHook.showToast(`Container image error: ${data.errorMessage || data.message}`, 'error')
      }
    }))

    unsubscribers.push(wsHook.on('error', (payload) => {
      const data = payload as { message: string }
      toastsHook.showToast(data.message, 'error')
    }))

    // Planning chat WebSocket handlers are now managed inside usePlanningChat hook
    // to avoid stale closure issues with session state

    unsubscribers.push(wsHook.on('container_config_updated', () => {
      toastsHook.addLog('Container configuration updated', 'info')
    }))

    unsubscribers.push(wsHook.on('container_package_added', (payload) => {
      toastsHook.addLog(`Package '${(payload as { name: string }).name}' added to container config`, 'info')
    }))

    unsubscribers.push(wsHook.on('container_package_removed', () => {
      toastsHook.addLog('Package removed from container config', 'info')
    }))

    unsubscribers.push(wsHook.on('container_build_started', (payload) => {
      toastsHook.showToast('Container build started', 'info')
      toastsHook.addLog(`Container build #${(payload as { buildId: number }).buildId} started (${(payload as { imageTag: string }).imageTag})`, 'info')
    }))

    unsubscribers.push(wsHook.on('container_build_progress', () => {
      // Progress updates handled within modal
    }))

    unsubscribers.push(wsHook.on('container_build_completed', (payload) => {
      const data = payload as { status: string; buildId: number }
      if (data.status === 'success') {
        toastsHook.showToast('Container build completed successfully!', 'success')
        toastsHook.addLog(`Container build #${data.buildId} completed successfully`, 'success')
      } else if (data.status === 'failed') {
        toastsHook.showToast('Container build failed', 'error')
        toastsHook.addLog(`Container build #${data.buildId} failed`, 'error')
      }
    }))

    unsubscribers.push(wsHook.on('container_build_cancelled', (payload) => {
      toastsHook.addLog(`Container build #${(payload as { buildId: number }).buildId} cancelled`, 'info')
    }))

    unsubscribers.push(wsHook.on('container_profile_created', (payload) => {
      toastsHook.showToast(`New profile "${(payload as { name: string }).name}" created`, 'success')
    }))

    unsubscribers.push(wsHook.on('execution_started', () => {
      toastsHook.addLog('Workflow execution started', 'info')
    }))

    unsubscribers.push(wsHook.on('execution_stopped', () => {
      toastsHook.addLog('Workflow execution stopped', 'info')
      workflowControl.updateStateFromRuns(runsHook.runs)
    }))

    unsubscribers.push(wsHook.on('execution_complete', () => {
      toastsHook.addLog('Workflow execution completed', 'success')
      workflowControl.updateStateFromRuns(runsHook.runs)
    }))

    wsHook.onReconnect(() => {
      console.log('[App] Reconnected - syncing state from server')
      Promise.all([
        tasksHook.loadTasks(),
        runsHook.loadRuns(),
        optionsHook.loadOptions(),
      ]).catch(err => {
        console.error('[App] State resync failed:', err)
      })
    })

    return () => {
      unsubscribers.forEach(unsub => unsub())
    }
  }, [])

  // Initialize
  useEffect(() => {
    const init = async () => {
      await optionsHook.loadOptions()
      await modelSearchHook.loadModels()
      await runsHook.loadRuns()
      await tasksHook.loadTasks()
      await loadContainerStatus()

      runsHook.setTasksRef(tasksHook.tasks)

      const hasPaused = await workflowControl.checkPausedState()
      if (hasPaused) {
        toastsHook.showToast('Found paused workflow. Click Resume to continue.', 'info')
      }

      if (runsHook.activeRuns?.length > 0) {
        const activeRun = runsHook.activeRuns[0]
        workflowControl.setRun(activeRun)
      }

      const hashMatch = location.hash.match(/^#session\/(.+)$/)
      if (hashMatch) {
        const sessionId = decodeURIComponent(hashMatch[1])
        openModal('session', { sessionId })
      }

      toastsHook.addLog('Kanban UI ready', 'info')
    }
    init()
  }, [])

  // Periodic state sync
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    syncIntervalRef.current = setInterval(() => {
      if (wsHook.isConnected) {
        tasksHook.loadTasks().catch(() => {})
        runsHook.loadRuns().catch(() => {})
      }
    }, 30000)

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
      }
    }
  }, [wsHook.isConnected])

  // Handle hash changes
  useEffect(() => {
    const handleHashChange = () => {
      const hashMatch = location.hash.match(/^#session\/(.+)$/)
      if (hashMatch) {
        const sessionId = decodeURIComponent(hashMatch[1])
        if (activeModal !== 'session') {
          openModal('session', { sessionId })
        }
      } else if (activeModal === 'session') {
        closeModal()
      }
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [activeModal, openModal, closeModal])

  return (
    <TasksContext.Provider value={tasksHook}>
      <RunsContext.Provider value={runsHook}>
        <OptionsContext.Provider value={optionsHook}>
          <ToastContext.Provider value={toastsHook}>
            <ModelSearchContext.Provider value={modelSearchHook}>
              <SessionContext.Provider value={sessionHook}>
                <WebSocketContext.Provider value={wsHook}>
                  <WorkflowControlContext.Provider value={workflowControl}>
                    <MultiSelectContext.Provider value={multiSelectHook}>
                      <PlanningChatContext.Provider value={planningChatHook}>
                        <ModalContext.Provider value={{ activeModal, modalData, openModal, closeModal, closeTopmostModal }}>
                          <ContainerStatusContext.Provider value={{ containerStatus, isContainerEnabled, loadContainerStatus }}>
                            <SessionUsageContext.Provider value={sessionUsageHook}>
                              <div className="app-layout bg-dark-bg text-dark-text">
                              <Sidebar
                                consumedSlots={consumedSlotsValue}
                                parallelTasks={parallelTasksValue}
                                isConnected={isConnectedValue}
                                controlState={workflowControl.controlState}
                                canPause={workflowControl.canPause}
                                canResume={workflowControl.canResume}
                                canStop={workflowControl.canStop}
                                isControlLoading={workflowControl.isLoading}
                                isPaused={workflowControl.isPaused}
                                activeRunId={currentActiveRun?.id ?? null}
                                totalTasks={tasksHook.tasks.length}
                                doneCount={tasksHook.groupedTasks?.done?.length ?? 0}
                                activeCount={tasksHook.groupedTasks?.executing?.length ?? 0}
                                reviewCount={tasksHook.groupedTasks?.review?.length ?? 0}
                                isContainerEnabled={isContainerEnabled}
                                onToggleExecution={async () => {
                                  const hasPaused = await workflowControl.checkPausedState()
                                  if (hasPaused) {
                                    toastsHook.showToast('Resuming paused workflow...', 'info')
                                    await workflowControl.resume()
                                    runsHook.loadRuns()
                                    return
                                  }

                                  const isRunning = consumedSlotsValue > 0 || workflowControl.isRunning
                                  if (isRunning) {
                                    optionsHook.stopExecution().then(() => {
                                      runsHook.loadRuns()
                                      toastsHook.showToast('Workflow stopped', 'success')
                                    }).catch(e => toastsHook.showToast('Failed to stop workflow: ' + (e instanceof Error ? e.message : String(e)), 'error'))
                                  } else {
                                    const grouped = tasksHook.groupedTasks
                                    const executableTasks = (grouped?.backlog?.length ?? 0) +
                                                            (grouped?.review?.length ?? 0) +
                                                            (grouped?.executing?.length ?? 0)
                                    if (executableTasks === 0) {
                                      toastsHook.showToast('No tasks available to execute. Create some tasks first.', 'error')
                                      return
                                    }
                                    if (optionsHook.options?.showExecutionGraph) {
                                      openModal('executionGraph')
                                    } else {
                                      optionsHook.startExecution().then(() => {
                                        runsHook.loadRuns()
                                        tasksHook.loadTasks()
                                        toastsHook.showToast('Workflow run started', 'success')
                                      }).catch(e => toastsHook.showToast('Execution control failed: ' + (e instanceof Error ? e.message : String(e)), 'error'))
                                    }
                                  }
                                }}
                                onPauseExecution={async (runId: string) => {
                                  toastsHook.showToast('Pausing workflow...', 'info')
                                  const success = await workflowControl.pause(runId)
                                  if (success) {
                                    toastsHook.showToast('Workflow paused', 'success')
                                    runsHook.loadRuns()
                                  } else {
                                    toastsHook.showToast(workflowControl.error || 'Failed to pause workflow', 'error')
                                  }
                                }}
                                onResumeExecution={async (runId: string) => {
                                  toastsHook.showToast('Resuming workflow...', 'info')
                                  const success = await workflowControl.resume(runId)
                                  if (success) {
                                    toastsHook.showToast('Workflow resumed', 'success')
                                    runsHook.loadRuns()
                                  } else {
                                    toastsHook.showToast(workflowControl.error || 'Failed to resume workflow', 'error')
                                  }
                                }}
                                onStopExecution={(type: 'graceful' | 'destructive') => {
                                  workflowControl.requestStop(type)
                                }}
                                onOpenOptions={() => openModal('options')}
                                onOpenContainerConfig={() => setShowContainerConfigModal(true)}
                                onOpenTemplateModal={() => openModal('task', { mode: 'create', createStatus: 'template' })}
                                onOpenTaskModal={() => openModal('task', { mode: 'create', createStatus: 'backlog' })}
                                onArchiveAllDone={async () => {
                                  if (!confirm(`Archive all ${tasksHook.groupedTasks?.done?.length ?? 0} done task(s)?`)) return
                                  await tasksHook.archiveAllDone()
                                  toastsHook.showToast('All done tasks archived', 'success')
                                }}
                                onTogglePlanningChat={planningChatHook.togglePanel}
                              />

                              <main className="main-content">
                                <TopBar />

                                <KanbanBoard
                                  tasks={tasksHook.tasks}
                                  bonSummaries={tasksHook.bonSummaries}
                                  getTaskRunColor={runsHook.getTaskRunColor}
                                  isTaskMutationLocked={runsHook.isTaskMutationLocked}
                                  dragDrop={dragDrop}
                                  isMultiSelecting={multiSelectHook.isSelecting}
                                  getIsSelected={multiSelectHook.isSelected}
                                  columnSorts={optionsHook.options?.columnSorts}
                                  highlightedRunId={highlightedRunId}
                                  isTaskInRun={runsHook.isTaskInRun}
                                  onOpenTask={(id: string, e?: React.MouseEvent) => {
                                    if (e && (e.ctrlKey || e.metaKey)) {
                                      multiSelectHook.toggleSelection(id, e)
                                    } else {
                                      openModal('task', { taskId: id, mode: 'edit' })
                                    }
                                  }}
                                  onOpenTemplateModal={() => openModal('task', { mode: 'create', createStatus: 'template' })}
                                  onOpenTaskModal={() => openModal('task', { mode: 'create', createStatus: 'backlog' })}
                                  onDeployTemplate={(id: string) => openModal('task', { mode: 'deploy', seedTaskId: id })}
                                  onOpenTaskSessions={(id: string) => openModal('taskSessions', { taskId: id })}
                                  onApprovePlan={(id: string) => openModal('approve', { taskId: id })}
                                  onRequestRevision={(id: string) => openModal('revision', { taskId: id })}
                                  onStartSingle={(id: string) => openModal('startSingle', { taskId: id })}
                                  onRepairTask={(id: string, action: string) => tasksHook.repairTask(id, action)}
                                  onMarkDone={(id: string) => tasksHook.updateTask(id, { status: 'done', completedAt: Math.floor(Date.now() / 1000) })}
                                  onResetTask={tasksHook.resetTask}
                                  onConvertToTemplate={(id: string, event?: React.MouseEvent) => {
                                    const task = tasksHook.getTaskById(id)
                                    const taskName = task?.name || 'this task'
                                    const ctrlHeld = event?.ctrlKey || event?.metaKey || false
                                    showConfirmation('convertToTemplate', id, taskName, ctrlHeld)
                                  }}
                                  onArchiveTask={(id: string, event?: React.MouseEvent) => {
                                    const task = tasksHook.getTaskById(id)
                                    const taskName = task?.name || 'this task'
                                    const ctrlHeld = event?.ctrlKey || event?.metaKey || false
                                    showConfirmation('delete', id, taskName, ctrlHeld)
                                  }}
                                  onArchiveAllDone={async () => {
                                    if (!confirm(`Archive all ${tasksHook.groupedTasks?.done?.length ?? 0} done task(s)?`)) return
                                    await tasksHook.archiveAllDone()
                                    toastsHook.showToast('All done tasks archived', 'success')
                                  }}
                                  onViewRuns={(id: string) => openModal('bestOfNDetail', { taskId: id })}
                                  onContinueReviews={(id: string) => tasksHook.repairTask(id, 'continue_with_more_reviews')}
                                  onChangeColumnSort={(status: string, sort: string) => {
                                    const newSorts = { ...(optionsHook.options?.columnSorts || {}), [status]: sort }
                                    optionsHook.updateOptions({ columnSorts: newSorts })
                                  }}
                                />

                                <TabbedLogPanel
                                  collapsed={logPanelCollapsed}
                                  onCollapsedChange={setLogPanelCollapsed}
                                  logs={toastsHook.logs}
                                  runs={runsHook.runs}
                                  staleRuns={runsHook.staleRuns}
                                  onClear={toastsHook.clearLogs}
                                  onArchiveRun={async (id: string) => {
                                    try {
                                      await runsHook.archiveRun(id)
                                      toastsHook.showToast('Run archived', 'success')
                                    } catch (e) {
                                      toastsHook.showToast('Failed to archive run: ' + (e instanceof Error ? e.message : String(e)), 'error')
                                    }
                                  }}
                                  onArchiveAllStaleRuns={async () => {
                                    const staleCount = runsHook.staleRuns?.length ?? 0
                                    if (staleCount === 0) return
                                    if (!confirm(`Archive ${staleCount} stale workflow run${staleCount > 1 ? 's' : ''}?`)) return
                                    try {
                                      await Promise.all(runsHook.staleRuns.map(run => runsHook.archiveRun(run.id)))
                                      toastsHook.showToast(`${staleCount} stale run${staleCount > 1 ? 's' : ''} archived`, 'success')
                                    } catch (e) {
                                      toastsHook.showToast('Failed to archive runs: ' + (e instanceof Error ? e.message : String(e)), 'error')
                                    }
                                  }}
                                  onHighlightRun={(runId: string) => setHighlightedRunId(runId)}
                                  onClearHighlight={() => setHighlightedRunId(null)}
                                />
                              </main>

                              <ToastContainer
                                toasts={toastsHook.toasts}
                                bottomOffset={logPanelCollapsed ? 16 : 200}
                                onRemove={toastsHook.removeToast}
                              />

                              {multiSelectHook.isSelecting && (
                                <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-dark-surface border border-dark-border rounded-lg shadow-lg px-4 py-3 flex items-center gap-4 z-50">
                                  <span className="text-sm font-medium text-dark-text">
                                    {multiSelectHook.selectedCount} task{multiSelectHook.selectedCount === 1 ? '' : 's'} selected
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <button
                                      className="btn btn-primary btn-sm"
                                      onClick={() => openModal('batchEdit', { taskIds: multiSelectHook.getSelectedIds() })}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      className="btn btn-sm"
                                      onClick={multiSelectHook.clearSelection}
                                    >
                                      Clear
                                    </button>
                                  </div>
                                </div>
                              )}

                              {activeModal === 'task' && (
                                <TaskModal
                                  mode={(modalData.mode as string) || 'create'}
                                  taskId={modalData.taskId as string | undefined}
                                  createStatus={(modalData.createStatus as 'template' | 'backlog') || 'backlog'}
                                  seedTaskId={modalData.seedTaskId as string | undefined}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'options' && (
                                <OptionsModal onClose={closeModal} />
                              )}

                              {activeModal === 'executionGraph' && (
                                <ExecutionGraphModal onClose={closeModal} />
                              )}

                              {activeModal === 'approve' && (
                                <ApproveModal
                                  taskId={modalData.taskId as string}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'revision' && (
                                <RevisionModal
                                  taskId={modalData.taskId as string}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'startSingle' && (
                                <StartSingleModal
                                  taskId={modalData.taskId as string}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'session' && (
                                <SessionModal
                                  sessionId={modalData.sessionId as string}
                                  onClose={() => {
                                    closeModal()
                                    if (location.hash.startsWith('#session/')) {
                                      history.pushState(null, '', location.pathname + location.search)
                                    }
                                  }}
                                />
                              )}

                              {activeModal === 'taskSessions' && (
                                <TaskSessionsModal
                                  taskId={modalData.taskId as string}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'bestOfNDetail' && (
                                <BestOfNDetailModal
                                  taskId={modalData.taskId as string}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'batchEdit' && (
                                <BatchEditModal
                                  taskIds={(modalData.taskIds as string[]) || []}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'planningPrompt' && (
                                <PlanningPromptModal onClose={closeModal} />
                              )}

                              <ContainerConfigModal
                                isOpen={showContainerConfigModal}
                                onClose={() => setShowContainerConfigModal(false)}
                              />

                              <StopConfirmModal
                                isOpen={showStopConfirmModal || workflowControl.isConfirmingStop}
                                runName={currentActiveRun?.displayName}
                                isStopping={workflowControl.isStopping}
                                onClose={() => {
                                  setShowStopConfirmModal(false)
                                  workflowControl.cancelStop()
                                }}
                                onConfirmGraceful={async () => {
                                  toastsHook.showToast('Pausing workflow gracefully...', 'info')
                                  workflowControl.requestStop('graceful')
                                  const success = await workflowControl.confirmStop()
                                  if (success) {
                                    toastsHook.showToast('Workflow paused gracefully - work preserved', 'success')
                                    runsHook.loadRuns()
                                  } else {
                                    toastsHook.showToast(workflowControl.error || 'Failed to pause workflow', 'error')
                                  }
                                }}
                                onConfirmDestructive={async () => {
                                  toastsHook.showToast('STOPPING workflow - killing all containers...', 'info')
                                  const success = await workflowControl.confirmStop()
                                  if (success) {
                                    const result = workflowControl.lastResult
                                    toastsHook.showToast(`Workflow STOPPED. Killed ${result?.killed || 0} processes, deleted ${result?.cleaned || 0} containers.`, 'warning')
                                    runsHook.loadRuns()
                                    tasksHook.loadTasks()
                                  } else {
                                    toastsHook.showToast(workflowControl.error || 'Failed to stop workflow', 'error')
                                  }
                                }}
                              />

                              <ConfirmModal
                                isOpen={showConfirmModal}
                                action={confirmModalAction}
                                taskName={confirmModalTaskName}
                                onClose={() => {
                                  setShowConfirmModal(false)
                                  setConfirmModalTaskId(null)
                                }}
                                onConfirm={handleConfirmModalConfirm}
                              />

                              <ChatContainer />
                              </div>
                            </SessionUsageContext.Provider>
                          </ContainerStatusContext.Provider>
                        </ModalContext.Provider>
                      </PlanningChatContext.Provider>
                    </MultiSelectContext.Provider>
                  </WorkflowControlContext.Provider>
                </WebSocketContext.Provider>
              </SessionContext.Provider>
            </ModelSearchContext.Provider>
          </ToastContext.Provider>
        </OptionsContext.Provider>
      </RunsContext.Provider>
    </TasksContext.Provider>
  )
}

export default App
