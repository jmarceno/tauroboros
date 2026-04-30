/**
 * Tasks API - All task-related API endpoints
 */

import { Effect } from 'effect'
import { apiClient } from './client.ts'
import type {
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskGroup,
  BestOfNSummary,
  TaskRun,
  Candidate,
  ReviewStatus,
  Session,
  SessionUsageRollup,
  TaskDiffsResponse,
} from "@/types"

export const tasksApi = {
  getAll: () => apiClient.get<Task[]>("/api/tasks"),
  getById: (id: string) => apiClient.get<Task>(`/api/tasks/${id}`),
  getTaskRuns: (id: string) => apiClient.get<TaskRun[]>(`/api/tasks/${id}/runs`),
  getTaskSessions: (id: string) => apiClient.get<Session[]>(`/api/tasks/${id}/sessions`),
  getTaskCandidates: (id: string) => apiClient.get<Candidate[]>(`/api/tasks/${id}/candidates`),
  getBestOfNSummary: (id: string) => apiClient.get<BestOfNSummary>(`/api/tasks/${id}/best-of-n-summary`),
  getReviewStatus: (id: string) => apiClient.get<ReviewStatus>(`/api/tasks/${id}/review-status`),
  getLastUpdate: (id: string) =>
    apiClient.get<{ taskId: string; lastUpdateAt: number | null }>(`/api/tasks/${id}/last-update`),

  create: (data: CreateTaskDTO) => apiClient.post<Task>("/api/tasks", data),
  createAndWait: (data: unknown) => apiClient.post<unknown>("/api/tasks/create-and-wait", data),
  update: (id: string, data: UpdateTaskDTO) => apiClient.patch<Task>(`/api/tasks/${id}`, data),
  delete: (id: string) => apiClient.delete<{ id: string; archived?: boolean }>(`/api/tasks/${id}`),
  reorder: (id: string, newIdx: number) => apiClient.put("/api/tasks/reorder", { id, newIdx }),
  archiveAllDone: () => apiClient.delete<{ archived: number; deleted: number }>("/api/tasks/done/all"),
  startSingle: (id: string) => apiClient.post(`/api/tasks/${id}/start`),

  approvePlan: (id: string, message?: string) =>
    apiClient.post<Task>(`/api/tasks/${id}/approve-plan`, message ? { message } : undefined),

  requestPlanRevision: (id: string, feedback: string) =>
    apiClient.post<Task>(`/api/tasks/${id}/request-plan-revision`, { feedback }),

  repair: (
    id: string,
    action: string,
    options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number },
  ) =>
    apiClient.post<{ ok: boolean; action: string; reason?: string; task: Task }>(
      `/api/tasks/${id}/repair-state`,
      { action, ...options },
    ),

  reset: (id: string) =>
    apiClient.post<{ task: Task; group?: TaskGroup; wasInGroup: boolean }>(`/api/tasks/${id}/reset`),

  resetToGroup: (id: string) =>
    apiClient.post<{ task: Task; group: TaskGroup; restoredToGroup: boolean }>(`/api/tasks/${id}/reset-to-group`),

  moveToGroup: (id: string, groupId: string | null) =>
    apiClient.post<Task>(`/api/tasks/${id}/move-to-group`, { groupId }),

  selectCandidate: (taskId: string, candidateId: string) =>
    apiClient.post(`/api/tasks/${taskId}/best-of-n/select-candidate`, { candidateId }),

  abortBestOfN: (taskId: string, reason: string) =>
    apiClient.post(`/api/tasks/${taskId}/best-of-n/abort`, { reason }),

  getTaskDiffs: (id: string) =>
    apiClient.get<TaskDiffsResponse>(`/api/tasks/${id}/diffs`),

  getArchived: () =>
    apiClient.get<{ runs: { run: import("@/types").WorkflowRun; tasks: Task[] }[] }>("/api/archived/tasks"),
}

export function fetchBestOfNSummaries(taskIds: string[]) {
  return Effect.all(taskIds.map((id) =>
    tasksApi.getBestOfNSummary(id).pipe(
      Effect.map((summary) => ({ id, summary })),
    ),
  )).pipe(
    Effect.map((results) => {
      const summaries: Record<string, BestOfNSummary> = {}
      for (const { id, summary } of results) {
        summaries[id] = summary
      }
      return summaries
    }),
  )
}

export function fetchSessionUsages(sessionIds: string[]) {
  return Effect.all(sessionIds.map((id) =>
    apiClient.get<SessionUsageRollup>(`/api/sessions/${id}/usage`).pipe(
      Effect.map((usage) => ({ id, usage })),
    ),
  )).pipe(
    Effect.map((results) => {
      const usages: Record<string, SessionUsageRollup> = {}
      for (const { id, usage } of results) {
        usages[id] = usage
      }
      return usages
    }),
  )
}