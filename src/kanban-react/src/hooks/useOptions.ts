/**
 * Options Hook - TanStack Query Wrapper
 */

import { useCallback } from 'react'
import {
  useOptionsQuery,
  useUpdateOptionsMutation,
  useStartExecutionMutation,
  useStopExecutionMutation,
} from '@/queries'
import type { Options } from '@/types'

export function useOptions() {
  // Use TanStack Query
  const { data: options, isLoading, error } = useOptionsQuery()

  // Mutations
  const updateOptionsMutation = useUpdateOptionsMutation()
  const startExecutionMutation = useStartExecutionMutation()
  const stopExecutionMutation = useStopExecutionMutation()

  const loadOptions = useCallback(async () => {
    // Options are loaded automatically by the query
    // This function is kept for backward compatibility
    return options
  }, [options])

  const saveOptions = useCallback(async (data: Partial<Options>) => {
    return await updateOptionsMutation.mutateAsync(data)
  }, [updateOptionsMutation])

  const startExecution = useCallback(async () => {
    return await startExecutionMutation.mutateAsync()
  }, [startExecutionMutation])

  const stopExecution = useCallback(async () => {
    return await stopExecutionMutation.mutateAsync()
  }, [stopExecutionMutation])

  return {
    options: options ?? null,
    isLoading,
    error: error?.message ?? null,
    loadOptions,
    saveOptions,
    updateOptions: saveOptions,
    startExecution,
    stopExecution,
  }
}
