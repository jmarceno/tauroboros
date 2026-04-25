/**
 * SSE Hub - Server-Sent Events manager for session message streaming.
 *
 * Manages long-lived SSE connections per session, delivering new messages
 * as they arrive via the Pi webhook. Subscribers receive events when new
 * messages are created for sessions they are subscribed to.
 */

import { Effect, Queue, Schema } from "effect"
import type { SessionMessage } from "../types.ts"

export class SseHubError extends Schema.TaggedError<SseHubError>()("SseHubError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface SseEvent {
  type: "session_message" | "session_status"
  sessionId: string
  payload: SessionMessage | { status: string; finishedAt: number | null }
}

interface SseConnection {
  id: string
  sessionId: string
  queue: Queue.Queue<SseEvent>
  connectedAt: number
}

export class SseHub {
  private readonly connections = new Map<string, SseConnection>()
  private nextId = 0

  /**
   * Create a new SSE connection for a session.
   * Returns a queue that the SSE endpoint will consume to stream events.
   * The queue is unbounded and will be cleaned up when the connection is removed.
   */
  createConnection(sessionId: string): Effect.Effect<Queue.Queue<SseEvent>, SseHubError, never> {
    return Effect.gen(this, function* () {
      const connectionId = `conn_${++this.nextId}`
      const queue = yield* Queue.unbounded<SseEvent>()

      const connection: SseConnection = {
        id: connectionId,
        sessionId,
        queue,
        connectedAt: Date.now(),
      }
      this.connections.set(connectionId, connection)

      return queue
    })
  }

  /**
   * Remove a connection. The queue will be garbage collected when no longer referenced.
   */
  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId)
  }

  /**
   * Broadcast a new session message to all connections for that session.
   */
  broadcastMessage(message: SessionMessage): void {
    const event: SseEvent = {
      type: "session_message",
      sessionId: message.sessionId,
      payload: message,
    }

    // Find all connections for this session and offer the event
    for (const [, conn] of this.connections) {
      if (conn.sessionId === message.sessionId) {
        Queue.unsafeOffer(conn.queue, event)
      }
    }
  }

  /**
   * Broadcast a session status change to all connections for that session.
   */
  broadcastStatus(sessionId: string, status: string, finishedAt: number | null): void {
    const event: SseEvent = {
      type: "session_status",
      sessionId,
      payload: { status, finishedAt },
    }

    for (const [, conn] of this.connections) {
      if (conn.sessionId === sessionId) {
        Queue.unsafeOffer(conn.queue, event)
      }
    }
  }

  /**
   * Get the number of active connections.
   */
  connectionCount(): number {
    return this.connections.size
  }

  /**
   * Get connection count for a specific session.
   */
  sessionConnectionCount(sessionId: string): number {
    let count = 0
    for (const [, conn] of this.connections) {
      if (conn.sessionId === sessionId) {
        count++
      }
    }
    return count
  }
}

export function makeSseHub(): Effect.Effect<SseHub, never> {
  return Effect.sync(() => new SseHub())
}
