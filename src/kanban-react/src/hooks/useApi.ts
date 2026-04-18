import { useCallback, useRef } from 'react'
import type {
  Task, CreateTaskDTO, UpdateTaskDTO, CreateTaskAndWaitDTO, CreateAndWaitResult, WorkflowRun, Options, BranchList,
  ModelCatalog, ExecutionGraph, Session, SessionMessage, TaskRun,
  Candidate, BestOfNSummary, ReviewStatus, SessionUsageRollup,
  PlanningPrompt, PlanningPromptVersion, PlanningSession, CreatePlanningSessionDTO,
  ContainerImage, TaskGroup, TaskGroupWithTasks, TaskGroupStatus,
} from '@/types'
import type { ApiError } from '../../../shared/error-codes.ts'

export interface ArchivedTasksResponse {
  runs: {
    run: WorkflowRun
    tasks: Task[]
  }[]
}

const API_BASE = (import.meta as unknown as { env: { VITE_API_URL?: string } }).env.VITE_API_URL || location.origin

export class ApiErrorResponse extends Error {
  code?: string
  details?: Record<string, unknown>
  status: number

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiErrorResponse'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function useApi() {
  const requestRef = useRef(async <T>(path: string, options?: RequestInit): Promise<T> => {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(new Error('Request timeout')), 60000)
    
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        ...options,
      })
      
      // Clear timeout on successful response or if fetch completes before timeout
      clearTimeout(timeout)
      
      if (!res.ok) {
        const text = await res.text()
        let parsed: ApiError | undefined
        
        try {
          parsed = JSON.parse(text) as ApiError
        } catch (parseError) {
          throw new ApiErrorResponse(
            `Request failed (${res.status}): ${text || 'No error details provided'}`,
            res.status,
            undefined,
            { parseError: parseError instanceof Error ? parseError.message : 'Unknown parse error' }
          )
        }

        throw new ApiErrorResponse(
          parsed.error || text || `Request failed (${res.status})`,
          res.status,
          parsed.code,
          parsed.details
        )
      }
      if (res.status === 204) {
        return undefined as T
      }
      return res.json()
    } finally {
      clearTimeout(timeout)
    }
  })

  const request = useCallback(async <T>(path: string, options?: RequestInit): Promise<T> => {
    return requestRef.current(path, options)
  }, [])

  return {
    // Tasks - all callbacks are stable since they use request which is stable via ref
    getTasks: useCallback(() => request<Task[]>('/api/tasks'), []),
    getTask: useCallback((id: string) => request<Task>(`/api/tasks/${id}`), []),
    createTask: useCallback((data: CreateTaskDTO) => request<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }), []),
    createTaskAndWait: useCallback((data: CreateTaskAndWaitDTO) => request<CreateAndWaitResult>('/api/tasks/create-and-wait', {
      method: 'POST',
      body: JSON.stringify(data),
    }), []),
    updateTask: useCallback((id: string, data: UpdateTaskDTO) => request<Task>(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }), []),
    deleteTask: useCallback((id: string) => request<{ id: string; archived?: boolean }>(`/api/tasks/${id}`, {
      method: 'DELETE',
    }), []),
    reorderTask: useCallback((id: string, newIdx: number) => request('/api/tasks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ id, newIdx }),
    }), []),
    archiveAllDone: useCallback(() => request<{ archived: number; deleted: number }>('/api/tasks/done/all', {
      method: 'DELETE',
    }), []),
    startSingleTask: useCallback((id: string) => request(`/api/tasks/${id}/start`, { method: 'POST' }), []),
    approvePlan: useCallback((id: string, message?: string) => request<Task>(`/api/tasks/${id}/approve-plan`, {
      method: 'POST',
      body: message ? JSON.stringify({ message }) : undefined,
    }), []),
    requestPlanRevision: useCallback((id: string, feedback: string) => request<Task>(`/api/tasks/${id}/request-plan-revision`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    }), []),
    repairTask: useCallback((id: string, action: string, options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number }) =>
      request<{ ok: boolean; action: string; reason?: string; task: Task }>(`/api/tasks/${id}/repair-state`, {
        method: 'POST',
        body: JSON.stringify({ action, ...options }),
      }), []),
    resetTaskWithGroupInfo: useCallback((id: string) => request<{ task: Task; group?: TaskGroup; wasInGroup: boolean }>(`/api/tasks/${id}/reset`, { method: 'POST' }), []),
    resetTaskToGroup: useCallback((id: string) => request<{ task: Task; group: TaskGroup; restoredToGroup: boolean }>(`/api/tasks/${id}/reset-to-group`, { method: 'POST' }), []),
    moveTaskToGroup: useCallback((id: string, groupId: string | null) => request<Task>(`/api/tasks/${id}/move-to-group`, {
      method: 'POST',
      body: JSON.stringify({ groupId }),
    }), []),

    // Task metadata
    getTaskRuns: useCallback((id: string) => request<TaskRun[]>(`/api/tasks/${id}/runs`), []),
    getTaskSessions: useCallback((id: string) => request<Session[]>(`/api/tasks/${id}/sessions`), []),
    getTaskCandidates: useCallback((id: string) => request<Candidate[]>(`/api/tasks/${id}/candidates`), []),
    getBestOfNSummary: useCallback((id: string) => request<BestOfNSummary>(`/api/tasks/${id}/best-of-n-summary`), []),
    getReviewStatus: useCallback((id: string) => request<ReviewStatus>(`/api/tasks/${id}/review-status`), []),
    selectCandidate: useCallback((taskId: string, candidateId: string) => request(`/api/tasks/${taskId}/best-of-n/select-candidate`, {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }), []),
    abortBestOfN: useCallback((taskId: string, reason: string) => request(`/api/tasks/${taskId}/best-of-n/abort`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }), []),

    // Archived tasks
    getArchivedTasks: useCallback(() => request<ArchivedTasksResponse>('/api/archived/tasks'), []),

    // Workflow runs
    getRuns: useCallback(() => request<WorkflowRun[]>('/api/runs'), []),
    pauseRun: useCallback((id: string) => request<{ success: boolean; run: WorkflowRun }>(`/api/runs/${id}/pause`, { method: 'POST' }), []),
    resumeRun: useCallback((id: string) => request<{ success: boolean; run: WorkflowRun }>(`/api/runs/${id}/resume`, { method: 'POST' }), []),
    stopRun: useCallback((id: string, options?: { destructive?: boolean }) => request<{ success: boolean; run: WorkflowRun; killed?: number; cleaned?: number }>(`/api/runs/${id}/stop`, {
      method: 'POST',
      ...(options ? { body: JSON.stringify(options) } : {}),
    }), []),
    forceStopRun: useCallback((id: string) => request<{ success: boolean; killed: number; cleaned: number; run: WorkflowRun }>(`/api/runs/${id}/force-stop`, { method: 'POST' }), []),
    getPausedState: useCallback(() => request<{ hasPausedRun: boolean; state: unknown }>('/api/runs/paused-state'), []),
    archiveRun: useCallback((id: string) => request(`/api/runs/${id}`, { method: 'DELETE' }), []),

    // Options
    getOptions: useCallback(() => request<Options>('/api/options'), []),
    updateOptions: useCallback((data: Partial<Options>) => request<Options>('/api/options', {
      method: 'PUT',
      body: JSON.stringify(data),
    }), []),

    // Version
    getVersion: useCallback(() => request<{ version: string; commit: string; displayVersion: string; isCompiled: boolean }>('/api/version'), []),

    // Reference data
    getBranches: useCallback(() => request<BranchList>('/api/branches'), []),
    getModels: useCallback(() => request<ModelCatalog>('/api/models'), []),

    // Execution
    startExecution: useCallback(() => request('/api/start', { method: 'POST' }), []),
    stopExecution: useCallback(() => request('/api/stop', { method: 'POST' }), []),
    getExecutionGraph: useCallback(() => request<ExecutionGraph>('/api/execution-graph'), []),

    // Sessions
    getSession: useCallback((id: string) => request<Session>(`/api/sessions/${id}`), []),
    getSessionMessages: useCallback((id: string, limit = 1000) => request<SessionMessage[]>(`/api/sessions/${id}/messages?limit=${limit}`), []),
    getSessionUsage: useCallback((id: string) => request<SessionUsageRollup>(`/api/sessions/${id}/usage`), []),

    // Container
    getContainerImageStatus: useCallback(() => request('/api/container/image-status'), []),
    getContainerImages: useCallback(() => request<{ images: ContainerImage[] }>('/api/container/images'), []),
    deleteContainerImage: useCallback((tag: string) => request<{ success: boolean; message: string; tasksUsing?: string[] }>(`/api/container/images/${encodeURIComponent(tag)}`, { method: 'DELETE' }), []),
    validateContainerImage: useCallback((tag: string) => request<{ exists: boolean; tag: string; availableInPodman: boolean }>('/api/container/validate-image', {
      method: 'POST',
      body: JSON.stringify({ tag }),
    }), []),

    // Planning Chat
    getPlanningPrompt: useCallback(() => request<PlanningPrompt>('/api/planning/prompt'), []),
    getAllPlanningPrompts: useCallback(() => request<PlanningPrompt[]>('/api/planning/prompts'), []),
    updatePlanningPrompt: useCallback((data: { key?: string; name?: string; description?: string; promptText?: string; isActive?: boolean }) =>
      request<PlanningPrompt>('/api/planning/prompt', {
        method: 'PUT',
        body: JSON.stringify(data),
      }), []),
    getPlanningPromptVersions: useCallback((key: string) => request<PlanningPromptVersion[]>(`/api/planning/prompt/${key}/versions`), []),

    // Planning Sessions
    getPlanningSessions: useCallback(() => request<PlanningSession[]>('/api/planning/sessions'), []),
    getActivePlanningSessions: useCallback(() => request<PlanningSession[]>('/api/planning/sessions/active'), []),
    createPlanningSession: useCallback((data: CreatePlanningSessionDTO) => request<PlanningSession>('/api/planning/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }), []),
    getPlanningSession: useCallback((id: string) => request<PlanningSession>(`/api/planning/sessions/${id}`), []),
    updatePlanningSession: useCallback((id: string, data: { status?: string; errorMessage?: string }) =>
      request<PlanningSession>(`/api/planning/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }), []),
    reconnectPlanningSession: useCallback((id: string, data?: { model?: string; thinkingLevel?: string }) =>
      request<PlanningSession>(`/api/planning/sessions/${id}/reconnect`, {
        method: 'POST',
        ...(data ? { body: JSON.stringify(data) } : {}),
      }), []),
    setPlanningSessionModel: useCallback((id: string, model: string, thinkingLevel?: string) =>
      request<{ ok: boolean; model: string; thinkingLevel?: string }>(`/api/planning/sessions/${id}/model`, {
        method: 'POST',
        body: JSON.stringify({ model, thinkingLevel }),
      }), []),
    closePlanningSession: useCallback((id: string) => request<PlanningSession>(`/api/planning/sessions/${id}/close`, {
      method: 'POST',
    }), []),
    getPlanningSessionMessages: useCallback((id: string, limit = 500) => request<SessionMessage[]>(`/api/planning/sessions/${id}/messages?limit=${limit}`), []),
    getPlanningSessionTimeline: useCallback((id: string) => request(`/api/planban/sessions/${id}/timeline`), []),

    // Send message to planning session
    sendPlanningMessage: useCallback((id: string, content: string, contextAttachments?: Array<{ type: 'file' | 'screenshot' | 'task'; name: string; content?: string; filePath?: string; taskId?: string }>) =>
      request<{ ok: boolean }>(`/api/planning/sessions/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, contextAttachments }),
      }), []),

    createTasksFromPlanning: useCallback((id: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) =>
      request<{ tasks?: Task[]; count?: number; message?: string }>(`/api/planning/sessions/${id}/create-tasks`, {
        method: 'POST',
        body: JSON.stringify({ tasks }),
      }), []),

    // Task Groups
    getTaskGroups: useCallback(() => request<TaskGroup[]>('/api/task-groups'), []),
    getTaskGroup: useCallback((id: string) => request<TaskGroupWithTasks>(`/api/task-groups/${id}`), []),
    createTaskGroup: useCallback((data: { name?: string; color?: string; taskIds?: string[] }) =>
      request<TaskGroup>('/api/task-groups', {
        method: 'POST',
        body: JSON.stringify(data),
      }), []),
    updateTaskGroup: useCallback((id: string, data: { name?: string; color?: string; status?: TaskGroupStatus }) =>
      request<TaskGroup>(`/api/task-groups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }), []),
    deleteTaskGroup: useCallback((id: string) =>
      request(`/api/task-groups/${id}`, { method: 'DELETE' }), []),
    addTasksToGroup: useCallback((groupId: string, taskIds: string[]) =>
      request<TaskGroup>(`/api/task-groups/${groupId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ taskIds }),
      }), []),
    removeTasksFromGroup: useCallback((groupId: string, taskIds: string[]) =>
      request<TaskGroup>(`/api/task-groups/${groupId}/tasks`, {
        method: 'DELETE',
        body: JSON.stringify({ taskIds }),
      }), []),
    startGroup: useCallback((groupId: string) =>
      request<WorkflowRun>(`/api/task-groups/${groupId}/start`, { method: 'POST' }), []),
  }
}
