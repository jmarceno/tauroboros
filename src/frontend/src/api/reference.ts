/**
 * Reference Data API - Static/reference data endpoints
 */

import { apiClient } from './client.ts'
import type { BranchList, ModelCatalog, ExecutionGraph } from '@/types'

export const referenceApi = {
  // Queries
  getBranches: () => apiClient.get<BranchList>('/api/branches'),
  getModels: () => apiClient.get<ModelCatalog>('/api/models'),
  getExecutionGraph: (groupId?: string) => {
    const path = groupId ? `/api/execution-graph?groupId=${encodeURIComponent(groupId)}` : '/api/execution-graph'
    return apiClient.get<ExecutionGraph>(path)
  },
  getVersion: () => apiClient.get<{ version: string; commit: string; displayVersion: string; isCompiled: boolean }>('/api/version'),
}
