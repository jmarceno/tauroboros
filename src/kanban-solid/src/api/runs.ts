/**
 * Workflow Runs API - All run-related API endpoints
 */

import { apiClient } from './client.ts'
import type { WorkflowRun } from '@/types'

export interface CleanRunResult {
  success: boolean
  tasksReset: number
  sessionsDeleted: number
  taskRunsDeleted: number
  candidatesDeleted: number
  reportsDeleted: number
  runsDeleted: number
  message: string
}

export const runsApi = {
  // Queries
  getAll: () => apiClient.get<WorkflowRun[]>('/api/runs'),
  getPausedState: () => apiClient.get<{ hasPausedRun: boolean; state: unknown }>('/api/runs/paused-state'),
  getSlots: () => apiClient.get<{
    maxSlots: number
    usedSlots: number
    availableSlots: number
    tasks: Array<{ taskId: string; runId: string; taskName: string; slotIndex: number }>
  }>('/api/slots'),
  getQueueStatus: (id: string) => apiClient.get<{
    runId: string
    status: WorkflowRun['status']
    totalTasks: number
    queuedTasks: number
    executingTasks: number
    completedTasks: number
  }>(`/api/runs/${id}/queue-status`),

  // Mutations
  pause: (id: string) => apiClient.post<{ success: boolean; run: WorkflowRun }>(`/api/runs/${id}/pause`),
  resume: (id: string) => apiClient.post<{ success: boolean; run: WorkflowRun }>(`/api/runs/${id}/resume`),
  stop: (id: string, options?: { destructive?: boolean }) =>
    apiClient.post<{ success: boolean; run: WorkflowRun; killed?: number; cleaned?: number }>(`/api/runs/${id}/stop`, options),
  forceStop: (id: string) => apiClient.post<{ success: boolean; killed: number; cleaned: number; run: WorkflowRun }>(`/api/runs/${id}/force-stop`),
  archive: (id: string) => apiClient.delete(`/api/runs/${id}`),
  clean: (id: string) => apiClient.post<CleanRunResult>(`/api/runs/${id}/clean`),
}
