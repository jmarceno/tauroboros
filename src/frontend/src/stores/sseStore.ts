/**
 * SSE Store - Real-time updates using Server-Sent Events
 * Replaces: websocketStore.ts
 *
 * Manages a single EventSource connection to /sse.
 * The server sends named events (event: task_updated, event: run_updated, etc.)
 * with data being a JSON-serialized WSMessage: {"type":"task_updated","payload":{...}}
 *
 * Each handler type gets exactly one addEventListener on the current EventSource.
 * On reconnect, all handlers are re-registered automatically.
 * Cleanup removes the handler from the dispatch map (addEventListener stays on old closed source).
 */

import { createSignal, onMount, onCleanup } from 'solid-js'
import { Effect } from 'effect'
import { runApiEffect } from '@/api'
import type { WSMessage, WSMessageType } from '@/types'

type MessageHandler = (payload: unknown) => void

export function createSseStore() {
  const [isConnected, setIsConnected] = createSignal(false)
  const [reconnectAttempts, setReconnectAttempts] = createSignal(0)

  const handlers = new Map<WSMessageType, Set<MessageHandler>>()
  // Track which event types have addEventListener registered on the current EventSource.
  // This prevents duplicate listeners when `on()` is called for an already-registered type.
  const registeredTypes = new Set<string>()
  let reconnectCallback: (() => void) | null = null
  let intentionalClose = false
  let esRef: EventSource | null = null
  let reconnectAttemptsRef = 0
  let reconnectToken = 0
  let reconnectInFlight = false

  const MAX_RECONNECT_ATTEMPTS = 50
  const INITIAL_RECONNECT_DELAY = 1000
  const MAX_RECONNECT_DELAY = 30000

  const getReconnectDelay = () => {
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef), MAX_RECONNECT_DELAY)
    return delay + Math.random() * 1000
  }

  const reconnectEffect = (tokenAtStart: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      while (!intentionalClose && tokenAtStart === reconnectToken && reconnectAttemptsRef < MAX_RECONNECT_ATTEMPTS) {
        const delayMs = Math.max(1, Math.floor(getReconnectDelay()))
        yield* Effect.sleep(`${delayMs} millis`)

        if (intentionalClose || tokenAtStart !== reconnectToken) {
          return
        }

        reconnectAttemptsRef++
        setReconnectAttempts(reconnectAttemptsRef)
        connect()
        return
      }
    })

  const scheduleReconnect = () => {
    if (reconnectInFlight) {
      return
    }

    reconnectInFlight = true
    const tokenAtStart = reconnectToken

    void runApiEffect(
      reconnectEffect(tokenAtStart).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    ).finally(() => {
      reconnectInFlight = false
    })
  }

  /**
   * Register an addEventListener on the current EventSource for a specific event type.
   * Each event type is only registered once per EventSource instance.
   * The listener parses the data as WSMessage and dispatches message.payload to all handlers of that type.
   */
  const registerEventListener = (type: string) => {
    if (!esRef || registeredTypes.has(type)) return
    registeredTypes.add(type)

    esRef.addEventListener(type, (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data) as WSMessage
        const typeHandlers = handlers.get(message.type)
        if (typeHandlers) {
          typeHandlers.forEach(handler => handler(message.payload))
        }
      } catch {
        // Ignore malformed messages
      }
    })
  }

  const connect = () => {
    reconnectToken++
    reconnectInFlight = false

    // Clear current EventSource and reset registered types tracking
    if (esRef) {
      esRef.close()
    }
    registeredTypes.clear()

    const url = `/sse`

    const newEs = new EventSource(url)
    esRef = newEs

    newEs.onopen = () => {
      setIsConnected(true)
      const wasReconnect = reconnectAttemptsRef > 0
      reconnectAttemptsRef = 0
      setReconnectAttempts(0)
      if (wasReconnect && reconnectCallback) {
        reconnectCallback()
      }
    }

    newEs.onerror = () => {
      setIsConnected(false)
      if (intentionalClose) {
        intentionalClose = false
        return
      }
      scheduleReconnect()
    }

    // Register addEventListener for all currently known handler types on the new EventSource
    for (const messageType of handlers.keys()) {
      registerEventListener(messageType)
    }
  }

  const disconnect = () => {
    intentionalClose = true
    reconnectToken++
    reconnectInFlight = false
    esRef?.close()
    esRef = null
    setIsConnected(false)
  }

  /**
   * Register a handler for a specific message type.
   * If there's an active EventSource, registers a single addEventListener for that type
   * (deduplicated - only one listener per type per EventSource instance).
   * Returns an unsubscribe function.
   */
  const on = (type: WSMessageType, handler: MessageHandler) => {
    if (!handlers.has(type)) {
      handlers.set(type, new Set())
    }
    handlers.get(type)!.add(handler)

    // Register the event listener on the current EventSource if we haven't already
    registerEventListener(type)

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
    intentionalClose = true
    reconnectToken++
    reconnectInFlight = false
    esRef?.close()
    esRef = null
  })

  return {
    isConnected,
    reconnectAttempts,
    connect,
    disconnect,
    on,
    onReconnect,
  }
}
