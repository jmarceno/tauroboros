import { ref, computed } from 'vue'
import type { PlanningSession, PlanningPrompt, SessionMessage, ThinkingLevel } from '@/types/api'
import { useApi } from './useApi'
import { ErrorCode, isErrorCode, detectErrorCodeFromMessage } from '../../../shared/error-codes'

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

interface PendingMessage {
  id: string
  content: string
  attachments?: ContextAttachment[]
  retryCount: number
  maxRetries: number
}

export function usePlanningChat() {
  const api = useApi()

  const isOpen = ref(false)
  const width = ref(400)
  const isResizing = ref(false)
  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const planningPrompt = ref<PlanningPrompt | null>(null)
  const isLoadingPrompt = ref(false)

  // Track pending messages per session for auto-retry
  const pendingMessages = new Map<string, PendingMessage[]>()
  
  // Track if a reconnect is in progress per session to prevent race conditions
  const reconnectingSessions = new Set<string>()
  
  // Track sending state per session for race condition prevention
  const sendingSessions = new Set<string>()

  const activeSession = computed(() => {
    if (!activeSessionId.value) return null
    return sessions.value.find(s => s.id === activeSessionId.value) || null
  })

  const visibleSessions = computed(() => {
    return sessions.value.filter(s => !s.isMinimized)
  })

  const minimizedSessions = computed(() => {
    return sessions.value.filter(s => s.isMinimized)
  })

  const hasSessions = computed(() => sessions.value.length > 0)

  const openPanel = () => {
    isOpen.value = true
    if (!hasSessions.value) {
      createNewSession()
    }
    if (!planningPrompt.value && !isLoadingPrompt.value) {
      loadPlanningPrompt()
    }
  }

  const closePanel = () => {
    isOpen.value = false
  }

  const togglePanel = () => {
    isOpen.value ? closePanel() : openPanel()
  }

  const setWidth = (newWidth: number) => {
    width.value = Math.max(320, Math.min(600, newWidth))
  }

  const createNewSession = async (model?: string, thinkingLevel?: string) => {
    const sessionId = `chat-${Date.now()}`
    const newSession: ChatSession = {
      id: sessionId,
      name: `Chat ${sessions.value.length + 1}`,
      session: null,
      messages: [],
      isMinimized: false,
      isLoading: true,
      isSending: false,
      isReconnecting: false,
      error: null,
    }

    sessions.value.push(newSession)
    activeSessionId.value = sessionId

    try {
      const planningSession = await api.createPlanningSession({
        cwd: window.location.pathname,
        model,
        thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
      })

      const idx = sessions.value.findIndex(s => s.id === sessionId)
      if (idx >= 0) {
        sessions.value[idx].session = planningSession
        sessions.value[idx].isLoading = false
      }
    } catch (e) {
      const idx = sessions.value.findIndex(s => s.id === sessionId)
      if (idx >= 0) {
        sessions.value[idx].error = e instanceof Error ? e.message : 'Failed to create session'
        sessions.value[idx].isLoading = false
      }
    }
  }

  /**
   * Internal function to attempt sending a message with auto-reconnect logic.
   * This handles the actual send/retry flow without optimistic UI updates.
   */
  const attemptSendMessage = async (
    sessionId: string, 
    content: string, 
    attachments?: ContextAttachment[],
    isRetry = false
  ): Promise<void> => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    // Prevent multiple concurrent sends on the same session
    if (sendingSessions.has(sessionId) && !isRetry) {
      throw new Error('Already sending a message')
    }

    // Mark as sending
    sendingSessions.add(sessionId)
    
    if (!isRetry) {
      session.isSending = true
      session.error = null
    }

    const backendSessionId = session.session.id

    try {
      await api.sendPlanningMessage(backendSessionId, content, attachments)
      
      // Success - clear sending state
      sendingSessions.delete(sessionId)
      session.isSending = false
      session.error = null
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to send message'
      
      // Check if the error indicates session is not active
      const isSessionNotActive = isErrorCode(e, ErrorCode.PLANNING_SESSION_NOT_ACTIVE) ||
        detectErrorCodeFromMessage(errorMsg) === ErrorCode.PLANNING_SESSION_NOT_ACTIVE

      if (isSessionNotActive) {
        // Prevent concurrent reconnect attempts
        if (reconnectingSessions.has(sessionId)) {
          // Queue the message for retry after reconnect completes
          const pending = pendingMessages.get(sessionId) || []
          pendingMessages.set(sessionId, [...pending, {
            id: `pending-${Date.now()}`,
            content,
            attachments,
            retryCount: 0,
            maxRetries: 1,
          }])
          return
        }

        reconnectingSessions.add(sessionId)
        
        // Set reconnecting state
        session.isReconnecting = true
        session.error = 'Session not active. Reconnecting automatically...'
        session.isSending = false

        try {
          // Attempt to reconnect
          const reconnectedSession = await api.reconnectPlanningSession(backendSessionId, {
            model: session.session.model,
            thinkingLevel: session.session.thinkingLevel as ThinkingLevel | undefined,
          })
          
          reconnectingSessions.delete(sessionId)
          
          session.session = reconnectedSession
          session.isReconnecting = false
          session.error = null

          // Retry sending the message after successful reconnect
          await api.sendPlanningMessage(reconnectedSession.id, content, attachments)
          
          // Success after retry - clear sending state
          sendingSessions.delete(sessionId)
          session.isSending = false

          // Process any queued messages
          const pending = pendingMessages.get(sessionId) || []
          pendingMessages.delete(sessionId)
          
          for (const queuedMsg of pending) {
            await attemptSendMessage(sessionId, queuedMsg.content, queuedMsg.attachments, true)
          }
        } catch (reconnectError) {
          // Reconnect failed - clear all states and re-throw
          reconnectingSessions.delete(sessionId)
          sendingSessions.delete(sessionId)
          
          const reconnectErrorMsg = reconnectError instanceof Error ? reconnectError.message : 'Failed to reconnect session'
          session.error = `Session not active. Reconnect failed: ${reconnectErrorMsg}`
          session.isReconnecting = false
          session.isSending = false
          throw reconnectError
        }
      } else {
        // Other errors - clear sending state and re-throw
        sendingSessions.delete(sessionId)
        session.error = errorMsg
        session.isSending = false
        throw e
      }
    }
  }

  /**
   * Send a message to the planning session.
   * The message is queued and will be sent after the session is confirmed active.
   * NO optimistic UI update - the message only appears after successful send.
   */
  const sendMessage = async (sessionId: string, content: string, attachments?: ContextAttachment[]) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    // Check if already sending (prevents race conditions)
    if (sendingSessions.has(sessionId)) {
      throw new Error('Already sending a message')
    }

    // If session is not active, queue the message and trigger reconnect first
    const isSessionNotActive = !session.session || session.error?.includes('not active')
    
    if (isSessionNotActive || session.isReconnecting) {
      // Queue the message
      const pending = pendingMessages.get(sessionId) || []
      pendingMessages.set(sessionId, [...pending, {
        id: `pending-${Date.now()}`,
        content,
        attachments,
        retryCount: 0,
        maxRetries: 1,
      }])

      // If not already reconnecting, trigger reconnect
      if (!session.isReconnecting && !reconnectingSessions.has(sessionId)) {
        await attemptSendMessage(sessionId, content, attachments)
      }
      return
    }

    // Normal send flow
    await attemptSendMessage(sessionId, content, attachments)
  }

  const setSessionModel = async (sessionId: string, model: string, thinkingLevel?: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    try {
      await api.setPlanningSessionModel(session.session.id, model, thinkingLevel)
      session.session = { ...session.session, model, thinkingLevel }
      return { ok: true, model, thinkingLevel }
    } catch (e) {
      console.error('Failed to change model:', e)
      throw e
    }
  }

  const reconnectSession = async (sessionId: string, model?: string, thinkingLevel?: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session?.session?.id) {
      throw new Error('No session to reconnect')
    }

    // Prevent concurrent reconnect attempts
    if (reconnectingSessions.has(sessionId)) {
      throw new Error('Reconnect already in progress')
    }

    reconnectingSessions.add(sessionId)
    session.isLoading = true
    session.isReconnecting = true
    session.error = null

    try {
      const reconnectedSession = await api.reconnectPlanningSession(session.session.id, {
        model,
        thinkingLevel,
      })
      
      reconnectingSessions.delete(sessionId)
      
      session.session = reconnectedSession
      session.isLoading = false
      session.isReconnecting = false
      return reconnectedSession
    } catch (e) {
      reconnectingSessions.delete(sessionId)
      
      session.error = e instanceof Error ? e.message : 'Failed to reconnect session'
      session.isLoading = false
      session.isReconnecting = false
      throw e
    }
  }

  const createTasksFromChat = async (sessionId: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session?.session?.id) {
      throw new Error('No active session')
    }

    try {
      return await api.createTasksFromPlanning(session.session.id, tasks)
    } catch (e) {
      console.error('Failed to create tasks:', e)
      throw e
    }
  }

  const switchToSession = (sessionId: string) => {
    activeSessionId.value = sessionId
    const session = sessions.value.find(s => s.id === sessionId)
    if (session) {
      session.isMinimized = false
    }
  }

  const minimizeSession = (sessionId: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (session) {
      session.isMinimized = true
    }
  }

  const closeSession = (sessionId: string) => {
    const idx = sessions.value.findIndex(s => s.id === sessionId)
    if (idx >= 0) {
      const session = sessions.value[idx]
      if (session.session?.id) {
        api.closePlanningSession(session.session.id).catch(console.error)
      }
      
      // Clean up refs
      pendingMessages.delete(sessionId)
      reconnectingSessions.delete(sessionId)
      sendingSessions.delete(sessionId)
      
      sessions.value.splice(idx, 1)
    }

    if (activeSessionId.value === sessionId) {
      const visible = visibleSessions.value
      activeSessionId.value = visible.length > 0 ? visible[0].id : null
    }

    if (sessions.value.length === 0) {
      closePanel()
    }
  }

  const renameSession = (sessionId: string, newName: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (session) {
      session.name = newName
    }
  }

  const addMessageToSession = (sessionId: string, message: SessionMessage) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return

    const existingIdx = session.messages.findIndex(m => 
      m.id === message.id || 
      (m.messageId && m.messageId === message.messageId)
    )
    
    if (existingIdx >= 0) {
      session.messages[existingIdx] = message
    } else {
      session.messages.push(message)
    }
    
    session.messages.sort((a, b) => {
      const sa = Number(a.seq || 0)
      const sb = Number(b.seq || 0)
      if (sa !== sb) return sa - sb
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      return ta !== tb ? ta - tb : Number(a.id || 0) - Number(b.id || 0)
    })
  }

  const loadPlanningPrompt = async () => {
    isLoadingPrompt.value = true
    try {
      planningPrompt.value = await api.getPlanningPrompt()
    } catch (e) {
      console.error('Failed to load planning prompt:', e)
    } finally {
      isLoadingPrompt.value = false
    }
  }

  const savePlanningPrompt = async (updates: { name?: string; description?: string; promptText: string }) => {
    try {
      const updated = await api.updatePlanningPrompt({
        key: 'default',
        ...updates,
      })
      planningPrompt.value = updated
      return updated
    } catch (e) {
      console.error('Failed to save planning prompt:', e)
      throw e
    }
  }

  const handlePlanningSessionCreated = (data: PlanningSession) => {
    const session = sessions.value.find(s => s.session?.id === data.id)
    if (session) {
      session.session = data
    }
  }

  const handlePlanningSessionUpdated = (data: PlanningSession) => {
    const session = sessions.value.find(s => s.session?.id === data.id)
    if (session) {
      session.session = { ...session.session, ...data }
    }
  }

  const handlePlanningSessionClosed = (data: { id: string }) => {
    const session = sessions.value.find(s => s.session?.id === data.id)
    if (session) {
      session.session = { ...session.session, status: 'completed', finishedAt: Date.now() }
    }
  }

  const handlePlanningSessionMessage = (data: { sessionId: string; message: SessionMessage }) => {
    const session = sessions.value.find(s => s.session?.id === data.sessionId)
    if (session) {
      addMessageToSession(session.id, data.message)
    }
  }

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
