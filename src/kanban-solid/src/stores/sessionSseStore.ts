/**
 * Session SSE Store - Server-Sent Events client for real-time session message updates
 *
 * Manages SSE connections per session, receiving new messages as they arrive
 * from the backend Pi webhook. Uses EventSource for lightweight, one-way streaming.
 */

import { createSignal, onCleanup } from 'solid-js'
import { Effect, Schema } from 'effect'
import { runApiEffect } from '@/api'
import type { SessionMessage } from '@/types'

export class SseClientError extends Schema.TaggedError<SseClientError>()('SseClientError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

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
   * Returns an Effect that manages the lifecycle.
   */
  const connect = (sessionId: string): Effect.Effect<void, SseClientError> =>
    Effect.gen(function* () {
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

      setConnections(prev => {
        const next = new Map(prev)
        next.set(sessionId, connection)
        return next
      })

      // Set up event handlers
      eventSource.onopen = () => {
        setIsConnecting(prev => {
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
      }

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SseEvent
          const conn = connections().get(sessionId)
          if (conn) {
            conn.handlers.forEach(handler => handler(data))
          }
        } catch {
          // Ignore malformed messages
        }
      }

      eventSource.onerror = () => {
        // Connection will auto-reconnect, but update state
        setIsConnecting(prev => {
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
      }
    })

  /**
   * Disconnect from a session's SSE endpoint.
   */
  const disconnect = (sessionId: string): Effect.Effect<void, never> =>
    Effect.sync(() => {
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
    })

  /**
   * Subscribe to events for a session.
   * Returns an unsubscribe function.
   */
  const on = (sessionId: string, handler: MessageHandler): (() => void) => {
    // Auto-connect if not already connected
    const conn = connections().get(sessionId)
    if (!conn || conn.eventSource.readyState === EventSource.CLOSED) {
      void runApiEffect(connect(sessionId).pipe(Effect.catchAll(() => Effect.void)))
    }

    // Add handler
    const currentConn = connections().get(sessionId)
    if (currentConn) {
      currentConn.handlers.add(handler)
    }

    return () => {
      const c = connections().get(sessionId)
      if (c) {
        c.handlers.delete(handler)
        // Disconnect if no more handlers
        if (c.handlers.size === 0) {
          void runApiEffect(disconnect(sessionId))
        }
      }
    }
  }

  /**
   * Disconnect all sessions.
   */
  const disconnectAll = (): Effect.Effect<void, never> =>
    Effect.sync(() => {
      for (const [sessionId] of connections()) {
        const conn = connections().get(sessionId)
        if (conn) {
          conn.eventSource.close()
        }
      }
      setConnections(new Map())
      setIsConnecting(new Set())
    })

  // Cleanup on component unmount
  onCleanup(() => {
    void runApiEffect(disconnectAll())
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
