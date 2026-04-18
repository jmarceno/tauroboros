import { useState, useCallback, useRef } from "react"
import type { Session, SessionMessage, TaskRunContext } from "@/types"
import { useApi } from "./useApi"

export function useSession() {
  const api = useApi()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [taskRunContext, setTaskRunContext] = useState<TaskRunContext | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadTokenRef = useRef(0)
  const currentLoadingIdRef = useRef<string | null>(null)

  const loadSession = useCallback(async (id: string, context?: TaskRunContext) => {
    const token = ++loadTokenRef.current
    currentLoadingIdRef.current = id
    setSessionId(id)
    setTaskRunContext(context || null)
    setSession(null)
    setMessages([])
    setError(null)
    setIsLoading(true)

    try {
      const [sessionData, messagesData] = await Promise.all([
        api.getSession(id),
        api.getSessionMessages(id, 1000),
      ])

      if (token !== loadTokenRef.current || currentLoadingIdRef.current !== id) return

      setSession(sessionData)
      setMessages(messagesData.sort((a, b) => {
        const ta = Number(a.timestamp || 0)
        const tb = Number(b.timestamp || 0)
        if (ta !== tb) return ta - tb
        return Number(a.id || 0) - Number(b.id || 0)
      }))
    } catch (e) {
      if (token !== loadTokenRef.current || currentLoadingIdRef.current !== id) return
      const errorMsg = e instanceof Error ? e.message : String(e)
      setError(errorMsg)
      setSession({
        id,
        status: 'failed',
        errorMessage: errorMsg,
        sessionKind: 'unknown',
        createdAt: 0,
        updatedAt: 0,
      } as Session)
    } finally {
      if (token === loadTokenRef.current && currentLoadingIdRef.current === id) {
        setIsLoading(false)
      }
    }
  }, [api])

  const closeSession = useCallback(() => {
    currentLoadingIdRef.current = null
    loadTokenRef.current = 0
    setSessionId(null)
    setSession(null)
    setMessages([])
    setTaskRunContext(null)
    setError(null)
    setIsLoading(false)
  }, [])

  const addMessage = useCallback((message: SessionMessage) => {
    setMessages(prev => {
      const existingIdx = prev.findIndex(m =>
        m.id === message.id ||
        (m.messageId && m.messageId === message.messageId)
      )
      let newMessages
      if (existingIdx >= 0) {
        newMessages = prev.map((m, i) => i === existingIdx ? message : m)
      } else {
        newMessages = [...prev, message]
      }
      return newMessages.sort((a, b) => {
        const ta = Number(a.timestamp || 0)
        const tb = Number(b.timestamp || 0)
        if (ta !== tb) return ta - tb
        return Number(a.id || 0) - Number(b.id || 0)
      })
    })
  }, [])

  const updateSession = useCallback((data: Session) => {
    setSession(prev => {
      if (prev?.id === data.id) {
        return { ...prev, ...data }
      }
      return prev
    })
  }, [])

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
