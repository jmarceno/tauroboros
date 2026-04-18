import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import type { PlanningSession, PlanningPrompt, SessionMessage, ThinkingLevel } from "@/types"
import { useApi } from "./useApi"
import type { useWebSocket } from "./useWebSocket"
import { ErrorCode, isErrorCode, detectErrorCodeFromMessage } from "../../../shared/error-codes"

export interface ContextAttachment {
  type: "file" | "screenshot" | "task"
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

interface PendingMessage {
  id: string
  content: string
  attachments?: ContextAttachment[]
  retryCount: number
  maxRetries: number
}

export function usePlanningChat(wsHook: ReturnType<typeof useWebSocket>) {
  const api = useApi()

  const [isOpen, setIsOpen] = useState(false)
  const [width, setWidthState] = useState(400)
  const [isResizing, setIsResizing] = useState(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [planningPrompt, setPlanningPrompt] = useState<PlanningPrompt | null>(null)
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(false)

  // Track pending messages per session for auto-retry
  const pendingMessagesRef = useRef<Map<string, PendingMessage[]>>(new Map())

  // Track if a reconnect is in progress per session to prevent race conditions
  const reconnectingRef = useRef<Set<string>>(new Set())

  // Track sending state per session for race condition prevention
  const sendingRef = useRef<Set<string>>(new Set())

  // Use ref to track sessions for WebSocket handlers
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  // Helper to get current session from state (avoids stale closures)
  const getSession = useCallback((sessionId: string): ChatSession | undefined => {
    return sessionsRef.current.find(s => s.id === sessionId)
  }, [])

  const activeSession = sessions.find(s => s.id === activeSessionId) || null
  const visibleSessions = sessions.filter(s => !s.isMinimized)
  const minimizedSessions = sessions.filter(s => s.isMinimized)
  const hasSessions = sessions.length > 0

  const openPanel = useCallback(() => {
    setIsOpen(true)
  }, [])

  const closePanel = useCallback(() => {
    setIsOpen(false)
  }, [])

  const togglePanel = useCallback(() => {
    setIsOpen(prev => !prev)
  }, [])

  const setWidth = useCallback((newWidth: number) => {
    setWidthState(Math.max(320, Math.min(600, newWidth)))
  }, [])

  const createNewSession = useCallback(async (model?: string, thinkingLevel?: string) => {
    const sessionId = `chat-${Date.now()}`
    const newSession: ChatSession = {
      id: sessionId,
      name: `Chat ${sessions.length + 1}`,
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
      const planningSession = await api.createPlanningSession({
        model,
        thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
      })

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
  }, [api, sessions.length])

  /**
   * Internal function to attempt sending a message with auto-reconnect logic.
   * This handles the actual send/retry flow without optimistic UI updates.
   */
  const attemptSendMessage = useCallback(async (
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
    if (sendingRef.current.has(sessionId) && !isRetry) {
      throw new Error('Already sending a message')
    }

    // Mark as sending
    sendingRef.current.add(sessionId)

    if (!isRetry) {
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, isSending: true, error: null }
          : s
      ))
    }

    const backendSessionId = session.session.id

    try {
      await api.sendPlanningMessage(backendSessionId, content, attachments)

      // Success - clear sending state
      sendingRef.current.delete(sessionId)
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, isSending: false, error: null }
          : s
      ))
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to send message'

      // Check if the error indicates session is not active
      const isSessionNotActive = isErrorCode(e, ErrorCode.PLANNING_SESSION_NOT_ACTIVE) ||
        detectErrorCodeFromMessage(errorMsg) === ErrorCode.PLANNING_SESSION_NOT_ACTIVE

      if (isSessionNotActive) {
        // Prevent concurrent reconnect attempts
        if (reconnectingRef.current.has(sessionId)) {
          // Queue the message for retry after reconnect completes
          const pending = pendingMessagesRef.current.get(sessionId) || []
          pendingMessagesRef.current.set(sessionId, [...pending, {
            id: `pending-${Date.now()}`,
            content,
            attachments,
            retryCount: 0,
            maxRetries: 1,
          }])
          return
        }

        reconnectingRef.current.add(sessionId)

        // Set reconnecting state
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, isReconnecting: true, error: 'Session not active. Reconnecting automatically...', isSending: false }
            : s
        ))

        try {
          // Attempt to reconnect with the session's current model and thinking level
          const reconnectedSession = await api.reconnectPlanningSession(backendSessionId, {
            model: session.session.model,
            thinkingLevel: session.session.thinkingLevel,
          })

          reconnectingRef.current.delete(sessionId)

          // Update session with reconnected state
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, session: reconnectedSession, isReconnecting: false, error: null }
              : s
          ))

          // Retry sending the message after successful reconnect
          await api.sendPlanningMessage(reconnectedSession.id, content, attachments)

          // Success after retry - clear sending state
          sendingRef.current.delete(sessionId)
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, isSending: false, error: null }
              : s
          ))

          // Process any queued messages
          const pending = pendingMessagesRef.current.get(sessionId) || []
          pendingMessagesRef.current.delete(sessionId)

          for (const queuedMsg of pending) {
            await attemptSendMessage(sessionId, queuedMsg.content, queuedMsg.attachments, true)
          }
        } catch (reconnectError) {
          // Reconnect failed - clear all states and throw
          reconnectingRef.current.delete(sessionId)
          sendingRef.current.delete(sessionId)

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
        sendingRef.current.delete(sessionId)
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, error: errorMsg, isSending: false }
            : s
        ))
        throw e
      }
    }
  }, [api, getSession])

  /**
   * Send a message to the planning session.
   * The message is queued and will be sent after the session is confirmed active.
   * NO optimistic UI update - the message only appears after successful send.
   */
  const sendMessage = useCallback(async (sessionId: string, content: string, attachments?: ContextAttachment[]) => {
    const session = getSession(sessionId)

    if (!session) {
      throw new Error('Session not found')
    }

    if (!session.session?.id) {
      throw new Error('No active session')
    }

    // Check if already sending (prevents race conditions)
    if (sendingRef.current.has(sessionId)) {
      throw new Error('Already sending a message')
    }

    // If session is not active, queue the message and trigger reconnect first
    const isSessionNotActive = !session.session || session.error?.includes('not active')

    if (isSessionNotActive || session.isReconnecting) {
      // Queue the message
      const pending = pendingMessagesRef.current.get(sessionId) || []
      pendingMessagesRef.current.set(sessionId, [...pending, {
        id: `pending-${Date.now()}`,
        content,
        attachments,
        retryCount: 0,
        maxRetries: 1,
      }])

      // If not already reconnecting, trigger reconnect
      if (!session.isReconnecting && !reconnectingRef.current.has(sessionId)) {
        await attemptSendMessage(sessionId, content, attachments)
      }
      return
    }

    // Normal send flow
    await attemptSendMessage(sessionId, content, attachments)
  }, [attemptSendMessage, getSession])

  const setSessionModel = useCallback(async (sessionId: string, model: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    try {
      await api.setPlanningSessionModel(session.session.id, model, thinkingLevel)
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, session: s.session ? { ...s.session, model, thinkingLevel } : null }
          : s
      ))
      return { ok: true, model, thinkingLevel }
    } catch (e) {
      console.error('Failed to change model:', e)
      throw e
    }
  }, [api, getSession])

  const reconnectSession = useCallback(async (sessionId: string, model?: string, thinkingLevel?: string) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      throw new Error('No session to reconnect')
    }

    // Prevent concurrent reconnect attempts
    if (reconnectingRef.current.has(sessionId)) {
      throw new Error('Reconnect already in progress')
    }

    reconnectingRef.current.add(sessionId)

    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, isLoading: true, isReconnecting: true, error: null }
        : s
    ))

    try {
      const reconnectedSession = await api.reconnectPlanningSession(session.session.id, {
        model,
        thinkingLevel,
      })

      reconnectingRef.current.delete(sessionId)

      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, session: reconnectedSession, isLoading: false, isReconnecting: false }
          : s
      ))
      return reconnectedSession
    } catch (e) {
      reconnectingRef.current.delete(sessionId)

      const errorMsg = e instanceof Error ? e.message : 'Failed to reconnect session'
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, error: errorMsg, isLoading: false, isReconnecting: false }
          : s
      ))
      throw e
    }
  }, [api, getSession])

  const createTasksFromChat = useCallback(async (sessionId: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) => {
    const session = getSession(sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    try {
      return await api.createTasksFromPlanning(session.session.id, tasks)
    } catch (e) {
      console.error('Failed to create tasks:', e)
      throw e
    }
  }, [api, getSession])

  const switchToSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, isMinimized: false }
        : s
    ))
  }, [])

  const minimizeSession = useCallback((sessionId: string) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, isMinimized: true }
        : s
    ))
  }, [])

  const closeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const session = prev.find(s => s.id === sessionId)
      if (session?.session?.id) {
        api.closePlanningSession(session.session.id).catch(console.error)
      }

      // Clean up refs
      pendingMessagesRef.current.delete(sessionId)
      reconnectingRef.current.delete(sessionId)
      sendingRef.current.delete(sessionId)

      // Update active session ID if needed
      if (activeSessionId === sessionId) {
        const remainingVisible = prev.filter(s => s.id !== sessionId && !s.isMinimized)
        const nextActiveId = remainingVisible.length > 0 ? remainingVisible[0].id : null
        setActiveSessionId(nextActiveId)
      }

      return prev.filter(s => s.id !== sessionId)
    })
  }, [api, activeSessionId])

  const renameSession = useCallback((sessionId: string, newName: string) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, name: newName }
        : s
    ))
  }, [])

  const addMessageToSession = useCallback((sessionId: string, message: SessionMessage) => {
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
  }, [])

  const loadPlanningPrompt = useCallback(async () => {
    setIsLoadingPrompt(true)
    try {
      const prompt = await api.getPlanningPrompt()
      setPlanningPrompt(prompt)
    } catch (e) {
      console.error('Failed to load planning prompt:', e)
    } finally {
      setIsLoadingPrompt(false)
    }
  }, [api])

  const savePlanningPrompt = useCallback(async (updates: { name?: string; description?: string; promptText: string }) => {
    try {
      const updated = await api.updatePlanningPrompt({
        key: 'default',
        ...updates,
      })
      setPlanningPrompt(updated)
      return updated
    } catch (e) {
      console.error('Failed to save planning prompt:', e)
      throw e
    }
  }, [api])

  const handlePlanningSessionCreated = useCallback((data: PlanningSession) => {
    setSessions(prev => prev.map(s =>
      s.session?.id === data.id
        ? { ...s, session: data }
        : s
    ))
  }, [])

  const handlePlanningSessionUpdated = useCallback((data: PlanningSession) => {
    setSessions(prev => prev.map(s =>
      s.session?.id === data.id
        ? { ...s, session: s.session ? { ...s.session, ...data } : null }
        : s
    ))
  }, [])

  const handlePlanningSessionClosed = useCallback((data: { id: string }) => {
    setSessions(prev => prev.map(s =>
      s.session?.id === data.id
        ? { ...s, session: s.session ? { ...s.session, status: 'completed', finishedAt: Date.now() } : null }
        : s
    ))
  }, [])

  const handlePlanningSessionMessage = useCallback((data: { sessionId: string; message: SessionMessage }) => {
    // Use ref to access current sessions state
    const session = sessionsRef.current.find(s => s.session?.id === data.sessionId)
    if (session) {
      addMessageToSession(session.id, data.message)
    }
  }, [addMessageToSession])

  // Register WebSocket handlers
  useEffect(() => {
    if (!wsHook) return

    const unsubscribers: (() => void)[] = []

    unsubscribers.push(wsHook.on('planning_session_created', (payload) => {
      handlePlanningSessionCreated(payload as PlanningSession)
    }))

    unsubscribers.push(wsHook.on('planning_session_updated', (payload) => {
      handlePlanningSessionUpdated(payload as PlanningSession)
    }))

    unsubscribers.push(wsHook.on('planning_session_closed', (payload) => {
      handlePlanningSessionClosed(payload as { id: string })
    }))

    unsubscribers.push(wsHook.on('planning_session_message', (payload) => {
      handlePlanningSessionMessage(payload as { sessionId: string; message: SessionMessage })
    }))

    return () => {
      unsubscribers.forEach(unsub => unsub())
    }
  }, [wsHook, handlePlanningSessionCreated, handlePlanningSessionUpdated, handlePlanningSessionClosed, handlePlanningSessionMessage])

  // Global cleanup on unmount - clear all refs to prevent memory leaks
  useEffect(() => {
    return () => {
      // Clear all pending message queues
      pendingMessagesRef.current.clear()
      // Clear all reconnection tracking sets
      reconnectingRef.current.clear()
      sendingRef.current.clear()
    }
  }, [])

  /**
   * Add an existing session from history to active sessions
   */
  const addExistingSession = useCallback((session: ChatSession) => {
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
  }, [])

  const contextValue = useMemo(() => ({
    isOpen,
    width,
    isResizing,
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
    setWidth,
    createNewSession,
    switchToSession,
    minimizeSession,
    closeSession,
    renameSession,
    addMessageToSession,
    loadPlanningPrompt,
    savePlanningPrompt,
    handlePlanningSessionCreated,
    handlePlanningSessionUpdated,
    handlePlanningSessionClosed,
    handlePlanningSessionMessage,
    sendMessage,
    createTasksFromChat,
    reconnectSession,
    setSessionModel,
    addExistingSession,
  }), [
    isOpen, width, isResizing, sessions, activeSessionId, planningPrompt, isLoadingPrompt,
    activeSession, visibleSessions, minimizedSessions, hasSessions,
    openPanel, closePanel, togglePanel, setWidth, createNewSession, switchToSession,
    minimizeSession, closeSession, renameSession, addMessageToSession, loadPlanningPrompt,
    savePlanningPrompt, handlePlanningSessionCreated, handlePlanningSessionUpdated,
    handlePlanningSessionClosed, handlePlanningSessionMessage, sendMessage, createTasksFromChat,
    reconnectSession, setSessionModel, addExistingSession
  ])

  return contextValue
}
