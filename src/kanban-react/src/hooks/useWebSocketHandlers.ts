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

// Type guards for WebSocket payload validation
function isTask(payload: unknown): payload is Task {
  return typeof payload === 'object' && payload !== null && 'id' in payload && typeof (payload as Task).id === 'string'
}

function isWorkflowRun(payload: unknown): payload is WorkflowRun {
  return typeof payload === 'object' && payload !== null && 'id' in payload && 'status' in payload
}

function isTaskGroup(payload: unknown): payload is TaskGroup {
  return typeof payload === 'object' && payload !== null && 'id' in payload && 'name' in payload
}

function isSession(payload: unknown): payload is Session {
  return typeof payload === 'object' && payload !== null && 'id' in payload && 'sessionKind' in payload
}

function isSessionMessage(payload: unknown): payload is SessionMessage {
  return typeof payload === 'object' && payload !== null && 'sessionId' in payload && 'messageType' in payload
}

interface IdPayload {
  id: string
}

function hasId(payload: unknown): payload is IdPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.id === 'string'
}

interface RunIdPayload {
  runId: string
}

function hasRunId(payload: unknown): payload is RunIdPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.runId === 'string'
}

interface TaskIdPayload {
  taskId: string
}

function hasTaskId(payload: unknown): payload is TaskIdPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.taskId === 'string'
}

interface NamePayload {
  name: string
}

function hasName(payload: unknown): payload is NamePayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.name === 'string'
}

interface RunStoppedPayload {
  runId: string
  destructive?: boolean
}

function isRunStoppedPayload(payload: unknown): payload is RunStoppedPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.runId === 'string'
}

interface SessionStartedPayload {
  id: string
  taskId?: string
}

function isSessionStartedPayload(payload: unknown): payload is SessionStartedPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.id === 'string'
}

interface ImageStatusPayload {
  status: string
  message: string
  errorMessage?: string
}

function isImageStatusPayload(payload: unknown): payload is ImageStatusPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.status === 'string' && typeof p.message === 'string'
}

interface BuildCompletedPayload {
  status: string
  buildId: number
}

function isBuildCompletedPayload(payload: unknown): payload is BuildCompletedPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.status === 'string' && typeof p.buildId === 'number'
}

interface CountPayload {
  count: number
}

function isCountPayload(payload: unknown): payload is CountPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  return typeof p.count === 'number'
}

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

  const tasksRef = useRef(tasksHook.tasks)
  const runsRef = useRef(runsHook.runs)
  const sessionIdRef = useRef(sessionHook.sessionId)

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

  tasksRef.current = tasksHook.tasks
  runsRef.current = runsHook.runs
  sessionIdRef.current = sessionHook.sessionId
  runsArrayRef.current = runsHook.runs

  // Only depend on the stable wsHook reference - all other dependencies are accessed through refs
  useEffect(() => {
    if (!wsHook) return

    const unsubscribers: (() => void)[] = []

    // Task event handlers - using refs to access latest state without causing re-runs
    unsubscribers.push(
      wsHook.on('task_created', async (payload) => {
        if (!isTask(payload)) {
          console.error('[WebSocket] Invalid task_created payload:', payload)
          return
        }
        const task = payload
        if (!task.id) return
        const currentTasks = tasksRef.current
        const existingTask = currentTasks.find((t) => t.id === task.id)
        if (existingTask) return
        setTasksRef.current([...currentTasks, task])
        addLogRef.current(`Task created: ${task.name} (status: ${task.status || 'undefined'})`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('task_updated', async (payload) => {
        if (!isTask(payload)) {
          console.error('[WebSocket] Invalid task_updated payload:', payload)
          return
        }
        const task = payload
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
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid task_deleted payload:', payload)
          return
        }
        const { id } = payload
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
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid task_archived payload:', payload)
          return
        }
        const { id } = payload
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

    unsubscribers.push(
      wsHook.on('options_updated', () => {
        addLogRef.current('Options updated', 'info')
        loadOptionsRef.current()
      })
    )

    // Run handlers
    unsubscribers.push(
      wsHook.on('run_created', (payload) => {
        if (!isWorkflowRun(payload)) {
          console.error('[WebSocket] Invalid run_created payload:', payload)
          return
        }
        updateRunFromWebSocketRef.current(payload)
        handleRunUpdateRef.current(payload)
      })
    )

    unsubscribers.push(
      wsHook.on('run_updated', (payload) => {
        if (!isWorkflowRun(payload)) {
          console.error('[WebSocket] Invalid run_updated payload:', payload)
          return
        }
        updateRunFromWebSocketRef.current(payload)
        handleRunUpdateRef.current(payload)
      })
    )

    unsubscribers.push(
      wsHook.on('run_archived', (payload) => {
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid run_archived payload:', payload)
          return
        }
        addLogRef.current(`Workflow run archived: ${payload.id}`, 'info')
        removeRunRef.current(payload.id)
        clearRunRef.current()
      })
    )

    unsubscribers.push(
      wsHook.on('execution_paused', (payload) => {
        if (!hasRunId(payload)) {
          console.error('[WebSocket] Invalid execution_paused payload:', payload)
          return
        }
        showToastRef.current('Workflow paused', 'info')
        addLogRef.current(`Workflow paused: ${payload.runId}`, 'info')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('execution_resumed', (payload) => {
        if (!hasRunId(payload)) {
          console.error('[WebSocket] Invalid execution_resumed payload:', payload)
          return
        }
        showToastRef.current('Workflow resumed', 'success')
        addLogRef.current(`Workflow resumed: ${payload.runId}`, 'success')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('run_paused', (payload) => {
        if (!hasRunId(payload)) {
          console.error('[WebSocket] Invalid run_paused payload:', payload)
          return
        }
        showToastRef.current('Workflow run paused', 'info')
        addLogRef.current(`Workflow run paused: ${payload.runId}`, 'info')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('run_resumed', (payload) => {
        if (!hasRunId(payload)) {
          console.error('[WebSocket] Invalid run_resumed payload:', payload)
          return
        }
        showToastRef.current('Workflow run resumed', 'success')
        addLogRef.current(`Workflow run resumed: ${payload.runId}`, 'success')
        updateStateFromRunsRef.current(runsRef.current)
      })
    )

    unsubscribers.push(
      wsHook.on('run_stopped', (payload) => {
        if (!isRunStoppedPayload(payload)) {
          console.error('[WebSocket] Invalid run_stopped payload:', payload)
          return
        }
        const message = payload.destructive ? 'Workflow force stopped' : 'Workflow stopped'
        showToastRef.current(message, payload.destructive ? 'error' : 'info')
        addLogRef.current(`${message}: ${payload.runId}`, payload.destructive ? 'error' : 'info')
        loadRunsRef.current()
      })
    )

    unsubscribers.push(
      wsHook.on('session_started', (payload) => {
        if (!isSessionStartedPayload(payload)) {
          console.error('[WebSocket] Invalid session_started payload:', payload)
          return
        }
        const currentTasks = tasksRef.current
        if (payload.taskId && payload.id) {
          const idx = currentTasks.findIndex((t) => t.id === payload.taskId)
          if (idx >= 0) {
            const updatedTasks = [...currentTasks]
            updatedTasks[idx] = {
              ...updatedTasks[idx],
              sessionId: payload.id,
              sessionUrl: `/#session/${encodeURIComponent(payload.id)}`,
            }
            setTasksRef.current(updatedTasks)
          }
        }
        if (sessionIdRef.current === payload.id) {
          const sessionData: Session = {
            id: payload.id,
            sessionKind: 'task',
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            taskId: payload.taskId,
          }
          updateSessionRef.current(sessionData)
        }
      })
    )

    unsubscribers.push(
      wsHook.on('session_message_created', (payload) => {
        if (!isSessionMessage(payload)) {
          console.error('[WebSocket] Invalid session_message_created payload:', payload)
          return
        }
        if (payload.sessionId === sessionIdRef.current) {
          addMessageRef.current(payload)
        }
      })
    )

    unsubscribers.push(
      wsHook.on('session_status_changed', (payload) => {
        if (!isSession(payload)) {
          console.error('[WebSocket] Invalid session_status_changed payload:', payload)
          return
        }
        if (sessionIdRef.current === payload.id) {
          updateSessionRef.current(payload)
        }
      })
    )

    unsubscribers.push(
      wsHook.on('session_completed', (payload) => {
        if (!isSession(payload)) {
          console.error('[WebSocket] Invalid session_completed payload:', payload)
          return
        }
        if (sessionIdRef.current === payload.id) {
          updateSessionRef.current(payload)
        }
      })
    )

    unsubscribers.push(
      wsHook.on('task_run_updated', (payload) => {
        if (!hasTaskId(payload)) {
          console.error('[WebSocket] Invalid task_run_updated payload:', payload)
          return
        }
        refreshBonSummariesRef.current(undefined, [payload.taskId])
      })
    )

    unsubscribers.push(
      wsHook.on('task_candidate_updated', (payload) => {
        if (!hasTaskId(payload)) {
          console.error('[WebSocket] Invalid task_candidate_updated payload:', payload)
          return
        }
        refreshBonSummariesRef.current(undefined, [payload.taskId])
      })
    )

    unsubscribers.push(
      wsHook.on('image_status', (payload) => {
        if (!isImageStatusPayload(payload)) {
          console.error('[WebSocket] Invalid image_status payload:', payload)
          return
        }
        if (payload.status === 'preparing') {
          addLogRef.current(`⏳ ${payload.message}`, 'info')
        } else if (payload.status === 'ready') {
          addLogRef.current(`✅ ${payload.message}`, 'success')
        } else if (payload.status === 'error') {
          addLogRef.current(
            `❌ ${payload.message}${payload.errorMessage ? ': ' + payload.errorMessage : ''}`,
            'error'
          )
          showToastRef.current(`Container image error: ${payload.errorMessage || payload.message}`, 'error')
        }
      })
    )

    unsubscribers.push(
      wsHook.on('error', (payload) => {
        if (typeof payload === 'object' && payload !== null && 'message' in payload) {
          const p = payload as Record<string, unknown>
          if (typeof p.message === 'string') {
            showToastRef.current(p.message, 'error')
            return
          }
        }
        showToastRef.current(String(payload), 'error')
      })
    )

    unsubscribers.push(
      wsHook.on('container_config_updated', () => {
        addLogRef.current('Container configuration updated', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_package_added', (payload) => {
        if (!hasName(payload)) {
          console.error('[WebSocket] Invalid container_package_added payload:', payload)
          return
        }
        addLogRef.current(`Package '${payload.name}' added to container config`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_package_removed', () => {
        addLogRef.current('Package removed from container config', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_started', (payload) => {
        if (typeof payload !== 'object' || payload === null) {
          console.error('[WebSocket] Invalid container_build_started payload:', payload)
          return
        }
        const p = payload as Record<string, unknown>
        if (typeof p.buildId !== 'number' || typeof p.imageTag !== 'string') {
          console.error('[WebSocket] Invalid container_build_started payload:', payload)
          return
        }
        showToastRef.current('Container build started', 'info')
        addLogRef.current(`Container build #${p.buildId} started (${p.imageTag})`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_progress', () => {
        // Progress updates handled within modal
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_completed', (payload) => {
        if (!isBuildCompletedPayload(payload)) {
          console.error('[WebSocket] Invalid container_build_completed payload:', payload)
          return
        }
        if (payload.status === 'success') {
          showToastRef.current('Container build completed successfully!', 'success')
          addLogRef.current(`Container build #${payload.buildId} completed successfully`, 'success')
        } else if (payload.status === 'failed') {
          showToastRef.current('Container build failed', 'error')
          addLogRef.current(`Container build #${payload.buildId} failed`, 'error')
        }
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_cancelled', (payload) => {
        if (typeof payload !== 'object' || payload === null) {
          console.error('[WebSocket] Invalid container_build_cancelled payload:', payload)
          return
        }
        const p = payload as Record<string, unknown>
        if (typeof p.buildId !== 'number') {
          console.error('[WebSocket] Invalid container_build_cancelled payload:', payload)
          return
        }
        addLogRef.current(`Container build #${p.buildId} cancelled`, 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('container_profile_created', (payload) => {
        if (!hasName(payload)) {
          console.error('[WebSocket] Invalid container_profile_created payload:', payload)
          return
        }
        showToastRef.current(`New profile "${payload.name}" created`, 'success')
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


    unsubscribers.push(
      wsHook.on('task_group_created', (payload) => {
        if (!isTaskGroup(payload)) {
          console.error('[WebSocket] Invalid task_group_created payload:', payload)
          return
        }
        updateGroupFromWebSocketRef.current(payload)
        addLogRef.current(`Group created from task context: ${payload.name}`, 'success')
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_updated', (payload) => {
        if (!isTaskGroup(payload)) {
          console.error('[WebSocket] Invalid task_group_updated payload:', payload)
          return
        }
        updateGroupFromWebSocketRef.current(payload)
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_deleted', (payload) => {
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid task_group_deleted payload:', payload)
          return
        }
        removeGroupFromWebSocketRef.current(payload.id)
        addLogRef.current('Group deleted from task context', 'info')
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_members_added', (payload) => {
        if (!isCountPayload(payload)) {
          console.error('[WebSocket] Invalid task_group_members_added payload:', payload)
          return
        }
        addLogRef.current(`${payload.count} task(s) added to group`, 'info')
        loadTasksRef.current()
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_members_removed', (payload) => {
        if (!isCountPayload(payload)) {
          console.error('[WebSocket] Invalid task_group_members_removed payload:', payload)
          return
        }
        addLogRef.current(`${payload.count} task(s) removed from group`, 'info')
        loadTasksRef.current()
      })
    )
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
