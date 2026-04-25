import { Effect, Queue, Schema } from "effect"
import type { WSMessage } from "../types.ts"

export class GlobalSseHubError extends Schema.TaggedError<GlobalSseHubError>()("GlobalSseHubError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface SseEvent {
  event: string
  data: unknown
}

interface SseConnection {
  id: string
  queue: Queue.Queue<SseEvent>
  filters: string[] | null
  connectedAt: number
}

export class GlobalSseHub {
  private readonly connections = new Map<string, SseConnection>()
  private nextId = 0

  createConnection(filters?: string[]): Effect.Effect<{ connectionId: string; queue: Queue.Queue<SseEvent> }, never> {
    return Effect.gen(this, function* () {
      const connectionId = `global_conn_${++this.nextId}`
      const queue = yield* Queue.unbounded<SseEvent>()

      const connection: SseConnection = {
        id: connectionId,
        queue,
        filters: filters ?? null,
        connectedAt: Date.now(),
      }
      this.connections.set(connectionId, connection)

      return { connectionId, queue }
    })
  }

  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId)
  }

  broadcast(message: WSMessage): void {
    const event: SseEvent = {
      event: message.type,
      data: message,
    }

    for (const [, conn] of this.connections) {
      if (conn.filters === null || matchesFilter(message.type, conn.filters)) {
        Queue.unsafeOffer(conn.queue, event)
      }
    }
  }

  connectionCount(): number {
    return this.connections.size
  }

  close(): void {
    this.connections.clear()
  }
}

function matchesFilter(messageType: string, filters: string[]): boolean {
  for (const filter of filters) {
    if (filter.endsWith("*")) {
      const prefix = filter.slice(0, -1)
      if (messageType.startsWith(prefix)) return true
    } else if (messageType === filter) {
      return true
    }
  }
  return false
}

export function makeGlobalSseHub(): Effect.Effect<GlobalSseHub, never> {
  return Effect.sync(() => new GlobalSseHub())
}
