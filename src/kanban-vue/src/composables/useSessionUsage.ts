import { ref, computed } from 'vue'
import type { SessionUsageRollup } from '@/types/api'
import { useApi } from './useApi'

export function useSessionUsage() {
  const api = useApi()
  const usageCache = ref<Record<string, SessionUsageRollup>>({})
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const loadSessionUsage = async (sessionId: string): Promise<SessionUsageRollup | null> => {
    // Return cached data if available
    if (usageCache.value[sessionId]) {
      return usageCache.value[sessionId]
    }

    isLoading.value = true
    error.value = null
    
    try {
      const usage = await api.getSessionUsage(sessionId)
      usageCache.value[sessionId] = usage
      return usage
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      isLoading.value = false
    }
  }

  const getCachedUsage = (sessionId: string): SessionUsageRollup | null => {
    return usageCache.value[sessionId] || null
  }

  const clearCache = () => {
    usageCache.value = {}
  }

  const formatTokenCount = (count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M'
    } else if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'k'
    }
    return count.toString()
  }

  const formatCost = (cost: number): string => {
    if (cost >= 1) {
      return '$' + cost.toFixed(2)
    } else if (cost >= 0.01) {
      return '$' + cost.toFixed(3)
    } else if (cost > 0) {
      return '$' + cost.toFixed(4)
    }
    return '$0'
  }

  return {
    usageCache,
    isLoading,
    error,
    loadSessionUsage,
    getCachedUsage,
    clearCache,
    formatTokenCount,
    formatCost,
  }
}
