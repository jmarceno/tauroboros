import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import type { InfrastructureSettings } from "./config/settings.ts"
import { PiKanbanDB } from "./db.ts"
import { PiKanbanServer } from "./server/server.ts"
import { PiOrchestrator } from "./orchestrator.ts"
import { PiContainerManager } from "./runtime/container-manager.ts"

export interface CreateServerOptions {
  dbPath?: string
  port?: number
  settings?: InfrastructureSettings
}

/**
 * Find the project root by looking for a .git directory or .pi directory.
 * Checks current working directory first, then falls back to walking up
 * from the script location.
 */
export function findProjectRoot(): string {
  // First, check if current working directory has .git or .pi
  // This is important for E2E tests that run from a temp directory
  const cwd = process.cwd()
  if (existsSync(resolve(cwd, ".git")) || existsSync(resolve(cwd, ".pi"))) {
    return cwd
  }

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
  return cwd
}

export function createPiServer(options: CreateServerOptions = {}): {
  db: PiKanbanDB
  server: PiKanbanServer
  orchestrator: PiOrchestrator
} {
  // Use explicit dbPath, or find project root for consistent location
  const projectRoot = findProjectRoot()
  const defaultDbPath = resolve(projectRoot, ".pi", "tauroboros", "tasks.db")
  const dbPath = options.dbPath ?? defaultDbPath
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new PiKanbanDB(dbPath)
  let orchestrator: PiOrchestrator | null = null

  const server = new PiKanbanServer(db, {
    port: options.port,
    settings: options.settings,
    projectRoot: projectRoot,
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
    onPauseRun: async (runId: string) => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      const success = await orchestrator.pauseRun(runId)
      const run = db.getWorkflowRun(runId)
      return { success, run }
    },
    onResumeRun: async (runId: string) => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      return await orchestrator.resumeRun(runId)
    },
    onStopRun: async (runId: string, options?: { destructive?: boolean }) => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      if (options?.destructive) {
        const result = await orchestrator.destructiveStop(runId)
        const run = db.getWorkflowRun(runId)
        return { success: true, run, killed: result.killed, cleaned: result.cleaned }
      } else {
        await orchestrator.stopRun(runId)
        const run = db.getWorkflowRun(runId)
        return { success: true, run }
      }
    },
  })

  orchestrator = new PiOrchestrator(
    db,
    (message) => server.broadcast(message),
    (sessionId) => `/#session/${encodeURIComponent(sessionId)}`,
    projectRoot,
    options.settings,
    (() => {
      // Container mode is the default - only skip when explicitly disabled
      if (options.settings?.workflow?.container?.enabled === false) return undefined
      const containerSettings = options.settings?.workflow?.container ?? {
        image: "pi-agent:alpine",
      }
      const containerManager = new PiContainerManager(
        containerSettings.image,
        server.getImageManager() ?? undefined,
      )
      console.log("[server] PiContainerManager created for orchestrator (image:", containerSettings.image + ")")
      return containerManager
    })(),
  )

  return { db, server, orchestrator }
}

export { PiKanbanServer }
