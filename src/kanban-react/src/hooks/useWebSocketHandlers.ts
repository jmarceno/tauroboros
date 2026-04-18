import { useEffect, useRef } from 'react'
import type { Task, WorkflowRun, TaskGroup, Session, SessionMessage } from '@/types'
import type { useWebSocket } from './useWebSocket'
import type { useTasks } from './useTasks'
import type { useRuns } from './useRuns'
import type { useOptions } from './useOptions'
import type { useToasts } from './useToasts'
import type { useSession } from './useSession'
import type { useTaskGroups } from './useTaskGroups'
import type { useWorkflowControl } from './useWorkflowControl'

interface UseWebSocketHandlersDeps {
  wsHook: ReturnType<typeof useWebSocket>
  tasksHook: ReturnType<typeof useTasks>
  runsHook: ReturnType<typeof useRuns>
  optionsHook: ReturnType<typeof useOptions>
  toastsHook: ReturnType<typeof useToasts>
  sessionHook: ReturnType<typeof useSession>
  taskGroupsHook: ReturnType<typeof useTaskGroups>
  workflowControl: ReturnType<typeof useWorkflowControl>
}

/**
 * Custom hook for WebSocket event handler registration.
 * Consolidates all WebSocket handlers with proper dependency management
 * using the stable callback refs pattern to avoid stale closures.
 * 
 * NOTE: This hook uses the pattern of extracting stable callbacks and refs
 * from hook objects, then only depending on those stable values in useEffect.
 * This follows the rerender-dependencies best practice of only using primitive
 * and stable ref dependencies in effect arrays.
 */
export function useWebSocketHandlers(deps: UseWebSocketHandlersDeps) {
  const {
    wsHook,
    tasksHook,
    runsHook,
    optionsHook,
    toastsHook,
    sessionHook,
    taskGroupsHook,
    workflowControl,
  } = deps

  // Extract stable callbacks and refs from hook objects
  // These don't change between renders, preventing effect re-runs
  const tasksRef = useRef(tasksHook.tasks)
  const runsRef = useRef(runsHook.runs)
  const sessionIdRef = useRef(sessionHook.sessionId)

  // Store stable callbacks from hooks (these are memoized in their respective hooks)
  const setTasksRef = useRef(tasksHook.setTasks)
  const removeBonSummaryRef = useRef(tasksHook.removeBonSummary)
  const refreshBonSummariesRef = useRef(tasksHook.refreshBonSummaries)
  const loadTasksRef = useRef(tasksHook.loadTasks)
  const updateRunFromWebSocketRef = useRef(runsHook.updateRunFromWebSocket)
  const setTasksRefRunsRef = useRef(runsHook.setTasksRef)
  const loadRunsRef = useRef(runsHook.loadRuns)
  const removeRunRef = useRef(runsHook.removeRun)
  const addLogRef = useRef(toastsHook.addLog)
  const showToastRef = useRef(toastsHook.showToast)
  const loadOptionsRef = useRef(optionsHook.loadOptions)
  const updateSessionRef = useRef(sessionHook.updateSession)
  const addMessageRef = useRef(sessionHook.addMessage)
  const updateGroupFromWebSocketRef = useRef(taskGroupsHook.updateGroupFromWebSocket)
  const removeGroupFromWebSocketRef = useRef(taskGroupsHook.removeGroupFromWebSocket)
  const loadGroupsRef = useRef(taskGroupsHook.loadGroups)
  const handleRunUpdateRef = useRef(workflowControl.handleRunUpdate)
  const updateStateFromRunsRef = useRef(workflowControl.updateStateFromRuns)
  const clearRunRef = useRef(workflowControl.clearRun)
  const runsArrayRef = useRef(runsHook.runs)

  // Keep refs synchronized with latest values (this doesn't cause re-renders)
  tasksRef.current = tasksHook.tasks
  runsRef.current = runsHook.runs
  sessionIdRef.current = sessionHook.sessionId
  runsArrayRef.current = runsHook.runs

  // Only depend on the stable wsHook reference and sessionId primitive
  // All other dependencies are accessed through refs to prevent effect re-runs
  useEffect(() => {
    if (!wsHook) return

    const unsubscribers: (() => void)[] = []

    // Task event handlers - using refs to access latest state without causing re-runs
    unsubscribers.push(
      wsHook.on('task_created', async (payload) => {
        const task = payload as Task
        if (!task?.id) return
        const currentTasks = tasksRef.current
        const existingTask = currentTasks.find((t) => t.id === task.id)
        if (existingTask) return
        setTasksRef.current([...currentTasks, task])
        addLogRef.current(`Task created: ${task.name} (status: ${task.status || 'undefined'})`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('task_updated', async (payload) => {
        const task = payload as Task
        const currentTasks = tasksRef.current
        const idx = currentTasks.findIndex((t) => t.id === task.id)
        const prev = idx >= 0 ? currentTasks[idx] : null

        if (prev && task.updatedAt && prev.updatedAt && task.updatedAt < prev.updatedAt) {
          console.log(`[WebSocket] Skipping stale task_updated for ${task.name}`)
          return
        }

        const mergedTask = prev ? { ...prev, ...task } : task

        if (idx >= 0) {
          setTasksRef.current(currentTasks.map((t, i) => (i === idx ? mergedTask : t)))
        }
        setTasksRefRunsRef.current(currentTasks)

        if (!prev || prev.status !== task.status) {
          if (task.status === 'executing') addLogRef.current(`Task started: ${task.name}`, 'info')
          if (task.status === 'done') addLogRef.current(`Task completed: ${task.name}`, 'success')
          if (task.status === 'failed' || task.status === 'stuck') {
            addLogRef.current(
              `Task failed: ${task.name}${task.errorMessage ? ' - ' + task.errorMessage : ''}`,
              'error'
            )
          }
        }

        if (task.executionStrategy === 'best_of_n') {
          refreshBonSummariesRef.current(undefined, [task.id])
        }
      })
    )

    unsubscribers.push(
      wsHook.on('task_deleted', (payload) => {
        const { id } = payload as { id: string }
        const currentTasks = tasksRef.current
        const task = currentTasks.find((t) => t.id === id)
        removeBonSummaryRef.current(id)
        setTasksRef.current(currentTasks.filter((t) => t.id !== id))
        setTasksRefRunsRef.current(currentTasks.filter((t) => t.id !== id))
        addLogRef.current(`Task deleted: ${task?.name || id}`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('task_archived', (payload) => {
        const { id } = payload as { id: string }
        const currentTasks = tasksRef.current
        const task = currentTasks.find((t) => t.id === id)
        removeBonSummaryRef.current(id)
        setTasksRef.current(currentTasks.filter((t) => t.id !== id))
        setTasksRefRunsRef.current(currentTasks.filter((t) => t.id !== id))
        addLogRef.current(`Task archived: ${task?.name || id}`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('task_reordered', () => {
        addLogRef.current('Task order updated', 'info')
        loadTasksRef.current().then((data) => {
          setTasksRefRunsRef.current(data || tasksRef.current)
        })
      })
    )

    // Options handlers
    unsubscribers.push(
      wsHook.on('options_updated', () => {
        addLogRef.current('Options updated', 'info')
        loadOptionsRef.current()
      })
    )

    // Run handlers
    unsubscribers.push(
      wsHook.on('run_created', (payload) => {
        const run = payload as WorkflowRun
        updateRunFromWebSocketRef.current(run)
        handleRunUpdateRef.current(run)
      })
    )

    unsubscribers.push(
      wsHook.on('run_updated', (payload) => {
        const run = payload as WorkflowRun
        updateRunFromWebSocketRef.current(run)
        handleRunUpdateRef.current(run)
      })
    )

    unsubscribers.push(
      wsHook.on('run_archived', (payload) => {
        const { id } = payload as { id: string }
        addLogRef.current(`Workflow run archived: ${id}`, 'info')
        removeRunRef.current(id)
        clearRunRef.current()
      })
    )

    // Execution control handlers
    unsubscribers.push(
      wsHook.on('execution_paused', (payload) => {
        const data = payload as { runId: string }
        showToastRef.current('Workflow paused', 'info')
        addLogRef.current(`Workflow paused: ${data.runId}`, 'info')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('execution_resumed', (payload) => {
        const data = payload as { runId: string }
        showToastRef.current('Workflow resumed', 'success')
        addLogRef.current(`Workflow resumed: ${data.runId}`, 'success')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('run_paused', (payload) => {
        const data = payload as { runId: string }
        showToastRef.current('Workflow run paused', 'info')
        addLogRef.current(`Workflow run paused: ${data.runId}`, 'info')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('run_resumed', (payload) => {
        const data = payload as { runId: string }
        showToastRef.current('Workflow run resumed', 'success')
        addLogRef.current(`Workflow run resumed: ${data.runId}`, 'success')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('run_stopped', (payload) => {
        const data = payload as { runId: string; destructive?: boolean }
        const message = data.destructive ? 'Workflow force stopped' : 'Workflow stopped'
        showToastRef.current(message, data.destructive ? 'error' : 'info')
        addLogRef.current(`${message}: ${data.runId}`, data.destructive ? 'error' : 'info')
        loadRunsRef.current()
      })
    )

    // Session handlers
    unsubscribers.push(
      wsHook.on('session_started', (payload) => {
        const data = payload as { id: string; taskId?: string }
        const currentTasks = tasksRef.current
        if (data.taskId && data.id) {
          const idx = currentTasks.findIndex((t) => t.id === data.taskId)
          if (idx >= 0) {
            const updatedTasks = [...currentTasks]
            updatedTasks[idx] = {
              ...updatedTasks[idx],
              sessionId: data.id,
              sessionUrl: `/#session/${encodeURIComponent(data.id)}`,
            }
            setTasksRef.current(updatedTasks)
          }
        }
        if (sessionIdRef.current === data.id) {
          updateSessionRef.current(data as Session)
        }
      })
    )

    unsubscribers.push(
      wsHook.on('session_message_created', (payload) => {
        const msg = payload as SessionMessage
        if (msg.sessionId === sessionIdRef.current) {
          addMessageRef.current(msg)
        }
      })
    )

    unsubscribers.push(
      wsHook.on('session_status_changed', (payload) => {
        const data = payload as Session
        if (sessionIdRef.current === data.id) {
          updateSessionRef.current(data)
        }
      })
    )

    unsubscribers.push(
      wsHook.on('session_completed', (payload) => {
        const data = payload as Session
        if (sessionIdRef.current === data.id) {
          updateSessionRef.current(data)
        }
      })
    )

    // Best of N handlers
    unsubscribers.push(
      wsHook.on('task_run_updated', (payload) => {
        const data = payload as { taskId: string }
        if (data.taskId) {
          refreshBonSummariesRef.current(undefined, [data.taskId])
        }
      })
    )

    unsubscribers.push(
      wsHook.on('task_candidate_updated', (payload) => {
        const data = payload as { taskId: string }
        if (data.taskId) {
          refreshBonSummariesRef.current(undefined, [data.taskId])
        }
      })
    )

    // Container handlers
    unsubscribers.push(
      wsHook.on('image_status', (payload) => {
        const data = payload as { status: string; message: string; errorMessage?: string }
        if (data.status === 'preparing') {
          addLogRef.current(`⏳ ${data.message}`, 'info')
        } else if (data.status === 'ready') {
          addLogRef.current(`✅ ${data.message}`, 'success')
        } else if (data.status === 'error') {
          addLogRef.current(
            `❌ ${data.message}${data.errorMessage ? ': ' + data.errorMessage : ''}`,
            'error'
          )
          showToastRef.current(`Container image error: ${data.errorMessage || data.message}`, 'error')
        }
      })
    )

    unsubscribers.push(
      wsHook.on('error', (payload) => {
        const data = payload as { message: string }
        showToastRef.current(data.message, 'error')
      })
    )

    unsubscribers.push(
      wsHook.on('container_config_updated', () => {
        addLogRef.current('Container configuration updated', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_package_added', (payload) => {
        addLogRef.current(`Package '${(payload as { name: string }).name}' added to container config`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_package_removed', () => {
        addLogRef.current('Package removed from container config', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_started', (payload) => {
        const data = payload as { buildId: number; imageTag: string }
        showToastRef.current('Container build started', 'info')
        addLogRef.current(`Container build #${data.buildId} started (${data.imageTag})`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_progress', () => {
        // Progress updates handled within modal
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_completed', (payload) => {
        const data = payload as { status: string; buildId: number }
        if (data.status === 'success') {
          showToastRef.current('Container build completed successfully!', 'success')
          addLogRef.current(`Container build #${data.buildId} completed successfully`, 'success')
        } else if (data.status === 'failed') {
          showToastRef.current('Container build failed', 'error')
          addLogRef.current(`Container build #${data.buildId} failed`, 'error')
        }
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_cancelled', (payload) => {
        const data = payload as { buildId: number }
        addLogRef.current(`Container build #${data.buildId} cancelled`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_profile_created', (payload) => {
        showToastRef.current(`New profile "${(payload as { name: string }).name}" created`, 'success')
      })
    )

    // Execution lifecycle handlers
    unsubscribers.push(
      wsHook.on('execution_started', () => {
        addLogRef.current('Workflow execution started', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('execution_stopped', () => {
        addLogRef.current('Workflow execution stopped', 'info')
        updateStateFromRunsRef.current(runsArrayRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('execution_complete', () => {
        addLogRef.current('Workflow execution completed', 'success')
        updateStateFromRunsRef.current(runsArrayRef.current)
      })
    )

    // Task Group handlers
    unsubscribers.push(
      wsHook.on('group_created', (payload) => {
        const group = payload as { id: string; name: string }
        updateGroupFromWebSocketRef.current(group as TaskGroup)
        addLogRef.current(`Group created: ${group.name}`, 'success')
      })
    )

    unsubscribers.push(
      wsHook.on('group_updated', (payload) => {
        const group = payload as TaskGroup
        updateGroupFromWebSocketRef.current(group)
      })
    )

    unsubscribers.push(
      wsHook.on('group_deleted', (payload) => {
        const { id } = payload as { id: string }
        removeGroupFromWebSocketRef.current(id)
        addLogRef.current('Group deleted', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('group_task_added', () => {
        addLogRef.current('Task added to group', 'info')
        loadTasksRef.current()
      })
    )

    unsubscribers.push(
      wsHook.on('group_task_removed', () => {
        addLogRef.current('Task removed from group', 'info')
        loadTasksRef.current()
      })
    )

    unsubscribers.push(
      wsHook.on('group_execution_started', () => {
        showToastRef.current('Group execution started', 'success')
      })
    )

    unsubscribers.push(
      wsHook.on('group_execution_complete', () => {
        showToastRef.current('Group execution completed', 'success')
      })
    )

    // Task-scoped group handlers
    unsubscribers.push(
      wsHook.on('task_group_created', (payload) => {
        const group = payload as TaskGroup
        updateGroupFromWebSocketRef.current(group)
        addLogRef.current(`Group created from task context: ${group.name}`, 'success')
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_updated', (payload) => {
        const group = payload as TaskGroup
        updateGroupFromWebSocketRef.current(group)
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_deleted', (payload) => {
        const { id } = payload as { id: string }
        removeGroupFromWebSocketRef.current(id)
        addLogRef.current('Group deleted from task context', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_members_added', (payload) => {
        const { count } = payload as { count: number }
        addLogRef.current(`${count} task(s) added to group`, 'info')
        loadTasksRef.current()
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_members_removed', (payload) => {
        const { count } = payload as { count: number }
        addLogRef.current(`${count} task(s) removed from group`, 'info')
        loadTasksRef.current()
      })
    )

    // Reconnect handler
    // Note: onReconnect doesn't return an unsubscribe function, it's a one-time registration
    wsHook.onReconnect(() => {
      console.log('[App] Reconnected - syncing state from server')
      Promise.all([
        loadTasksRef.current(),
        loadRunsRef.current(),
        loadOptionsRef.current(),
        loadGroupsRef.current(),
      ]).catch((err) => {
        console.error('[App] State resync failed:', err)
      })
    })

    return () => {
      unsubscribers.forEach((unsub) => unsub())
    }
    // Only depend on wsHook - all other dependencies are accessed through stable refs
    // This prevents unnecessary effect re-runs when hook objects change reference
  }, [wsHook])
}
