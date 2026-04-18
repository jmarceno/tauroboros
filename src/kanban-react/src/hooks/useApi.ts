import { useCallback } from "react"
import type {
  Task, CreateTaskDTO, UpdateTaskDTO, CreateTaskAndWaitDTO, CreateAndWaitResult, WorkflowRun, Options, BranchList,
  ModelCatalog, ExecutionGraph, Session, SessionMessage, TaskRun,
  Candidate, BestOfNSummary, ReviewStatus, SessionUsageRollup,
  PlanningPrompt, PlanningPromptVersion, PlanningSession, CreatePlanningSessionDTO,
  ContainerImage, TaskGroup, TaskGroupWithTasks, TaskGroupStatus,
} from "@/types"
import type { ApiError } from "../../../shared/error-codes.ts"

const API_BASE = import.meta.env.VITE_API_URL || location.origin

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
  const request = useCallback(async <T>(path: string, options?: RequestInit): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    })
    if (!res.ok) {
      const text = await res.text()
      let errorMessage = `Request failed (${res.status})`
      let errorCode: string | undefined
      let errorDetails: Record<string, unknown> | undefined

      try {
        const parsed = JSON.parse(text) as ApiError
        if (parsed?.error) errorMessage = parsed.error
        else errorMessage = text || errorMessage
        errorCode = parsed?.code
        errorDetails = parsed?.details
      } catch {
        errorMessage = text || errorMessage
      }

      throw new ApiErrorResponse(errorMessage, res.status, errorCode, errorDetails)
    }
    return res.status === 204 ? undefined as T : res.json()
  }, [])

  return {
    // Tasks
    getTasks: useCallback(() => request<Task[]>('/api/tasks'), [request]),
    getTask: useCallback((id: string) => request<Task>(`/api/tasks/${id}`), [request]),
    createTask: useCallback((data: CreateTaskDTO) => request<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }), [request]),
    createTaskAndWait: useCallback((data: CreateTaskAndWaitDTO) => request<CreateAndWaitResult>('/api/tasks/create-and-wait', {
      method: 'POST',
      body: JSON.stringify(data),
    }), [request]),
    updateTask: useCallback((id: string, data: UpdateTaskDTO) => request<Task>(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }), [request]),
    deleteTask: useCallback((id: string) => request<{ id: string; archived?: boolean }>(`/api/tasks/${id}`, {
      method: 'DELETE',
    }), [request]),
    reorderTask: useCallback((id: string, newIdx: number) => request('/api/tasks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ id, newIdx }),
    }), [request]),
    archiveAllDone: useCallback(() => request<{ archived: number; deleted: number }>('/api/tasks/done/all', {
      method: 'DELETE',
    }), [request]),
    startSingleTask: useCallback((id: string) => request(`/api/tasks/${id}/start`, { method: 'POST' }), [request]),
    approvePlan: useCallback((id: string, message?: string) => request<Task>(`/api/tasks/${id}/approve-plan`, {
      method: 'POST',
      body: message ? JSON.stringify({ message }) : undefined,
    }), [request]),
    requestPlanRevision: useCallback((id: string, feedback: string) => request<Task>(`/api/tasks/${id}/request-plan-revision`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    }), [request]),
    repairTask: useCallback((id: string, action: string, options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number }) =>
      request<{ ok: boolean; action: string; reason?: string; task: Task }>(`/api/tasks/${id}/repair-state`, {
        method: 'POST',
        body: JSON.stringify({ action, ...options }),
      }), [request]),
    resetTask: useCallback((id: string) => request<Task>(`/api/tasks/${id}/reset`, { method: 'POST' }), [request]),

    // Task metadata
    getTaskRuns: useCallback((id: string) => request<TaskRun[]>(`/api/tasks/${id}/runs`), [request]),
    getTaskSessions: useCallback((id: string) => request<Session[]>(`/api/tasks/${id}/sessions`), [request]),
    getTaskCandidates: useCallback((id: string) => request<Candidate[]>(`/api/tasks/${id}/candidates`), [request]),
    getBestOfNSummary: useCallback((id: string) => request<BestOfNSummary>(`/api/tasks/${id}/best-of-n-summary`), [request]),
    getReviewStatus: useCallback((id: string) => request<ReviewStatus>(`/api/tasks/${id}/review-status`), [request]),
    selectCandidate: useCallback((taskId: string, candidateId: string) => request(`/api/tasks/${taskId}/best-of-n/select-candidate`, {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }), [request]),
    abortBestOfN: useCallback((taskId: string, reason: string) => request(`/api/tasks/${taskId}/best-of-n/abort`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }), [request]),

    // Workflow runs
    getRuns: useCallback(() => request<WorkflowRun[]>('/api/runs'), [request]),
    pauseRun: useCallback((id: string) => request<{ success: boolean; run: WorkflowRun }>(`/api/runs/${id}/pause`, { method: 'POST' }), [request]),
    resumeRun: useCallback((id: string) => request<{ success: boolean; run: WorkflowRun }>(`/api/runs/${id}/resume`, { method: 'POST' }), [request]),
    stopRun: useCallback((id: string, options?: { destructive?: boolean }) => request<{ success: boolean; run: WorkflowRun; killed?: number; cleaned?: number }>(`/api/runs/${id}/stop`, {
      method: 'POST',
      ...(options ? { body: JSON.stringify(options) } : {}),
    }), [request]),
    forceStopRun: useCallback((id: string) => request<{ success: boolean; killed: number; cleaned: number; run: WorkflowRun }>(`/api/runs/${id}/force-stop`, { method: 'POST' }), [request]),
    getPausedState: useCallback(() => request<{ hasPausedRun: boolean; state: unknown }>('/api/runs/paused-state'), [request]),
    archiveRun: useCallback((id: string) => request(`/api/runs/${id}`, { method: 'DELETE' }), [request]),

    // Options
    getOptions: useCallback(() => request<Options>('/api/options'), [request]),
    updateOptions: useCallback((data: Partial<Options>) => request<Options>('/api/options', {
      method: 'PUT',
      body: JSON.stringify(data),
    }), [request]),

    // Version
    getVersion: useCallback(() => request<{ version: string; commit: string; displayVersion: string; isCompiled: boolean }>('/api/version'), [request]),

    // Reference data
    getBranches: useCallback(() => request<BranchList>('/api/branches'), [request]),
    getModels: useCallback(() => request<ModelCatalog>('/api/models'), [request]),

    // Execution
    startExecution: useCallback(() => request('/api/start', { method: 'POST' }), [request]),
    stopExecution: useCallback(() => request('/api/stop', { method: 'POST' }), [request]),
    getExecutionGraph: useCallback(() => request<ExecutionGraph>('/api/execution-graph'), [request]),

    // Sessions
    getSession: useCallback((id: string) => request<Session>(`/api/sessions/${id}`), [request]),
    getSessionMessages: useCallback((id: string, limit = 1000) => request<SessionMessage[]>(`/api/sessions/${id}/messages?limit=${limit}`), [request]),
    getSessionUsage: useCallback((id: string) => request<SessionUsageRollup>(`/api/sessions/${id}/usage`), [request]),

    // Container
    getContainerImageStatus: useCallback(() => request('/api/container/image-status'), [request]),
    getContainerImages: useCallback(() => request<{ images: ContainerImage[] }>('/api/container/images'), [request]),
    deleteContainerImage: useCallback((tag: string) => request<{ success: boolean; message: string; tasksUsing?: string[] }>(`/api/container/images/${encodeURIComponent(tag)}`, { method: 'DELETE' }), [request]),
    validateContainerImage: useCallback((tag: string) => request<{ exists: boolean; tag: string; availableInPodman: boolean }>('/api/container/validate-image', {
      method: 'POST',
      body: JSON.stringify({ tag }),
    }), [request]),

    // Planning Chat
    getPlanningPrompt: useCallback(() => request<PlanningPrompt>('/api/planning/prompt'), [request]),
    getAllPlanningPrompts: useCallback(() => request<PlanningPrompt[]>('/api/planning/prompts'), [request]),
    updatePlanningPrompt: useCallback((data: { key?: string; name?: string; description?: string; promptText?: string; isActive?: boolean }) =>
      request<PlanningPrompt>('/api/planning/prompt', {
        method: 'PUT',
        body: JSON.stringify(data),
      }), [request]),
    getPlanningPromptVersions: useCallback((key: string) => request<PlanningPromptVersion[]>(`/api/planning/prompt/${key}/versions`), [request]),

    // Planning Sessions
    getPlanningSessions: useCallback(() => request<PlanningSession[]>('/api/planning/sessions'), [request]),
    getActivePlanningSessions: useCallback(() => request<PlanningSession[]>('/api/planning/sessions/active'), [request]),
    createPlanningSession: useCallback((data: CreatePlanningSessionDTO) => request<PlanningSession>('/api/planning/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }), [request]),
    getPlanningSession: useCallback((id: string) => request<PlanningSession>(`/api/planning/sessions/${id}`), [request]),
    updatePlanningSession: useCallback((id: string, data: { status?: string; errorMessage?: string }) =>
      request<PlanningSession>(`/api/planning/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }), [request]),
    reconnectPlanningSession: useCallback((id: string, data?: { model?: string; thinkingLevel?: string }) =>
      request<PlanningSession>(`/api/planning/sessions/${id}/reconnect`, {
        method: 'POST',
        ...(data ? { body: JSON.stringify(data) } : {}),
      }), [request]),
    setPlanningSessionModel: useCallback((id: string, model: string, thinkingLevel?: string) =>
      request<{ ok: boolean; model: string; thinkingLevel?: string }>(`/api/planning/sessions/${id}/model`, {
        method: 'POST',
        body: JSON.stringify({ model, thinkingLevel }),
      }), [request]),
    closePlanningSession: useCallback((id: string) => request<PlanningSession>(`/api/planning/sessions/${id}/close`, {
      method: 'POST',
    }), [request]),
    getPlanningSessionMessages: useCallback((id: string, limit = 500) => request<SessionMessage[]>(`/api/planning/sessions/${id}/messages?limit=${limit}`), [request]),
    getPlanningSessionTimeline: useCallback((id: string) => request(`/api/planban/sessions/${id}/timeline`), [request]),

    // Send message to planning session
    sendPlanningMessage: useCallback((id: string, content: string, contextAttachments?: Array<{ type: 'file' | 'screenshot' | 'task'; name: string; content?: string; filePath?: string; taskId?: string }>) =>
      request<{ ok: boolean }>(`/api/planning/sessions/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, contextAttachments }),
      }), [request]),

    createTasksFromPlanning: useCallback((id: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) =>
      request<{ tasks?: Task[]; count?: number; message?: string }>(`/api/planning/sessions/${id}/create-tasks`, {
        method: 'POST',
        body: JSON.stringify({ tasks }),
      }), [request]),

    // Task Groups
    getTaskGroups: useCallback(() => request<TaskGroup[]>('/api/task-groups'), [request]),
    getTaskGroup: useCallback((id: string) => request<TaskGroupWithTasks>(`/api/task-groups/${id}`), [request]),
    createTaskGroup: useCallback((data: { name?: string; color?: string; taskIds?: string[] }) =>
      request<TaskGroup>('/api/task-groups', {
        method: 'POST',
        body: JSON.stringify(data),
      }), [request]),
    updateTaskGroup: useCallback((id: string, data: { name?: string; color?: string; status?: TaskGroupStatus }) =>
      request<TaskGroup>(`/api/task-groups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }), [request]),
    deleteTaskGroup: useCallback((id: string) =>
      request(`/api/task-groups/${id}`, { method: 'DELETE' }), [request]),
    addTasksToGroup: useCallback((groupId: string, taskIds: string[]) =>
      request<TaskGroup>(`/api/task-groups/${groupId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ taskIds }),
      }), [request]),
    removeTasksFromGroup: useCallback((groupId: string, taskIds: string[]) =>
      request<TaskGroup>(`/api/task-groups/${groupId}/tasks`, {
        method: 'DELETE',
        body: JSON.stringify({ taskIds }),
      }), [request]),
    startGroup: useCallback((groupId: string) =>
      request<WorkflowRun>(`/api/task-groups/${groupId}/start`, { method: 'POST' }), [request]),
  }
}
