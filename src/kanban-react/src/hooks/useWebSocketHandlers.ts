/**
 * WebSocket Handlers - TanStack Query Integration
 * 
 * This hook sets up WebSocket event handlers that invalidate TanStack Query caches
 * instead of manually merging state. This eliminates:
 * - Race conditions
 * - Stale closures  
 * - Manual state synchronization bugs
 */

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys, updateSessionMessagesCache, updateSessionCache, updateTaskGroupCache, removeTaskGroupCache, updatePlanningSessionMessagesCache, updatePlanningSessionCache } from '@/queries'
import type { Task, WorkflowRun, TaskGroup, Session, SessionMessage, PlanningSession, WSMessageType } from '@/types'
import type { WebSocketHook } from './useWebSocket.ts'

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

function isPlanningSession(payload: unknown): payload is PlanningSession {
  return typeof payload === 'object' && payload !== null && 'id' in payload && 'sessionKind' in payload && (payload as PlanningSession).sessionKind === 'planning'
}

function isPlanningMessage(payload: unknown): payload is { sessionId: string; message: SessionMessage } {
  return typeof payload === 'object' && payload !== null && 'sessionId' in payload && 'message' in payload
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

/**
 * Setup WebSocket handlers with TanStack Query cache invalidation
 */
export function useWebSocketHandlers(wsHook: WebSocketHook) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!wsHook) return

    const unsubscribers: (() => void)[] = []

    // ============================================================================
    // Task Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('task_created', (payload) => {
        if (!isTask(payload)) {
          console.error('[WebSocket] Invalid task_created payload:', payload)
          return
        }
        console.log('[WebSocket] Task created, invalidating tasks cache')
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('task_updated', (payload) => {
        if (!isTask(payload)) {
          console.error('[WebSocket] Invalid task_updated payload:', payload)
          return
        }
        // Invalidate the specific task and the list
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(payload.id) })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('task_deleted', (payload) => {
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid task_deleted payload:', payload)
          return
        }
        queryClient.removeQueries({ queryKey: queryKeys.tasks.detail(payload.id) })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('task_archived', (payload) => {
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid task_archived payload:', payload)
          return
        }
        queryClient.removeQueries({ queryKey: queryKeys.tasks.detail(payload.id) })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('task_reordered', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    // ============================================================================
    // Run Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('run_created', (payload) => {
        if (!isWorkflowRun(payload)) {
          console.error('[WebSocket] Invalid run_created payload:', payload)
          return
        }
        queryClient.setQueryData(queryKeys.runs.detail(payload.id), payload)
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('run_updated', (payload) => {
        if (!isWorkflowRun(payload)) {
          console.error('[WebSocket] Invalid run_updated payload:', payload)
          return
        }
        queryClient.setQueryData(queryKeys.runs.detail(payload.id), payload)
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('run_archived', (payload) => {
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid run_archived payload:', payload)
          return
        }
        queryClient.removeQueries({ queryKey: queryKeys.runs.detail(payload.id) })
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('execution_paused', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.pausedState() })
      })
    )

    unsubscribers.push(
      wsHook.on('execution_resumed', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.pausedState() })
      })
    )

    unsubscribers.push(
      wsHook.on('run_paused', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('run_resumed', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('run_stopped', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('execution_started', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('execution_stopped', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('execution_complete', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    // ============================================================================
    // Options Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('options_updated', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.options.current() })
      })
    )

    // ============================================================================
    // Session Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('session_started', (payload) => {
        if (!isSession(payload)) {
          console.error('[WebSocket] Invalid session_started payload:', payload)
          return
        }
        // Update cache with new session data
        queryClient.setQueryData(queryKeys.sessions.detail(payload.id), payload)
        // Invalidate task if associated
        if (payload.taskId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(payload.taskId) })
        }
      })
    )

    unsubscribers.push(
      wsHook.on('session_message_created', (payload) => {
        if (!isSessionMessage(payload)) {
          console.error('[WebSocket] Invalid session_message_created payload:', payload)
          return
        }
        // Update messages cache directly for real-time updates
        updateSessionMessagesCache(queryClient, payload.sessionId, payload)
      })
    )

    unsubscribers.push(
      wsHook.on('session_status_changed', (payload) => {
        if (!isSession(payload)) {
          console.error('[WebSocket] Invalid session_status_changed payload:', payload)
          return
        }
        updateSessionCache(queryClient, payload)
      })
    )

    unsubscribers.push(
      wsHook.on('session_completed', (payload) => {
        if (!isSession(payload)) {
          console.error('[WebSocket] Invalid session_completed payload:', payload)
          return
        }
        updateSessionCache(queryClient, payload)
      })
    )

    // ============================================================================
    // Task Run & Candidate Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('task_run_updated', (payload) => {
        if (!hasTaskId(payload)) {
          console.error('[WebSocket] Invalid task_run_updated payload:', payload)
          return
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.runs(payload.taskId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.bestOfNSummary(payload.taskId) })
      })
    )

    unsubscribers.push(
      wsHook.on('task_candidate_updated', (payload) => {
        if (!hasTaskId(payload)) {
          console.error('[WebSocket] Invalid task_candidate_updated payload:', payload)
          return
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.candidates(payload.taskId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.bestOfNSummary(payload.taskId) })
      })
    )

    // ============================================================================
    // Task Group Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('task_group_created', (payload) => {
        if (!isTaskGroup(payload)) {
          console.error('[WebSocket] Invalid task_group_created payload:', payload)
          return
        }
        updateTaskGroupCache(queryClient, payload)
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_updated', (payload) => {
        if (!isTaskGroup(payload)) {
          console.error('[WebSocket] Invalid task_group_updated payload:', payload)
          return
        }
        updateTaskGroupCache(queryClient, payload)
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_deleted', (payload) => {
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid task_group_deleted payload:', payload)
          return
        }
        removeTaskGroupCache(queryClient, payload.id)
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_members_added', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('task_group_members_removed', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('group_execution_started', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      })
    )

    unsubscribers.push(
      wsHook.on('group_execution_complete', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      })
    )

    // ============================================================================
    // Planning Chat Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('planning_session_created', (payload) => {
        if (!isPlanningSession(payload)) {
          console.error('[WebSocket] Invalid planning_session_created payload:', payload)
          return
        }
        updatePlanningSessionCache(queryClient, payload)
        queryClient.invalidateQueries({ queryKey: queryKeys.planning.activeSessions() })
      })
    )

    unsubscribers.push(
      wsHook.on('planning_session_updated', (payload) => {
        if (!isPlanningSession(payload)) {
          console.error('[WebSocket] Invalid planning_session_updated payload:', payload)
          return
        }
        updatePlanningSessionCache(queryClient, payload)
      })
    )

    unsubscribers.push(
      wsHook.on('planning_session_closed', (payload) => {
        if (!hasId(payload)) {
          console.error('[WebSocket] Invalid planning_session_closed payload:', payload)
          return
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.planning.session(payload.id) })
        queryClient.invalidateQueries({ queryKey: queryKeys.planning.activeSessions() })
      })
    )

    unsubscribers.push(
      wsHook.on('planning_session_message', (payload) => {
        if (!isPlanningMessage(payload)) {
          console.error('[WebSocket] Invalid planning_session_message payload:', payload)
          return
        }
        updatePlanningSessionMessagesCache(queryClient, payload.sessionId, payload.message)
      })
    )

    unsubscribers.push(
      wsHook.on('planning_prompt_updated', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.planning.prompts() })
      })
    )

    // ============================================================================
    // Container Events
    // ============================================================================

    unsubscribers.push(
      wsHook.on('container_config_updated', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.containers.status() })
      })
    )

    unsubscribers.push(
      wsHook.on('container_package_added', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.containers.status() })
      })
    )

    unsubscribers.push(
      wsHook.on('container_package_removed', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.containers.status() })
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_started', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.containers.images() })
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_completed', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.containers.images() })
      })
    )

    unsubscribers.push(
      wsHook.on('container_build_cancelled', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.containers.images() })
      })
    )

    unsubscribers.push(
      wsHook.on('container_profile_created', () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.containers.status() })
      })
    )

    // ============================================================================
    // Reconnection Handler
    // ============================================================================

    wsHook.onReconnect(() => {
      console.log('[WebSocket] Reconnected - syncing all data from server')
      // Invalidate all major queries to force refetch
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.options.current() })
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.sessions() })
    })

    return () => {
      unsubscribers.forEach((unsub) => unsub())
    }
  }, [wsHook, queryClient])
}
