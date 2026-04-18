/**
 * Options Queries - TanStack Query hooks for workflow options
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { optionsApi } from '@/api'
import { queryKeys } from './keys.ts'
import type { Options } from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get workflow options
 */
export function useOptionsQuery(options?: Omit<UseQueryOptions<Options, Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.options.current(),
    queryFn: optionsApi.get,
    staleTime: 10000, // Options don't change often
    ...options,
  })
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Update options
 */
export function useUpdateOptionsMutation(
  options?: Omit<UseMutationOptions<Options, Error, Partial<Options>>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: optionsApi.update,
    onSuccess: (updatedOptions) => {
      // Update cache immediately with new options
      queryClient.setQueryData(queryKeys.options.current(), updatedOptions)
    },
    ...options,
  })
}

/**
 * Start workflow execution
 */
export function useStartExecutionMutation(
  options?: Omit<UseMutationOptions<unknown, Error, void>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: optionsApi.startExecution,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Stop workflow execution
 */
export function useStopExecutionMutation(
  options?: Omit<UseMutationOptions<unknown, Error, void>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: optionsApi.stopExecution,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}
