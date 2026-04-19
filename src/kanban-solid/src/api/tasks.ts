/**
 * Tasks API - All task-related API endpoints
 */

import { apiClient } from './client.ts'
import type {
  Task,
  CreateTaskDTO,
  CreateTaskAndWaitDTO,
  CreateAndWaitResult,
  UpdateTaskDTO,
  TaskGroup,
  BestOfNSummary,
  TaskRun,
  Candidate,
  ReviewStatus,
  Session,
  SessionUsageRollup,
} from '@/types'

export const tasksApi = {
  // Queries (GET requests)
  getAll: () => apiClient.get<Task[]>('/api/tasks'),
  getById: (id: string) => apiClient.get<Task>(`/api/tasks/${id}`),
  getTaskRuns: (id: string) => apiClient.get<TaskRun[]>(`/api/tasks/${id}/runs`),
  getTaskSessions: (id: string) => apiClient.get<Session[]>(`/api/tasks/${id}/sessions`),
  getTaskCandidates: (id: string) => apiClient.get<Candidate[]>(`/api/tasks/${id}/candidates`),
  getBestOfNSummary: (id: string) => apiClient.get<BestOfNSummary>(`/api/tasks/${id}/best-of-n-summary`),
  getReviewStatus: (id: string) => apiClient.get<ReviewStatus>(`/api/tasks/${id}/review-status`),
  getLastUpdate: (id: string) => apiClient.get<{ taskId: string; lastUpdateAt: number | null }>(`/api/tasks/${id}/last-update`),

  // Mutations (POST/PATCH/PUT/DELETE)
  create: (data: CreateTaskDTO) => apiClient.post<Task>('/api/tasks', data),
  createAndWait: (data: CreateTaskAndWaitDTO) => apiClient.post<CreateAndWaitResult>('/api/tasks/create-and-wait', data),
  update: (id: string, data: UpdateTaskDTO) => apiClient.patch<Task>(`/api/tasks/${id}`, data),
  delete: (id: string) => apiClient.delete<{ id: string; archived?: boolean }>(`/api/tasks/${id}`),
  reorder: (id: string, newIdx: number) => apiClient.put('/api/tasks/reorder', { id, newIdx }),
  archiveAllDone: () => apiClient.delete<{ archived: number; deleted: number }>('/api/tasks/done/all'),
  startSingle: (id: string) => apiClient.post(`/api/tasks/${id}/start`),
  
  // Plan management
  approvePlan: (id: string, message?: string) => apiClient.post<Task>(`/api/tasks/${id}/approve-plan`, message ? { message } : undefined),
  requestPlanRevision: (id: string, feedback: string) => apiClient.post<Task>(`/api/tasks/${id}/request-plan-revision`, { feedback }),
  
  // Repair
  repair: (id: string, action: string, options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number }) =>
    apiClient.post<{ ok: boolean; action: string; reason?: string; task: Task }>(`/api/tasks/${id}/repair-state`, { action, ...options }),
  
  // Reset operations
  reset: (id: string) => apiClient.post<{ task: Task; group?: TaskGroup; wasInGroup: boolean }>(`/api/tasks/${id}/reset`),
  resetToGroup: (id: string) => apiClient.post<{ task: Task; group: TaskGroup; restoredToGroup: boolean }>(`/api/tasks/${id}/reset-to-group`),
  moveToGroup: (id: string, groupId: string | null) => apiClient.post<Task>(`/api/tasks/${id}/move-to-group`, { groupId }),
  
  // Best of N operations
  selectCandidate: (taskId: string, candidateId: string) => apiClient.post(`/api/tasks/${taskId}/best-of-n/select-candidate`, { candidateId }),
  abortBestOfN: (taskId: string, reason: string) => apiClient.post(`/api/tasks/${taskId}/best-of-n/abort`, { reason }),
  
  // Archived tasks
  getArchived: () => apiClient.get<{ runs: { run: import('@/types').WorkflowRun; tasks: Task[] }[] }>('/api/archived/tasks'),
}

// Helper to batch fetch BestOfN summaries
export async function fetchBestOfNSummaries(taskIds: string[]): Promise<Record<string, BestOfNSummary>> {
  const results = await Promise.all(
    taskIds.map(async (id) => {
      try {
        const summary = await tasksApi.getBestOfNSummary(id)
        return { id, summary }
      } catch {
        return { id, summary: null }
      }
    })
  )

  const summaries: Record<string, BestOfNSummary> = {}
  for (const { id, summary } of results) {
    if (summary) {
      summaries[id] = summary
    }
  }
  return summaries
}

// Helper to fetch session usage for multiple sessions
export async function fetchSessionUsages(sessionIds: string[]): Promise<Record<string, SessionUsageRollup>> {
  const results = await Promise.all(
    sessionIds.map(async (id) => {
      try {
        const usage = await apiClient.get<SessionUsageRollup>(`/api/sessions/${id}/usage`)
        return { id, usage }
      } catch {
        return { id, usage: null }
      }
    })
  )

  const usages: Record<string, SessionUsageRollup> = {}
  for (const { id, usage } of results) {
    if (usage) {
      usages[id] = usage
    }
  }
  return usages
}
