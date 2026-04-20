import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { Context, Effect, Layer } from "effect"
import type { InfrastructureSettings } from "./config/settings.ts"
import type { WSMessage } from "./types.ts"
import { PiKanbanDB } from "./db.ts"
import { PiKanbanServer } from "./server/server.ts"
import { WebSocketHub } from "./server/websocket.ts"
import {
  PiOrchestrator,
  runOrchestratorOperationPromiseEffect,
  runOrchestratorOperationSyncEffect,
} from "./orchestrator.ts"
import { PiContainerManager } from "./runtime/container-manager.ts"
import { ContainerImageManager } from "./runtime/container-image-manager.ts"
import { PlanningSessionManager } from "./runtime/planning-session.ts"
import { SmartRepairService } from "./runtime/smart-repair.ts"
import { BASE_IMAGES } from "./config/base-images.ts"

export interface CreateServerOptions {
  projectRoot?: string
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

export function findProjectRoot(): string {
  const cwd = process.cwd()
  if (existsSync(resolve(cwd, ".git")) || existsSync(resolve(cwd, ".pi"))) {
    return cwd
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  let currentDir = scriptDir

  while (currentDir !== dirname(currentDir)) {
    if (existsSync(resolve(currentDir, ".git")) || existsSync(resolve(currentDir, ".pi"))) {
      return currentDir
    }
    currentDir = dirname(currentDir)
  }

  return cwd
}

function buildPiServerRuntime(
  projectRoot: string,
  options: CreateServerOptions,
  db: PiKanbanDB,
  wsHub: WebSocketHub,
): PiServerRuntime {
  const smartRepair = new SmartRepairService(db, options.settings)
  const planningSessionManager = new PlanningSessionManager(db, undefined, options.settings)

  const containerSettings = options.settings?.workflow?.container ?? {
    image: BASE_IMAGES.piAgent,
    imageSource: "dockerfile" as const,
    dockerfilePath: "docker/pi-agent/Dockerfile",
    registryUrl: null,
  }

  const imageManager = options.settings?.workflow?.container?.enabled === false
    ? undefined
    : new ContainerImageManager({
        imageName: containerSettings.image,
        imageSource: containerSettings.imageSource,
        dockerfilePath: containerSettings.dockerfilePath,
        registryUrl: containerSettings.registryUrl,
        cacheDir: resolve(projectRoot, ".tauroboros"),
        projectRoot,
        onStatusChange: () => {},
      })

  const containerManager = options.settings?.workflow?.container?.enabled === false
    ? undefined
    : new PiContainerManager(containerSettings.image, imageManager)

  let server: PiKanbanServer | null = null
  const broadcast = (message: WSMessage): void => {
    server?.broadcast(message)
  }
  const sessionUrlFor = (sessionId: string): string => `/#session/${encodeURIComponent(sessionId)}`

  const orchestrator = new PiOrchestrator(
    db,
    broadcast,
    sessionUrlFor,
    projectRoot,
    options.settings,
    containerManager,
  )

  server = new PiKanbanServer(db, {
    port: options.port,
    settings: options.settings,
    projectRoot,
    smartRepair,
    planningSessionManager,
    imageManager,
    containerManager,
    wsHub,
    onStart: () => runOrchestratorOperationPromiseEffect(orchestrator, "startAll", (instance) => instance.startAll()),
    onStartSingle: (taskId: string) => runOrchestratorOperationPromiseEffect(orchestrator, "startSingle", (instance) => instance.startSingle(taskId)),
    onStartGroup: (groupId: string) => runOrchestratorOperationPromiseEffect(orchestrator, "startGroup", (instance) => instance.startGroup(groupId)),
    onStop: () =>
      runOrchestratorOperationPromiseEffect(orchestrator, "stop", (instance) => instance.stop()).pipe(
        Effect.as({ ok: true }),
      ),
    onPauseRun: (runId: string) =>
      runOrchestratorOperationPromiseEffect(orchestrator, "pauseRun", (instance) => instance.pauseRun(runId)).pipe(
        Effect.map((success) => {
          const run = db.getWorkflowRun(runId)
          return { success, run }
        }),
      ),
    onResumeRun: (runId: string) => runOrchestratorOperationPromiseEffect(orchestrator, "resumeRun", (instance) => instance.resumeRun(runId)),
    onStopRun: (runId: string, stopOptions?: { destructive?: boolean }) => Effect.gen(function* () {
      if (stopOptions?.destructive) {
        const result = yield* runOrchestratorOperationPromiseEffect(orchestrator, "destructiveStop", (instance) => instance.destructiveStop(runId))
        const run = db.getWorkflowRun(runId)!
        return { success: true, run, killed: result.killed, cleaned: result.cleaned }
      }

      yield* runOrchestratorOperationPromiseEffect(orchestrator, "stopRun", (instance) => instance.stopRun(runId))
      const run = db.getWorkflowRun(runId)!
      return { success: true, run }
    }),
    onGetSlots: () => runOrchestratorOperationSyncEffect(orchestrator, "getSlotUtilization", (instance) => instance.getSlotUtilization()),
    onGetRunQueueStatus: (runId: string) => runOrchestratorOperationSyncEffect(orchestrator, "getRunQueueStatus", (instance) => instance.getRunQueueStatus(runId)),
    onManualSelfHealRecover: (taskId: string, reportId: string, action: "restart_task" | "keep_failed") =>
      runOrchestratorOperationPromiseEffect(orchestrator, "manualSelfHealRecover", (instance) => instance.manualSelfHealRecover(taskId, reportId, action)),
  })

  return { db, server, orchestrator }
}

export const makePiServerRuntime = Effect.fn("makePiServerRuntime")(
  function* (projectRoot: string, options: CreateServerOptions) {
    const defaultDbPath = resolve(projectRoot, ".pi", "tauroboros", "tasks.db")
    const dbPath = options.dbPath ?? defaultDbPath
    mkdirSync(dirname(dbPath), { recursive: true })

    const db = new PiKanbanDB(dbPath)
    const wsHub = new WebSocketHub()
    return buildPiServerRuntime(projectRoot, options, db, wsHub)
  },
)

const makeScopedPiServerRuntime = Effect.fn("makeScopedPiServerRuntime")(
  function* (projectRoot: string, options: CreateServerOptions) {
    const defaultDbPath = resolve(projectRoot, ".pi", "tauroboros", "tasks.db")
    const dbPath = options.dbPath ?? defaultDbPath

    const db = yield* Effect.acquireRelease(
      Effect.sync(() => {
        mkdirSync(dirname(dbPath), { recursive: true })
        return new PiKanbanDB(dbPath)
      }),
      (database) => Effect.sync(() => database.close()),
    )

    const wsHub = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocketHub()),
      (hub) => Effect.sync(() => hub.close()),
    )

    return yield* Effect.acquireRelease(
      Effect.sync(() => buildPiServerRuntime(projectRoot, options, db, wsHub)),
      (runtime) => Effect.sync(() => runtime.server.stop()),
    )
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
    const projectRootLayer = Layer.succeed(ProjectRootContext, options.projectRoot ?? findProjectRoot())
    const runtimeLayer = PiServerRuntimeLayer.pipe(
      Layer.provideMerge(projectRootLayer),
      Layer.provideMerge(CreateServerOptionsLayer(options)),
    )

    return yield* PiServerRuntimeContext.pipe(Effect.provide(runtimeLayer))
  },
)

export const createPiServerScopedEffect = Effect.fn("createPiServerScopedEffect")(
  function* (options: CreateServerOptions = {}) {
    const projectRoot = options.projectRoot ?? findProjectRoot()
    return yield* makeScopedPiServerRuntime(projectRoot, options)
  },
)

export { PiKanbanServer }
