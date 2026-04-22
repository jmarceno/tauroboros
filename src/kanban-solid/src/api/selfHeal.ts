/**
 * Self-Heal Reports API
 */

import { apiClient } from './client.ts'
import type { SelfHealReport } from '@/types'

export const selfHealApi = {
  getReportsForRun: (runId: string) =>
    apiClient.get<SelfHealReport[]>(`/api/runs/${runId}/self-heal-reports`),

  getReportsForTask: (taskId: string) =>
    apiClient.get<SelfHealReport[]>(`/api/tasks/${taskId}/self-heal-reports`),

  manualRecover: (taskId: string, reportId: string, action: 'restart_task' | 'keep_failed') =>
    apiClient.post<{ ok: boolean; message: string }>(`/api/tasks/${taskId}/self-heal-recover`, {
      reportId,
      action,
    }),
}
