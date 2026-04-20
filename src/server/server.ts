import { readFileSync, existsSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import type { InfrastructureSettings } from "../config/settings.ts"
import { BASE_IMAGES } from "../config/base-images.ts"
import { discoverPiModels } from "../pi/model-discovery.ts"
import type { ImageStatusPayload, RunQueueStatus, SlotUtilization, WorkflowRun, WSMessage } from "../types.ts"
import { PiKanbanDB } from "../db.ts"
import type { PackageDefinition } from "../db/types.ts"
import { Effect } from "effect"
import { runStartupRecoveryEffect } from "../recovery/startup-recovery.ts"
import { ContainerImageManager } from "../runtime/container-image-manager.ts"
import { PiContainerManager } from "../runtime/container-manager.ts"
import { SmartRepairService } from "../runtime/smart-repair.ts"
import { PlanningSessionManager } from "../runtime/planning-session.ts"
import { sendTelegramNotification, sendTelegramWorkflowSummary, shouldSendNotification, type NotificationContext } from "../telegram.ts"
import { Router } from "./router.ts"
import type { RequestContext, ServerRouteContext } from "./types.ts"
import { WebSocketHub } from "./websocket.ts"
import { readEmbeddedFile, embeddedFileExists, getContentType, getIndexHtml } from "./embedded-files.ts"
import { VERSION, COMMIT_HASH, DISPLAY_VERSION, IS_COMPILED } from "./version.ts"
import { isThinkingLevel } from "./validators.ts"
import { registerTaskRoutes } from "./routes/task-routes.ts"
import { registerExecutionRoutes } from "./routes/execution-routes.ts"
import { registerSessionRoutes } from "./routes/session-routes.ts"
import { registerPlanningRoutes } from "./routes/planning-routes.ts"
import { registerContainerRoutes } from "./routes/container-routes.ts"
import { registerTaskGroupRoutes } from "./routes/task-group-routes.ts"
import { registerStatsRoutes } from "./routes/stats-routes.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Static file serving paths - SolidJS kanban
const KANBAN_DIST = join(__dirname, "..", "kanban-solid", "dist")
const KANBAN_INDEX = join(KANBAN_DIST, "index.html")

import type {
  RunControlFn,
  StartFn,
  StartSingleFn,
  StartGroupFn,
  StopFn,
  StopRunFn,
  GetSlotsFn,
  GetRunQueueStatusFn,
  ManualSelfHealRecoverFn,
} from "./types.ts"

export class PiKanbanServer {
  private readonly db: PiKanbanDB
  private readonly router = new Router()
  private readonly wsHub = new WebSocketHub()
  private server: Bun.Server<unknown> | null = null
  private readonly onStart: StartFn
  private readonly onStartSingle: StartSingleFn
  private readonly onStartGroup: StartGroupFn | null
  private readonly onStop: StopFn
  private readonly onPauseRun: RunControlFn | null
  private readonly onResumeRun: RunControlFn | null
  private readonly onStopRun: StopRunFn | null
  private readonly onGetSlots: GetSlotsFn | null
  private readonly onGetRunQueueStatus: GetRunQueueStatusFn | null
  private readonly onManualSelfHealRecover: ManualSelfHealRecoverFn | null
  private readonly defaultPort: number
  private readonly smartRepair: SmartRepairService
  private readonly imageManager?: ContainerImageManager
  private readonly containerManager?: PiContainerManager
  private readonly settings?: InfrastructureSettings
  private readonly projectRoot: string
  private readonly planningSessionManager: PlanningSessionManager
  private _currentRunId: string | null = null

  getImageManager(): ContainerImageManager | null {
    return this.imageManager ?? null
  }

  /**
   * Get the current server port
   */
  getPort(): number {
    return this.server?.port ?? this.defaultPort
  }

  /**
   * Get the path to container profiles JSON file
   * Uses extracted config in .tauroboros/config/ if available, falls back to src/config/
   */
  private getContainerProfilesPath(): string {
    // First check extracted location (binary or source mode)
    const extractedPath = join(this.projectRoot, ".tauroboros", "config", "container-profiles.json")
    if (existsSync(extractedPath)) {
      return extractedPath
    }

    // Fallback to source location (development mode)
    return join(__dirname, "..", "config", "container-profiles.json")
  }

  /**
   * Get the path to the base Dockerfile
   * Uses extracted docker files in .tauroboros/docker/ if available, falls back to docker/
   */
  private getDockerfilePath(subpath: string = "pi-agent/Dockerfile"): string {
    // First check extracted location (binary or source mode)
    const extractedPath = join(this.projectRoot, ".tauroboros", "docker", subpath)
    if (existsSync(extractedPath)) {
      return extractedPath
    }

    // Fallback to source location (development mode)
    return join(this.projectRoot, "docker", subpath)
  }

  constructor(
    db: PiKanbanDB,
    opts: {
      port?: number
      onStart?: StartFn
      onStartSingle?: StartSingleFn
      onStartGroup?: StartGroupFn
      onStop?: StopFn
      onPauseRun?: RunControlFn
      onResumeRun?: RunControlFn
      onStopRun?: StopRunFn  // Unified stop with destructive option
      onGetSlots?: GetSlotsFn
      onGetRunQueueStatus?: GetRunQueueStatusFn
      onManualSelfHealRecover?: ManualSelfHealRecoverFn
      settings?: InfrastructureSettings
      projectRoot?: string
    } = {},
  ) {
    this.db = db
    this.settings = opts.settings
    this.projectRoot = opts.projectRoot ?? process.cwd()
    this.defaultPort = opts.port ?? this.db.getOptions().port
    this.smartRepair = new SmartRepairService(this.db, opts.settings)
    this.onStart = opts.onStart ?? (async () => null)
    this.onStartSingle = opts.onStartSingle ?? (async () => null)
    this.onStartGroup = opts.onStartGroup ?? null
    this.onStop = opts.onStop ?? (async () => null)
    this.onPauseRun = opts.onPauseRun ?? null
    this.onResumeRun = opts.onResumeRun ?? null
    this.onStopRun = opts.onStopRun ?? null
    this.onGetSlots = opts.onGetSlots ?? null
    this.onGetRunQueueStatus = opts.onGetRunQueueStatus ?? null
    this.onManualSelfHealRecover = opts.onManualSelfHealRecover ?? null

    // Container mode is the default - only disabled when explicitly set to false
    if (opts.settings?.workflow?.container?.enabled !== false) {
      console.log("[container] Container mode enabled (default) - initializing image manager...")
      const containerSettings = opts.settings?.workflow?.container ?? {
        image: BASE_IMAGES.piAgent,
        imageSource: "dockerfile" as const,
        dockerfilePath: "docker/pi-agent/Dockerfile",
        registryUrl: null,
      }
      this.imageManager = new ContainerImageManager({
        imageName: containerSettings.image,
        imageSource: containerSettings.imageSource,
        dockerfilePath: containerSettings.dockerfilePath,
        registryUrl: containerSettings.registryUrl,
        cacheDir: join(this.projectRoot, ".tauroboros"),
        projectRoot: this.projectRoot,
        onStatusChange: (event) => {
          const payload: ImageStatusPayload = {
            status: event.status,
            message: event.message,
            progress: event.progress,
            errorMessage: event.errorMessage,
          }
          this.broadcast({ type: "image_status", payload })
        },
      })
      console.log("[container] Image manager initialized successfully")

      // Initialize container manager for image operations
      this.containerManager = new PiContainerManager(
        containerSettings.image,
        this.imageManager,
      )
      console.log("[container] Container manager initialized successfully")
    } else {
      console.log("[container] Container mode explicitly disabled - running in native mode. Tasks will execute directly on the host without container isolation.")
    }

    this.planningSessionManager = new PlanningSessionManager(this.db, undefined, opts.settings)

    // Register Telegram notification listener for task status changes
    this.db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = this.db.getTask(taskId)
      if (!task) return
      const options = this.db.getOptions()
      if (!options.telegramBotToken || !options.telegramChatId) return

      // Check if notification should be sent based on notification level
      const context: NotificationContext = {
        isWorkflowDone: this.db.hasRunningWorkflows(),
      }
      
      // Validate status values before passing to shouldSendNotification
      const validStatuses = ["template", "backlog", "queued", "executing", "review", "code-style", "done", "failed", "stuck"] as const
      if (!validStatuses.includes(oldStatus as typeof validStatuses[number]) || 
          !validStatuses.includes(newStatus as typeof validStatuses[number])) {
        return
      }
      
      if (!shouldSendNotification(
        options.telegramNotificationLevel, 
        oldStatus as typeof validStatuses[number], 
        newStatus as typeof validStatuses[number], 
        context
      )) {
        return
      }

      sendTelegramNotification(
        { botToken: options.telegramBotToken, chatId: options.telegramChatId },
        task.name,
        oldStatus,
        newStatus,
        (msg: string) => console.debug(msg)
      ).catch((err: unknown) => {
        console.error("[telegram] notification failed:", err)
      })
    })

    this.registerRoutes()
  }

  private withCors(response: Response): Response {
    const headers = new Headers(response.headers)
    headers.set("Access-Control-Allow-Origin", "*")
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
    headers.set("Access-Control-Allow-Headers", "Content-Type")
    return new Response(response.body, { status: response.status, headers })
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
  }

  private text(data: string, status = 200): Response {
    return new Response(data, { status, headers: { "Content-Type": "text/plain" } })
  }

  private sessionUrlFor(sessionId: string): string {
    return `/#session/${encodeURIComponent(sessionId)}`
  }

  private baseContext(req: Request): Omit<RequestContext, "params"> {
    const url = new URL(req.url)
    return {
      req,
      url,
      db: this.db,
      json: (data, status = 200) => this.json(data, status),
      text: (data, status = 200) => this.text(data, status),
      broadcast: (message) => this.broadcast(message),
      sessionUrlFor: (sessionId) => this.sessionUrlFor(sessionId),
    }
  }

  broadcast(message: WSMessage): void {
    this.wsHub.broadcast(message)

    // Track workflow start/completion for notification context
    if (message.type === "execution_started") {
      const payload = message.payload as { runId?: unknown } | null
      this._currentRunId = payload && typeof payload.runId === "string" ? payload.runId : this._currentRunId
    } else if (message.type === "execution_queued") {
      const payload = message.payload as { runId?: unknown } | null
      if (payload && typeof payload.runId === "string") {
        this._currentRunId = payload.runId
      }
    } else if (message.type === "execution_complete") {
      const payload = message.payload as { runId?: unknown } | null
      const completedRunId = payload && typeof payload.runId === "string" ? payload.runId : this._currentRunId
      if (completedRunId) {
        const run = this.db.getWorkflowRun(completedRunId)
        if (run) {
          const options = this.db.getOptions()
          const notificationLevel = options.telegramNotificationLevel
          
          // Only send workflow summary for workflow_done_and_failures level
          if (notificationLevel === "workflow_done_and_failures" && options.telegramBotToken && options.telegramChatId) {
            // Count task outcomes in this workflow
            let completed = 0
            let failed = 0
            let stuck = 0
            
            for (const taskId of run.taskOrder ?? []) {
              const task = this.db.getTask(taskId)
              if (task) {
                if (task.status === "done") completed++
                else if (task.status === "failed") failed++
                else if (task.status === "stuck") stuck++
              }
            }
            
            sendTelegramWorkflowSummary(
              { botToken: options.telegramBotToken, chatId: options.telegramChatId },
              run.displayName || "Workflow",
              run.taskOrder?.length ?? 0,
              completed,
              failed,
              stuck,
              (msg: string) => console.debug(msg)
            ).catch((err: unknown) => {
              console.error("[telegram] workflow summary notification failed:", err)
            })
          }
        }
        if (this._currentRunId === completedRunId) {
          this._currentRunId = null
        }
      }
    }
  }

  async start(port = this.defaultPort): Promise<number> {
    if (this.server) return this.server.port ?? this.defaultPort

    // Prepare container image if autoPrepare is enabled
    // CRITICAL: If container mode is enabled, image preparation MUST succeed
    if (this.imageManager && this.settings?.workflow?.container?.autoPrepare) {
      try {
        await this.imageManager.prepare()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error("[server] CRITICAL: Failed to prepare container image:", message)
        console.error("[server] Container mode is enabled but image preparation failed. Server cannot start.")
        throw new Error(
          `Container mode is enabled but image preparation failed: ${message}. ` +
            `Fix the issue or disable container mode in .tauroboros/settings.json`
        )
      }
    }

    // CRITICAL: Verify container runtime is available when container mode is enabled
    if (this.settings?.workflow?.container?.enabled !== false && this.containerManager) {
      const setupStatus = await this.containerManager.validateSetup()
      if (!setupStatus.podman) {
        console.error("[server] CRITICAL: Container mode is enabled but Podman is not available.")
        console.error("[server] Install Podman or explicitly disable container mode in .tauroboros/settings.json")
        throw new Error(
          "Container mode is enabled but Podman is not available. " +
            "Install Podman or set workflow.container.enabled to false in .tauroboros/settings.json"
        )
      }
      if (!setupStatus.image) {
        console.error("[server] CRITICAL: Container mode is enabled but container image is not available.")
        throw new Error(
          "Container mode is enabled but container image is not available. " +
            `Build it with: podman build -t ${this.settings?.workflow?.container?.image ?? BASE_IMAGES.piAgent} -f docker/pi-agent/Dockerfile .`
        )
      }
    }

    await Effect.runPromise(runStartupRecoveryEffect({
      db: this.db,
      broadcast: (message) => this.broadcast(message),
    }))

    this.server = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: async (req, server) => {
        const url = new URL(req.url)

        if (req.method === "OPTIONS") {
          return this.withCors(this.text("", 204))
        }

        if (url.pathname === "/ws") {
          if (server.upgrade(req, { data: undefined })) return undefined
          return this.withCors(this.text("Upgrade failed", 500))
        }

        try {
          const handled = await this.router.dispatch(req.method, url.pathname, this.baseContext(req))
          if (handled) return this.withCors(handled)
          return this.withCors(this.json({ error: "Not found" }, 404))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return this.withCors(this.json({ error: message }, 500))
        }
      },
      websocket: {
        open: (ws) => this.wsHub.addClient(ws),
        close: (ws) => this.wsHub.removeClient(ws),
        message: () => {},
      },
    })

    return this.server.port ?? this.defaultPort
  }

  stop(): void {
    this.server?.stop()
    this.server = null
  }

  private registerRoutes(): void {
    const ctx: ServerRouteContext = {
      settings: this.settings,
      projectRoot: this.projectRoot,
      onStart: this.onStart,
      onStartSingle: this.onStartSingle,
      onStartGroup: this.onStartGroup,
      onStop: this.onStop,
      onPauseRun: this.onPauseRun,
      onResumeRun: this.onResumeRun,
      onStopRun: this.onStopRun,
      onGetSlots: this.onGetSlots,
      onGetRunQueueStatus: this.onGetRunQueueStatus,
      onManualSelfHealRecover: this.onManualSelfHealRecover,
      imageManager: this.imageManager,
      containerManager: this.containerManager,
      validateContainerImage: (tag) => this.validateContainerImage(tag),
      getContainerProfilesPath: () => this.getContainerProfilesPath(),
      getDockerfilePath: (subpath) => this.getDockerfilePath(subpath),
      getPodmanImages: () => this.getPodmanImages(),
      hashPackages: (packages) => this.hashPackages(packages),
      planningSessionManager: this.planningSessionManager,
      smartRepair: this.smartRepair,
      getPort: () => this.getPort(),
    }

    registerTaskRoutes(this.router, ctx)
    registerExecutionRoutes(this.router, ctx)
    registerSessionRoutes(this.router, ctx)
    registerPlanningRoutes(this.router, ctx)
    registerContainerRoutes(this.router, ctx)
    registerTaskGroupRoutes(this.router, ctx)
    registerStatsRoutes(this.router, ctx)

    this.router.get("/", async () => {
      const content = await getIndexHtml()
      if (content) {
        return new Response(content, { headers: { "Content-Type": "text/html" } })
      }
      return new Response("index.html not found", { status: 404 })
    })

    this.router.get("/assets/:file", async ({ params }) => {
      const filePath = join(KANBAN_DIST, "assets", params.file)
      if (!(await embeddedFileExists(filePath))) {
        return new Response("Not found", { status: 404 })
      }
      try {
        const content = await readEmbeddedFile(filePath)
        const contentType = getContentType(params.file)
        return new Response(content as unknown as BodyInit, { headers: { "Content-Type": contentType } })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return new Response(`Failed to read file: ${errorMessage}`, { status: 500 })
      }
    })

    this.router.get("/healthz", ({ json }) => json({ ok: true, wsClients: this.wsHub.size() }))

    this.router.get("/api/container/image-status", ({ json }) => {
      if (!this.imageManager) {
        return json({
          enabled: false,
          status: "not_present",
          message: "Container mode is not enabled",
        })
      }

      const cache = this.imageManager.getCache()
      return json({
        enabled: true,
        status: this.imageManager.getStatus(),
        imageName: this.settings?.workflow?.container?.image,
        ...cache,
      })
    })

    this.router.get("/api/options", ({ json, db }) => json(db.getOptions()))

    this.router.get("/api/version", ({ json }) =>
      json({
        version: VERSION,
        commit: COMMIT_HASH,
        displayVersion: DISPLAY_VERSION,
        isCompiled: IS_COMPILED,
      }),
    )

    this.router.put("/api/options", async ({ req, json, broadcast, db }) => {
      const body = await req.json()
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.planThinkingLevel !== undefined && !isThinkingLevel(body.planThinkingLevel)) {
        return json({ error: "Invalid planThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionThinkingLevel !== undefined && !isThinkingLevel(body.executionThinkingLevel)) {
        return json({ error: "Invalid executionThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.reviewThinkingLevel !== undefined && !isThinkingLevel(body.reviewThinkingLevel)) {
        return json({ error: "Invalid reviewThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.repairThinkingLevel !== undefined && !isThinkingLevel(body.repairThinkingLevel)) {
        return json({ error: "Invalid repairThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.maxJsonParseRetries !== undefined) {
        const retries = Number(body.maxJsonParseRetries)
        if (isNaN(retries) || retries < 1 || retries > 20) {
          return json({ error: "Invalid maxJsonParseRetries. Must be a number between 1 and 20" }, 400)
        }
      }
      const options = db.updateOptions(body)
      broadcast({ type: "options_updated", payload: options })
      return json(options)
    })

    this.router.get("/api/branches", ({ json }) => {
      try {
        const branchOutput = Bun.spawnSync({
          cmd: ["git", "branch", "--format=%(refname:short)"],
          stdout: "pipe",
          stderr: "pipe",
          cwd: this.projectRoot,
        })
        const currentOutput = Bun.spawnSync({
          cmd: ["git", "branch", "--show-current"],
          stdout: "pipe",
          stderr: "pipe",
          cwd: this.projectRoot,
        })
        if (branchOutput.exitCode !== 0 || currentOutput.exitCode !== 0) {
          return json({ branches: [], current: null, error: "Failed to list git branches" })
        }
        const branches = new TextDecoder()
          .decode(branchOutput.stdout)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
        const current = new TextDecoder().decode(currentOutput.stdout).trim() || null
        if (current && !branches.includes(current)) branches.unshift(current)
        return json({ branches, current })
      } catch (error) {
        return json({ branches: [], current: null, error: error instanceof Error ? error.message : String(error) })
      }
    })

    this.router.get("/api/models", async ({ json }) => {
      const catalog = await discoverPiModels({ maxRetries: 2 })
      return json(catalog)
    })
  }


  private async getPodmanImages(): Promise<Array<{ tag: string; createdAt: number; size: string }>> {
    const proc = Bun.spawn(["podman", "images", "--format", "json", "--filter", "reference=*pi-agent*"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited

    const images = JSON.parse(stdout) as Array<{
      Names?: string[]
      CreatedAt?: string
      Size?: string
    }>

    const result: Array<{ tag: string; createdAt: number; size: string }> = []

    for (const img of images) {
      if (!Array.isArray(img.Names)) {
        throw new Error(`Invalid podman image data: 'Names' must be an array, got ${typeof img.Names}`)
      }
      for (const tag of img.Names) {
        if (!img.CreatedAt) {
          throw new Error(`Invalid podman image data: 'CreatedAt' is required for image '${tag}'`)
        }
        if (!img.Size) {
          throw new Error(`Invalid podman image data: 'Size' is required for image '${tag}'`)
        }
        result.push({
          tag,
          createdAt: new Date(img.CreatedAt).getTime(),
          size: img.Size,
        })
      }
    }

    return result
  }

  private hashPackages(packages: PackageDefinition[]): string {
    const names = packages.map(p => p.name).sort().join(",")
    // Simple hash for packages
    let hash = 0
    for (let i = 0; i < names.length; i++) {
      const char = names.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16).slice(0, 8)
  }

  /**
   * Validate that a container image exists.
   * Checks both container_builds table and podman.
   * @throws Error if tag is empty/whitespace or if validation fails
   */
  private async validateContainerImage(tag: string): Promise<boolean> {
    if (!tag || tag.trim() === "") {
      throw new Error("Cannot validate container image: tag is empty or whitespace-only")
    }

    // Check container_builds table
    const builds = this.db.getContainerBuilds(100)
    const existsInBuilds = builds.some(b => b.imageTag === tag && b.status === "success")
    if (existsInBuilds) return true

    // Check podman if available
    try {
      const proc = Bun.spawn(["podman", "image", "exists", tag], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      return exitCode === 0
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to validate container image '${tag}' via podman: ${errorMessage}`)
    }
  }
}
