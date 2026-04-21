import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { Context, Effect, Layer } from "effect"
import type { InfrastructureSettings } from "./config/settings.ts"
import type { WSMessage } from "./types.ts"
import { PiKanbanDB } from "./db.ts"
import { PiKanbanServer } from "./server/server.ts"
import { WebSocketHub } from "./server/websocket.ts"
import { PiOrchestrator, OrchestratorOperationError } from "./orchestrator.ts"
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

interface RuntimeManagers {
  smartRepair: SmartRepairService
  planningSessionManager: PlanningSessionManager
  imageManager?: ContainerImageManager
  containerManager?: PiContainerManager
}

function wrapOrchestratorSync<A>(operation: string, run: () => A): Effect.Effect<A, OrchestratorOperationError> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof OrchestratorOperationError
        ? cause
        : new OrchestratorOperationError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  })
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

function resolveContainerSettings(projectRoot: string, options: CreateServerOptions): {
  imageManager?: ContainerImageManager
  containerManager?: PiContainerManager
} {
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

  return { imageManager, containerManager }
}

function buildPiServerRuntime(
  projectRoot: string,
  options: CreateServerOptions,
  db: PiKanbanDB,
  wsHub: WebSocketHub,
  managers: RuntimeManagers,
): PiServerRuntime {
  const { smartRepair, planningSessionManager, imageManager, containerManager } = managers

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
    onStart: () => orchestrator.startAll(),
    onStartSingle: (taskId: string) => orchestrator.startSingle(taskId),
    onStartGroup: (groupId: string) => orchestrator.startGroup(groupId),
    onStop: () =>
      orchestrator.stop().pipe(
        Effect.as({ ok: true }),
      ),
    onPauseRun: (runId: string) =>
      orchestrator.pauseRun(runId).pipe(
        Effect.map((success) => {
          const run = db.getWorkflowRun(runId)
          return { success, run }
        }),
      ),
    onResumeRun: (runId: string) => orchestrator.resumeRun(runId),
    onStopRun: (runId: string, stopOptions?: { destructive?: boolean }) => Effect.gen(function* () {
      if (stopOptions?.destructive) {
        const result = yield* orchestrator.destructiveStop(runId)
        const run = db.getWorkflowRun(runId)!
        return { success: true, run, killed: result.killed, cleaned: result.cleaned }
      }

      yield* orchestrator.stopRun(runId)
      const run = db.getWorkflowRun(runId)!
      return { success: true, run }
    }),
    onGetSlots: () => wrapOrchestratorSync("getSlotUtilization", () => orchestrator.getSlotUtilization()),
    onGetRunQueueStatus: (runId: string) => wrapOrchestratorSync("getRunQueueStatus", () => orchestrator.getRunQueueStatus(runId)),
    onManualSelfHealRecover: (taskId: string, reportId: string, action: "restart_task" | "keep_failed") =>
      orchestrator.manualSelfHealRecover(taskId, reportId, action),
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
    const smartRepair = new SmartRepairService(db, options.settings)
    const { imageManager, containerManager } = resolveContainerSettings(projectRoot, options)
    const planningSessionManager = new PlanningSessionManager(db, containerManager, options.settings)

    return buildPiServerRuntime(projectRoot, options, db, wsHub, {
      smartRepair,
      planningSessionManager,
      imageManager,
      containerManager,
    })
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

    const smartRepair = new SmartRepairService(db, options.settings)
    const { imageManager: resolvedImageManager, containerManager: resolvedContainerManager } = resolveContainerSettings(projectRoot, options)

    const imageManager = resolvedImageManager
      ? yield* Effect.acquireRelease(
          Effect.succeed(resolvedImageManager),
          (manager) => Effect.promise(() => manager.close()),
        )
      : undefined

    const containerManager = resolvedContainerManager
      ? yield* Effect.acquireRelease(
          Effect.succeed(resolvedContainerManager),
          (manager) => Effect.promise(() => manager.close()),
        )
      : undefined

    const planningSessionManager = yield* Effect.acquireRelease(
      Effect.sync(() => new PlanningSessionManager(db, containerManager, options.settings)),
      (manager) => manager.closeAllSessions().pipe(Effect.orDie),
    )

    return yield* Effect.acquireRelease(
      Effect.sync(() => buildPiServerRuntime(projectRoot, options, db, wsHub, {
        smartRepair,
        planningSessionManager,
        imageManager,
        containerManager,
      })),
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
