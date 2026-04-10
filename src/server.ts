import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import type { InfrastructureSettings } from "./config/settings.ts"
import { PiKanbanDB } from "./db.ts"
import { PiKanbanServer } from "./server/server.ts"
import { PiOrchestrator } from "./orchestrator.ts"

export interface CreateServerOptions {
  dbPath?: string
  port?: number
  settings?: InfrastructureSettings
}

/**
 * Find the project root by looking for a .git directory or .pi directory
 * starting from the script location and walking up.
 */
export function findProjectRoot(): string {
  // Start from the directory of this script
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  let currentDir = scriptDir

  // Walk up looking for .git or .pi directory
  while (currentDir !== dirname(currentDir)) {
    if (existsSync(resolve(currentDir, ".git")) || existsSync(resolve(currentDir, ".pi"))) {
      return currentDir
    }
    currentDir = dirname(currentDir)
  }

  // Fallback to process.cwd() if no project root found
  return process.cwd()
}

export function createPiServer(options: CreateServerOptions = {}): {
  db: PiKanbanDB
  server: PiKanbanServer
  orchestrator: PiOrchestrator
} {
  // Use explicit dbPath, or find project root for consistent location
  const projectRoot = findProjectRoot()
  const defaultDbPath = resolve(projectRoot, ".pi", "easy-workflow", "tasks.db")
  const dbPath = options.dbPath ?? defaultDbPath
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new PiKanbanDB(dbPath)
  let orchestrator: PiOrchestrator | null = null

  const server = new PiKanbanServer(db, {
    port: options.port,
    settings: options.settings,
    onStart: async () => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      return await orchestrator.startAll()
    },
    onStartSingle: async (taskId: string) => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      return await orchestrator.startSingle(taskId)
    },
    onStop: async () => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      await orchestrator.stop()
      return { ok: true }
    },
  })

  orchestrator = new PiOrchestrator(
    db,
    (message) => server.broadcast(message),
    (sessionId) => `/#session/${encodeURIComponent(sessionId)}`,
    projectRoot,
    options.settings,
  )

  return { db, server, orchestrator }
}

export { PiKanbanServer }
