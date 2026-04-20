/**
 * Planning Chat Store - Planning chat sessions
 * Replaces: PlanningChatContext
 * Ported from React usePlanningChat hook with full feature parity
 */

import { createSignal, createMemo } from 'solid-js'
import { createQuery, useQueryClient } from '@tanstack/solid-query'
import type { Session, SessionMessage, PlanningPrompt, PlanningSession, WSMessageType } from '@/types'
import * as api from '@/api'

const DEFAULT_WIDTH = 400
const MIN_WIDTH = 350
const MAX_WIDTH = 800

const queryKeys = {
  planningPrompt: ['planning', 'prompt'] as const,
  sessions: ['planning', 'sessions'] as const,
}

export interface ContextAttachment {
  type: 'file' | 'screenshot' | 'task'
  name: string
  content?: string
  filePath?: string
  taskId?: string
}

export interface ChatSession {
  id: string
  name: string
  session: PlanningSession | null
  messages: SessionMessage[]
  isMinimized: boolean
  isLoading: boolean
  isSending: boolean
  isReconnecting: boolean
  error: string | null
}

export function createPlanningChatStore(wsStore: { on: (type: WSMessageType, handler: (payload: unknown) => void) => () => void }) {
  const queryClient = useQueryClient()
  const runApi = api.runApiEffect

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
    queryFn: () => runApi(api.planningApi.getPrompt()),
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

  const loadPlanningPrompt = async () => {
    await planningPromptQuery.refetch()
  }

  const savePlanningPrompt = async (updates: { name?: string; description?: string; promptText: string }) => {
    return await runApi(api.planningApi.updatePrompt({
      key: 'default',
      ...updates,
    }))
  }

  const createNewSession = async (model?: string, thinkingLevel?: string) => {
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

    try {
      const planningSession = await runApi(api.planningApi.createSession({
        model,
        thinkingLevel: thinkingLevel as import('@/types').ThinkingLevel | undefined,
      }))

      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, session: planningSession, isLoading: false }
          : s
      ))
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to create session'
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, error: errorMsg, isLoading: false }
          : s
      ))
    }
  }

  const switchToSession = (sessionId: string) => {
    setActiveSessionId(sessionId)
    // Unminimize if minimized
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
      void runApi(api.planningApi.closeSession(session.session.id)).catch(() => undefined)
    }

    // Clean up refs
    pendingMessagesMap.delete(sessionId)
    reconnectingSet.delete(sessionId)
    sendingSet.delete(sessionId)

    setSessions(prev => {
      // Update active session ID if needed
      if (activeSessionId() === sessionId) {
        const remainingVisible = prev.filter(s => s.id !== sessionId && !s.isMinimized)
        const nextActiveId = remainingVisible.length > 0 ? remainingVisible[0].id : null
        setActiveSessionId(nextActiveId)
      }

      return prev.filter(s => s.id !== sessionId)
    })
  }

  const renameSession = (sessionId: string, newName: string) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, name: newName } : s
    ))
  }

  const addMessageToSession = (sessionId: string, message: SessionMessage) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s

      // Check for exact duplicate by ID or messageId
      const existingIdx = s.messages.findIndex(m =>
        m.id === message.id ||
        (m.messageId && m.messageId === message.messageId)
      )

      // If exact match found, update it (server confirmation replacing optimistic)
      if (existingIdx >= 0) {
        return { ...s, messages: s.messages.map((m, i) => i === existingIdx ? message : m) }
      }

      // Check for optimistic message to replace (same content, role, similar timestamp)
      if (message.role === 'user' && message.messageType === 'user_prompt') {
        const messageText = (message.contentJson as { text?: string })?.text || ''
        const optimisticIdx = s.messages.findIndex(m => {
          if (m.role !== 'user' || m.messageType !== 'user_prompt') return false
          const mText = (m.contentJson as { text?: string })?.text || ''
          // Same content and within 30 seconds (reasonable window for network delay)
          const timeDiff = Math.abs(Number(m.timestamp || 0) - Number(message.timestamp || 0))
          return mText === messageText && timeDiff < 30
        })

        if (optimisticIdx >= 0) {
          // Replace optimistic with server-confirmed message
          return { ...s, messages: s.messages.map((m, i) => i === optimisticIdx ? message : m) }
        }
      }

      // New message - add it
      let newMessages = [...s.messages, message]

      // Sort by seq, then timestamp, then id
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

  const attemptSendMessage = async (
    sessionId: string,
    content: string,
    attachments?: ContextAttachment[],
    isRetry = false
  ): Promise<void> => {
    const session = getSession(sessionId)

    if (!session) {
      throw new Error('Session not found')
    }

    if (!session.session?.id) {
      throw new Error('No active session')
    }

    // Prevent multiple concurrent sends on the same session
    if (sendingSet.has(sessionId) && !isRetry) {
      throw new Error('Already sending a message')
    }

    // Mark as sending
    sendingSet.add(sessionId)

    if (!isRetry) {
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, isSending: true, error: null }
          : s
      ))
    }

    const backendSessionId = session.session.id

    try {
      await runApi(api.planningApi.sendMessage(backendSessionId, content, attachments))

      // Success - clear sending state
      sendingSet.delete(sessionId)
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, isSending: false, error: null }
          : s
      ))
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to send message'

      // Check if the error indicates session is not active
      const isSessionNotActive = errorMsg.includes('not active') || errorMsg.includes('PLANNING_SESSION_NOT_ACTIVE')

      if (isSessionNotActive) {
        // Prevent concurrent reconnect attempts
        if (reconnectingSet.has(sessionId)) {
          // Queue the message for retry after reconnect completes
          const pending = pendingMessagesMap.get(sessionId) || []
          pendingMessagesMap.set(sessionId, [...pending, {
            id: `pending-${Date.now()}`,
            content,
            attachments,
            retryCount: 0,
            maxRetries: 1,
          }])
          return
        }

        reconnectingSet.add(sessionId)

        // Set reconnecting state
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, isReconnecting: true, error: 'Session not active. Reconnecting automatically...', isSending: false }
            : s
        ))

        try {
          // Attempt to reconnect with the session's current model and thinking level
          const reconnectedSession = await runApi(api.planningApi.reconnectSession(backendSessionId, {
            model: session.session.model,
            thinkingLevel: session.session.thinkingLevel,
          }))

          reconnectingSet.delete(sessionId)

          // Update session with reconnected state
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, session: reconnectedSession, isReconnecting: false, error: null }
              : s
          ))

          // Retry sending the message after successful reconnect
          await runApi(api.planningApi.sendMessage(reconnectedSession.id, content, attachments))

          // Success after retry - clear sending state
          sendingSet.delete(sessionId)
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, isSending: false, error: null }
              : s
          ))

          // Process any queued messages
          const pending = pendingMessagesMap.get(sessionId) || []
          pendingMessagesMap.delete(sessionId)

          for (const queuedMsg of pending) {
            await attemptSendMessage(sessionId, queuedMsg.content, queuedMsg.attachments, true)
          }
        } catch (reconnectError) {
          // Reconnect failed - clear all states and throw
          reconnectingSet.delete(sessionId)
          sendingSet.delete(sessionId)

          const reconnectErrorMsg = reconnectError instanceof Error ? reconnectError.message : 'Failed to reconnect session'
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, isReconnecting: false, error: `Session not active. Reconnect failed: ${reconnectErrorMsg}`, isSending: false }
              : s
          ))
          throw reconnectError
        }
      } else {
        // Other errors - clear sending state and throw
        sendingSet.delete(sessionId)
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, error: errorMsg, isSending: false }
            : s
        ))
        throw e
      }
    }
  }

  const sendMessage = async (sessionId: string, content: string, attachments?: ContextAttachment[]) => {
    const session = getSession(sessionId)

    if (!session) {
      throw new Error('Session not found')
    }

    if (!session.session?.id) {
      throw new Error('No active session')
    }

    // Check if already sending (prevents race conditions)
    if (sendingSet.has(sessionId)) {
      throw new Error('Already sending a message')
    }

    // If session is not active, queue the message and trigger reconnect first
    const isSessionNotActive = !session.session || session.error?.includes('not active')

    if (isSessionNotActive || session.isReconnecting) {
      // Queue the message
      const pending = pendingMessagesMap.get(sessionId) || []
      pendingMessagesMap.set(sessionId, [...pending, {
        id: `pending-${Date.now()}`,
        content,
        attachments,
        retryCount: 0,
        maxRetries: 1,
      }])

      // If not already reconnecting, trigger reconnect
      if (!session.isReconnecting && !reconnectingSet.has(sessionId)) {
        await attemptSendMessage(sessionId, content, attachments)
      }
      return
    }

    // Normal send flow
    await attemptSendMessage(sessionId, content, attachments)
  }

  const createTasksFromChat = async (sessionId: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    try {
      return await runApi(api.planningApi.createTasksFromSession(session.session.id, tasks))
    } catch (e) {
      throw e
    }
  }

  const reconnectSession = async (sessionId: string, model?: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      throw new Error('No session to reconnect')
    }

    // Prevent concurrent reconnect attempts
    if (reconnectingSet.has(sessionId)) {
      throw new Error('Reconnect already in progress')
    }

    reconnectingSet.add(sessionId)

    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, isLoading: true, isReconnecting: true, error: null }
        : s
    ))

    try {
      const reconnectedSession = await runApi(api.planningApi.reconnectSession(session.session.id, {
        model,
        thinkingLevel,
      }))

      reconnectingSet.delete(sessionId)

      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, session: reconnectedSession, isLoading: false, isReconnecting: false }
          : s
      ))
      return reconnectedSession
    } catch (e) {
      reconnectingSet.delete(sessionId)

      const errorMsg = e instanceof Error ? e.message : 'Failed to reconnect session'
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, error: errorMsg, isLoading: false, isReconnecting: false }
          : s
      ))
      throw e
    }
  }

  const setSessionModel = async (sessionId: string, model: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    try {
      await runApi(api.planningApi.setSessionModel(session.session.id, model, thinkingLevel))
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, session: s.session ? { ...s.session, model, thinkingLevel } : null }
          : s
      ))
      return { ok: true, model, thinkingLevel }
    } catch (e) {
      throw e
    }
  }

  const addExistingSession = (session: ChatSession) => {
    setSessions(prev => {
      // Check if session already exists
      const exists = prev.some(s => s.id === session.id || s.session?.id === session.session?.id)
      if (exists) {
        // If session exists, just switch to it
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
        ? { ...s, session: s.session ? { ...s.session, ...data } : null }
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
    if (session) {
      addMessageToSession(session.id, data.message)
    }
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
