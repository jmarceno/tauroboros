import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { Context, Effect, Layer } from "effect"
import type { InfrastructureSettings } from "./config/settings.ts"
import { PiKanbanDB } from "./db.ts"
import { PiKanbanServer } from "./server/server.ts"
import {
  PiOrchestrator,
  runOrchestratorOperationPromise,
  runOrchestratorOperationSync,
} from "./orchestrator.ts"
import { PiContainerManager } from "./runtime/container-manager.ts"
import { BASE_IMAGES } from "./config/base-images.ts"

export interface CreateServerOptions {
  dbPath?: string
  port?: number
  settings?: InfrastructureSettings
}

export interface PiServerRuntime {
  db: PiKanbanDB
  server: PiKanbanServer
  orchestrator: PiOrchestrator
}

export const ProjectRootContext = Context.GenericTag<string>("ProjectRootContext")
export const CreateServerOptionsContext = Context.GenericTag<CreateServerOptions>("CreateServerOptionsContext")
export const PiServerRuntimeContext = Context.GenericTag<PiServerRuntime>("PiServerRuntimeContext")

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
  const runtimeLayer = PiServerRuntimeLayer.pipe(
    Layer.provideMerge(ProjectRootLayer),
    Layer.provideMerge(CreateServerOptionsLayer(options)),
  )

  return Effect.runSync(
    Effect.gen(function* () {
      return yield* PiServerRuntimeContext
    }).pipe(Effect.provide(runtimeLayer)),
  )
}

export const makePiServerRuntime = Effect.fn("makePiServerRuntime")(
  function* (projectRoot: string, options: CreateServerOptions) {
    // Use explicit dbPath, or find project root for consistent location
  const defaultDbPath = resolve(projectRoot, ".pi", "tauroboros", "tasks.db")
  const dbPath = options.dbPath ?? defaultDbPath
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new PiKanbanDB(dbPath)
  let orchestrator: PiOrchestrator | null = null

  const server = new PiKanbanServer(db, {
    port: options.port,
    settings: options.settings,
    projectRoot: projectRoot,
    onStart: async () => await runOrchestratorOperationPromise(orchestrator, "startAll", (instance) => instance.startAll()),
    onStartSingle: async (taskId: string) => await runOrchestratorOperationPromise(orchestrator, "startSingle", (instance) => instance.startSingle(taskId)),
    onStartGroup: async (groupId: string) => await runOrchestratorOperationPromise(orchestrator, "startGroup", (instance) => instance.startGroup(groupId)),
    onStop: async () => {
      await runOrchestratorOperationPromise(orchestrator, "stop", (instance) => instance.stop())
      return { ok: true }
    },
    onPauseRun: async (runId: string) => {
      const success = await runOrchestratorOperationPromise(orchestrator, "pauseRun", (instance) => instance.pauseRun(runId))
      const run = db.getWorkflowRun(runId)
      return { success, run }
    },
    onResumeRun: async (runId: string) => await runOrchestratorOperationPromise(orchestrator, "resumeRun", (instance) => instance.resumeRun(runId)),
    onStopRun: async (runId: string, options?: { destructive?: boolean }) => {
      if (options?.destructive) {
        const result = await runOrchestratorOperationPromise(orchestrator, "destructiveStop", (instance) => instance.destructiveStop(runId))
        const run = db.getWorkflowRun(runId)!
        return { success: true, run, killed: result.killed, cleaned: result.cleaned }
      }

      await runOrchestratorOperationPromise(orchestrator, "stopRun", (instance) => instance.stopRun(runId))
      const run = db.getWorkflowRun(runId)!
      return { success: true, run }
    },
    onGetSlots: () => {
      if (!orchestrator) {
        const maxSlots = Math.max(1, db.getOptions().parallelTasks ?? 1)
        return {
          maxSlots,
          usedSlots: 0,
          availableSlots: maxSlots,
          tasks: [],
        }
      }
      return runOrchestratorOperationSync(orchestrator, "getSlotUtilization", (instance) => instance.getSlotUtilization())
    },
    onGetRunQueueStatus: async (runId: string) => await runOrchestratorOperationPromise(orchestrator, "getRunQueueStatus", (instance) => instance.getRunQueueStatus(runId)),
    onManualSelfHealRecover: async (taskId: string, reportId: string, action: "restart_task" | "keep_failed") =>
      await runOrchestratorOperationPromise(orchestrator, "manualSelfHealRecover", (instance) => instance.manualSelfHealRecover(taskId, reportId, action)),
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
        image: BASE_IMAGES.piAgent,
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
  },
)

export const findProjectRootEffect = Effect.fn("findProjectRootEffect")(
  function* () {
    return findProjectRoot()
  },
)

export const ProjectRootLayer = Layer.effect(
  ProjectRootContext,
  findProjectRootEffect(),
)

export const CreateServerOptionsLayer = (options: CreateServerOptions = {}) =>
  Layer.succeed(CreateServerOptionsContext, options)

export const PiServerRuntimeLayer = Layer.effect(
  PiServerRuntimeContext,
  Effect.gen(function* () {
    const projectRoot = yield* ProjectRootContext
    const options = yield* CreateServerOptionsContext
    return yield* makePiServerRuntime(projectRoot, options)
  }),
)

export const createPiServerEffect = Effect.fn("createPiServerEffect")(
  function* (options: CreateServerOptions = {}) {
    const runtimeLayer = PiServerRuntimeLayer.pipe(
      Layer.provideMerge(ProjectRootLayer),
      Layer.provideMerge(CreateServerOptionsLayer(options)),
    )

    return yield* Effect.gen(function* () {
      return yield* PiServerRuntimeContext
    }).pipe(Effect.provide(runtimeLayer))
  },
)

export { PiKanbanServer }
