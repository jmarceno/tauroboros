import { ref } from 'vue'
import type {
  Task, CreateTaskDTO, UpdateTaskDTO, WorkflowRun, Options, BranchList,
  ModelCatalog, ExecutionGraph, Session, SessionMessage, TaskRun,
  Candidate, BestOfNSummary, ReviewStatus, SessionUsageRollup,
} from '@/types/api'

const API_BASE = import.meta.env.VITE_API_URL || location.origin

export function useApi() {
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
    isLoading.value = true
    error.value = null
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      })
      if (!res.ok) {
        const text = await res.text()
        let errorMessage = `Request failed (${res.status})`
        try {
          const parsed = JSON.parse(text)
          if (parsed?.error) errorMessage = parsed.error
          else errorMessage = text || errorMessage
        } catch {
          errorMessage = text || errorMessage
        }
        throw new Error(errorMessage)
      }
      return res.status === 204 ? undefined as T : res.json()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      isLoading.value = false
    }
  }

  return {
    isLoading,
    error,

    // Tasks
    getTasks: () => request<Task[]>('/api/tasks'),
    getTask: (id: string) => request<Task>(`/api/tasks/${id}`),
    createTask: (data: CreateTaskDTO) => request<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    updateTask: (id: string, data: UpdateTaskDTO) => request<Task>(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    deleteTask: (id: string) => request<{ id: string; archived?: boolean }>(`/api/tasks/${id}`, {
      method: 'DELETE',
    }),
    reorderTask: (id: string, newIdx: number) => request('/api/tasks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ id, newIdx }),
    }),
    archiveAllDone: () => request<{ archived: number; deleted: number }>('/api/tasks/done/all', {
      method: 'DELETE',
    }),
    startSingleTask: (id: string) => request(`/api/tasks/${id}/start`, { method: 'POST' }),
    approvePlan: (id: string, message?: string) => request<Task>(`/api/tasks/${id}/approve-plan`, {
      method: 'POST',
      body: message ? JSON.stringify({ message }) : undefined,
    }),
    requestPlanRevision: (id: string, feedback: string) => request<Task>(`/api/tasks/${id}/request-plan-revision`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    }),
    repairTask: (id: string, action: string, options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number }) =>
      request<{ ok: boolean; action: string; reason?: string; task: Task }>(`/api/tasks/${id}/repair-state`, {
        method: 'POST',
        body: JSON.stringify({ action, ...options }),
      }),
    resetTask: (id: string) => request<Task>(`/api/tasks/${id}/reset`, { method: 'POST' }),

    // Task metadata
    getTaskRuns: (id: string) => request<TaskRun[]>(`/api/tasks/${id}/runs`),
    getTaskCandidates: (id: string) => request<Candidate[]>(`/api/tasks/${id}/candidates`),
    getBestOfNSummary: (id: string) => request<BestOfNSummary>(`/api/tasks/${id}/best-of-n-summary`),
    getReviewStatus: (id: string) => request<ReviewStatus>(`/api/tasks/${id}/review-status`),
    selectCandidate: (taskId: string, candidateId: string) => request(`/api/tasks/${taskId}/best-of-n/select-candidate`, {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }),
    abortBestOfN: (taskId: string, reason: string) => request(`/api/tasks/${taskId}/best-of-n/abort`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

    // Workflow runs
    getRuns: () => request<WorkflowRun[]>('/api/runs'),
    pauseRun: (id: string) => request<WorkflowRun>(`/api/runs/${id}/pause`, { method: 'POST' }),
    resumeRun: (id: string) => request<WorkflowRun>(`/api/runs/${id}/resume`, { method: 'POST' }),
    stopRun: (id: string) => request<WorkflowRun>(`/api/runs/${id}/stop`, { method: 'POST' }),
    archiveRun: (id: string) => request(`/api/runs/${id}`, { method: 'DELETE' }),

    // Options
    getOptions: () => request<Options>('/api/options'),
    updateOptions: (data: Partial<Options>) => request<Options>('/api/options', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

    // Reference data
    getBranches: () => request<BranchList>('/api/branches'),
    getModels: () => request<ModelCatalog>('/api/models'),

    // Execution
    startExecution: () => request('/api/start', { method: 'POST' }),
    stopExecution: () => request('/api/stop', { method: 'POST' }),
    getExecutionGraph: () => request<ExecutionGraph>('/api/execution-graph'),

    // Sessions
    getSession: (id: string) => request<Session>(`/api/sessions/${id}`),
    getSessionMessages: (id: string, limit = 1000) => request<SessionMessage[]>(`/api/sessions/${id}/messages?limit=${limit}`),
    getSessionUsage: (id: string) => request<SessionUsageRollup>(`/api/sessions/${id}/usage`),

    // Container
    getContainerImageStatus: () => request('/api/container/image-status'),
  }
}
