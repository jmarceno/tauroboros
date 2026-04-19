/**
 * Options Store - Options management
 * Replaces: OptionsContext
 */

import { createSignal, createMemo } from 'solid-js'
import { createQuery, useQueryClient, createMutation } from '@tanstack/solid-query'
import type { Options } from '@/types'
import * as api from '@/api'

const queryKeys = {
  options: ['options'] as const,
}

export function createOptionsStore() {
  const queryClient = useQueryClient()

  // Query
  const optionsQuery = createQuery(() => ({
    queryKey: queryKeys.options,
    queryFn: () => api.optionsApi.get(),
    staleTime: 10000,
  }))

  const options = createMemo(() => optionsQuery.data || null)
  const isLoading = () => optionsQuery.isLoading
  const error = () => optionsQuery.error?.message || null

  // Actions
  const loadOptions = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.options })
  }

  // Mutations
  const saveOptionsMutation = createMutation(() => ({
    mutationFn: (data: Partial<Options>) => api.optionsApi.save(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.options })
    },
  }))

  const updateOptionsMutation = createMutation(() => ({
    mutationFn: (data: Partial<Options>) => api.optionsApi.update(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.options })
    },
  }))

  const startExecutionMutation = createMutation(() => ({
    mutationFn: () => api.optionsApi.startExecution(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.options })
    },
  }))

  const stopExecutionMutation = createMutation(() => ({
    mutationFn: () => api.optionsApi.stopExecution(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.options })
    },
  }))

  const saveOptions = async (data: Partial<Options>) => {
    return await saveOptionsMutation.mutateAsync(data)
  }

  const updateOptions = async (data: Partial<Options>) => {
    return await updateOptionsMutation.mutateAsync(data)
  }

  const startExecution = async () => {
    return await startExecutionMutation.mutateAsync()
  }

  const stopExecution = async () => {
    return await stopExecutionMutation.mutateAsync()
  }

  return {
    options,
    isLoading,
    error,
    loadOptions,
    saveOptions,
    updateOptions,
    startExecution,
    stopExecution,
  }
}
