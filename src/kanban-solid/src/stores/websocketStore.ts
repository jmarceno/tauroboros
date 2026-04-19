/**
 * WebSocket Store - Real-time updates
 * Replaces: WebSocketContext
 */

import { createSignal, onMount, onCleanup } from 'solid-js'
import type { WSMessage, WSMessageType } from '@/types'

type MessageHandler = (payload: unknown) => void

export function createWebSocketStore() {
  const [ws, setWs] = createSignal<WebSocket | null>(null)
  const [isConnected, setIsConnected] = createSignal(false)
  const [reconnectAttempts, setReconnectAttempts] = createSignal(0)

  const handlers = new Map<WSMessageType, Set<MessageHandler>>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectCallback: (() => void) | null = null
  let intentionalClose = false
  let wsRef: WebSocket | null = null
  let reconnectAttemptsRef = 0

  const MAX_RECONNECT_ATTEMPTS = 50
  const INITIAL_RECONNECT_DELAY = 1000
  const MAX_RECONNECT_DELAY = 30000

  const getReconnectDelay = () => {
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef), MAX_RECONNECT_DELAY)
    return delay + Math.random() * 1000
  }

  const connect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${location.host}/ws`
    console.log('[WebSocket] Connecting to:', wsUrl)

    const newWs = new WebSocket(wsUrl)
    wsRef = newWs
    setWs(newWs)

    newWs.onopen = () => {
      setIsConnected(true)
      const wasReconnect = reconnectAttemptsRef > 0
      reconnectAttemptsRef = 0
      setReconnectAttempts(0)
      console.log('[WebSocket] Connected')
      if (wasReconnect && reconnectCallback) {
        console.log('[WebSocket] Triggering state resync after reconnection')
        reconnectCallback()
      }
    }

    newWs.onclose = () => {
      setIsConnected(false)
      console.log('[WebSocket] Disconnected')
      if (intentionalClose) {
        intentionalClose = false
        return
      }
      if (reconnectAttemptsRef < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay()
        console.log(`[WebSocket] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttemptsRef + 1}/${MAX_RECONNECT_ATTEMPTS})`)
        reconnectTimer = setTimeout(() => {
          reconnectAttemptsRef++
          setReconnectAttempts(reconnectAttemptsRef)
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
        const typeHandlers = handlers.get(message.type)
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
  }

  const disconnect = () => {
    intentionalClose = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    wsRef?.close()
    wsRef = null
    setWs(null)
    setIsConnected(false)
    intentionalClose = false
  }

  const on = (type: WSMessageType, handler: MessageHandler) => {
    if (!handlers.has(type)) {
      handlers.set(type, new Set())
    }
    handlers.get(type)!.add(handler)

    return () => {
      handlers.get(type)?.delete(handler)
    }
  }

  const onReconnect = (callback: () => void) => {
    reconnectCallback = callback
  }

  // Auto-connect on mount
  onMount(() => {
    connect()
  })

  // Cleanup on unmount
  onCleanup(() => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    intentionalClose = true
    wsRef?.close()
    wsRef = null
  })

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
