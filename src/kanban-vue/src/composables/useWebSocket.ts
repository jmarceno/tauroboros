import { ref, onMounted, onUnmounted } from 'vue'
import type { WSMessage, WSMessageType } from '@/types/api'

type MessageHandler = (payload: unknown) => void

console.log('[useWebSocket] Module loaded')

export function useWebSocket() {
  console.log('[useWebSocket] Function called')
  const ws = ref<WebSocket | null>(null)
  const isConnected = ref(false)
  const reconnectAttempts = ref(0)
  const MAX_RECONNECT_ATTEMPTS = 50
  const INITIAL_RECONNECT_DELAY = 1000
  const MAX_RECONNECT_DELAY = 30000
  const handlers = new Map<WSMessageType, Set<MessageHandler>>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectCallback: (() => void) | null = null
  let intentionalClose = false

  const getReconnectDelay = () => {
    const attempt = reconnectAttempts.value
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY)
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
    // @ts-ignore - debug
    window.__WS_URL__ = wsUrl

    ws.value = new WebSocket(wsUrl)
    // @ts-ignore - debug
    window.__WS_INSTANCE__ = ws.value

    ws.value.onopen = () => {
      isConnected.value = true
      const wasReconnect = reconnectAttempts.value > 0
      reconnectAttempts.value = 0
      // @ts-ignore - debug
      window.__WS_STATUS__ = 'connected'
      console.log('[WebSocket] Connected')
      if (wasReconnect && reconnectCallback) {
        console.log('[WebSocket] Triggering state resync after reconnection')
        reconnectCallback()
      }
    }

    ws.value.onclose = () => {
      isConnected.value = false
      // @ts-ignore - debug
      window.__WS_STATUS__ = 'disconnected'
      console.log('[WebSocket] Disconnected')
      if (intentionalClose) {
        intentionalClose = false
        return
      }
      if (reconnectAttempts.value < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay()
        console.log(`[WebSocket] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts.value + 1}/${MAX_RECONNECT_ATTEMPTS})`)
        reconnectTimer = setTimeout(() => {
          reconnectAttempts.value++
          connect()
        }, delay)
      } else {
        console.warn('[WebSocket] Max reconnect attempts reached')
      }
    }

    ws.value.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data)
        console.log('[WebSocket] Message received:', message.type, message.payload?.id || message.payload?.name || '')
        const typeHandlers = handlers.get(message.type)
        if (typeHandlers) {
          typeHandlers.forEach(handler => handler(message.payload))
        }
      } catch {
        // Ignore malformed messages
      }
    }

    ws.value.onerror = () => {
      // Error handled by onclose
    }
  }

  const disconnect = () => {
    intentionalClose = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    ws.value?.close()
    ws.value = null
    isConnected.value = false
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

  onMounted(() => {
    console.log('[useWebSocket] onMounted - connecting...')
    connect()
  })

  onUnmounted(() => {
    disconnect()
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