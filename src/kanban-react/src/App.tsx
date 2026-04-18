import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import './styles/theme.css'
import {
  TasksContext, RunsContext, OptionsContext, ToastContext,
  ModelSearchContext, SessionContext, WebSocketContext,
  WorkflowControlContext, MultiSelectContext, PlanningChatContext,
  ModalContext, ContainerStatusContext, SessionUsageContext, TaskLastUpdateContext,
  TaskGroupsContext,
} from '@/contexts/AppContext'
// Direct imports from hook files (avoid barrel file)
import { useTasks } from '@/hooks/useTasks'
import { useRuns } from '@/hooks/useRuns'
import { useOptions } from '@/hooks/useOptions'
import { useToasts } from '@/hooks/useToasts'
import { useModelSearch } from '@/hooks/useModelSearch'
import { useSession } from '@/hooks/useSession'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useWorkflowControl } from '@/hooks/useWorkflowControl'
import { useMultiSelect } from '@/hooks/useMultiSelect'
import { usePlanningChat } from '@/hooks/usePlanningChat'
import { useDragDrop } from '@/hooks/useDragDrop'
import { useKeyboard } from '@/hooks/useKeyboard'
import { useSessionUsage } from '@/hooks/useSessionUsage'
import { useTaskLastUpdate } from '@/hooks/useTaskLastUpdate'
import { useTaskGroups } from '@/hooks/useTaskGroups'
import { useWebSocketHandlers } from '@/hooks/useWebSocketHandlers'
import { validateTaskDrop, validateGroupDrop } from '@/utils/dropValidation'
import type { DropAction } from '@/utils/dropValidation'
import type { Task, TaskStatus, TaskGroup } from '@/types'

// Components (direct imports from source files)
import { Sidebar } from '@/components/board/Sidebar'
import { TopBar } from '@/components/board/TopBar'
import { KanbanBoard } from '@/components/board/KanbanBoard'
import { GroupActionBar } from '@/components/board/GroupActionBar'
import { TabbedLogPanel } from '@/components/common/TabbedLogPanel'
import { ToastContainer } from '@/components/common/ToastContainer'
import { ChatContainer } from '@/components/chat/ChatContainer'

// Modals (direct imports from source files)
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
import { GroupCreateModal } from '@/components/modals/GroupCreateModal'
import { RestoreToGroupModal } from '@/components/modals/RestoreToGroupModal'

function App() {
  // Container status
  const [containerStatus, setContainerStatus] = useState<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)
  const isContainerEnabled = containerStatus?.enabled ?? false

  const loadContainerStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/container/status")
      setContainerStatus(await response.json())
    } catch {
      setContainerStatus({ enabled: false, available: false, hasRunningWorkflows: false, message: "Failed to load status" })
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
  const taskLastUpdateHook = useTaskLastUpdate(wsHook)
  const taskGroupsHook = useTaskGroups()

  // Workflow control
  const workflowControl = useWorkflowControl(
    (state) => {
      toastsHook.addLog(`Workflow state: ${state}`, "info")
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
  const [confirmModalAction, setConfirmModalAction] = useState<"delete" | "convertToTemplate">("delete")
  const [confirmModalTaskId, setConfirmModalTaskId] = useState<string | null>(null)
  const [confirmModalTaskName, setConfirmModalTaskName] = useState('')
  const [logPanelCollapsed, setLogPanelCollapsed] = useState(false)
  const [highlightedRunId, setHighlightedRunId] = useState<string | null>(null)
  const [showGroupCreateModal, setShowGroupCreateModal] = useState(false)
  const [groupCreateModalData, setGroupCreateModalData] = useState<{ taskIds: string[]; defaultName?: string }>({ taskIds: [] })

  // Restore to group modal state
  const [showRestoreModal, setShowRestoreModal] = useState(false)
  const [pendingRestoreTask, setPendingRestoreTask] = useState<Task | null>(null)
  const [pendingRestoreGroup, setPendingRestoreGroup] = useState<TaskGroup | null>(null)

  // Computed
  const isAnyModalOpen = activeModal !== null || showContainerConfigModal || showStopConfirmModal || showConfirmModal || showGroupCreateModal || showRestoreModal
  const consumedSlotsValue = runsHook.consumedRunSlots
  const parallelTasksValue = optionsHook.options?.parallelTasks ?? 1
  const isConnectedValue = wsHook.isConnected
  const currentActiveRun = runsHook.activeRuns[0] || null

  // Build group members map from tasks with groupId
  const groupMembers = useMemo(() => {
    const members: Record<string, string[]> = {}
    for (const task of tasksHook.tasks) {
      if (task.groupId) {
        if (!members[task.groupId]) {
          members[task.groupId] = []
        }
        members[task.groupId].push(task.id)
      }
    }
    return members
  }, [tasksHook.tasks])

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
    if (showRestoreModal) {
      setShowRestoreModal(false)
      setPendingRestoreTask(null)
      setPendingRestoreGroup(null)
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
    if (showGroupCreateModal) {
      setShowGroupCreateModal(false)
      multiSelectHook.cancelGroupCreation()
      return true
    }
    return false
  }, [activeModal, showRestoreModal, showContainerConfigModal, showStopConfirmModal, showConfirmModal, showGroupCreateModal, closeModal, multiSelectHook])

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

  // Handle restore to group choice
  const handleRestoreToGroup = useCallback(async () => {
    if (!pendingRestoreTask) return
    try {
      await tasksHook.resetTaskToGroup(pendingRestoreTask.id)
      toastsHook.showToast(`Task restored to group "${pendingRestoreGroup?.name}"`, "success")
      await tasksHook.loadTasks()
    } catch (e) {
      toastsHook.showToast("Restore to group failed: " + (e instanceof Error ? e.message : String(e)), "error")
    } finally {
      setShowRestoreModal(false)
      setPendingRestoreTask(null)
      setPendingRestoreGroup(null)
    }
  }, [pendingRestoreTask, pendingRestoreGroup, tasksHook, toastsHook])

  const handleMoveToBacklog = useCallback(async () => {
    if (!pendingRestoreTask) return
    try {
      // Remove task from its group when moving to general backlog
      await tasksHook.moveTaskToGroup(pendingRestoreTask.id, null)
      toastsHook.showToast("Task moved to general backlog", "info")
      await tasksHook.loadTasks()
    } catch (e) {
      toastsHook.showToast("Move to backlog failed: " + (e instanceof Error ? e.message : String(e)), "error")
    } finally {
      setShowRestoreModal(false)
      setPendingRestoreTask(null)
      setPendingRestoreGroup(null)
    }
  }, [pendingRestoreTask, tasksHook, toastsHook])

  // Drag and drop handler with group support
  const dragDrop = useDragDrop(async (taskId: string, target: string, action: DropAction) => {
    const task = tasksHook.getTaskById(taskId)
    if (!task) return

    // Handle group-related actions
    if (action === 'add-to-group') {
      // Validate that task can be added to group
      const validation = validateGroupDrop(
        task,
        task.groupId ? 'group' : 'backlog',
        target,
        task.groupId ?? null
      )

      if (!validation.allowed) {
        if (validation.reason && validation.reason !== 'no-change') {
          toastsHook.showToast(validation.reason, 'error')
        }
        return
      }

      try {
        await taskGroupsHook.addTasksToGroup(target, [taskId])
        await tasksHook.loadTasks()
        toastsHook.showToast('Task added to group', 'success')
      } catch (e) {
        toastsHook.showToast('Failed to add task to group: ' + (e instanceof Error ? e.message : String(e)), 'error')
      }
      return
    }

    if (action === 'remove-from-group') {
      // Validate removal from group
      const validation = validateGroupDrop(
        task,
        'group',
        null,
        task.groupId ?? null
      )

      if (!validation.allowed) {
        if (validation.reason && validation.reason !== 'no-change') {
          toastsHook.showToast(validation.reason, 'error')
        }
        return
      }

      if (!task.groupId) {
        toastsHook.showToast('Task is not in a group', 'error')
        return
      }

      try {
        await taskGroupsHook.removeTasksFromGroup(task.groupId, [taskId])
        await tasksHook.loadTasks()
        toastsHook.showToast('Task removed from group', 'success')
      } catch (e) {
        toastsHook.showToast('Failed to remove task from group: ' + (e instanceof Error ? e.message : String(e)), 'error')
      }
      return
    }

    // Handle column drops (original behavior)
    const validation = validateTaskDrop(
      task,
      target as TaskStatus,
      runsHook.isTaskMutationLocked(taskId)
    )

    if (!validation.allowed) {
      if (validation.reason !== "no-change") {
        toastsHook.showToast(validation.reason, "error")
      }
      return
    }

    try {
      switch (validation.action) {
        case "move-to-done":
          await tasksHook.updateTask(taskId, {
            status: "done" as TaskStatus,
            completedAt: Math.floor(Date.now() / 1000),
          })
          toastsHook.showToast("Task moved to Done", "success")
          break
        case "reset-to-backlog":
          {
            const result = await tasksHook.resetTask(taskId)
            // If task was in a group, show restore modal
            if (result.wasInGroup && result.group) {
              setPendingRestoreTask(result.task)
              setPendingRestoreGroup(result.group)
              setShowRestoreModal(true)
              return
            }
          }
          break
        case "move-to-review":
          await tasksHook.updateTask(taskId, { status: "review" as TaskStatus })
          toastsHook.showToast("Task moved to Review", "success")
          break
      }
      await tasksHook.loadTasks()
    } catch (e) {
      toastsHook.showToast("Move failed: " + (e instanceof Error ? e.message : String(e)), "error")
    }
  })

  // Group modal helpers
  const openGroupCreateModal = useCallback((taskIds: string[]) => {
    if (taskIds.length < 2) {
      toastsHook.showToast('Select at least 2 tasks to create a group', 'error')
      return
    }
    const defaultName = `Group ${taskGroupsHook.activeGroups.length + 1}`
    setGroupCreateModalData({ taskIds, defaultName })
    setShowGroupCreateModal(true)
    multiSelectHook.startGroupCreation()
  }, [taskGroupsHook.activeGroups.length, multiSelectHook, toastsHook])

  const closeGroupCreateModal = useCallback(() => {
    setShowGroupCreateModal(false)
    setGroupCreateModalData({ taskIds: [] })
    multiSelectHook.cancelGroupCreation()
  }, [multiSelectHook])

  const handleCreateGroup = useCallback(async (name: string) => {
    const { taskIds } = groupCreateModalData
    if (taskIds.length === 0) return

    try {
      await taskGroupsHook.createGroup(taskIds, name)
      setShowGroupCreateModal(false)
      setGroupCreateModalData({ taskIds: [] })
      multiSelectHook.confirmGroupCreation()
      toastsHook.showToast(`Group "${name}" created successfully`, 'success')
    } catch (e) {
      toastsHook.showToast(`Failed to create group: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [groupCreateModalData, taskGroupsHook, multiSelectHook, toastsHook])

  // Keyboard shortcuts
  useKeyboard({
    onCreateTemplate: () => openModal('task', { mode: 'create', createStatus: 'template' }),
    onCreateBacklog: () => openModal('task', { mode: 'create', createStatus: 'backlog' }),
    onTogglePlanningChat: () => planningChatHook.togglePanel(),
    onCreateGroup: () => {
      if (multiSelectHook.isSelecting && multiSelectHook.selectedCount >= 2) {
        openGroupCreateModal(multiSelectHook.getSelectedIds())
      }
    },
    onCloseGroupPanel: () => taskGroupsHook.openGroup(null),
    isGroupPanelOpen: () => taskGroupsHook.activeGroupId !== null,
    selectedCount: () => multiSelectHook.selectedCount,
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
      if (showGroupCreateModal) {
        closeGroupCreateModal()
        return true
      }
      if (multiSelectHook.isSelecting) {
        multiSelectHook.clearSelection()
        return true
      }
      return closeTopmostModal()
    },
    isModalOpen: () => isAnyModalOpen,
  })

  // WebSocket event handlers - consolidated in custom hook for better state management
  useWebSocketHandlers({
    wsHook,
    tasksHook,
    runsHook,
    optionsHook,
    toastsHook,
    sessionHook,
    taskGroupsHook,
    workflowControl,
  })

  // Initialize
  useEffect(() => {
    const init = async () => {
      // Load options first as other operations may depend on it
      await optionsHook.loadOptions()

      // Parallelize independent data loading operations
      await Promise.all([
        modelSearchHook.loadModels(),
        runsHook.loadRuns(),
        tasksHook.loadTasks(),
        taskGroupsHook.loadGroups(),
        loadContainerStatus(),
      ])

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

  // Memoize context values to prevent unnecessary re-renders
  const tasksContextValue = useMemo(() => tasksHook, [tasksHook])
  const runsContextValue = useMemo(() => runsHook, [runsHook])
  const optionsContextValue = useMemo(() => optionsHook, [optionsHook])
  const toastsContextValue = useMemo(() => toastsHook, [toastsHook])
  const modelSearchContextValue = useMemo(() => modelSearchHook, [modelSearchHook])
  const sessionContextValue = useMemo(() => sessionHook, [sessionHook])
  const wsContextValue = useMemo(() => wsHook, [wsHook])
  const workflowControlContextValue = useMemo(() => workflowControl, [workflowControl])
  const multiSelectContextValue = useMemo(() => multiSelectHook, [multiSelectHook])
  const planningChatContextValue = useMemo(() => planningChatHook, [planningChatHook])
  const modalContextValue = useMemo(() => ({ activeModal, modalData, openModal, closeModal, closeTopmostModal }), [activeModal, modalData, openModal, closeModal, closeTopmostModal])
  const containerStatusContextValue = useMemo(() => ({ containerStatus, isContainerEnabled, loadContainerStatus }), [containerStatus, isContainerEnabled, loadContainerStatus])
  const sessionUsageContextValue = useMemo(() => sessionUsageHook, [sessionUsageHook])
  const taskLastUpdateContextValue = useMemo(() => taskLastUpdateHook, [taskLastUpdateHook])
  const taskGroupsContextValue = useMemo(() => taskGroupsHook, [taskGroupsHook])

  // Memoize Sidebar callbacks
  const onToggleExecution = useCallback(async () => {
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
  }, [workflowControl, toastsHook, consumedSlotsValue, optionsHook, tasksHook, runsHook, openModal])

  const onPauseExecution = useCallback(async (runId: string) => {
    toastsHook.showToast('Pausing workflow...', 'info')
    const success = await workflowControl.pause(runId)
    if (success) {
      toastsHook.showToast('Workflow paused', 'success')
      runsHook.loadRuns()
    } else {
      toastsHook.showToast(workflowControl.error || 'Failed to pause workflow', 'error')
    }
  }, [toastsHook, workflowControl, runsHook])

  const onResumeExecution = useCallback(async (runId: string) => {
    toastsHook.showToast('Resuming workflow...', 'info')
    const success = await workflowControl.resume(runId)
    if (success) {
      toastsHook.showToast('Workflow resumed', 'success')
      runsHook.loadRuns()
    } else {
      toastsHook.showToast(workflowControl.error || 'Failed to resume workflow', 'error')
    }
  }, [toastsHook, workflowControl, runsHook])

  const onStopExecution = useCallback((type: 'graceful' | 'destructive') => {
    workflowControl.requestStop(type)
  }, [workflowControl])

  const onOpenOptions = useCallback(() => openModal('options'), [openModal])
  const onOpenContainerConfig = useCallback(() => setShowContainerConfigModal(true), [setShowContainerConfigModal])
  const onOpenTemplateModal = useCallback(() => openModal('task', { mode: 'create', createStatus: 'template' }), [openModal])
  const onOpenTaskModal = useCallback(() => openModal('task', { mode: 'create', createStatus: 'backlog' }), [openModal])

  const onArchiveAllDoneSidebar = useCallback(async () => {
    if (!confirm(`Archive all ${tasksHook.groupedTasks?.done?.length ?? 0} done task(s)?`)) return
    await tasksHook.archiveAllDone()
    toastsHook.showToast('All done tasks archived', 'success')
  }, [tasksHook, toastsHook])

  const onTogglePlanningChat = useCallback(() => planningChatHook.togglePanel(), [planningChatHook])

  // Memoize KanbanBoard callbacks
  const onOpenTask = useCallback((id: string, e?: React.MouseEvent) => {
    if (e && (e.ctrlKey || e.metaKey)) {
      multiSelectHook.toggleSelection(id, e)
    } else {
      openModal('task', { taskId: id, mode: 'edit' })
    }
  }, [multiSelectHook, openModal])

  const onDeployTemplate = useCallback((id: string, e: React.MouseEvent) => {
    const ctrlHeld = e.ctrlKey || e.metaKey
    const shiftHeld = e.shiftKey

    if (!ctrlHeld) {
      openModal('task', { mode: 'deploy', seedTaskId: id })
      return
    }

    const template = tasksHook.getTaskById(id)
    if (!template) return

    const { id: _, idx, status, createdAt, updatedAt, completedAt, sessionId, sessionUrl, ...templateData } = template

    tasksHook.createTask({ ...templateData, status: 'backlog' })
      .then(() => {
        toastsHook.showToast('Template deployed', 'success')
        if (shiftHeld) {
          return tasksHook.deleteTask(id).then(() => {
            toastsHook.showToast('Template deleted after deployment', 'success')
          })
        }
      })
      .catch(e => {
        toastsHook.showToast(`Deploy failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
      })
  }, [tasksHook, toastsHook, openModal])

  const onOpenTaskSessions = useCallback((id: string) => openModal('taskSessions', { taskId: id }), [openModal])
  const onApprovePlan = useCallback((id: string) => openModal('approve', { taskId: id }), [openModal])
  const onRequestRevision = useCallback((id: string) => openModal('revision', { taskId: id }), [openModal])
  const onStartSingle = useCallback((id: string) => openModal('startSingle', { taskId: id }), [openModal])

  const onRepairTask = useCallback((id: string, action: string) => {
    tasksHook.repairTask(id, action)
  }, [tasksHook])

  const onMarkDone = useCallback((id: string) => {
    tasksHook.updateTask(id, { status: 'done', completedAt: Math.floor(Date.now() / 1000) })
  }, [tasksHook])

  const onResetTask = useCallback(async (id: string) => {
    try {
      const result = await tasksHook.resetTask(id)
      if (result.wasInGroup && result.group) {
        setPendingRestoreTask(result.task)
        setPendingRestoreGroup(result.group)
        setShowRestoreModal(true)
      }
    } catch (e) {
      toastsHook.showToast("Reset task failed: " + (e instanceof Error ? e.message : String(e)), "error")
    }
  }, [tasksHook, toastsHook])

  const onConvertToTemplate = useCallback((id: string, event?: React.MouseEvent) => {
    const task = tasksHook.getTaskById(id)
    const taskName = task?.name || 'this task'
    const ctrlHeld = event?.ctrlKey || event?.metaKey || false
    showConfirmation('convertToTemplate', id, taskName, ctrlHeld)
  }, [tasksHook, showConfirmation])

  const onArchiveTask = useCallback((id: string, event?: React.MouseEvent) => {
    const task = tasksHook.getTaskById(id)
    const taskName = task?.name || 'this task'
    const ctrlHeld = event?.ctrlKey || event?.metaKey || false
    showConfirmation('delete', id, taskName, ctrlHeld)
  }, [tasksHook, showConfirmation])

  const onArchiveAllDoneBoard = useCallback(async () => {
    if (!confirm(`Archive all ${tasksHook.groupedTasks?.done?.length ?? 0} done task(s)?`)) return
    await tasksHook.archiveAllDone()
    toastsHook.showToast('All done tasks archived', 'success')
  }, [tasksHook, toastsHook])

  const onViewRuns = useCallback((id: string) => openModal('bestOfNDetail', { taskId: id }), [openModal])

  const onContinueReviews = useCallback((id: string) => {
    tasksHook.repairTask(id, 'continue_with_more_reviews')
  }, [tasksHook])

  const onChangeColumnSort = useCallback((status: string, sort: string) => {
    const newSorts = { ...(optionsHook.options?.columnSorts || {}), [status]: sort }
    optionsHook.updateOptions({ columnSorts: newSorts })
  }, [optionsHook])

  const onVirtualCardClick = useCallback((groupId: string) => {
    taskGroupsHook.openGroup(groupId)
  }, [taskGroupsHook])

  const onDeleteGroup = useCallback((groupId: string) => {
    taskGroupsHook.deleteGroup(groupId)
  }, [taskGroupsHook])

  const onStartGroup = useCallback((groupId: string) => {
    taskGroupsHook.startGroup(groupId)
  }, [taskGroupsHook])

  const onCloseGroupPanel = useCallback(() => {
    taskGroupsHook.openGroup(null)
  }, [taskGroupsHook])

  const onRemoveTaskFromGroup = useCallback((taskId: string) => {
    const groupId = taskGroupsHook.activeGroupId
    if (groupId) {
      taskGroupsHook.removeTasksFromGroup(groupId, [taskId])
    }
  }, [taskGroupsHook])

  const onAddTasksToGroup = useCallback((taskIds: string[]) => {
    const groupId = taskGroupsHook.activeGroupId
    if (groupId) {
      taskGroupsHook.addTasksToGroup(groupId, taskIds)
    }
  }, [taskGroupsHook])

  // Memoize TabbedLogPanel callbacks
  const onArchiveRun = useCallback(async (id: string) => {
    try {
      await runsHook.archiveRun(id)
      toastsHook.showToast('Run archived', 'success')
    } catch (e) {
      toastsHook.showToast('Failed to archive run: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }, [runsHook, toastsHook])

  const onArchiveAllStaleRuns = useCallback(async () => {
    const staleCount = runsHook.staleRuns?.length ?? 0
    if (staleCount === 0) return
    if (!confirm(`Archive ${staleCount} stale workflow run${staleCount > 1 ? 's' : ''}?`)) return
    try {
      await Promise.all(runsHook.staleRuns.map(run => runsHook.archiveRun(run.id)))
      toastsHook.showToast(`${staleCount} stale run${staleCount > 1 ? 's' : ''} archived`, 'success')
    } catch (e) {
      toastsHook.showToast('Failed to archive runs: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }, [runsHook, toastsHook])

  const onHighlightRun = useCallback((runId: string) => setHighlightedRunId(runId), [setHighlightedRunId])
  const onClearHighlight = useCallback(() => setHighlightedRunId(null), [setHighlightedRunId])

  // Memoize GroupActionBar callbacks
  const onCreateGroup = useCallback(() => {
    const selectedIds = multiSelectHook.getSelectedIds()
    openGroupCreateModal(selectedIds)
  }, [multiSelectHook, openGroupCreateModal])

  const onBatchEdit = useCallback(() => openModal('batchEdit', { taskIds: multiSelectHook.getSelectedIds() }), [multiSelectHook, openModal])
  const onClearSelection = useCallback(() => multiSelectHook.clearSelection(), [multiSelectHook])

  return (
    <TasksContext.Provider value={tasksContextValue}>
      <RunsContext.Provider value={runsContextValue}>
        <OptionsContext.Provider value={optionsContextValue}>
          <ToastContext.Provider value={toastsContextValue}>
            <ModelSearchContext.Provider value={modelSearchContextValue}>
              <SessionContext.Provider value={sessionContextValue}>
                <WebSocketContext.Provider value={wsContextValue}>
                  <WorkflowControlContext.Provider value={workflowControlContextValue}>
                    <MultiSelectContext.Provider value={multiSelectContextValue}>
                      <PlanningChatContext.Provider value={planningChatContextValue}>
                        <ModalContext.Provider value={modalContextValue}>
                          <ContainerStatusContext.Provider value={containerStatusContextValue}>
                            <SessionUsageContext.Provider value={sessionUsageContextValue}>
                              <TaskLastUpdateContext.Provider value={taskLastUpdateContextValue}>
                              <TaskGroupsContext.Provider value={taskGroupsContextValue}>
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
                                onToggleExecution={onToggleExecution}
                                onPauseExecution={onPauseExecution}
                                onResumeExecution={onResumeExecution}
                                onStopExecution={onStopExecution}
                                onOpenOptions={onOpenOptions}
                                onOpenContainerConfig={onOpenContainerConfig}
                                onOpenTemplateModal={onOpenTemplateModal}
                                onOpenTaskModal={onOpenTaskModal}
                                onArchiveAllDone={onArchiveAllDoneSidebar}
                                onTogglePlanningChat={onTogglePlanningChat}
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
                                  groups={taskGroupsHook.activeGroups}
                                  groupMembers={groupMembers}
                                  activeGroupId={taskGroupsHook.activeGroupId}
                                  onOpenTask={onOpenTask}
                                  onOpenTemplateModal={onOpenTemplateModal}
                                  onOpenTaskModal={onOpenTaskModal}
                                  onDeployTemplate={onDeployTemplate}
                                  onOpenTaskSessions={onOpenTaskSessions}
                                  onApprovePlan={onApprovePlan}
                                  onRequestRevision={onRequestRevision}
                                  onStartSingle={onStartSingle}
                                  onRepairTask={onRepairTask}
                                  onMarkDone={onMarkDone}
                                  onResetTask={onResetTask}
                                  onConvertToTemplate={onConvertToTemplate}
                                  onArchiveTask={onArchiveTask}
                                  onArchiveAllDone={onArchiveAllDoneBoard}
                                  onViewRuns={onViewRuns}
                                  onContinueReviews={onContinueReviews}
                                  onChangeColumnSort={onChangeColumnSort}
                                  onVirtualCardClick={onVirtualCardClick}
                                  onDeleteGroup={onDeleteGroup}
                                  onStartGroup={onStartGroup}
                                  onCloseGroupPanel={onCloseGroupPanel}
                                  onRemoveTaskFromGroup={onRemoveTaskFromGroup}
                                  onAddTasksToGroup={onAddTasksToGroup}
                                />

                                <TabbedLogPanel
                                  collapsed={logPanelCollapsed}
                                  onCollapsedChange={setLogPanelCollapsed}
                                  logs={toastsHook.logs}
                                  runs={runsHook.runs}
                                  staleRuns={runsHook.staleRuns}
                                  onClear={toastsHook.clearLogs}
                                  onArchiveRun={onArchiveRun}
                                  onArchiveAllStaleRuns={onArchiveAllStaleRuns}
                                  onHighlightRun={onHighlightRun}
                                  onClearHighlight={onClearHighlight}
                                />
                              </main>

                              <ToastContainer
                                toasts={toastsHook.toasts}
                                bottomOffset={logPanelCollapsed ? 16 : 200}
                                onRemove={toastsHook.removeToast}
                              />

                              <GroupActionBar
                                selectedCount={multiSelectHook.selectedCount}
                                onCreateGroup={onCreateGroup}
                                onBatchEdit={onBatchEdit}
                                onClear={onClearSelection}
                              />

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

                              {showGroupCreateModal && (
                                <GroupCreateModal
                                  taskCount={multiSelectHook.selectedCount}
                                  defaultName={groupCreateModalData.defaultName}
                                  isLoading={taskGroupsHook.loading}
                                  onClose={closeGroupCreateModal}
                                  onConfirm={handleCreateGroup}
                                />
                              )}

                              <RestoreToGroupModal
                                isOpen={showRestoreModal}
                                onClose={() => {
                                  setShowRestoreModal(false)
                                  setPendingRestoreTask(null)
                                  setPendingRestoreGroup(null)
                                }}
                                task={pendingRestoreTask}
                                group={pendingRestoreGroup}
                                onRestoreToGroup={handleRestoreToGroup}
                                onMoveToBacklog={handleMoveToBacklog}
                              />

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
                              </TaskGroupsContext.Provider>
                              </TaskLastUpdateContext.Provider>
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
