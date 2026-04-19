/**
 * Reference Data API - Static/reference data endpoints
 */

import { apiClient } from './client.ts'
import type { BranchList, ModelCatalog, ExecutionGraph } from '@/types'

export const referenceApi = {
  // Queries
  getBranches: () => apiClient.get<BranchList>('/api/branches'),
  getModels: () => apiClient.get<ModelCatalog>('/api/models'),
  getExecutionGraph: () => apiClient.get<ExecutionGraph>('/api/execution-graph'),
  getVersion: () => apiClient.get<{ version: string; commit: string; displayVersion: string; isCompiled: boolean }>('/api/version'),
}
