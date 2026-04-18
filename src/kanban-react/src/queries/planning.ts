/**
 * Planning Chat Queries - TanStack Query hooks for planning sessions
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { planningApi } from '@/api'
import { queryKeys } from './keys.ts'
import type {
  PlanningPrompt,
  PlanningPromptVersion,
  PlanningSession,
  CreatePlanningSessionDTO,
  SessionMessage,
  Task,
} from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get the active planning prompt
 */
export function usePlanningPromptQuery(
  options?: Omit<UseQueryOptions<PlanningPrompt, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.planning.prompt(),
    queryFn: planningApi.getPrompt,
    staleTime: 60000,
    ...options,
  })
}

/**
 * Get all planning prompts
 */
export function useAllPlanningPromptsQuery(
  options?: Omit<UseQueryOptions<PlanningPrompt[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.planning.prompts(),
    queryFn: planningApi.getAllPrompts,
    staleTime: 60000,
    ...options,
  })
}

/**
 * Get prompt versions
 */
export function usePlanningPromptVersionsQuery(
  key: string,
  options?: Omit<UseQueryOptions<PlanningPromptVersion[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: [...queryKeys.planning.prompts(), key, 'versions'],
    queryFn: () => planningApi.getPromptVersions(key),
    enabled: !!key,
    staleTime: 60000,
    ...options,
  })
}

/**
 * Get all planning sessions
 */
export function usePlanningSessionsQuery(
  options?: Omit<UseQueryOptions<PlanningSession[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.planning.sessions(),
    queryFn: planningApi.getSessions,
    staleTime: 5000,
    ...options,
  })
}

/**
 * Get active planning sessions
 */
export function useActivePlanningSessionsQuery(
  options?: Omit<UseQueryOptions<PlanningSession[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.planning.activeSessions(),
    queryFn: planningApi.getActiveSessions,
    staleTime: 3000,
    ...options,
  })
}

/**
 * Get a specific planning session
 */
export function usePlanningSessionQuery(
  id: string | null,
  options?: Omit<UseQueryOptions<PlanningSession, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.planning.session(id ?? ''),
    queryFn: () => planningApi.getSession(id!),
    enabled: !!id,
    staleTime: 5000,
    ...options,
  })
}

/**
 * Get planning session messages
 */
export function usePlanningSessionMessagesQuery(
  id: string | null,
  limit = 500,
  options?: Omit<UseQueryOptions<SessionMessage[], Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.planning.sessionMessages(id ?? ''),
    queryFn: () => planningApi.getSessionMessages(id!, limit),
    enabled: !!id,
    staleTime: 2000,
    ...options,
  })
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Update planning prompt
 */
export function useUpdatePlanningPromptMutation(
  options?: Omit<UseMutationOptions<PlanningPrompt, Error, { name?: string; description?: string; promptText: string; key?: string }>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data) => planningApi.updatePrompt(data),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.planning.prompt(updated.key), updated)
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.prompts() })
    },
    ...options,
  })
}

/**
 * Create planning session
 */
export function useCreatePlanningSessionMutation(
  options?: Omit<UseMutationOptions<PlanningSession, Error, CreatePlanningSessionDTO>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: planningApi.createSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.sessions() })
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.activeSessions() })
    },
    ...options,
  })
}

/**
 * Update planning session
 */
export interface UpdatePlanningSessionVariables {
  id: string
  data: { status?: string; errorMessage?: string }
}

export function useUpdatePlanningSessionMutation(
  options?: Omit<UseMutationOptions<PlanningSession, Error, UpdatePlanningSessionVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }) => planningApi.updateSession(id, data),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.planning.session(session.id), session)
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.sessions() })
    },
    ...options,
  })
}

/**
 * Reconnect planning session
 */
export interface ReconnectSessionVariables {
  id: string
  model?: string
  thinkingLevel?: string
}

export function useReconnectPlanningSessionMutation(
  options?: Omit<UseMutationOptions<PlanningSession, Error, ReconnectSessionVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, model, thinkingLevel }) => planningApi.reconnectSession(id, { model, thinkingLevel }),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.planning.session(session.id), session)
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.sessions() })
    },
    ...options,
  })
}

/**
 * Set planning session model
 */
export interface SetSessionModelVariables {
  id: string
  model: string
  thinkingLevel?: string
}

export function useSetPlanningSessionModelMutation(
  options?: Omit<UseMutationOptions<{ ok: boolean; model: string; thinkingLevel?: string }, Error, SetSessionModelVariables>, 'mutationFn'>
) {
  return useMutation({
    mutationFn: ({ id, model, thinkingLevel }) => planningApi.setSessionModel(id, model, thinkingLevel),
    ...options,
  })
}

/**
 * Close planning session
 */
export function useClosePlanningSessionMutation(
  options?: Omit<UseMutationOptions<PlanningSession, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: planningApi.closeSession,
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.planning.session(session.id), session)
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.sessions() })
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.activeSessions() })
    },
    ...options,
  })
}

/**
 * Send planning message
 */
export interface SendPlanningMessageVariables {
  id: string
  content: string
  attachments?: Array<{
    type: 'file' | 'screenshot' | 'task'
    name: string
    content?: string
    filePath?: string
    taskId?: string
  }>
}

export function useSendPlanningMessageMutation(
  options?: Omit<UseMutationOptions<{ ok: boolean }, Error, SendPlanningMessageVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, content, attachments }) => planningApi.sendMessage(id, content, attachments),
    onSuccess: (_, { id }) => {
      // Invalidate messages to fetch the new message
      queryClient.invalidateQueries({ queryKey: queryKeys.planning.sessionMessages(id) })
    },
    ...options,
  })
}

/**
 * Create tasks from planning session
 */
export interface CreateTasksFromPlanningVariables {
  id: string
  tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>
}

export function useCreateTasksFromPlanningMutation(
  options?: Omit<UseMutationOptions<{ tasks?: Task[]; count?: number; message?: string }, Error, CreateTasksFromPlanningVariables>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, tasks }) => planningApi.createTasksFromSession(id, tasks),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() })
    },
    ...options,
  })
}

// ============================================================================
// Cache Helpers
// ============================================================================

/**
 * Helper to add/update a planning session message in cache
 */
export function updatePlanningSessionMessagesCache(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
  message: SessionMessage
) {
  const queryKey = queryKeys.planning.sessionMessages(sessionId)
  
  queryClient.setQueryData<SessionMessage[]>(queryKey, (old) => {
    if (!old) return [message]
    
    // Check for duplicates
    const existingIdx = old.findIndex(m => 
      m.id === message.id || (m.messageId && m.messageId === message.messageId)
    )
    
    if (existingIdx >= 0) {
      return old.map((m, i) => i === existingIdx ? message : m)
    }
    
    // Add and sort by sequence/timestamp
    const newMessages = [...old, message]
    return newMessages.sort((a, b) => {
      const sa = Number((a as unknown as { seq?: number }).seq || 0)
      const sb = Number((b as unknown as { seq?: number }).seq || 0)
      if (sa !== sb) return sa - sb
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      return ta !== tb ? ta - tb : Number(a.id || 0) - Number(b.id || 0)
    })
  })
}

/**
 * Helper to update planning session in cache
 */
export function updatePlanningSessionCache(
  queryClient: ReturnType<typeof useQueryClient>,
  session: PlanningSession
) {
  queryClient.setQueryData(queryKeys.planning.session(session.id), (old: PlanningSession | undefined) => {
    if (!old) return session
    return { ...old, ...session }
  })
}
