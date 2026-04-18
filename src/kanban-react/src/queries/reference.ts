/**
 * Reference Data Queries - TanStack Query hooks for static/reference data
 */

import {
  useQuery,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { referenceApi } from '@/api'
import { queryKeys } from './keys.ts'
import type { BranchList, ModelCatalog, ExecutionGraph } from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get Git branches
 */
export function useBranchesQuery(options?: Omit<UseQueryOptions<BranchList, Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.reference.branches(),
    queryFn: referenceApi.getBranches,
    staleTime: 30000, // Branches don't change often
    ...options,
  })
}

/**
 * Get available models
 */
export function useModelsQuery(options?: Omit<UseQueryOptions<ModelCatalog, Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.reference.models(),
    queryFn: referenceApi.getModels,
    staleTime: 60000, // Models rarely change
    ...options,
  })
}

/**
 * Get execution graph
 */
export function useExecutionGraphQuery(options?: Omit<UseQueryOptions<ExecutionGraph, Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.reference.executionGraph(),
    queryFn: referenceApi.getExecutionGraph,
    staleTime: 5000,
    ...options,
  })
}

/**
 * Get version info
 */
export function useVersionQuery(options?: Omit<UseQueryOptions<{ version: string; commit: string; displayVersion: string; isCompiled: boolean }, Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.reference.version(),
    queryFn: referenceApi.getVersion,
    staleTime: Infinity, // Version never changes during runtime
    ...options,
  })
}
