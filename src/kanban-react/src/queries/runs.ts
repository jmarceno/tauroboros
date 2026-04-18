/**
 * Workflow Runs Queries - TanStack Query hooks for workflow runs
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { runsApi } from '@/api'
import { queryKeys } from './keys.ts'
import type { WorkflowRun } from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get all workflow runs
 */
export function useRunsQuery(options?: Omit<UseQueryOptions<WorkflowRun[], Error>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: queryKeys.runs.lists(),
    queryFn: runsApi.getAll,
    staleTime: 3000,
    ...options,
  })
}

/**
 * Get paused run state
 */
export function usePausedStateQuery(
  options?: Omit<UseQueryOptions<{ hasPausedRun: boolean; state: unknown }, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.runs.pausedState(),
    queryFn: runsApi.getPausedState,
    staleTime: 5000,
    ...options,
  })
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Pause a run
 */
export function usePauseRunMutation(
  options?: Omit<UseMutationOptions<{ success: boolean; run: WorkflowRun }, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: runsApi.pause,
    onSuccess: (result) => {
      // Update the specific run in cache
      queryClient.setQueryData(queryKeys.runs.detail(result.run.id), result.run)
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.pausedState() })
    },
    ...options,
  })
}

/**
 * Resume a run
 */
export function useResumeRunMutation(
  options?: Omit<UseMutationOptions<{ success: boolean; run: WorkflowRun }, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: runsApi.resume,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.runs.detail(result.run.id), result.run)
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.pausedState() })
    },
    ...options,
  })
}

/**
 * Stop a run
 */
export interface StopRunVariables {
  id: string
  destructive?: boolean
}

export function useStopRunMutation(
  options?: Omit<UseMutationOptions<{ success: boolean; run: WorkflowRun; killed?: number; cleaned?: number }, Error, StopRunVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, destructive }) => runsApi.stop(id, { destructive }),
    onSuccess: (result) => {
      if (result.run) {
        queryClient.setQueryData(queryKeys.runs.detail(result.run.id), result.run)
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Force stop a run
 */
export function useForceStopRunMutation(
  options?: Omit<UseMutationOptions<{ success: boolean; killed: number; cleaned: number; run: WorkflowRun }, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: runsApi.forceStop,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.runs.detail(result.run.id), result.run)
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

/**
 * Archive (delete) a run
 */
export function useArchiveRunMutation(
  options?: Omit<UseMutationOptions<void, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: runsApi.archive,
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.runs.detail(id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })
    },
    ...options,
  })
}
