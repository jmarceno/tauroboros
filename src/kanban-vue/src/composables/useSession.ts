import { ref, watch } from 'vue'
import type { Session, SessionMessage, TaskRun } from '@/types/api'
import { useApi } from './useApi'

export interface TaskRunContext {
  taskId: string | null
  phase: string | null
  slotIndex: number
  attemptIndex: number
}

export function useSession() {
  const api = useApi()
  const sessionId = ref<string | null>(null)
  const session = ref<Session | null>(null)
  const messages = ref<SessionMessage[]>([])
  const taskRunContext = ref<TaskRunContext | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const loadToken = ref(0)

  const loadSession = async (id: string, context?: TaskRunContext) => {
    const token = ++loadToken.value
    sessionId.value = id
    taskRunContext.value = context || null
    session.value = null
    messages.value = []
    error.value = null
    isLoading.value = true

    try {
      const [sessionData, messagesData] = await Promise.all([
        api.getSession(id),
        api.getSessionMessages(id, 1000),
      ])

      if (token !== loadToken.value || sessionId.value !== id) return

      session.value = sessionData
      messages.value = messagesData.sort((a, b) => {
        const ta = Number(a.timestamp || 0)
        const tb = Number(b.timestamp || 0)
        if (ta !== tb) return ta - tb
        return Number(a.id || 0) - Number(b.id || 0)
      })
    } catch (e) {
      if (token !== loadToken.value || sessionId.value !== id) return
      error.value = e instanceof Error ? e.message : String(e)
      session.value = {
        id,
        status: 'failed',
        errorMessage: error.value,
        sessionKind: 'unknown',
        createdAt: 0,
        updatedAt: 0,
      } as Session
    } finally {
      isLoading.value = false
    }
  }

  const closeSession = () => {
    sessionId.value = null
    session.value = null
    messages.value = []
    taskRunContext.value = null
    error.value = null
  }

  const addMessage = (message: SessionMessage) => {
    const existingIdx = messages.value.findIndex(m =>
      m.id === message.id ||
      (m.messageId && m.messageId === message.messageId)
    )
    if (existingIdx >= 0) {
      messages.value[existingIdx] = message
    } else {
      messages.value.push(message)
    }
    messages.value.sort((a, b) => {
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      if (ta !== tb) return ta - tb
      return Number(a.id || 0) - Number(b.id || 0)
    })
  }

  const updateSession = (data: Session) => {
    if (session.value?.id === data.id) {
      session.value = { ...session.value, ...data }
    }
  }

  return {
    sessionId,
    session,
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
