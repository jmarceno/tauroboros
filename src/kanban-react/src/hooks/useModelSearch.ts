import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import Fuse from "fuse.js"
import type { ModelEntry, ModelCatalog } from "@/types"
import { useApi } from "./useApi"

export function useModelSearch() {
  const api = useApi()
  const getModels = api.getModels
  const hasLoadedRef = useRef(false)
  const [catalog, setCatalog] = useState<ModelCatalog>({ providers: [] })
  const [searchIndex, setSearchIndex] = useState<ModelEntry[]>([])
  const [fuse, setFuse] = useState<Fuse<ModelEntry> | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultEntry: ModelEntry = {
    value: 'default',
    label: 'default',
    providerId: 'default',
    providerName: 'default',
    labelWithProvider: 'default',
  }

  const rebuildIndex = useCallback((currentCatalog: ModelCatalog) => {
    const entries: ModelEntry[] = [defaultEntry]

    for (const provider of currentCatalog.providers || []) {
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

    setSearchIndex(entries)
    setFuse(new Fuse(entries, {
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true,
      keys: ['value', 'label', 'providerId', 'providerName', 'labelWithProvider'],
    }))
  }, [])

  const loadModels = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await getModels()
      if (data.error) {
        throw new Error(data.error)
      }
      setCatalog(data)
      rebuildIndex(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setCatalog({ providers: [] })
      rebuildIndex({ providers: [] })
    } finally {
      setIsLoading(false)
    }
  }, [getModels, rebuildIndex])

  const getSuggestions = useCallback((query: string, limit = 12): ModelEntry[] => {
    const q = query?.trim() || ''
    if (!q) return searchIndex.slice(0, limit)
    if (fuse) {
      return fuse.search(q, { limit }).map(r => r.item)
    }
    const lower = q.toLowerCase()
    return searchIndex
      .filter(m =>
        m.labelWithProvider.toLowerCase().includes(lower) ||
        m.value.toLowerCase().includes(lower)
      )
      .slice(0, limit)
  }, [searchIndex, fuse])

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

    if (fuse) {
      const [topMatch] = fuse.search(value, { limit: 1 })
      if (topMatch && typeof topMatch.score === 'number' && topMatch.score <= 0.2) {
        return topMatch.item.value
      }
    }

    return value
  }, [searchIndex, fuse])

  const getModelOptions = useCallback((selected = 'default'): { value: string; label: string; selected: boolean }[] => {
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

  useEffect(() => {
    // Ref-guarded single mount pattern - guarantees single execution
    // without suppressing eslint exhaustive-deps rule
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true
      loadModels()
    }
  }, [loadModels])

  const contextValue = useMemo(() => ({
    catalog,
    searchIndex,
    isLoading,
    error,
    loadModels,
    getSuggestions,
    normalizeValue,
    getModelOptions,
  }), [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    catalog, searchIndex, loadModels, getSuggestions, normalizeValue, getModelOptions
  ])

  return contextValue
}
