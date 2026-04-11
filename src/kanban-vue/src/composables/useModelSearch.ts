import { ref, onMounted } from 'vue'
import Fuse from 'fuse.js'
import type { ModelEntry, ModelCatalog } from '@/types/api'
import { useApi } from './useApi'

export function useModelSearch() {
  const api = useApi()
  const catalog = ref<ModelCatalog>({ providers: [] })
  const searchIndex = ref<ModelEntry[]>([])
  const fuse = ref<Fuse<ModelEntry> | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const defaultEntry: ModelEntry = {
    value: 'default',
    label: 'default',
    providerId: 'default',
    providerName: 'default',
    labelWithProvider: 'default',
  }

  const loadModels = async () => {
    isLoading.value = true
    error.value = null
    try {
      const data = await api.getModels()
      if (data.error) {
        throw new Error(data.error)
      }
      catalog.value = data
      rebuildIndex()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      catalog.value = { providers: [] }
      rebuildIndex()
    } finally {
      isLoading.value = false
    }
  }

  const rebuildIndex = () => {
    const entries: ModelEntry[] = [defaultEntry]

    for (const provider of catalog.value.providers || []) {
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

    searchIndex.value = entries
    fuse.value = new Fuse(entries, {
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true,
      keys: ['value', 'label', 'providerId', 'providerName', 'labelWithProvider'],
    })
  }

  const getSuggestions = (query: string, limit = 12): ModelEntry[] => {
    const q = query?.trim() || ''
    if (!q) return searchIndex.value.slice(0, limit)
    if (fuse.value) {
      return fuse.value.search(q, { limit }).map(r => r.item)
    }
    const lower = q.toLowerCase()
    return searchIndex.value
      .filter(m =>
        m.labelWithProvider.toLowerCase().includes(lower) ||
        m.value.toLowerCase().includes(lower)
      )
      .slice(0, limit)
  }

  const normalizeValue = (rawValue: string): string => {
    const value = (rawValue || '').trim()
    if (!value) return 'default'

    const exactValue = searchIndex.value.find(
      m => m.value.toLowerCase() === value.toLowerCase()
    )
    if (exactValue) return exactValue.value

    const exactLabel = searchIndex.value.find(
      m => m.label.toLowerCase() === value.toLowerCase()
    )
    if (exactLabel) return exactLabel.value

    if (fuse.value) {
      const [topMatch] = fuse.value.search(value, { limit: 1 })
      if (topMatch && typeof topMatch.score === 'number' && topMatch.score <= 0.2) {
        return topMatch.item.value
      }
    }

    return value
  }

  const getModelOptions = (selected = 'default'): { value: string; label: string; selected: boolean }[] => {
    const options = [{ value: 'default', label: 'default', selected: selected === 'default' }]
    for (const provider of catalog.value.providers || []) {
      for (const model of provider.models || []) {
        options.push({
          value: model.value,
          label: model.label,
          selected: model.value === selected,
        })
      }
    }
    return options
  }

  onMounted(() => {
    loadModels()
  })

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
