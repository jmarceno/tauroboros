/**
 * Options API - Workflow options and execution control
 */

import { apiClient } from './client.ts'
import type { Options } from '@/types'

export const optionsApi = {
  // Queries
  get: () => apiClient.get<Options>('/api/options'),

  // Mutations
  update: (data: Partial<Options>) => apiClient.put<Options>('/api/options', data),
  startExecution: () => apiClient.post('/api/start'),
  stopExecution: () => apiClient.post('/api/stop'),
}
