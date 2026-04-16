import { useState, useCallback, useEffect, useRef } from 'react'
import type { PlanningSession, PlanningPrompt, SessionMessage, ThinkingLevel } from '@/types'
import { useApi } from './useApi'

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

export function usePlanningChat() {
  const api = useApi()

  const [isOpen, setIsOpen] = useState(false)
  const [width, setWidthState] = useState(400)
  const [isResizing, setIsResizing] = useState(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [planningPrompt, setPlanningPrompt] = useState<PlanningPrompt | null>(null)
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(false)

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
    const session = sessions.find(s => s.id === sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    if (session.isSending) {
      throw new Error('Already sending a message')
    }

    setSessions(prev => prev.map(s => 
      s.id === sessionId 
        ? { ...s, isSending: true, error: null }
        : s
    ))

    try {
      await api.sendPlanningMessage(session.session.id, content, attachments)
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
  }, [api, sessions])

  const setSessionModel = useCallback(async (sessionId: string, model: string, thinkingLevel?: string) => {
    const session = sessions.find(s => s.id === sessionId)
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
  }, [api, sessions])

  const reconnectSession = useCallback(async (sessionId: string, model?: string, thinkingLevel?: string) => {
    const session = sessions.find(s => s.id === sessionId)
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
  }, [api, sessions])

  const createTasksFromChat = useCallback(async (sessionId: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) => {
    const session = sessions.find(s => s.id === sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    try {
      return await api.createTasksFromPlanning(session.session.id, tasks)
    } catch (e) {
      console.error('Failed to create tasks:', e)
      throw e
    }
  }, [api, sessions])

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
      return prev.filter(s => s.id !== sessionId)
    })

    setActiveSessionId(prev => {
      if (prev === sessionId) {
        const remaining = sessions.filter(s => s.id !== sessionId && !s.isMinimized)
        return remaining.length > 0 ? remaining[0].id : null
      }
      return prev
    })
  }, [api, sessions])

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

      const existingIdx = s.messages.findIndex(m => 
        m.id === message.id || 
        (m.messageId && m.messageId === message.messageId)
      )
      
      let newMessages
      if (existingIdx >= 0) {
        newMessages = s.messages.map((m, i) => i === existingIdx ? message : m)
      } else {
        newMessages = [...s.messages, message]
      }
      
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
    const session = sessions.find(s => s.session?.id === data.sessionId)
    if (session) {
      addMessageToSession(session.id, data.message)
    }
  }, [sessions, addMessageToSession])

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
  }
}
