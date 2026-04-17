import { useState, useCallback, useEffect, useRef } from 'react'
import type { PlanningSession, PlanningPrompt, SessionMessage, ThinkingLevel } from '@/types'
import { useApi } from './useApi'
import type { useWebSocket } from './useWebSocket'

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
  error: string | null
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
      error: null,
    }

    setSessions(prev => [...prev, newSession])
    setActiveSessionId(sessionId)

    try {
      const planningSession = await api.createPlanningSession({
        cwd: window.location.pathname,
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

  const sendMessage = useCallback(async (sessionId: string, content: string, attachments?: ContextAttachment[]) => {
    // Get current session using ref
    const session = getSession(sessionId)

    if (!session) {
      throw new Error('Session not found')
    }

    if (!session.session?.id) {
      throw new Error('No active session')
    }

    if (session.isSending) {
      throw new Error('Already sending a message')
    }

    const backendSessionId = session.session.id

    // Create optimistic user message
    const optimisticMessage: SessionMessage = {
      id: Date.now(),
      seq: Math.max(0, ...session.messages.map(m => Number(m.seq || 0))) + 1,
      messageId: `user-${Date.now()}`,
      sessionId: backendSessionId,
      taskId: null,
      taskRunId: null,
      timestamp: Math.floor(Date.now() / 1000),
      role: 'user',
      eventName: 'user_message',
      messageType: 'user_prompt',
      contentJson: { text: content, attachments },
    }

    // Optimistically add user message to UI
    setSessions(prev => prev.map(s => 
      s.id === sessionId 
        ? { ...s, messages: [...s.messages, optimisticMessage], isSending: true, error: null }
        : s
    ))

    try {
      await api.sendPlanningMessage(backendSessionId, content, attachments)
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to send message'
      if (errorMsg.includes('Planning session not active')) {
        setSessions(prev => prev.map(s => 
          s.id === sessionId 
            ? { ...s, error: 'Session not active. Click "Reconnect" to resume the session.', isSending: false }
            : s
        ))
      } else {
        setSessions(prev => prev.map(s => 
          s.id === sessionId 
            ? { ...s, error: errorMsg, isSending: false }
            : s
        ))
      }
      throw e
    } finally {
      setSessions(prev => prev.map(s => 
        s.id === sessionId 
          ? { ...s, isSending: false }
          : s
      ))
    }
  }, [api])

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

    setSessions(prev => prev.map(s => 
      s.id === sessionId 
        ? { ...s, isLoading: true, error: null }
        : s
    ))

    try {
      const reconnectedSession = await api.reconnectPlanningSession(session.session.id, {
        model,
        thinkingLevel,
      })
      setSessions(prev => prev.map(s => 
        s.id === sessionId 
          ? { ...s, session: reconnectedSession, isLoading: false }
          : s
      ))
      return reconnectedSession
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to reconnect session'
      setSessions(prev => prev.map(s => 
        s.id === sessionId 
          ? { ...s, error: errorMsg, isLoading: false }
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

  return {
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
  }
}
