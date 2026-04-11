import { ref } from 'vue'
import type { Options } from '@/types/api'
import { useApi } from './useApi'

export function useOptions() {
  const api = useApi()
  const options = ref<Options>({
    branch: 'main',
    parallelTasks: 1,
    maxReviews: 2,
    thinkingLevel: 'default',
  })
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const loadOptions = async () => {
    isLoading.value = true
    error.value = null
    try {
      options.value = await api.getOptions()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading.value = false
    }
  }

  const saveOptions = async (data: Partial<Options>) => {
    const updated = await api.updateOptions(data)
    options.value = updated
    return updated
  }

  const startExecution = async () => {
    return await api.startExecution()
  }

  const stopExecution = async () => {
    return await api.stopExecution()
  }

  return {
    options,
    isLoading,
    error,
    api, // Expose api for other operations like getBranches
    loadOptions,
    saveOptions,
    updateOptions: saveOptions, // Alias for consistency
    startExecution,
    stopExecution,
  }
}
