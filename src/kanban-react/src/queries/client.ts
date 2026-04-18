/**
 * Query Client Configuration - TanStack Query setup
 */

import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query'

// Default stale times for different data types
const STALE_TIMES = {
  tasks: 5000,        // Tasks change frequently
  runs: 3000,         // Runs change frequently
  sessions: 2000,     // Session messages change very frequently
  options: 10000,    // Options change rarely
  reference: 60000,   // Reference data (models, branches) almost never changes
  containers: 30000,  // Container images change occasionally
  planning: 5000,     // Planning sessions change frequently
}

export { STALE_TIMES }

/**
 * Create and configure the QueryClient
 */
export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        console.error(`[QueryCache] Error in query ${query.queryKey.join('/')}:`, error)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, variables, context, mutation) => {
        console.error(`[MutationCache] Error in mutation:`, error)
      },
    }),
    defaultOptions: {
      queries: {
        // Default query configuration
        staleTime: STALE_TIMES.tasks,
        gcTime: 5 * 60 * 1000, // 5 minutes
        retry: (failureCount, error) => {
          // Retry on network errors, but not on 4xx errors
          if (error instanceof Error) {
            const message = error.message
            // Don't retry on client errors (4xx)
            if (message.includes('400') || message.includes('401') || message.includes('403') || message.includes('404') || message.includes('409')) {
              return false
            }
          }
          return failureCount < 3
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        // Default mutation configuration
        retry: false,
      },
    },
  })
}
