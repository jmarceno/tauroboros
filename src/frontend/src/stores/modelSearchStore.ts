/**
 * Model Search Store - Model catalog and search
 * Replaces: ModelSearchContext
 */

import { createSignal, createMemo } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import Fuse from 'fuse.js'
import type { ModelCatalog, ModelEntry } from '@/types'
import * as api from '@/api'

const queryKeys = {
  models: ['models'] as const,
}

export function createModelSearchStore() {
  const runApi = api.runApiEffect
  // Query
  const modelsQuery = createQuery(() => ({
    queryKey: queryKeys.models,
    queryFn: () => runApi(api.referenceApi.getModels()),
    staleTime: 60000,
  }))

  const catalog = createMemo(() => modelsQuery.data || { providers: [] })
  const isLoading = () => modelsQuery.isLoading
  const error = () => modelsQuery.error?.message || null

  // Build flat search index
  const searchIndex = createMemo(() => {
    const idx: ModelEntry[] = []
    for (const provider of catalog().providers) {
      for (const model of provider.models) {
        idx.push({
          ...model,
          providerId: provider.id,
          providerName: provider.name,
        })
      }
    }
    return idx
  })

  // Create Fuse instance
  const fuse = createMemo(() => {
    return new Fuse(searchIndex(), {
      keys: ['label', 'value', 'providerName'],
      threshold: 0.4,
    })
  })

  // Actions
  const loadModels = async () => {
    await modelsQuery.refetch()
  }

  const getSuggestions = (query: string, limit = 10): ModelEntry[] => {
    if (!query) {
      return searchIndex().slice(0, limit)
    }
    const results = fuse().search(query, { limit })
    return results.map(r => r.item)
  }

  const normalizeValue = (rawValue: string): string => {
    const normalized = rawValue.toLowerCase().trim()
    const found = searchIndex().find(m => 
      m.value.toLowerCase() === normalized ||
      m.label.toLowerCase() === normalized
    )
    return found?.value || rawValue
  }

  const getModelOptions = (selected?: string) => {
    return searchIndex().map(m => ({
      value: m.value,
      label: m.label,
      selected: m.value === selected,
    }))
  }

  return {
    catalog,
    searchIndex,
    isLoading,
    error,
    loadModels,
    getSuggestions,
    normalizeValue,
    getModelOptions,
  }
}
