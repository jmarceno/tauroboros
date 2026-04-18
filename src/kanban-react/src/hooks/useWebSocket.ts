import { useState, useCallback, useEffect, useRef } from "react"
import type { WSMessage, WSMessageType } from "@/types"

type MessageHandler = (payload: unknown) => void

export function useWebSocket() {
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const handlers = useRef(new Map<WSMessageType, Set<MessageHandler>>())
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectCallbackRef = useRef<(() => void) | null>(null)
  const intentionalCloseRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  // Use ref to track current reconnect attempts to avoid stale closures
  const reconnectAttemptsRef = useRef(0)

  const MAX_RECONNECT_ATTEMPTS = 50
  const INITIAL_RECONNECT_DELAY = 1000
  const MAX_RECONNECT_DELAY = 30000

  // Sync ref with state
  useEffect(() => {
    reconnectAttemptsRef.current = reconnectAttempts
  }, [reconnectAttempts])

  const getReconnectDelay = useCallback(() => {
    const attempt = reconnectAttemptsRef.current
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY)
    return delay + Math.random() * 1000
  }, [])

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${location.host}/ws`
    console.log('[WebSocket] Connecting to:', wsUrl)

    const newWs = new WebSocket(wsUrl)
    wsRef.current = newWs
    setWs(newWs)

    newWs.onopen = () => {
      setIsConnected(true)
      const wasReconnect = reconnectAttemptsRef.current > 0
      setReconnectAttempts(0)
      console.log('[WebSocket] Connected')
      if (wasReconnect && reconnectCallbackRef.current) {
        console.log('[WebSocket] Triggering state resync after reconnection')
        reconnectCallbackRef.current()
      }
    }

    newWs.onclose = () => {
      setIsConnected(false)
      console.log('[WebSocket] Disconnected')
      if (intentionalCloseRef.current) {
        intentionalCloseRef.current = false
        return
      }
      if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay()
        console.log(`[WebSocket] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS})`)
        reconnectTimerRef.current = setTimeout(() => {
          setReconnectAttempts(prev => prev + 1)
          connect()
        }, delay)
      } else {
        console.warn('[WebSocket] Max reconnect attempts reached')
      }
    }

    newWs.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data)
        console.log('[WebSocket] Message received:', message.type)
        const typeHandlers = handlers.current.get(message.type)
        if (typeHandlers) {
          typeHandlers.forEach(handler => handler(message.payload))
        }
      } catch {
        // Ignore malformed messages
      }
    }

    newWs.onerror = () => {
      // Error handled by onclose
    }
  }, [getReconnectDelay])

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    wsRef.current?.close()
    wsRef.current = null
    setWs(null)
    setIsConnected(false)
  }, [])

  const on = useCallback((type: WSMessageType, handler: MessageHandler) => {
    if (!handlers.current.has(type)) {
      handlers.current.set(type, new Set())
    }
    handlers.current.get(type)!.add(handler)

    return () => {
      handlers.current.get(type)?.delete(handler)
    }
  }, [])

  const onReconnect = useCallback((callback: () => void) => {
    reconnectCallbackRef.current = callback
  }, [])

  useEffect(() => {
    console.log('[useWebSocket] Connecting...')
    connect()

    return () => {
      disconnect()
    }
  }, [])

  return {
    ws,
    isConnected,
    reconnectAttempts,
    connect,
    disconnect,
    on,
    onReconnect,
  }
}
