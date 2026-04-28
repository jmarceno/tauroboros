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
}
