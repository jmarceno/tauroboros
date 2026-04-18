/**
 * Model Search Hook - TanStack Query Wrapper with Fuse.js integration
 */

import { useMemo, useCallback, useState, useEffect } from 'react'
import Fuse from 'fuse.js'
import { useModelsQuery } from '@/queries'
import type { ModelEntry } from '@/types'

export function useModelSearch() {
  const [hasLoaded, setHasLoaded] = useState(false)
  
  // Use TanStack Query
  const { data: catalog = { providers: [] }, isLoading, error } = useModelsQuery()

  // Build search index
  const searchIndex = useMemo(() => {
    const entries: ModelEntry[] = [{
      value: 'default',
      label: 'default',
      providerId: 'default',
      providerName: 'default',
      labelWithProvider: 'default',
    }]

    for (const provider of catalog.providers || []) {
      for (const model of provider.models || []) {
        if (!model?.value) continue
        const providerName = provider.name || provider.id || ''
        const label = model.label || model.value
        entries.push({
          value: model.value,
          label,
          providerId: provider.id || providerName || 'unknown',
          providerName,
          labelWithProvider: providerName ? `${label} (${providerName})` : label,
        })
      }
    }

    return entries
  }, [catalog])

  // Create Fuse instance
  const fuse = useMemo(() => {
    return new Fuse(searchIndex, {
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true,
      keys: ['value', 'label', 'providerId', 'providerName', 'labelWithProvider'],
    })
  }, [searchIndex])

  // Search function
  const getSuggestions = useCallback((query: string, limit = 12): ModelEntry[] => {
    const q = query?.trim() || ''
    if (!q) return searchIndex.slice(0, limit)
    
    const results = fuse.search(q, { limit })
    return results.map(r => r.item)
  }, [fuse, searchIndex])

  // Normalize a model value
  const normalizeValue = useCallback((rawValue: string): string => {
    const value = (rawValue || '').trim()
    if (!value) return 'default'

    const exactValue = searchIndex.find(
      m => m.value.toLowerCase() === value.toLowerCase()
    )
    if (exactValue) return exactValue.value

    const exactLabel = searchIndex.find(
      m => m.label.toLowerCase() === value.toLowerCase()
    )
    if (exactLabel) return exactLabel.value

    const [topMatch] = fuse.search(value, { limit: 1 })
    if (topMatch && typeof topMatch.score === 'number' && topMatch.score <= 0.2) {
      return topMatch.item.value
    }

    return value
  }, [searchIndex, fuse])

  // Get model options for dropdown
  const getModelOptions = useCallback((selected = 'default') => {
    const options = [{ value: 'default', label: 'default', selected: selected === 'default' }]
    for (const provider of catalog.providers || []) {
      for (const model of provider.models || []) {
        options.push({
          value: model.value,
          label: model.label,
          selected: model.value === selected,
        })
      }
    }
    return options
  }, [catalog])

  // Load once on mount
  useEffect(() => {
    if (!hasLoaded && !isLoading) {
      setHasLoaded(true)
    }
  }, [hasLoaded, isLoading])

  return {
    catalog,
    searchIndex,
    isLoading,
    error: error?.message ?? null,
    loadModels: async () => {}, // No-op - handled by query
    getSuggestions,
    normalizeValue,
    getModelOptions,
  }
}
