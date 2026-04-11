import { ref, onMounted, onUnmounted } from 'vue'
import type { WSMessage, WSMessageType } from '@/types/api'

type MessageHandler = (payload: unknown) => void

export function useWebSocket() {
  const ws = ref<WebSocket | null>(null)
  const isConnected = ref(false)
  const reconnectAttempts = ref(0)
  const MAX_RECONNECT_ATTEMPTS = 5
  const RECONNECT_DELAY = 2000
  const handlers = new Map<WSMessageType, Set<MessageHandler>>()

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${location.host}/ws`

    ws.value = new WebSocket(wsUrl)

    ws.value.onopen = () => {
      isConnected.value = true
      reconnectAttempts.value = 0
    }

    ws.value.onclose = () => {
      isConnected.value = false
      if (reconnectAttempts.value < MAX_RECONNECT_ATTEMPTS) {
        setTimeout(() => {
          reconnectAttempts.value++
          connect()
        }, RECONNECT_DELAY)
      }
    }

    ws.value.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data)
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

  onMounted(() => {
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
  }
}
