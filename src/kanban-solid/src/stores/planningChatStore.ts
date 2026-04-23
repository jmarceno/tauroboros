/**
 * Planning Chat Store - Planning chat sessions
 * Replaces: PlanningChatContext
 * Ported from React usePlanningChat hook with full feature parity
 * Fully migrated to Effect patterns
 */

import { createSignal, createMemo } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import { Effect } from 'effect'
import type { SessionMessage, PlanningSession, WSMessageType } from '@/types'
import { runApiEffect } from '@/api'
import * as api from '@/api'

// Extended PlanningSession with runtime properties
interface PlanningSessionWithDetails extends PlanningSession {
  status?: string
  model?: string
  thinkingLevel?: string
}

const DEFAULT_WIDTH = 400
const MIN_WIDTH = 350
const MAX_WIDTH = 800

const queryKeys = {
  planningPrompt: ['planning', 'prompt'] as const,
  sessions: ['planning', 'sessions'] as const,
}

export interface ContextAttachment {
  type: 'file' | 'screenshot' | 'task' | 'image'
  name: string
  content?: string
  filePath?: string
  taskId?: string
  imageData?: string // Base64 encoded image data
  mimeType?: string
}

export interface ChatSession {
  id: string
  name: string
  session: PlanningSessionWithDetails | null
  messages: SessionMessage[]
  isMinimized: boolean
  isLoading: boolean
  isSending: boolean
  isReconnecting: boolean
  error: string | null
  agentWorking?: boolean
  currentTool?: string | null
}

export function createPlanningChatStore(wsStore: { on: (type: WSMessageType, handler: (payload: unknown) => void) => () => void }) {
  const [isOpen, setIsOpen] = createSignal(false)
  const [width, setWidth] = createSignal(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = createSignal(false)
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [sessions, setSessions] = createSignal<ChatSession[]>([])

  // Track pending messages per session for auto-retry
  const pendingMessagesMap = new Map<string, Array<{ id: string; content: string; attachments?: ContextAttachment[]; retryCount: number; maxRetries: number }>>()

  // Track if a reconnect is in progress per session to prevent race conditions
  const reconnectingSet = new Set<string>()

  // Track sending state per session for race condition prevention
  const sendingSet = new Set<string>()

  // Queries
  const planningPromptQuery = createQuery(() => ({
    queryKey: queryKeys.planningPrompt,
    queryFn: () => runApiEffect(api.planningApi.getPrompt()),
    staleTime: 30000,
  }))

  const planningPrompt = createMemo(() => planningPromptQuery.data || null)
  const isLoadingPrompt = () => planningPromptQuery.isLoading

  // Derived
  const activeSession = createMemo(() =>
    sessions().find(s => s.id === activeSessionId()) || null
  )

  const visibleSessions = createMemo(() =>
    sessions().filter(s => !s.isMinimized)
  )

  const minimizedSessions = createMemo(() =>
    sessions().filter(s => s.isMinimized)
  )

  const hasSessions = createMemo(() => sessions().length > 0)

  // Actions
  const openPanel = () => setIsOpen(true)
  const closePanel = () => setIsOpen(false)
  const togglePanel = () => setIsOpen(prev => !prev)

  const setPanelWidth = (newWidth: number) => {
    setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth)))
  }

  const loadPlanningPrompt = () => {
    return planningPromptQuery.refetch()
  }

  const savePlanningPrompt = (updates: { name?: string; description?: string; promptText: string }) =>
    runApiEffect(api.planningApi.updatePrompt({ key: 'default', ...updates }))

  const createNewSession = (model?: string, thinkingLevel?: string) => {
    const sessionId = `chat-${Date.now()}`
    const newSession: ChatSession = {
      id: sessionId,
      name: `Chat ${sessions().length + 1}`,
      session: null,
      messages: [],
      isMinimized: false,
      isLoading: true,
      isSending: false,
      isReconnecting: false,
      error: null,
    }
    setSessions(prev => [...prev, newSession])
    setActiveSessionId(sessionId)

    return runApiEffect(
      Effect.gen(function* () {
        const planningSession = yield* api.planningApi.createSession({
          model,
          thinkingLevel: thinkingLevel as import('@/types').ThinkingLevel | undefined,
        })

        yield* Effect.sync(() => {
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, session: planningSession, isLoading: false }
              : s
          ))
        })

        return planningSession
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            const errorMsg = error instanceof Error ? error.message : 'Failed to create session'
            setSessions(prev => prev.map(s =>
              s.id === sessionId
                ? { ...s, error: errorMsg, isLoading: false }
                : s
            ))
          }).pipe(Effect.zipRight(Effect.fail(error)))
        )
      )
    )
  }

  const switchToSession = (sessionId: string) => {
    setActiveSessionId(sessionId)
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, isMinimized: false } : s
    ))
  }

  const minimizeSession = (sessionId: string) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, isMinimized: true } : s
    ))
  }

  const closeSession = (sessionId: string) => {
    const session = sessions().find(s => s.id === sessionId)
    if (session?.session?.id) {
      runApiEffect(api.planningApi.closeSession(session.session.id))
    }

    pendingMessagesMap.delete(sessionId)
    reconnectingSet.delete(sessionId)
    sendingSet.delete(sessionId)

    setSessions(prev => {
      if (activeSessionId() === sessionId) {
        const remainingVisible = prev.filter(s => s.id !== sessionId && !s.isMinimized)
        const nextActiveId = remainingVisible.length > 0 ? remainingVisible[0].id : null
        setActiveSessionId(nextActiveId)
      }
      return prev.filter(s => s.id !== sessionId)
    })
  }

  const renameSession = async (sessionId: string, newName: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      return { ok: false, error: 'No active session' }
    }

    // Optimistically update local state
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, name: newName } : s
    ))

    // Persist to backend
    return runApiEffect(
      Effect.mapError(
        api.planningApi.renameSession(session.session.id, newName),
        (error) => {
          // Revert local state on error
          setSessions(prev => prev.map(s =>
            s.id === sessionId ? { ...s, name: session.name } : s
          ))
          return { ok: false, error: error instanceof Error ? error.message : 'Failed to rename session' }
        }
      ).pipe(
        Effect.map(() => ({ ok: true } as const))
      )
    )
  }

  const addMessageToSession = (sessionId: string, message: SessionMessage) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s

      const existingIdx = s.messages.findIndex(m =>
        m.id === message.id ||
        (m.messageId && m.messageId === message.messageId)
      )

      if (existingIdx >= 0) {
        return { ...s, messages: s.messages.map((m, i) => i === existingIdx ? message : m) }
      }

      if (message.role === 'user' && message.messageType === 'user_prompt') {
        const messageText = (message.contentJson as { text?: string })?.text || ''
        const optimisticIdx = s.messages.findIndex(m => {
          if (m.role !== 'user' || m.messageType !== 'user_prompt') return false
          const mText = (m.contentJson as { text?: string })?.text || ''
          const timeDiff = Math.abs(Number(m.timestamp || 0) - Number(message.timestamp || 0))
          return mText === messageText && timeDiff < 30
        })

        if (optimisticIdx >= 0) {
          return { ...s, messages: s.messages.map((m, i) => i === optimisticIdx ? message : m) }
        }
      }

      let newMessages = [...s.messages, message]
      newMessages.sort((a, b) => {
        const sa = Number((a as unknown as { seq?: number }).seq || 0)
        const sb = Number((b as unknown as { seq?: number }).seq || 0)
        if (sa !== sb) return sa - sb
        const ta = Number(a.timestamp || 0)
        const tb = Number(b.timestamp || 0)
        return ta !== tb ? ta - tb : Number(a.id || 0) - Number(b.id || 0)
      })

      return { ...s, messages: newMessages }
    }))
  }

  const getSession = (sessionId: string): ChatSession | undefined => {
    return sessions().find(s => s.id === sessionId)
  }

  const updateSession = (sessionId: string, update: (session: ChatSession) => ChatSession) => {
    setSessions(prev => prev.map((session) =>
      session.id === sessionId ? update(session) : session,
    ))
  }

  const getErrorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback

  const attemptSendMessageEffect = (
    sessionId: string,
    content: string,
    attachments?: ContextAttachment[],
    isRetry = false
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const session = getSession(sessionId)

      if (!session) {
        return yield* Effect.fail(new Error('Session not found'))
      }

      const sessionData = session.session
      if (!sessionData?.id) {
        return yield* Effect.fail(new Error('No active session'))
      }

      if (sendingSet.has(sessionId) && !isRetry) {
        return yield* Effect.fail(new Error('Already sending a message'))
      }

      yield* Effect.sync(() => {
        sendingSet.add(sessionId)
        if (!isRetry) {
          updateSession(sessionId, (current) => ({ ...current, isSending: true, error: null }))
        }
      })

      const backendSessionId = sessionData.id

      yield* api.planningApi.sendMessage(backendSessionId, content, attachments).pipe(
        Effect.catchAll((error) => {
          const errorMsg = getErrorMessage(error, 'Failed to send message')
          const isSessionNotActive = errorMsg.includes('not active') || errorMsg.includes('PLANNING_SESSION_NOT_ACTIVE')

          if (!isSessionNotActive) {
            return Effect.sync(() => {
              sendingSet.delete(sessionId)
              updateSession(sessionId, (current) => ({ ...current, error: errorMsg, isSending: false }))
            }).pipe(Effect.zipRight(Effect.fail(error)))
          }

          if (reconnectingSet.has(sessionId)) {
            return Effect.sync(() => {
              // Clear sending state since we're queueing for later
              sendingSet.delete(sessionId)
              const pending = pendingMessagesMap.get(sessionId) || []
              pendingMessagesMap.set(sessionId, [...pending, {
                id: `pending-${Date.now()}`,
                content,
                attachments,
                retryCount: 0,
                maxRetries: 1,
              }])
              updateSession(sessionId, (current) => ({ ...current, isSending: false }))
            })
          }

          return Effect.gen(function* () {
            yield* Effect.sync(() => {
              reconnectingSet.add(sessionId)
              updateSession(sessionId, (current) => ({
                ...current,
                isReconnecting: true,
                error: 'Session not active. Reconnecting automatically...',
                isSending: false,
              }))
            })

            const reconnectedSession = yield* api.planningApi.reconnectSession(backendSessionId, {
              model: sessionData.model,
              thinkingLevel: sessionData.thinkingLevel,
            })

            yield* Effect.sync(() => {
              reconnectingSet.delete(sessionId)
              updateSession(sessionId, (current) => ({
                ...current,
                session: reconnectedSession,
                isReconnecting: false,
                error: null,
              }))
            })

            yield* api.planningApi.sendMessage(reconnectedSession.id, content, attachments)

            const pending = pendingMessagesMap.get(sessionId) || []
            yield* Effect.sync(() => {
              pendingMessagesMap.delete(sessionId)
            })

            for (const queuedMsg of pending) {
              yield* attemptSendMessageEffect(sessionId, queuedMsg.content, queuedMsg.attachments, true)
            }
          }).pipe(
            Effect.catchAll((reconnectError) =>
              Effect.sync(() => {
                reconnectingSet.delete(sessionId)
                sendingSet.delete(sessionId)
                const reconnectErrorMsg = getErrorMessage(reconnectError, 'Failed to reconnect session')
                updateSession(sessionId, (current) => ({
                  ...current,
                  isReconnecting: false,
                  error: `Session not active. Reconnect failed: ${reconnectErrorMsg}`,
                  isSending: false,
                }))
              }).pipe(Effect.zipRight(Effect.fail(reconnectError)))
            )
          )
        }),
      )

      yield* Effect.sync(() => {
        sendingSet.delete(sessionId)
        updateSession(sessionId, (current) => ({ ...current, isSending: false, error: null }))
      })
    })

  const sendMessage = (sessionId: string, content: string, attachments?: ContextAttachment[]) => {
    const session = getSession(sessionId)

    if (!session) {
      return
    }

    if (!session.session?.id) {
      return
    }

    if (sendingSet.has(sessionId)) {
      return
    }

    const isSessionNotActive = !session.session || session.error?.includes('not active')

    if (isSessionNotActive || session.isReconnecting) {
      const pending = pendingMessagesMap.get(sessionId) || []
      pendingMessagesMap.set(sessionId, [...pending, {
        id: `pending-${Date.now()}`,
        content,
        attachments,
        retryCount: 0,
        maxRetries: 1,
      }])

      if (!session.isReconnecting && !reconnectingSet.has(sessionId)) {
        runApiEffect(attemptSendMessageEffect(sessionId, content, attachments))
      }
      return
    }

    runApiEffect(attemptSendMessageEffect(sessionId, content, attachments))
  }

  const createTasksFromChat = (sessionId: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      return Promise.resolve({ ok: false, error: 'No active session' })
    }

    return runApiEffect(
      Effect.mapError(
        api.planningApi.createTasksFromSession(session.session.id, tasks),
        (error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to create tasks' } as const)
      ).pipe(
        Effect.map((result) => ({ ok: true, result } as const))
      )
    )
  }

  const reconnectSessionEffect = (sessionId: string, model?: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      return Effect.fail(new Error('No session to reconnect'))
    }

    if (reconnectingSet.has(sessionId)) {
      return Effect.fail(new Error('Reconnect already in progress'))
    }

    const backendSessionId = session.session.id

    return Effect.gen(function* () {
      yield* Effect.sync(() => {
        reconnectingSet.add(sessionId)
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, isLoading: true, isReconnecting: true, error: null }
            : s
        ))
      })

      const reconnectedSession = yield* api.planningApi.reconnectSession(backendSessionId, { model, thinkingLevel })

      yield* Effect.sync(() => {
        reconnectingSet.delete(sessionId)
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, session: reconnectedSession, isLoading: false, isReconnecting: false }
            : s
        ))
      })

      return reconnectedSession
    })
  }

  const reconnectSession = (sessionId: string, model?: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      return Promise.resolve({ ok: false, error: 'No session to reconnect' })
    }

    if (reconnectingSet.has(sessionId)) {
      return Promise.resolve({ ok: false, error: 'Reconnect already in progress' })
    }

    reconnectingSet.add(sessionId)
    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, isLoading: true, isReconnecting: true, error: null }
        : s
    ))

    return runApiEffect(
      Effect.mapError(
        reconnectSessionEffect(sessionId, model, thinkingLevel),
        (error) => {
          reconnectingSet.delete(sessionId)
          const errorMsg = error instanceof Error ? error.message : 'Failed to reconnect session'
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, error: errorMsg, isLoading: false, isReconnecting: false }
              : s
          ))
          return { ok: false, session: null, error: errorMsg }
        }
      ).pipe(
        Effect.map((session) => ({ ok: true, session } as const))
      )
    )
  }

  const setSessionModelEffect = (sessionId: string, model: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      return Effect.fail(new Error('No active session'))
    }

    const backendSessionId = session.session.id

    return Effect.gen(function* () {
      yield* api.planningApi.setSessionModel(backendSessionId, model, thinkingLevel)

      yield* Effect.sync(() => {
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, session: s.session ? { ...s.session, model, thinkingLevel } : null }
            : s
        ))
      })

      return { ok: true, model, thinkingLevel } as const
    })
  }

  const setSessionModel = (sessionId: string, model: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      return Promise.resolve({ ok: false, error: 'No active session' })
    }

    return runApiEffect(
      Effect.mapError(
        setSessionModelEffect(sessionId, model, thinkingLevel),
        (error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to set model' } as const)
      )
    )
  }

  const addExistingSession = (session: ChatSession) => {
    setSessions(prev => {
      const exists = prev.some(s => s.id === session.id || s.session?.id === session.session?.id)
      if (exists) {
        const existingSession = prev.find(s => s.session?.id === session.session?.id)
        if (existingSession) {
          setActiveSessionId(existingSession.id)
        }
        return prev
      }
      return [...prev, session]
    })
    setActiveSessionId(session.id)
  }

  // WebSocket handlers
  const setupWebSocketHandlers = () => {
    const unsubCreated = wsStore.on('planning_session_created', (data) => {
      const session = data as PlanningSession
      handlePlanningSessionCreated(session)
    })

    const unsubUpdated = wsStore.on('planning_session_updated', (data) => {
      const session = data as PlanningSession
      handlePlanningSessionUpdated(session)
    })

    const unsubClosed = wsStore.on('planning_session_closed', (data) => {
      const { id } = data as { id: string }
      handlePlanningSessionClosed({ id })
    })

    const unsubMessage = wsStore.on('planning_session_message', (data) => {
      const { sessionId, message } = data as { sessionId: string; message: SessionMessage }
      handlePlanningSessionMessage({ sessionId, message })
    })

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubClosed()
      unsubMessage()
    }
  }

  const handlePlanningSessionCreated = (data: PlanningSession) => {
    setSessions(prev => prev.map(s =>
      s.session?.id === data.id
        ? { ...s, session: data }
        : s
    ))
  }

  const handlePlanningSessionUpdated = (data: PlanningSession) => {
    setSessions(prev => prev.map(s =>
      s.session?.id === data.id
        ? { 
            ...s, 
            session: s.session ? { ...s.session, ...data } : null,
            // Update name if provided in the update
            ...(data.name ? { name: data.name } : {})
          }
        : s
    ))
  }

  const handlePlanningSessionClosed = (data: { id: string }) => {
    setSessions(prev => prev.map(s =>
      s.session?.id === data.id
        ? { ...s, session: s.session ? { ...s.session, status: 'completed', finishedAt: Date.now() } : null }
        : s
    ))
  }

  const handlePlanningSessionMessage = (data: { sessionId: string; message: SessionMessage }) => {
    const session = sessions().find(s => s.session?.id === data.sessionId)
    if (!session) return

    // Handle agent working status updates - don't add to message history
    if (data.message.messageType === 'session_status') {
      const content = data.message.contentJson || {}
      if (typeof content.agentWorking === 'boolean') {
        setSessions(prev => prev.map(s =>
          s.session?.id === data.sessionId
            ? { ...s, agentWorking: content.agentWorking, currentTool: content.currentTool || null }
            : s
        ))
      }
      return // Don't add session_status messages to chat
    }

    addMessageToSession(session.id, data.message)
  }

  return {
    isOpen,
    width,
    isResizing,
    setIsResizing,
    sessions,
    activeSessionId,
    planningPrompt,
    isLoadingPrompt,
    activeSession,
    visibleSessions,
    minimizedSessions,
    hasSessions,
    openPanel,
    closePanel,
    togglePanel,
    setPanelWidth,
    loadPlanningPrompt,
    savePlanningPrompt,
    createNewSession,
    switchToSession,
    minimizeSession,
    closeSession,
    renameSession,
    addMessageToSession,
    sendMessage,
    createTasksFromChat,
    reconnectSession,
    setSessionModel,
    addExistingSession,
    setupWebSocketHandlers,
    handlePlanningSessionCreated,
    handlePlanningSessionUpdated,
    handlePlanningSessionClosed,
    handlePlanningSessionMessage,
  }
}