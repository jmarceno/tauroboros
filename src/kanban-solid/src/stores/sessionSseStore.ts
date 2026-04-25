/**
 * Session SSE Store - Server-Sent Events client for real-time session message updates
 *
 * Manages SSE connections per session, receiving new messages as they arrive
 * from the backend Pi webhook. Uses EventSource for lightweight, one-way streaming.
 *
 * The server sends named events:
 *   event: session_message
 *   data: {"type":"session_message","sessionId":"...","payload":{...}}
 *
 *   event: session_status
 *   data: {"type":"session_status","sessionId":"...","payload":{...}}
 *
 * We use addEventListener for these named events, NOT onmessage (which only
 * fires for unnamed events).
 */

import { createSignal, onCleanup } from 'solid-js'
import type { SessionMessage } from '@/types'

export interface SseEvent {
  type: 'session_message' | 'session_status'
  sessionId: string
  payload: SessionMessage | { status: string; finishedAt: number | null }
}

type MessageHandler = (event: SseEvent) => void

type Connection = {
  eventSource: EventSource
  handlers: Set<MessageHandler>
  sessionId: string
}

export function createSessionSseStore() {
  const [connections, setConnections] = createSignal<Map<string, Connection>>(new Map())
  const [isConnecting, setIsConnecting] = createSignal<Set<string>>(new Set())

  /**
   * Connect to the SSE endpoint for a session.
   * Synchronously creates the EventSource and registers handlers.
   */
  const connect = (sessionId: string): void => {
    // Skip if already connected
    const existing = connections().get(sessionId)
    if (existing && existing.eventSource.readyState === EventSource.OPEN) {
      return
    }

    // Skip if already connecting
    if (isConnecting().has(sessionId)) {
      return
    }

    setIsConnecting(prev => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })

    const eventSource = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`)
    const handlers = new Set<MessageHandler>()

    const connection: Connection = {
      eventSource,
      handlers,
      sessionId,
    }

    // Store connection BEFORE setting up event handlers so on() can find it
    setConnections(prev => {
      const next = new Map(prev)
      next.set(sessionId, connection)
      return next
    })

    // Register addEventListener for the named event types from the server.
    // The server sends:
    //   event: session_message\ndata: {"type":"session_message","sessionId":"...","payload":...}
    //   event: session_status\ndata: {"type":"session_status","sessionId":"...","payload":...}
    // onmessage does NOT fire for named events - only addEventListener does.

    eventSource.addEventListener('session_message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseEvent
        const conn = connections().get(sessionId)
        if (conn) {
          conn.handlers.forEach(handler => handler(data))
        }
      } catch {
        // Ignore malformed messages
      }
    })

    eventSource.addEventListener('session_status', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseEvent
        const conn = connections().get(sessionId)
        if (conn) {
          conn.handlers.forEach(handler => handler(data))
        }
      } catch {
        // Ignore malformed messages
      }
    })

    eventSource.onopen = () => {
      setIsConnecting(prev => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }

    eventSource.onerror = (error) => {
      // Suppress expected errors from client-initiated disconnects
      const conn = connections().get(sessionId)
      if (!conn) return // Already cleaned up, ignore
      
      // Only update state if this is a connection error, not a close
      if (eventSource.readyState !== EventSource.CLOSED) {
        setIsConnecting(prev => {
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
      }
    }
  }

  /**
   * Disconnect from a session's SSE endpoint.
   */
  const disconnect = (sessionId: string): void => {
    const conn = connections().get(sessionId)
    if (conn) {
      conn.eventSource.close()
      setConnections(prev => {
        const next = new Map(prev)
        next.delete(sessionId)
        return next
      })
    }
    setIsConnecting(prev => {
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }

  /**
   * Subscribe to events for a session.
   * Auto-connects if not already connected.
   * Returns an unsubscribe function.
   */
  const on = (sessionId: string, handler: MessageHandler): (() => void) => {
    // Check if we need to connect first
    const conn = connections().get(sessionId)
    if (!conn || conn.eventSource.readyState === EventSource.CLOSED) {
      connect(sessionId)
    }

    // After connect(), the connection is available synchronously since connect() is synchronous.
    // Add the handler to the connection's handler set.
    const updatedConn = connections().get(sessionId)
    if (updatedConn) {
      updatedConn.handlers.add(handler)
    }

    return () => {
      const c = connections().get(sessionId)
      if (c) {
        c.handlers.delete(handler)
        // Disconnect if no more handlers
        if (c.handlers.size === 0) {
          disconnect(sessionId)
        }
      }
    }
  }

  /**
   * Disconnect all sessions.
   */
  const disconnectAll = (): void => {
    for (const [, conn] of connections()) {
      conn.eventSource.close()
    }
    setConnections(new Map())
    setIsConnecting(new Set())
  }

  // Cleanup on component unmount
  onCleanup(() => {
    disconnectAll()
  })

  return {
    connect,
    disconnect,
    on,
    disconnectAll,
    connections,
    isConnecting,
  }
}
