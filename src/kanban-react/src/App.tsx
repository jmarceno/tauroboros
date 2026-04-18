import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import './styles/theme.css'
import {
  TasksContext, RunsContext, OptionsContext, ToastContext,
  ModelSearchContext, SessionContext, WebSocketContext,
  WorkflowControlContext, MultiSelectContext, PlanningChatContext,
  ModalContext, ContainerStatusContext, SessionUsageContext, TaskLastUpdateContext,
  TaskGroupsContext,
} from '@/contexts/AppContext'
import { TabProvider, useTabContext, type MainTabId } from '@/contexts/TabContext'

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
import type { Task, TaskGroup, TaskStatus } from '@/types'

type ModalType = 'task' | 'options' | 'executionGraph' | 'approve' | 'revision' | 'startSingle' | 'session' | 'taskSessions' | 'bestOfNDetail' | 'batchEdit' | 'planningPrompt'

const VALID_MODALS = new Set<ModalType>(['task', 'options', 'executionGraph', 'approve', 'revision', 'startSingle', 'session', 'taskSessions', 'bestOfNDetail', 'batchEdit', 'planningPrompt'])

function hasMode(data: Record<string, unknown>): data is { mode: string; taskId?: string; createStatus?: string; seedTaskId?: string } {
  return typeof data.mode === 'string'
}

function hasTaskId(data: Record<string, unknown>): data is { taskId: string } {
  return typeof data.taskId === 'string' && data.taskId.length > 0
}

function hasSessionId(data: Record<string, unknown>): data is { sessionId: string } {
  return typeof data.sessionId === 'string' && data.sessionId.length > 0
}

function hasTaskIds(data: Record<string, unknown>): data is { taskIds: string[] } {
  return Array.isArray(data.taskIds) && data.taskIds.every(id => typeof id === 'string')
}
import { Sidebar } from '@/components/board/Sidebar'
import { TopBar } from '@/components/board/TopBar'
import { KanbanBoard } from '@/components/board/KanbanBoard'
import { TabBar, OptionsTab, ContainersTab, ArchivedTasksTab, StatsTab } from '@/components/tabs'
import { GroupActionBar } from '@/components/board/GroupActionBar'
import { TabbedLogPanel } from '@/components/common/TabbedLogPanel'
import { ToastContainer } from '@/components/common/ToastContainer'
import { ChatContainer } from '@/components/chat/ChatContainer'

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
import { memo } from 'react'
import type { TaskModalProps } from '@/components/modals/TaskModal'

const MemoizedTaskModal = memo(function MemoizedTaskModal(props: TaskModalProps) {
  return <TaskModal {...props} />
}, (prevProps, nextProps) => {
  return (
    prevProps.mode === nextProps.mode &&
    prevProps.taskId === nextProps.taskId &&
    prevProps.createStatus === nextProps.createStatus &&
    prevProps.seedTaskId === nextProps.seedTaskId
  )
})

function AppContent() {
  const { activeTab, setActiveTab } = useTabContext()
  return <AppInner activeTab={activeTab} setActiveTab={setActiveTab} />
}

interface AppInnerProps {
  activeTab: MainTabId
  setActiveTab: (tab: MainTabId) => void
}

function AppInner({ activeTab, setActiveTab }: AppInnerProps) {
  const [containerStatus, setContainerStatus] = useState<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)
  const isContainerEnabled = containerStatus?.enabled ?? false

  const loadContainerStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/container/status")
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`)
      }
      setContainerStatus(await response.json())
    } catch (e) {
      setContainerStatus({ enabled: false, available: false, hasRunningWorkflows: false, message: `Failed to load status: ${e instanceof Error ? e.message : String(e)}` })
    }
  }, [])

  const optionsHook = useOptions()
  const tasksHook = useTasks(optionsHook.options?.columnSorts)
  const runsHook = useRuns()
  const modelSearchHook = useModelSearch()
  const toastsHook = useToasts()
  const sessionHook = useSession()
  const wsHook = useWebSocket()
  const multiSelectHook = useMultiSelect()
  const planningChatHook = usePlanningChat(wsHook)
  const sessionUsageHook = useSessionUsage(wsHook)
  const taskLastUpdateHook = useTaskLastUpdate(wsHook)
  const taskGroupsHook = useTaskGroups({ showToast: toastsHook.showToast })

  const workflowControl = useWorkflowControl(
    (state) => {
      toastsHook.addLog(`Workflow state: ${state}`, "info")
    },
    (run) => {
      runsHook.updateRunFromWebSocket(run)
    }
  )

  const [activeModal, setActiveModal] = useState<ModalType | null>(null)
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

  const [showRestoreModal, setShowRestoreModal] = useState(false)
  const [pendingRestoreTask, setPendingRestoreTask] = useState<Task | null>(null)
  const [pendingRestoreGroup, setPendingRestoreGroup] = useState<TaskGroup | null>(null)

  const isAnyModalOpen = activeModal !== null || showContainerConfigModal || showStopConfirmModal || showConfirmModal || showGroupCreateModal || showRestoreModal
  const consumedSlotsValue = runsHook.consumedRunSlots
  const parallelTasksValue = optionsHook.options?.parallelTasks ?? 1
  const currentActiveRun = runsHook.activeRuns[0] || null

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

  const openModal = useCallback((name: string, data?: Record<string, unknown>) => {
    if (!VALID_MODALS.has(name as ModalType)) {
      throw new Error(`Invalid modal name: ${name}. Expected one of: ${Array.from(VALID_MODALS).join(', ')}`)
    }
    setActiveModal(name as ModalType)
    setModalData(data ?? {})
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
        tasksHook.updateTask(taskId, { status: 'template' }).then(() => {
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
        await tasksHook.updateTask(taskId, { status: 'template' })
        toastsHook.showToast('Task converted to template', 'success')
      }
    } catch (e) {
      toastsHook.showToast(`${action === 'delete' ? 'Delete' : 'Convert'} failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [tasksHook, toastsHook])

  const handleConfirmModalConfirm = useCallback(() => {
    if (!confirmModalTaskId) throw new Error('No task selected for confirmation')
    executeConfirmedAction(confirmModalAction, confirmModalTaskId)
    setShowConfirmModal(false)
    setConfirmModalTaskId(null)
  }, [confirmModalAction, confirmModalTaskId, executeConfirmedAction])

  // Handle restore to group choice
  const handleRestoreToGroup = useCallback(async () => {
    if (!pendingRestoreTask) throw new Error('No pending restore task available')
    if (!pendingRestoreGroup) throw new Error('No pending restore group available')
    await tasksHook.resetTaskToGroup(pendingRestoreTask.id)
    toastsHook.showToast(`Task restored to group "${pendingRestoreGroup.name}"`, "success")
    await tasksHook.loadTasks()
    setShowRestoreModal(false)
    setPendingRestoreTask(null)
    setPendingRestoreGroup(null)
  }, [pendingRestoreTask, pendingRestoreGroup, tasksHook, toastsHook])

  const handleMoveToBacklog = useCallback(async () => {
    if (!pendingRestoreTask) throw new Error('No pending restore task available')
    // Remove task from its group when moving to general backlog
    await tasksHook.moveTaskToGroup(pendingRestoreTask.id, null)
    toastsHook.showToast("Task moved to general backlog", "info")
    await tasksHook.loadTasks()
    setShowRestoreModal(false)
    setPendingRestoreTask(null)
    setPendingRestoreGroup(null)
  }, [pendingRestoreTask, tasksHook, toastsHook])

  const dragDrop = useDragDrop(async (taskId: string, target: string, action: DropAction) => {
    const task = tasksHook.getTaskById(taskId)
    if (!task) return

    // Handle group-related actions
    if (action === 'add-to-group') {
      // Validate that task can be added to group
      // Use the actual dragSourceContext from the hook to determine where the drag started
      const sourceContext = dragDrop.dragSourceContext === 'group' ? 'group' : 'column'
      const validation = validateGroupDrop(
        task,
        sourceContext,
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
            status: "done",
            completedAt: Math.floor(Date.now() / 1000),
          })
          toastsHook.showToast("Task moved to Done", "success")
          break
        case "reset-to-backlog":
          {
            const result = await tasksHook.resetTask(taskId)
            if (result.wasInGroup && result.group) {
              setPendingRestoreTask(result.task)
              setPendingRestoreGroup(result.group)
              setShowRestoreModal(true)
              return
            }
          }
          break
        case "move-to-review":
          await tasksHook.updateTask(taskId, { status: "review" })
          toastsHook.showToast("Task moved to Review", "success")
          break
      }
      await tasksHook.loadTasks()
    } catch (e) {
      toastsHook.showToast("Move failed: " + (e instanceof Error ? e.message : String(e)), "error")
    }
  })

  const openGroupCreateModal = useCallback((taskIds: string[]) => {
    if (taskIds.length < 2) {
      toastsHook.showToast('Select at least 2 tasks to create a group', 'error')
      return
    }
    const defaultName = `Group ${taskGroupsHook.activeGroups.length + 1}`
    setGroupCreateModalData({ taskIds, defaultName })
    setShowGroupCreateModal(true)
    multiSelectHook.startGroupCreation()
  }, [taskGroupsHook.activeGroups, multiSelectHook, toastsHook])

  const closeGroupCreateModal = useCallback(() => {
    setShowGroupCreateModal(false)
    setGroupCreateModalData({ taskIds: [] })
    multiSelectHook.cancelGroupCreation()
  }, [multiSelectHook])

  const handleCreateGroup = useCallback(async (name: string) => {
    const { taskIds } = groupCreateModalData
    if (taskIds.length === 0) throw new Error('No tasks selected for group creation')

    await taskGroupsHook.createGroup(taskIds, name)
    setShowGroupCreateModal(false)
    setGroupCreateModalData({ taskIds: [] })
    multiSelectHook.confirmGroupCreation()
    toastsHook.showToast(`Group "${name}" created successfully`, 'success')
  }, [groupCreateModalData, taskGroupsHook, multiSelectHook, toastsHook])

  const onSwitchTab = useCallback((tabIndex: number) => {
    if (tabIndex < 1 || tabIndex > 5) {
      throw new Error(`Invalid tab index: ${tabIndex}. Expected 1-5.`)
    }
    const tabs: MainTabId[] = ['kanban', 'options', 'containers', 'archived', 'stats']
    const targetTab = tabs[tabIndex - 1]
    if (!targetTab) {
      throw new Error(`Tab at index ${tabIndex} is not defined.`)
    }
    setActiveTab(targetTab)
  }, [setActiveTab])

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
    onSwitchTab,
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
      const result = await tasksHook.archiveAllDone()
      toastsHook.showToast(`${result.archived} tasks archived, ${result.deleted} deleted`, 'success')
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

  useWebSocketHandlers(wsHook)

  // Use ref to ensure init only runs once, preventing infinite re-renders
  const hasInitializedRef = useRef(false)
  useEffect(() => {
    if (hasInitializedRef.current) return
    hasInitializedRef.current = true
    
    let cancelled = false
    const init = async () => {
      await optionsHook.loadOptions()

      await Promise.all([
        modelSearchHook.loadModels(),
        runsHook.loadRuns(),
        tasksHook.loadTasks(),
        taskGroupsHook.loadGroups(),
        loadContainerStatus(),
      ])

      if (cancelled) return

      runsHook.setTasksRef(tasksHook.tasks)

      const hasPaused = await workflowControl.checkPausedState()
      if (hasPaused && !cancelled) {
        toastsHook.showToast('Found paused workflow. Click Resume to continue.', 'info')
      }

      if (runsHook.activeRuns?.length > 0 && !cancelled) {
        const activeRun = runsHook.activeRuns[0]
        workflowControl.setRun(activeRun)
      }

      const hashMatch = window.location.hash.match(/^#session\/(.+)$/)
      if (hashMatch && !cancelled) {
        const sessionId = decodeURIComponent(hashMatch[1])
        openModal('session', { sessionId })
      }

      if (!cancelled) {
        toastsHook.addLog('Kanban UI ready', 'info')
      }
    }
    init()
    return () => { cancelled = true }
    // Initialization runs once on mount. Dependencies are intentionally excluded
    // to prevent re-running when hook references change - initialization is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncErrorCountRef = useRef(0)
  const MAX_SYNC_ERRORS = 5

  useEffect(() => {
    syncIntervalRef.current = setInterval(() => {
      if (wsHook.isConnected) {
        Promise.all([
          tasksHook.loadTasks(),
          runsHook.loadRuns()
        ]).catch((e) => {
          syncErrorCountRef.current += 1
          const errorMessage = e instanceof Error ? e.message : String(e)
          toastsHook.addLog(`Sync failed (${syncErrorCountRef.current}/${MAX_SYNC_ERRORS}): ${errorMessage}`, 'error')
          
          if (syncErrorCountRef.current >= MAX_SYNC_ERRORS) {
            toastsHook.showToast(`Auto-sync disabled after ${MAX_SYNC_ERRORS} consecutive failures. Check connection.`, 'error')
            if (syncIntervalRef.current) {
              clearInterval(syncIntervalRef.current)
              syncIntervalRef.current = null
            }
          }
        })
      }
    }, 30000)

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
      }
    }
  }, [wsHook.isConnected, tasksHook.loadTasks, runsHook.loadRuns, toastsHook])

  useEffect(() => {
    const handleHashChange = () => {
      const hashMatch = window.location.hash.match(/^#session\/(.+)$/)
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

  const modalContextValue = useMemo(() => ({ activeModal, modalData, openModal, closeModal, closeTopmostModal }), [activeModal, modalData, openModal, closeModal, closeTopmostModal])
  const containerStatusContextValue = useMemo(() => ({ containerStatus, isContainerEnabled, loadContainerStatus }), [containerStatus, isContainerEnabled, loadContainerStatus])

  const onToggleExecution = useCallback(async () => {
    const hasPaused = await workflowControl.checkPausedState()
    if (hasPaused) {
      toastsHook.showToast('Resuming paused workflow...', 'info')
      await workflowControl.resume()
      await runsHook.loadRuns()
      return
    }

    const isRunning = consumedSlotsValue > 0 || workflowControl.isRunning
    if (isRunning) {
      try {
        await optionsHook.stopExecution()
        await runsHook.loadRuns()
        toastsHook.showToast('Workflow stopped', 'success')
      } catch (e) {
        toastsHook.showToast('Failed to stop workflow: ' + (e instanceof Error ? e.message : String(e)), 'error')
      }
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
        try {
          await optionsHook.startExecution()
          await runsHook.loadRuns()
          await tasksHook.loadTasks()
          toastsHook.showToast('Workflow run started', 'success')
        } catch (e) {
          toastsHook.showToast('Execution control failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
        }
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

  const onOpenTemplateModal = useCallback(() => openModal('task', { mode: 'create', createStatus: 'template' }), [openModal])
  const onOpenTaskModal = useCallback(() => openModal('task', { mode: 'create', createStatus: 'backlog' }), [openModal])

  const onArchiveAllDoneSidebar = useCallback(async () => {
    const doneCount = tasksHook.groupedTasks?.done?.length ?? 0
    if (doneCount === 0) {
      toastsHook.showToast('No done tasks to archive', 'error')
      return
    }
    if (!confirm(`Archive all ${doneCount} done task(s)?`)) return
    const result = await tasksHook.archiveAllDone()
    toastsHook.showToast(`${result.archived} tasks archived, ${result.deleted} deleted`, 'success')
  }, [tasksHook, toastsHook])

  const onTogglePlanningChat = useCallback(() => planningChatHook.togglePanel(), [planningChatHook])

  const onOpenTask = useCallback((id: string, e?: React.MouseEvent) => {
    if (e && (e.ctrlKey || e.metaKey)) {
      multiSelectHook.toggleSelection(id, e)
    } else {
      openModal('task', { taskId: id, mode: 'edit' })
    }
  }, [multiSelectHook, openModal])

  const onDeployTemplate = useCallback(async (id: string, e: React.MouseEvent) => {
    const ctrlHeld = e.ctrlKey || e.metaKey
    const shiftHeld = e.shiftKey

    if (!ctrlHeld) {
      openModal('task', { mode: 'deploy', seedTaskId: id })
      return
    }

    const template = tasksHook.getTaskById(id)
    if (!template) return

    const { id: _, idx, status, createdAt, updatedAt, completedAt, sessionId, sessionUrl, ...templateData } = template

    try {
      await tasksHook.createTask({ ...templateData, status: 'backlog' })
      toastsHook.showToast('Template deployed', 'success')
      if (shiftHeld) {
        await tasksHook.deleteTask(id)
        toastsHook.showToast('Template deleted after deployment', 'success')
      }
    } catch (e) {
      toastsHook.showToast(`Deploy failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
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
    const doneCount = tasksHook.groupedTasks?.done?.length ?? 0
    if (doneCount === 0) {
      toastsHook.showToast('No done tasks to archive', 'error')
      return
    }
    if (!confirm(`Archive all ${doneCount} done task(s)?`)) return
    const result = await tasksHook.archiveAllDone()
    toastsHook.showToast(`${result.archived} tasks archived, ${result.deleted} deleted`, 'success')
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

  const onRenameGroup = useCallback(async (groupId: string, newName: string) => {
    await taskGroupsHook.updateGroup(groupId, { name: newName })
  }, [taskGroupsHook])

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

  const onCreateGroup = useCallback(() => {
    const selectedIds = multiSelectHook.getSelectedIds()
    openGroupCreateModal(selectedIds)
  }, [multiSelectHook, openGroupCreateModal])

  const onBatchEdit = useCallback(() => openModal('batchEdit', { taskIds: multiSelectHook.getSelectedIds() }), [multiSelectHook, openModal])
  const onClearSelection = useCallback(() => multiSelectHook.clearSelection(), [multiSelectHook])

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
                        <ModalContext.Provider value={modalContextValue}>
                          <ContainerStatusContext.Provider value={containerStatusContextValue}>
                            <SessionUsageContext.Provider value={sessionUsageHook}>
                              <TaskLastUpdateContext.Provider value={taskLastUpdateHook}>
                              <TaskGroupsContext.Provider value={taskGroupsHook}>
                              <div className="app-layout bg-dark-bg text-dark-text">
                              <Sidebar
                                consumedSlots={consumedSlotsValue}
                                parallelTasks={parallelTasksValue}
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
                                onToggleExecution={onToggleExecution}
                                onPauseExecution={onPauseExecution}
                                onResumeExecution={onResumeExecution}
                                onStopExecution={onStopExecution}
                                onOpenTemplateModal={onOpenTemplateModal}
                                onOpenTaskModal={onOpenTaskModal}
                                onArchiveAllDone={onArchiveAllDoneSidebar}
                                onTogglePlanningChat={onTogglePlanningChat}
                              />

                              <main className="main-content">
                                <TopBar />
                                <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

                                {activeTab === 'kanban' && (
                                  <KanbanBoard
                                  logPanelCollapsed={logPanelCollapsed}
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
                                  onRenameGroup={onRenameGroup}
                                />
                                )}

                                {activeTab === 'options' && <OptionsTab />}

                                {activeTab === 'containers' && <ContainersTab />}

                                {activeTab === 'archived' && <ArchivedTasksTab />}

                                {activeTab === 'stats' && <StatsTab />}

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

                              {activeModal === 'task' && hasMode(modalData) && ['create', 'edit', 'deploy'].includes(modalData.mode) && (
                                <MemoizedTaskModal
                                  mode={modalData.mode as 'create' | 'edit' | 'deploy'}
                                  taskId={hasTaskId(modalData) ? modalData.taskId : undefined}
                                  createStatus={modalData.createStatus === 'template' ? 'template' : 'backlog'}
                                  seedTaskId={typeof modalData.seedTaskId === 'string' ? modalData.seedTaskId : undefined}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'options' && (
                                <OptionsModal onClose={closeModal} />
                              )}

                              {activeModal === 'executionGraph' && (
                                <ExecutionGraphModal onClose={closeModal} />
                              )}

                              {activeModal === 'approve' && hasTaskId(modalData) && (
                                <ApproveModal
                                  taskId={modalData.taskId}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'revision' && hasTaskId(modalData) && (
                                <RevisionModal
                                  taskId={modalData.taskId}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'startSingle' && hasTaskId(modalData) && (
                                <StartSingleModal
                                  taskId={modalData.taskId}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'session' && hasSessionId(modalData) && (
                                <SessionModal
                                  sessionId={modalData.sessionId}
                                  onClose={() => {
                                    closeModal()
                                    if (location.hash.startsWith('#session/')) {
                                      history.pushState(null, '', location.pathname + location.search)
                                    }
                                  }}
                                />
                              )}

                              {activeModal === 'taskSessions' && hasTaskId(modalData) && (
                                <TaskSessionsModal
                                  taskId={modalData.taskId}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'bestOfNDetail' && hasTaskId(modalData) && (
                                <BestOfNDetailModal
                                  taskId={modalData.taskId}
                                  onClose={closeModal}
                                />
                              )}

                              {activeModal === 'batchEdit' && hasTaskIds(modalData) && (
                                <BatchEditModal
                                  taskIds={modalData.taskIds}
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
                                    toastsHook.showToast(`Workflow STOPPED. Killed ${result?.killed ?? 0} processes, deleted ${result?.cleaned ?? 0} containers.`, 'error')
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

function App() {
  return (
    <TabProvider>
      <AppContent />
    </TabProvider>
  )
}

export default App
