/**
 * Options Store - Options management
 * Replaces: OptionsContext
 */

import { createSignal, createMemo } from 'solid-js'
import { createQuery, useQueryClient, createMutation } from '@tanstack/solid-query'
import { Effect } from 'effect'
import type { Options } from '@/types'
import * as api from '@/api'

const queryKeys = {
  options: ['options'] as const,
}

export function createOptionsStore() {
  const queryClient = useQueryClient()
  const runApi = api.runApiEffect

  // Query
  const optionsQuery = createQuery(() => ({
    queryKey: queryKeys.options,
    queryFn: () => runApi(api.optionsApi.get()),
    staleTime: 10000,
  }))

  const options = createMemo(() => optionsQuery.data || null)
  const isLoading = () => optionsQuery.isLoading
  const error = () => optionsQuery.error?.message || null

  // Actions
  const loadOptions = () => runApi(Effect.promise(() => queryClient.invalidateQueries({ queryKey: queryKeys.options })))

  // Mutations
  const updateOptionsMutation = createMutation(() => ({
    mutationFn: (data: Partial<Options>) => runApi(api.optionsApi.update(data)),
    onSuccess: () => {
      void loadOptions()
    },
  }))

  const startExecutionMutation = createMutation(() => ({
    mutationFn: () => runApi(api.optionsApi.startExecution()),
    onSuccess: () => {
      void loadOptions()
    },
  }))

  const stopExecutionMutation = createMutation(() => ({
    mutationFn: () => runApi(api.optionsApi.stopExecution()),
    onSuccess: () => {
      void loadOptions()
    },
  }))

  const saveOptions = (data: Partial<Options>) => updateOptionsMutation.mutateAsync(data)

  const updateOptions = (data: Partial<Options>) => updateOptionsMutation.mutateAsync(data)

  const startExecution = () => startExecutionMutation.mutateAsync()

  const stopExecution = () => stopExecutionMutation.mutateAsync()

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
