import { ref, computed, onUnmounted } from 'vue'
import type { SessionUsageRollup } from '@/types/api'
import { useApi } from './useApi'

const POLL_INTERVAL = 3000 // 3 seconds

export function useSessionUsage() {
  const api = useApi()
  const usageCache = ref<Record<string, SessionUsageRollup>>({})
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const activeSessionIds = ref<Set<string>>(new Set())
  const lastFetchTime = ref<Record<string, number>>({})
  let pollIntervalId: ReturnType<typeof setInterval> | null = null

  const startPolling = () => {
    if (pollIntervalId) return
    pollIntervalId = setInterval(async () => {
      for (const sessionId of activeSessionIds.value) {
        try {
          const usage = await api.getSessionUsage(sessionId)
          usageCache.value[sessionId] = usage
          lastFetchTime.value[sessionId] = Date.now()
        } catch (e) {
          // Silently fail on poll errors
        }
      }
    }, POLL_INTERVAL)
  }

  const stopPolling = () => {
    if (pollIntervalId) {
      clearInterval(pollIntervalId)
      pollIntervalId = null
    }
  }

  const startWatching = (sessionId: string) => {
    activeSessionIds.value.add(sessionId)
    startPolling()
  }

  const stopWatching = (sessionId: string) => {
    activeSessionIds.value.delete(sessionId)
    if (activeSessionIds.value.size === 0) {
      stopPolling()
    }
  }

  const loadSessionUsage = async (sessionId: string, forceRefresh = false): Promise<SessionUsageRollup | null> => {
    // Use cached data if fresh (less than 3 seconds old) and not forcing refresh
    const lastFetch = lastFetchTime.value[sessionId] || 0
    const isFresh = Date.now() - lastFetch < POLL_INTERVAL
    
    if (!forceRefresh && usageCache.value[sessionId] && isFresh) {
      return usageCache.value[sessionId]
    }

    isLoading.value = true
    error.value = null
    
    try {
      const usage = await api.getSessionUsage(sessionId)
      usageCache.value[sessionId] = usage
      lastFetchTime.value[sessionId] = Date.now()
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

  // Cleanup on component unmount (for component-level usage)
  onUnmounted(() => {
    stopPolling()
  })

  return {
    usageCache,
    isLoading,
    error,
    activeSessionIds,
    loadSessionUsage,
    getCachedUsage,
    clearCache,
    startWatching,
    stopWatching,
    formatTokenCount,
    formatCost,
  }
}
