import { ref, computed, watch } from 'vue'
import type { PlanningSession, PlanningPrompt, SessionMessage } from '@/types/api'
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

  // State
  const isOpen = ref(false)
  const width = ref(400)
  const isResizing = ref(false)
  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const planningPrompt = ref<PlanningPrompt | null>(null)
  const isLoadingPrompt = ref(false)

  // Computed
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

  // Actions
  const openPanel = () => {
    isOpen.value = true
    if (!hasSessions.value) {
      createNewSession()
    }
    // Load prompt on first open
    if (!planningPrompt.value && !isLoadingPrompt.value) {
      loadPlanningPrompt()
    }
  }

  const closePanel = () => {
    isOpen.value = false
  }

  const togglePanel = () => {
    if (isOpen.value) {
      closePanel()
    } else {
      openPanel()
    }
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
      error: null,
    }

    sessions.value.push(newSession)
    activeSessionId.value = sessionId

    try {
      const planningSession = await api.createPlanningSession({
        cwd: window.location.pathname,
        model,
        thinkingLevel: thinkingLevel as any,
      })

      const idx = sessions.value.findIndex(s => s.id === sessionId)
      if (idx >= 0) {
        sessions.value[idx].session = planningSession as PlanningSession
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

  const sendMessage = async (sessionId: string, content: string, attachments?: ContextAttachment[]) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || !session.session?.id) {
      throw new Error('No active session')
    }

    if (session.isSending) {
      throw new Error('Already sending a message')
    }

    session.isSending = true
    session.error = null

    try {
      // The message will appear via WebSocket when the server broadcasts it
      await api.sendPlanningMessage(session.session.id, content, attachments)
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to send message'
      // Check if the error indicates session is not active
      if (errorMsg.includes('Planning session not active')) {
        session.error = 'Session not active. Click "Reconnect" to resume the session.'
      } else {
        session.error = errorMsg
      }
      throw e
    } finally {
      session.isSending = false
    }
  }

  const setSessionModel = async (sessionId: string, model: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || !session.session?.id) {
      throw new Error('No active session')
    }

    try {
      await api.setPlanningSessionModel(session.session.id, model)
      // Update the session model locally
      if (session.session) {
        session.session = { ...session.session, model }
      }
      return { ok: true, model }
    } catch (e) {
      console.error('Failed to change model:', e)
      throw e
    }
  }

  const reconnectSession = async (sessionId: string, model?: string, thinkingLevel?: string) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || !session.session?.id) {
      throw new Error('No session to reconnect')
    }

    session.isLoading = true
    session.error = null

    try {
      const reconnectedSession = await api.reconnectPlanningSession(session.session.id, {
        model,
        thinkingLevel,
      })
      session.session = reconnectedSession as PlanningSession
      session.isLoading = false
      return reconnectedSession
    } catch (e) {
      session.error = e instanceof Error ? e.message : 'Failed to reconnect session'
      session.isLoading = false
      throw e
    }
  }

  const createTasksFromChat = async (sessionId: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) => {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || !session.session?.id) {
      throw new Error('No active session')
    }

    try {
      const result = await api.createTasksFromPlanning(session.session.id, tasks)
      return result
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
      // Close the pi session if it exists
      if (session.session?.id) {
        api.closePlanningSession(session.session.id).catch(console.error)
      }
      sessions.value.splice(idx, 1)
    }

    if (activeSessionId.value === sessionId) {
      const visible = visibleSessions.value
      if (visible.length > 0) {
        activeSessionId.value = visible[0].id
      } else {
        activeSessionId.value = null
      }
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

    // Find existing message by database id or messageId
    const existingIdx = session.messages.findIndex(m => 
      m.id === message.id || 
      (m.messageId && m.messageId === message.messageId)
    )
    
    if (existingIdx >= 0) {
      // Replace with updated message (backend now handles merging)
      session.messages[existingIdx] = message
    } else {
      session.messages.push(message)
    }
    
    // Sort by seq (primary) then timestamp
    session.messages.sort((a, b) => {
      const sa = Number(a.seq || 0)
      const sb = Number(b.seq || 0)
      if (sa !== sb) return sa - sb
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      if (ta !== tb) return ta - tb
      return Number(a.id || 0) - Number(b.id || 0)
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

  // WebSocket message handlers
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
    // State
    isOpen,
    width,
    isResizing,
    sessions,
    activeSessionId,
    planningPrompt,
    isLoadingPrompt,

    // Computed
    activeSession,
    visibleSessions,
    minimizedSessions,
    hasSessions,

    // Actions
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

    // WebSocket handlers
    handlePlanningSessionCreated,
    handlePlanningSessionUpdated,
    handlePlanningSessionClosed,
    handlePlanningSessionMessage,

    // Chat actions
    sendMessage,
    createTasksFromChat,
    reconnectSession,
    setSessionModel,
  }
}
