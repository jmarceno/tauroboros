/**
 * Main App Component - Full React feature parity
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, createMemo, onMount, Show, onCleanup } from 'solid-js'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { SolidQueryDevtools } from '@tanstack/solid-query-devtools'
import './styles/theme.css'

import {
  createTasksStore,
  createRunsStore,
  createOptionsStore,
  createTaskGroupsStore,
  createWorkflowControlStore,
  createModelSearchStore,
  createWebSocketStore,
  createMultiSelectStore,
  createDragDropStore,
  createPlanningChatStore,
  createSessionUsageStore,
  createTaskLastUpdateStore,
  tabStore,
  uiStore,
} from '@/stores'

import {
  containersApi,
  runApiEffect,
  Sidebar,
  TopBar,
  KanbanBoard,
  GroupActionBar,
  TabbedLogPanel,
  ToastContainer,
  TaskModal,
  ConfirmModal,
  GroupCreateModal,
  // Tab components
  OptionsTab,
  StatsTab,
  ContainersTab,
  ArchivedTasksTab,
  SelfHealReportsTab,
  TabBar,
  // Modal components
  ApproveModal,
  BatchEditModal,
  BestOfNDetailModal,
  ExecutionGraphModal,
  OptionsModal,
  PlanningPromptModal,
  RestoreToGroupModal,
  RevisionModal,
  SessionModal,
  StartSingleModal,
  StopConfirmModal,
  TaskSessionsModal,
  ChatContainer,
} from '@/components'

import type { Task, TaskGroup, TaskStatus } from '@/types'
import { validateTaskDrop, validateGroupDrop } from '@/utils/dropValidation'
import type { DropAction } from '@/utils/dropValidation'

// Create query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 3,
    },
  },
})

function App() {
  // Initialize stores
  const tasksStore = createTasksStore()
  const runsStore = createRunsStore()
  const optionsStore = createOptionsStore()
  const taskGroupsStore = createTaskGroupsStore()
  const wsStore = createWebSocketStore()
  const modelSearchStore = createModelSearchStore()
  const multiSelectStore = createMultiSelectStore()
  const planningChatStore = createPlanningChatStore(wsStore)
  const sessionUsage = createSessionUsageStore()
  
  const workflowControl = createWorkflowControlStore(
    (state) => uiStore.addLog(`Workflow state: ${state}`, 'info'),
    (run) => runsStore.updateRunFromWebSocket(run)
  )
  const taskLastUpdate = createTaskLastUpdateStore()

  // Local state
  const [logPanelCollapsed, setLogPanelCollapsed] = createSignal(false)
  const [highlightedRunId, setHighlightedRunId] = createSignal<string | null>(null)
  const [containerStatus, setContainerStatus] = createSignal<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)

  // Load container status
  const loadContainerStatus = async () => {
    try {
      setContainerStatus(await runApiEffect(containersApi.getStatus()))
    } catch (e) {
      setContainerStatus({ enabled: false, available: false, hasRunningWorkflows: false, message: `Failed to load status: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  // Drag & drop store with handler
  const dragDrop = createDragDropStore(async (taskId: string, target: string, action: DropAction) => {
    const task = tasksStore.getTaskById(taskId)
    if (!task) return

    // Handle group-related actions
    if (action === 'add-to-group') {
      // Validate that task can be added to group
      const sourceContext = dragDrop.dragSourceContext() === 'group' ? 'group' : 'column'
      const validation = validateGroupDrop(
        task,
        sourceContext,
        target,
        task.groupId ?? null
      )

      if (!validation.allowed) {
        if (validation.reason && validation.reason !== 'no-change') {
          uiStore.showToast(validation.reason, 'error')
        }
        return
      }

      try {
        await taskGroupsStore.addTasksToGroup(target, [taskId])
        await tasksStore.loadTasks()
        uiStore.showToast('Task added to group', 'success')
      } catch (e) {
        uiStore.showToast('Failed to add task to group: ' + (e instanceof Error ? e.message : String(e)), 'error')
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
          uiStore.showToast(validation.reason, 'error')
        }
        return
      }

      if (!task.groupId) {
        uiStore.showToast('Task is not in a group', 'error')
        return
      }

      try {
        await taskGroupsStore.removeTasksFromGroup(task.groupId, [taskId])
        await tasksStore.loadTasks()
        uiStore.showToast('Task removed from group', 'success')
      } catch (e) {
        uiStore.showToast('Failed to remove task from group: ' + (e instanceof Error ? e.message : String(e)), 'error')
      }
      return
    }

    // Handle column drops
    const validation = validateTaskDrop(
      task,
      target as TaskStatus,
      runsStore.isTaskMutationLocked(taskId)
    )

    if (!validation.allowed) {
      if (validation.reason !== 'no-change') {
        uiStore.showToast(validation.reason, 'error')
      }
      return
    }

    try {
      switch (validation.action) {
        case 'move-to-done':
          await tasksStore.updateTask(taskId, {
            status: 'done',
            completedAt: Math.floor(Date.now() / 1000),
          })
          uiStore.showToast('Task moved to Done', 'success')
          break
        case 'reset-to-backlog':
          {
            const result = await tasksStore.resetTask(taskId)
            if (result.wasInGroup && result.group) {
              uiStore.setModalData({ task: result.task, groupId: result.group.id })
              uiStore.setShowRestoreModal(true)
            }
          }
          break
        case 'move-to-review':
          await tasksStore.updateTask(taskId, { status: 'review' })
          uiStore.showToast('Task moved to Review', 'success')
          break
      }
      await tasksStore.loadTasks()
    } catch (e) {
      uiStore.showToast('Move failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  })

  // Initialize data on mount
  onMount(async () => {
    await Promise.all([
      optionsStore.loadOptions(),
      modelSearchStore.loadModels(),
      runsStore.loadRuns(),
      tasksStore.loadTasks(),
      taskGroupsStore.loadGroups(),
      loadContainerStatus(),
    ])

    runsStore.setTasksRef(tasksStore.tasks())

    const hasPaused = await workflowControl.checkPausedState()
    if (hasPaused) {
      uiStore.showToast('Found paused workflow. Click Resume to continue.', 'info')
    }

    if (runsStore.activeRuns().length > 0) {
      const activeRun = runsStore.activeRuns()[0]
      workflowControl.setRun(activeRun)
    }

    // Check URL hash for session
    const hashMatch = window.location.hash.match(/^#session\/(.+)$/)
    if (hashMatch) {
      const sessionId = decodeURIComponent(hashMatch[1])
      uiStore.openModal('session', { sessionId })
    }

    uiStore.addLog('Kanban UI ready', 'info')
  })

  // WebSocket handlers
  createEffect(() => {
    const unsubTaskCreated = wsStore.on('task_created', () => tasksStore.loadTasks())
    const unsubTaskUpdated = wsStore.on('task_updated', () => tasksStore.loadTasks())
    const unsubTaskDeleted = wsStore.on('task_deleted', () => tasksStore.loadTasks())
    const unsubRunUpdated = wsStore.on('run_updated', (payload) => {
      const run = payload as import('@/types').WorkflowRun
      runsStore.updateRunFromWebSocket(run)
    })
    const unsubGroupUpdated = wsStore.on('task_group_updated', (payload) => {
      const group = payload as TaskGroup
      taskGroupsStore.updateGroupFromWebSocket(group)
    })
    const unsubSessionMessage = wsStore.on('session_message_created', (payload) => {
      const msg = payload as { sessionId?: string }
      if (msg.sessionId) {
        // Debounce the refresh to avoid flickering
        setTimeout(() => {
          sessionUsage.loadSessionUsage(msg.sessionId!, true)
        }, 2000)
      }
    })
    const unsubSelfHeal = wsStore.on('self_heal_status', (payload) => {
      const event = payload as {
        status?: string
        message?: string
      }

      if (event.status === 'investigating') {
        uiStore.showToast(event.message || 'Self-healing investigation started', 'info')
        return
      }
      if (event.status === 'recovering') {
        uiStore.showToast(event.message || 'Self-healing is preparing recovery', 'info')
        return
      }
      if (event.status === 'recovered') {
        uiStore.showToast(event.message || 'Self-healing recovered the task', 'success')
        return
      }
      if (event.status === 'manual_required') {
        uiStore.showToast(event.message || 'Self-healing needs manual follow-up', 'warning')
        return
      }
      if (event.status === 'error') {
        uiStore.showToast(event.message || 'Self-healing failed', 'error')
      }
    })

    // Setup planning chat WebSocket handlers
    const unsubPlanningHandlers = planningChatStore.setupWebSocketHandlers()

    onCleanup(() => {
      unsubTaskCreated()
      unsubTaskUpdated()
      unsubTaskDeleted()
      unsubRunUpdated()
      unsubGroupUpdated()
      unsubSessionMessage()
      unsubSelfHeal()
      unsubPlanningHandlers()
    })
  })

  // URL hash change handler
  createEffect(() => {
    const handleHashChange = () => {
      const hashMatch = window.location.hash.match(/^#session\/(.+)$/)
      if (hashMatch) {
        const sessionId = decodeURIComponent(hashMatch[1])
        if (uiStore.activeModal() !== 'session') {
          uiStore.openModal('session', { sessionId })
        }
      } else if (uiStore.activeModal() === 'session') {
        uiStore.closeModal()
      }
    }

    window.addEventListener('hashchange', handleHashChange)
    onCleanup(() => window.removeEventListener('hashchange', handleHashChange))
  })

  // Auto-sync interval
  createEffect(() => {
    let syncInterval: ReturnType<typeof setInterval> | null = null
    let syncErrorCount = 0
    const MAX_SYNC_ERRORS = 5

    if (wsStore.isConnected()) {
      syncInterval = setInterval(() => {
        Promise.all([
          tasksStore.loadTasks(),
          runsStore.loadRuns()
        ]).catch((e) => {
          syncErrorCount += 1
          const errorMessage = e instanceof Error ? e.message : String(e)
          uiStore.addLog(`Sync failed (${syncErrorCount}/${MAX_SYNC_ERRORS}): ${errorMessage}`, 'error')
          
          if (syncErrorCount >= MAX_SYNC_ERRORS) {
            uiStore.showToast(`Auto-sync disabled after ${MAX_SYNC_ERRORS} consecutive failures. Check connection.`, 'error')
            if (syncInterval) {
              clearInterval(syncInterval)
              syncInterval = null
            }
          }
        })
      }, 30000)
    }

    onCleanup(() => {
      if (syncInterval) {
        clearInterval(syncInterval)
      }
    })
  })

  // Keyboard shortcuts
  createEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape to close modals
      if (e.key === 'Escape') {
        // Handle group create modal first
        if (uiStore.showGroupCreateModal()) {
          uiStore.setShowGroupCreateModal(false)
          multiSelectStore.cancelGroupCreation()
          return
        }
        // Handle multi-select clear
        if (multiSelectStore.isSelecting()) {
          multiSelectStore.clearSelection()
          return
        }
        uiStore.closeTopmostModal()
        return
      }

      // Ctrl+1-5 for tabs
      if (e.ctrlKey && e.key >= '1' && e.key <= '5') {
        e.preventDefault()
        const tabIndex = parseInt(e.key) - 1
        const tabs = ['kanban', 'options', 'containers', 'archived', 'stats'] as const
        tabStore.setActiveTab(tabs[tabIndex])
        return
      }

      // T for new template
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!uiStore.isAnyModalOpen()) {
          uiStore.openModal('task', { mode: 'create', createStatus: 'template' })
        }
        return
      }

      // B for new backlog task
      if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!uiStore.isAnyModalOpen()) {
          uiStore.openModal('task', { mode: 'create', createStatus: 'backlog' })
        }
        return
      }

      // P for planning chat
      if (e.key === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!uiStore.isAnyModalOpen()) {
          planningChatStore.togglePanel()
        }
        return
      }

      // Ctrl+G for group creation
      if (e.ctrlKey && e.key === 'g') {
        e.preventDefault()
        if (multiSelectStore.selectedCount() >= 2) {
          const defaultName = `Group ${taskGroupsStore.activeGroups().length + 1}`
          uiStore.setShowGroupCreateModal(true)
          uiStore.setGroupCreateModalData({
            taskIds: multiSelectStore.getSelectedIds(),
            defaultName,
          })
          multiSelectStore.startGroupCreation()
        }
        return
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    onCleanup(() => document.removeEventListener('keydown', handleKeyDown))
  })

  // Group members computed
  const groupMembers = createMemo(() => {
    const members: Record<string, string[]> = {}
    for (const task of tasksStore.tasks()) {
      if (task.groupId) {
        if (!members[task.groupId]) {
          members[task.groupId] = []
        }
        members[task.groupId].push(task.id)
      }
    }
    return members
  })

  // Current active run
  const currentActiveRun = createMemo(() => runsStore.activeRuns()[0] || null)

  createEffect(() => {
    const activeRun = currentActiveRun()
    if (activeRun) {
      workflowControl.setRun(activeRun)
      return
    }

    workflowControl.clearRun()
  })

  // Handlers
  const onToggleExecution = async () => {
    const hasPaused = await workflowControl.checkPausedState()
    if (hasPaused) {
      uiStore.showToast('Resuming paused workflow...', 'info')
      await workflowControl.resume()
      await runsStore.loadRuns()
      return
    }

    const isRunning = runsStore.consumedRunSlots() > 0 || workflowControl.isRunning()
    if (isRunning) {
      try {
        await optionsStore.stopExecution()
        await runsStore.loadRuns()
        uiStore.showToast('Workflow stopped', 'success')
      } catch (e) {
        uiStore.showToast('Failed to stop workflow: ' + (e instanceof Error ? e.message : String(e)), 'error')
      }
    } else {
      const grouped = tasksStore.groupedTasks()
      const executableTasks = (grouped?.backlog?.length ?? 0) +
                            (grouped?.review?.length ?? 0) +
                            (grouped?.executing?.length ?? 0)
      if (executableTasks === 0) {
        uiStore.showToast('No tasks available to execute. Create some tasks first.', 'error')
        return
      }
      if (optionsStore.options()?.showExecutionGraph) {
        uiStore.openModal('executionGraph')
      } else {
        try {
          await optionsStore.startExecution()
          await runsStore.loadRuns()
          await tasksStore.loadTasks()
          uiStore.showToast('Workflow run started', 'success')
        } catch (e) {
          uiStore.showToast('Execution control failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
        }
      }
    }
  }

  const onPauseExecution = async (runId: string) => {
    uiStore.showToast('Pausing workflow...', 'info')
    const success = await workflowControl.pause(runId)
    if (success) {
      uiStore.showToast('Workflow paused', 'success')
      runsStore.loadRuns()
    } else {
      uiStore.showToast(workflowControl.error() || 'Failed to pause workflow', 'error')
    }
  }

  const onResumeExecution = async (runId: string) => {
    uiStore.showToast('Resuming workflow...', 'info')
    const success = await workflowControl.resume(runId)
    if (success) {
      uiStore.showToast('Workflow resumed', 'success')
      runsStore.loadRuns()
    } else {
      uiStore.showToast(workflowControl.error() || 'Failed to resume workflow', 'error')
    }
  }

  const onStopExecution = (type: 'graceful' | 'destructive') => {
    workflowControl.requestStop(type)
    uiStore.setShowStopConfirmModal(true)
  }

  const closeStopConfirmModal = () => {
    uiStore.setShowStopConfirmModal(false)
    workflowControl.cancelStop()
  }

  const handleCreateGroup = async (name: string) => {
    const { taskIds } = uiStore.groupCreateModalData()
    if (taskIds.length === 0) {
      uiStore.showToast('No tasks selected for group creation', 'error')
      return
    }

    await taskGroupsStore.createGroup(taskIds, name)
    await tasksStore.loadTasks()
    uiStore.setShowGroupCreateModal(false)
    multiSelectStore.confirmGroupCreation()
    uiStore.showToast(`Group "${name}" created successfully`, 'success')
  }

  const closeGroupCreateModal = () => {
    uiStore.setShowGroupCreateModal(false)
    multiSelectStore.cancelGroupCreation()
  }

  const showConfirmation = (action: 'delete' | 'archive' | 'convertToTemplate', taskId: string, taskName: string, ctrlHeld: boolean) => {
    if (ctrlHeld) {
      if (action === 'delete' || action === 'archive') {
        tasksStore.deleteTask(taskId).then(() => {
          const message = action === 'delete' ? 'Task deleted' : 'Task archived'
          uiStore.showToast(message, 'success')
        }).catch(e => {
          const actionText = action === 'delete' ? 'Delete' : 'Archive'
          uiStore.showToast(actionText + ' failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
        })
      } else {
        tasksStore.updateTask(taskId, { status: 'template' }).then(() => {
          uiStore.showToast('Task converted to template', 'success')
        }).catch(e => {
          uiStore.showToast('Convert failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
        })
      }
      return
    }
    uiStore.setConfirmModalAction(action)
    uiStore.setConfirmModalTaskId(taskId)
    uiStore.setConfirmModalTaskName(taskName)
    uiStore.setShowConfirmModal(true)
  }

  const handleConfirmModalConfirm = async () => {
    const taskId = uiStore.confirmModalTaskId()
    const action = uiStore.confirmModalAction()
    if (!taskId) return

    try {
      if (action === 'delete' || action === 'archive') {
        await tasksStore.deleteTask(taskId)
        const message = action === 'delete' ? 'Task deleted' : 'Task archived'
        uiStore.showToast(message, 'success')
      } else {
        await tasksStore.updateTask(taskId, { status: 'template' })
        uiStore.showToast('Task converted to template', 'success')
      }
    } catch (e) {
      const actionText = action === 'delete' ? 'Delete' : action === 'archive' ? 'Archive' : 'Convert'
      uiStore.showToast(actionText + ' failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
    uiStore.setShowConfirmModal(false)
    uiStore.setConfirmModalTaskId(null)
  }

  // Get task for modal operations
  const getTaskForModal = () => {
    const taskId = uiStore.modalData().taskId as string | undefined
    const seededTask = uiStore.modalData().task as Task | undefined
    return taskId ? tasksStore.getTaskById(taskId) ?? seededTask : seededTask
  }

  return (
    <div class="app-layout bg-dark-bg text-dark-text">
      <Sidebar
        consumedSlots={runsStore.consumedRunSlots()}
        parallelTasks={optionsStore.options()?.parallelTasks ?? 1}
        controlState={workflowControl.controlState()}
        canPause={workflowControl.canPause()}
        canResume={workflowControl.canResume()}
        canStop={workflowControl.canStop()}
        isControlLoading={workflowControl.isLoading()}
        isPaused={workflowControl.isPaused()}
        activeRunId={currentActiveRun()?.id ?? null}
        totalTasks={tasksStore.tasks().length}
        doneCount={tasksStore.groupedTasks()?.done?.length ?? 0}
        activeCount={tasksStore.groupedTasks()?.executing?.length ?? 0}
        reviewCount={tasksStore.groupedTasks()?.review?.length ?? 0}
        onToggleExecution={onToggleExecution}
        onPauseExecution={onPauseExecution}
        onResumeExecution={onResumeExecution}
        onStopExecution={onStopExecution}
        onOpenTemplateModal={() => uiStore.openModal('task', { mode: 'create', createStatus: 'template' })}
        onOpenTaskModal={() => uiStore.openModal('task', { mode: 'create', createStatus: 'backlog' })}
        onArchiveAllDone={async () => {
          const doneCount = tasksStore.groupedTasks()?.done?.length ?? 0
          if (doneCount === 0) {
            uiStore.showToast('No done tasks to archive', 'error')
            return
          }
          if (!confirm(`Archive all ${doneCount} done task(s)? Task history will be preserved.`)) return
          const result = await tasksStore.archiveAllDone()
          uiStore.showToast(`${result.archived} tasks archived, ${result.deleted} deleted`, 'success')
        }}
        onTogglePlanningChat={() => planningChatStore.togglePanel()}
      />

      <main class="main-content">
        <TopBar />
        <TabBar activeTab={tabStore.activeTab()} onTabChange={tabStore.setActiveTab} />

        <Show when={tabStore.activeTab() === 'kanban'}>
          <KanbanBoard
            logPanelCollapsed={logPanelCollapsed()}
            tasks={tasksStore.tasks()}
            bonSummaries={tasksStore.bonSummaries()}
            getTaskRunColor={runsStore.getTaskRunColor}
            isTaskMutationLocked={runsStore.isTaskMutationLocked}
            dragDrop={dragDrop}
            sessionUsage={sessionUsage}
            taskLastUpdate={taskLastUpdate}
            isMultiSelecting={multiSelectStore.isSelecting()}
            getIsSelected={multiSelectStore.isSelected}
            columnSorts={optionsStore.options()?.columnSorts}
            highlightedRunId={highlightedRunId()}
            isTaskInRun={runsStore.isTaskInRun}
            groups={taskGroupsStore.activeGroups()}
            groupMembers={groupMembers()}
            activeGroupId={taskGroupsStore.activeGroupId()}
            options={optionsStore.options()}
            onOpenTask={(id, e) => {
              if (e && (e.ctrlKey || e.metaKey)) {
                multiSelectStore.toggleSelection(id, e)
              } else {
                uiStore.openModal('task', { mode: 'edit', taskId: id })
              }
            }}
            onOpenTemplateModal={() => uiStore.openModal('task', { mode: 'create', createStatus: 'template' })}
            onOpenTaskModal={() => uiStore.openModal('task', { mode: 'create', createStatus: 'backlog' })}
            onDeployTemplate={async (id, e) => {
              const ctrlHeld = e.ctrlKey || e.metaKey
              const shiftHeld = e.shiftKey
              const template = tasksStore.getTaskById(id)
              if (!template) return
              
              if (!ctrlHeld) {
                uiStore.openModal('task', { mode: 'deploy', seedTaskId: id })
                return
              }

              const { id: _, idx, status, createdAt, updatedAt, completedAt, sessionId, sessionUrl, ...templateData } = template
              try {
                await tasksStore.createTask({ ...templateData, status: 'backlog', autoDeploy: false, autoDeployCondition: null })
                uiStore.showToast('Template deployed', 'success')
                if (shiftHeld) {
                  await tasksStore.deleteTask(id)
                  uiStore.showToast('Template deleted after deployment', 'success')
                }
              } catch (e) {
                uiStore.showToast('Deploy failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
              }
            }}
            onOpenTaskSessions={(id) => uiStore.openModal('taskSessions', { taskId: id })}
            onApprovePlan={(id) => uiStore.openModal('approve', { taskId: id })}
            onRequestRevision={(id) => uiStore.openModal('revision', { taskId: id })}
            onStartSingle={(id) => uiStore.openModal('startSingle', { taskId: id })}
            onRepairTask={(id, action) => tasksStore.repairTask(id, action)}
            onMarkDone={(id) => tasksStore.updateTask(id, { status: 'done', completedAt: Math.floor(Date.now() / 1000) })}
            onResetTask={async (id) => {
              try {
                await tasksStore.resetTask(id)
              } catch (e) {
                uiStore.showToast('Reset task failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
              }
            }}
            onConvertToTemplate={(id, event) => {
              const task = tasksStore.getTaskById(id)
              const taskName = task?.name || 'this task'
              const ctrlHeld = event?.ctrlKey || event?.metaKey || false
              showConfirmation('convertToTemplate', id, taskName, ctrlHeld)
            }}
            onArchiveTask={(id, event) => {
              const task = tasksStore.getTaskById(id)
              const taskName = task?.name || 'this task'
              const ctrlHeld = event?.ctrlKey || event?.metaKey || false
              // Backlog tasks are deleted, others are archived
              const action = task?.status === 'backlog' ? 'delete' : 'archive'
              showConfirmation(action, id, taskName, ctrlHeld)
            }}
            onArchiveAllDone={async () => {
              const doneCount = tasksStore.groupedTasks()?.done?.length ?? 0
              if (doneCount === 0) {
                uiStore.showToast('No done tasks to archive', 'error')
                return
              }
              if (!confirm(`Archive all ${doneCount} done task(s)?`)) return
              const result = await tasksStore.archiveAllDone()
              uiStore.showToast(`${result.archived} tasks archived, ${result.deleted} deleted`, 'success')
            }}
            onViewRuns={(id) => uiStore.openModal('bestOfNDetail', { taskId: id })}
            onContinueReviews={(id) => tasksStore.repairTask(id, 'continue_with_more_reviews')}
            onChangeColumnSort={(status, sort) => {
              const newSorts = { ...(optionsStore.options()?.columnSorts || {}), [status]: sort }
              optionsStore.updateOptions({ columnSorts: newSorts })
            }}
            onVirtualCardClick={(groupId) => taskGroupsStore.openGroup(groupId)}
            onDeleteGroup={(groupId) => taskGroupsStore.deleteGroup(groupId)}
            onStartGroup={(groupId) => taskGroupsStore.startGroup(groupId)}
            onCloseGroupPanel={() => taskGroupsStore.openGroup(null)}
            onRemoveTaskFromGroup={(taskId) => {
              const groupId = taskGroupsStore.activeGroupId()
              if (groupId) {
                taskGroupsStore.removeTasksFromGroup(groupId, [taskId])
              }
            }}
            onAddTasksToGroup={(taskIds) => {
              const groupId = taskGroupsStore.activeGroupId()
              if (groupId) {
                taskGroupsStore.addTasksToGroup(groupId, taskIds)
              }
            }}
            onRenameGroup={async (groupId, newName) => {
              await taskGroupsStore.updateGroup(groupId, { name: newName })
            }}
          />
        </Show>

        <Show when={tabStore.activeTab() === 'options'}>
          <OptionsTab />
        </Show>

        <Show when={tabStore.activeTab() === 'containers'}>
          <ContainersTab />
        </Show>

        <Show when={tabStore.activeTab() === 'archived'}>
          <ArchivedTasksTab onOpenTaskSessions={(task) => uiStore.openModal('taskSessions', { taskId: task.id, task })} />
        </Show>

        <Show when={tabStore.activeTab() === 'stats'}>
          <StatsTab />
        </Show>

        <Show when={tabStore.activeTab() === 'self-heal'}>
          <SelfHealReportsTab />
        </Show>

        <TabbedLogPanel
          collapsed={logPanelCollapsed()}
          onCollapsedChange={setLogPanelCollapsed}
          logs={uiStore.logs()}
          runs={runsStore.runs()}
          staleRuns={runsStore.staleRuns()}
          onClear={() => uiStore.clearLogs()}
          onArchiveRun={(id) => runsStore.archiveRun(id)}
          onArchiveAllStaleRuns={async () => {
            const staleCount = runsStore.staleRuns().length
            if (staleCount === 0) return
            if (!confirm(`Archive ${staleCount} stale workflow run${staleCount > 1 ? 's' : ''}?`)) return
            try {
              await Promise.all(runsStore.staleRuns().map(run => runsStore.archiveRun(run.id)))
              uiStore.showToast(`${staleCount} stale run${staleCount > 1 ? 's' : ''} archived`, 'success')
            } catch (e) {
              uiStore.showToast('Failed to archive runs: ' + (e instanceof Error ? e.message : String(e)), 'error')
            }
          }}
          onHighlightRun={(runId) => setHighlightedRunId(runId)}
          onClearHighlight={() => setHighlightedRunId(null)}
        />
      </main>

      <ToastContainer
        toasts={uiStore.toasts()}
        bottomOffset={logPanelCollapsed() ? 16 : 200}
        onRemove={uiStore.removeToast}
      />

      <GroupActionBar
        selectedCount={multiSelectStore.selectedCount()}
        onCreateGroup={() => {
          const selectedIds = multiSelectStore.getSelectedIds()
          if (selectedIds.length < 2) {
            uiStore.showToast('Select at least 2 tasks to create a group', 'error')
            return
          }
          const defaultName = `Group ${taskGroupsStore.activeGroups().length + 1}`
          uiStore.setShowGroupCreateModal(true)
          uiStore.setGroupCreateModalData({
            taskIds: selectedIds,
            defaultName,
          })
          multiSelectStore.startGroupCreation()
        }}
        onBatchEdit={() => uiStore.openModal('batchEdit', { taskIds: multiSelectStore.getSelectedIds() })}
        onClear={() => multiSelectStore.clearSelection()}
      />

      {/* Modals */}
      <Show when={uiStore.activeModal() === 'task'}>
        <TaskModal
          mode={(uiStore.modalData().mode as 'create' | 'edit' | 'deploy') || 'create'}
          taskId={uiStore.modalData().taskId as string | undefined}
          createStatus={(uiStore.modalData().createStatus as TaskStatus) || 'backlog'}
          seedTaskId={uiStore.modalData().seedTaskId as string | undefined}
          onClose={uiStore.closeModal}
        />
      </Show>

      <ConfirmModal
        isOpen={uiStore.showConfirmModal()}
        action={uiStore.confirmModalAction()}
        taskName={uiStore.confirmModalTaskName()}
        onConfirm={handleConfirmModalConfirm}
        onClose={() => {
          uiStore.setShowConfirmModal(false)
          uiStore.setConfirmModalTaskId(null)
        }}
      />

      <Show when={uiStore.showGroupCreateModal()}>
        <GroupCreateModal
          taskCount={multiSelectStore.selectedCount()}
          defaultName={uiStore.groupCreateModalData().defaultName}
          isLoading={taskGroupsStore.loading()}
          onClose={closeGroupCreateModal}
          onConfirm={handleCreateGroup}
        />
      </Show>

      {/* Additional Modals */}
      <Show when={uiStore.activeModal() === 'approve' && !!getTaskForModal()?.id}>
        <ApproveModal
          taskId={getTaskForModal()!.id}
          onClose={uiStore.closeModal}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'batchEdit'}>
        <BatchEditModal
          taskIds={(uiStore.modalData().taskIds as string[]) || []}
          onClose={uiStore.closeModal}
          onConfirm={async (updates) => {
            await tasksStore.batchUpdateTasks((uiStore.modalData().taskIds as string[]) || [], updates)
            uiStore.closeModal()
            multiSelectStore.clearSelection()
            uiStore.showToast('Tasks updated successfully', 'success')
          }}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'bestOfNDetail'}>
        <BestOfNDetailModal
          task={getTaskForModal()}
          onClose={uiStore.closeModal}
          onSelectWinner={async (sessionId) => {
            const taskId = uiStore.modalData().taskId as string
            if (taskId) {
              await tasksStore.selectWinnerSession(taskId, sessionId)
              uiStore.closeModal()
            }
          }}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'executionGraph'}>
        <ExecutionGraphModal
          onClose={uiStore.closeModal}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'options'}>
        <OptionsModal
          onClose={uiStore.closeModal}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'planningPrompt'}>
        <PlanningPromptModal
          onClose={uiStore.closeModal}
        />
      </Show>

      <Show when={uiStore.showRestoreModal()}>
        <RestoreToGroupModal
          task={getTaskForModal()}
          groups={taskGroupsStore.activeGroups()}
          onClose={() => uiStore.setShowRestoreModal(false)}
          onRestore={async (taskId, groupId) => {
            await tasksStore.moveTaskToGroup(taskId, groupId)
            uiStore.setShowRestoreModal(false)
            await tasksStore.loadTasks()
            uiStore.showToast('Task restored to group', 'success')
          }}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'revision'}>
        <RevisionModal
          task={getTaskForModal()}
          onClose={uiStore.closeModal}
          onSubmit={async (taskId, revisionNotes) => {
            await tasksStore.requestPlanRevision(taskId, revisionNotes)
            uiStore.closeModal()
          }}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'session' && typeof uiStore.modalData().sessionId === 'string'}>
        <SessionModal
          sessionId={uiStore.modalData().sessionId as string}
          onClose={() => {
            uiStore.closeModal()
            if (location.hash.startsWith('#session/')) {
              history.pushState(null, '', location.pathname + location.search)
            }
          }}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'startSingle'}>
        <StartSingleModal
          task={getTaskForModal()}
          onClose={uiStore.closeModal}
          onConfirm={async (taskId) => {
            await tasksStore.startSingleTask(taskId)
            uiStore.closeModal()
          }}
        />
      </Show>

      <Show when={uiStore.showStopConfirmModal() || workflowControl.isConfirmingStop()}>
        <StopConfirmModal
          isOpen={uiStore.showStopConfirmModal() || workflowControl.isConfirmingStop()}
          runName={currentActiveRun()?.displayName}
          isStopping={workflowControl.isStopping()}
          onClose={closeStopConfirmModal}
          onConfirmGraceful={async () => {
            uiStore.showToast('Pausing workflow gracefully...', 'info')
            const success = await workflowControl.confirmStop()
            if (success) {
              closeStopConfirmModal()
              uiStore.showToast('Workflow paused gracefully - work preserved', 'success')
              runsStore.loadRuns()
            } else {
              uiStore.showToast(workflowControl.error() || 'Failed to pause workflow', 'error')
            }
          }}
          onConfirmDestructive={async () => {
            uiStore.showToast('STOPPING workflow - killing all containers...', 'info')
            const success = await workflowControl.confirmStop()
            if (success) {
              const result = workflowControl.lastResult()
              closeStopConfirmModal()
              uiStore.showToast(`Workflow STOPPED. Killed ${result?.killed ?? 0} processes, deleted ${result?.cleaned ?? 0} containers.`, 'error')
              runsStore.loadRuns()
              tasksStore.loadTasks()
            } else {
              uiStore.showToast(workflowControl.error() || 'Failed to stop workflow', 'error')
            }
          }}
        />
      </Show>

      <Show when={uiStore.activeModal() === 'taskSessions'}>
        <TaskSessionsModal
          taskId={uiStore.modalData().taskId as string | undefined}
          task={getTaskForModal()}
          onClose={uiStore.closeModal}
        />
      </Show>

      {/* Chat Container */}
      <ChatContainer
        planningChat={planningChatStore}
        options={() => ({ planModel: optionsStore.options()?.planModel, planThinkingLevel: optionsStore.options()?.planThinkingLevel })}
        loadOptions={optionsStore.loadOptions}
      />
    </div>
  )
}

// Root component with QueryClientProvider
export default function AppRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      <App />
      <SolidQueryDevtools />
    </QueryClientProvider>
  )
}
