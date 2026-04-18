/**
 * Session Hook - TanStack Query Wrapper
 */

import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useSessionQuery,
  useSessionMessagesQuery,
  updateSessionMessagesCache,
  updateSessionCache,
  queryKeys,
} from '@/queries'
import type { Session, SessionMessage, TaskRunContext } from '@/types'

export function useSession() {
  const queryClient = useQueryClient()
  
  // Local state for session selection
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [taskRunContext, setTaskRunContext] = useState<TaskRunContext | null>(null)

  // Use TanStack Query
  const { data: session, isLoading: isSessionLoading } = useSessionQuery(sessionId)
  const { data: messages = [], isLoading: isMessagesLoading } = useSessionMessagesQuery(sessionId, 1000)

  const isLoading = isSessionLoading || isMessagesLoading
  const error = null // Errors are handled by the query, but we keep this for API compatibility

  const loadSession = useCallback(async (id: string, context?: TaskRunContext) => {
    setSessionId(id)
    setTaskRunContext(context || null)
  }, [])

  const closeSession = useCallback(() => {
    setSessionId(null)
    setTaskRunContext(null)
  }, [])

  const addMessage = useCallback((message: SessionMessage) => {
    if (sessionId) {
      updateSessionMessagesCache(queryClient, sessionId, message)
    }
  }, [queryClient, sessionId])

  const updateSession = useCallback((data: Session) => {
    updateSessionCache(queryClient, data)
  }, [queryClient])

  return {
    sessionId,
    session: session ?? null,
    messages,
    taskRunContext,
    isLoading,
    error,
    loadSession,
    closeSession,
    addMessage,
    updateSession,
  }
}
