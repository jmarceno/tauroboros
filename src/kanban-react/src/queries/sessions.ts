/**
 * Sessions Queries - TanStack Query hooks for session management
 */

import {
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { sessionsApi } from '@/api'
import { queryKeys } from './keys.ts'
import type { Session, SessionMessage, SessionUsageRollup } from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get a session by ID
 */
export function useSessionQuery(
  id: string | null,
  options?: Omit<UseQueryOptions<Session, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id ?? ''),
    queryFn: () => sessionsApi.getById(id!),
    enabled: !!id,
    staleTime: 5000,
    ...options,
  })
}

/**
 * Get session messages
 */
export function useSessionMessagesQuery(
  id: string | null,
  limit = 1000,
  options?: Omit<UseQueryOptions<SessionMessage[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.sessions.messages(id ?? ''),
    queryFn: () => sessionsApi.getMessages(id!, limit),
    enabled: !!id,
    staleTime: 2000, // Messages change frequently, use short stale time
    ...options,
  })
}

/**
 * Get session usage
 */
export function useSessionUsageQuery(
  id: string | null,
  options?: Omit<UseQueryOptions<SessionUsageRollup, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.sessions.usage(id ?? ''),
    queryFn: () => sessionsApi.getUsage(id!),
    enabled: !!id,
    staleTime: 10000,
    ...options,
  })
}

// ============================================================================
// Cache Helpers
// ============================================================================

/**
 * Helper to add/update a message in the session messages cache
 */
export function updateSessionMessagesCache(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
  message: SessionMessage
) {
  const queryKey = queryKeys.sessions.messages(sessionId)
  
  queryClient.setQueryData<SessionMessage[]>(queryKey, (old) => {
    if (!old) return [message]
    
    // Check if message already exists (by id or messageId)
    const existingIdx = old.findIndex(m => 
      m.id === message.id || (m.messageId && m.messageId === message.messageId)
    )
    
    if (existingIdx >= 0) {
      // Update existing message
      return old.map((m, i) => i === existingIdx ? message : m)
    }
    
    // Add new message and sort by timestamp
    const newMessages = [...old, message]
    return newMessages.sort((a, b) => {
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      if (ta !== tb) return ta - tb
      return Number(a.id || 0) - Number(b.id || 0)
    })
  })
}

/**
 * Helper to update session status in cache
 */
export function updateSessionCache(
  queryClient: ReturnType<typeof useQueryClient>,
  session: Session
) {
  queryClient.setQueryData(queryKeys.sessions.detail(session.id), (old: Session | undefined) => {
    if (!old) return session
    return { ...old, ...session }
  })
}
