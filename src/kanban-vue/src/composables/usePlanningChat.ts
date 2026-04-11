import { ref, computed, watch } from 'vue'
import type { PlanningSession, PlanningPrompt, SessionMessage } from '@/types/api'
import { useApi } from './useApi'

export interface ChatSession {
  id: string
  name: string
  session: PlanningSession | null
  messages: SessionMessage[]
  isMinimized: boolean
  isLoading: boolean
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

  const createNewSession = async () => {
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

    // Update active session
    if (activeSessionId.value === sessionId) {
      const visible = visibleSessions.value
      if (visible.length > 0) {
        activeSessionId.value = visible[0].id
      } else {
        activeSessionId.value = null
      }
    }

    // Close panel if no sessions left
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
    if (session) {
      const existingIdx = session.messages.findIndex(m => m.id === message.id)
      if (existingIdx >= 0) {
        session.messages[existingIdx] = message
      } else {
        session.messages.push(message)
      }
      // Sort by timestamp
      session.messages.sort((a, b) => {
        const ta = Number(a.timestamp || 0)
        const tb = Number(b.timestamp || 0)
        if (ta !== tb) return ta - tb
        return Number(a.id || 0) - Number(b.id || 0)
      })
    }
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
    // Update existing session with server data if needed
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

  const handlePlanningSessionMessage = (data: SessionMessage) => {
    const session = sessions.value.find(s => s.session?.id === data.sessionId)
    if (session) {
      addMessageToSession(session.id, data)
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
  }
}
