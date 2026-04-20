import type { ServerWebSocket } from "bun"
import type { WSMessage } from "../types.ts"

export class WebSocketHub {
  private readonly clients = new Set<ServerWebSocket<unknown>>()

  addClient(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws)
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws)
  }

  broadcast(message: WSMessage): void {
    const payload = JSON.stringify(message)
    for (const ws of this.clients) {
      try {
        ws.send(payload)
      } catch {
        this.clients.delete(ws)
      }
    }
  }

  size(): number {
    return this.clients.size
  }

  close(): void {
    for (const ws of this.clients) {
      try {
        ws.close()
      } catch {
        // Ignore already-closed sockets.
      }
    }
    this.clients.clear()
  }
}
