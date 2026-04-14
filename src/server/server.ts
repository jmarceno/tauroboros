import { randomUUID } from "crypto"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import type { InfrastructureSettings } from "../config/settings.ts"
import { buildExecutionGraph, getExecutionGraphTasks } from "../execution-plan.ts"
import { discoverPiModels } from "../pi/model-discovery.ts"
import { isTaskAwaitingPlanApproval } from "../task-state.ts"
import type { BestOfNConfig, ImageStatusPayload, Task, TaskRun, ThinkingLevel, WSMessage, SessionMessage } from "../types.ts"
import { PiKanbanDB } from "../db.ts"
import type { SessionIORecordType, PackageDefinition } from "../db/types.ts"
import { runStartupRecovery } from "../recovery/startup-recovery.ts"
import { ContainerImageManager, loadContainerConfig, saveContainerConfig } from "../runtime/container-image-manager.ts"
import { SmartRepairService, type SmartRepairAction } from "../runtime/smart-repair.ts"
import { PlanningSessionManager, type ContextAttachment } from "../runtime/planning-session.ts"
import { sendTelegramNotification } from "../telegram.ts"
import { loadPausedRunState, loadPausedSessionState } from "../runtime/session-pause-state.ts"
import { Router } from "./router.ts"
import type { RequestContext } from "./types.ts"
import { WebSocketHub } from "./websocket.ts"
import { readEmbeddedFile, embeddedFileExists, getContentType, getIndexHtml } from "./embedded-files.ts"
import { VERSION, COMMIT_HASH, DISPLAY_VERSION, IS_COMPILED } from "./version.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Static file serving paths - Vue kanban only
const KANBAN_VUE_DIST = join(__dirname, "..", "kanban-vue", "dist")
const KANBAN_VUE_INDEX = join(KANBAN_VUE_DIST, "index.html")

const TASK_BOOLEAN_FIELDS = ["planmode", "autoApprovePlan", "review", "autoCommit", "deleteWorktree", "skipPermissionAsking"] as const

type RunControlFn = (runId: string) => Promise<any>
type StartFn = () => Promise<any>
type StartSingleFn = (taskId: string) => Promise<any>
type StopFn = () => Promise<any>
type StopRunFn = (runId: string, options?: { destructive?: boolean }) => Promise<{ success: boolean; run: WorkflowRun; killed?: number; cleaned?: number }>

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "default" || value === "low" || value === "medium" || value === "high"
}

function isExecutionStrategy(value: unknown): value is "standard" | "best_of_n" {
  return value === "standard" || value === "best_of_n"
}

function isSelectionMode(value: unknown): value is "pick_best" | "synthesize" | "pick_or_synthesize" {
  return value === "pick_best" || value === "synthesize" || value === "pick_or_synthesize"
}

interface BestOfNSlotInput {
  model?: unknown
  count?: unknown
  taskSuffix?: unknown
}

interface BestOfNFinalApplierInput {
  model?: unknown
  taskSuffix?: unknown
}

interface BestOfNConfigInput {
  workers?: unknown
  reviewers?: unknown
  finalApplier?: unknown
  selectionMode?: unknown
  minSuccessfulWorkers?: unknown
  verificationCommand?: unknown
}

function validateBestOfNConfig(config: unknown): { valid: boolean; error?: string } {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "bestOfNConfig must be an object" }
  }

  const cfg = config as BestOfNConfigInput
  if (!Array.isArray(cfg.workers) || cfg.workers.length === 0) {
    return { valid: false, error: "At least one worker slot is required" }
  }

  for (let i = 0; i < cfg.workers.length; i++) {
    const slot = cfg.workers[i] as BestOfNSlotInput
    if (!slot.model || typeof slot.model !== "string") return { valid: false, error: `Worker slot ${i + 1}: model is required` }
    if (typeof slot.count !== "number" || slot.count < 1) return { valid: false, error: `Worker slot ${i + 1}: count must be at least 1` }
  }

  if (!Array.isArray(cfg.reviewers)) return { valid: false, error: "Reviewers must be an array" }
  for (let i = 0; i < cfg.reviewers.length; i++) {
    const slot = cfg.reviewers[i] as BestOfNSlotInput
    if (!slot.model || typeof slot.model !== "string") return { valid: false, error: `Reviewer slot ${i + 1}: model is required` }
    if (typeof slot.count !== "number" || slot.count < 1) return { valid: false, error: `Reviewer slot ${i + 1}: count must be at least 1` }
  }

  const finalApplier = cfg.finalApplier as BestOfNFinalApplierInput | undefined
  if (!finalApplier || typeof finalApplier !== "object" || typeof finalApplier.model !== "string") {
    return { valid: false, error: "Final applier model is required" }
  }

  if (cfg.selectionMode && !isSelectionMode(cfg.selectionMode as string)) {
    return { valid: false, error: "selectionMode must be pick_best, synthesize, or pick_or_synthesize" }
  }

  const totalWorkers = cfg.workers.reduce((sum: number, slot: any) => sum + Number(slot.count || 0), 0)
  if (typeof cfg.minSuccessfulWorkers !== "number" || cfg.minSuccessfulWorkers < 1 || cfg.minSuccessfulWorkers > totalWorkers) {
    return { valid: false, error: "minSuccessfulWorkers must be between 1 and total worker count" }
  }

  return { valid: true }
}

function getInvalidTaskBooleanField(body: any): string | null {
  for (const field of TASK_BOOLEAN_FIELDS) {
    if (body?.[field] !== undefined && !isBoolean(body[field])) return field
  }
  return null
}

function normalizeTaskForClient(task: Task, sessionUrlFor: (sessionId: string) => string): Task {
  if (!task.sessionId) return task
  if (!task.sessionUrl || task.sessionUrl.includes("opencode") || !task.sessionUrl.includes("#session/")) {
    return { ...task, sessionUrl: sessionUrlFor(task.sessionId) }
  }
  return task
}

function normalizeTaskRunForClient(run: TaskRun, sessionUrlFor: (sessionId: string) => string): TaskRun {
  if (!run.sessionId) return run
  if (!run.sessionUrl || run.sessionUrl.includes("opencode") || !run.sessionUrl.includes("#session/")) {
    return { ...run, sessionUrl: sessionUrlFor(run.sessionId) }
  }
  return run
}

export class PiKanbanServer {
  private readonly db: PiKanbanDB
  private readonly router = new Router()
  private readonly wsHub = new WebSocketHub()
  private server: Bun.Server<unknown> | null = null
  private readonly onStart: StartFn
  private readonly onStartSingle: StartSingleFn
  private readonly onStop: StopFn
  private readonly onPauseRun: RunControlFn | null
  private readonly onResumeRun: RunControlFn | null
  private readonly onStopRun: StopRunFn | null
  private readonly defaultPort: number
  private readonly smartRepair: SmartRepairService
  private readonly imageManager?: ContainerImageManager
  private readonly settings?: InfrastructureSettings
  private readonly projectRoot: string
  private readonly planningSessionManager: PlanningSessionManager

  getImageManager(): ContainerImageManager | null {
    return this.imageManager ?? null
  }

  constructor(
    db: PiKanbanDB,
    opts: {
      port?: number
      onStart?: StartFn
      onStartSingle?: StartSingleFn
      onStop?: StopFn
      onPauseRun?: RunControlFn
      onResumeRun?: RunControlFn
      onStopRun?: StopRunFn  // Unified stop with destructive option
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
    this.onStop = opts.onStop ?? (async () => null)
    this.onPauseRun = opts.onPauseRun ?? null
    this.onResumeRun = opts.onResumeRun ?? null
    this.onStopRun = opts.onStopRun ?? null

    if (opts.settings?.workflow?.container?.enabled) {
      console.log("[container] Container mode enabled - initializing image manager...")
      const containerSettings = opts.settings.workflow.container
      this.imageManager = new ContainerImageManager({
        imageName: containerSettings.image,
        imageSource: containerSettings.imageSource,
        dockerfilePath: containerSettings.dockerfilePath,
        registryUrl: containerSettings.registryUrl,
          cacheDir: join(process.cwd(), ".pi", "tauroboros"),
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
    } else {
      console.log("[container] Container mode disabled - container features will be unavailable. To enable, set 'workflow.container.enabled' to true in .pi/settings.json and restart the server.")
    }

    this.planningSessionManager = new PlanningSessionManager(this.db, undefined, opts.settings)

    // Register Telegram notification listener for task status changes
    this.db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = this.db.getTask(taskId)
      if (!task) return
      const opts = this.db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
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
  }

  async start(port = this.defaultPort): Promise<number> {
    if (this.server) return this.server.port

    // Prepare container image if autoPrepare is enabled
    if (this.imageManager && this.settings?.workflow?.container?.autoPrepare) {
      try {
        await this.imageManager.prepare()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error("[server] Failed to prepare container image:", message)
        // Broadcast error but continue starting server
        this.broadcast({
          type: "image_status",
          payload: {
            status: "error",
            message: "Failed to prepare container image",
            errorMessage: message,
          },
        })
      }
    }

    await runStartupRecovery({
      db: this.db,
      broadcast: (message) => this.broadcast(message),
    })

    this.server = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: async (req, server) => {
        const url = new URL(req.url)

        if (req.method === "OPTIONS") {
          return this.withCors(this.text("", 204))
        }

        if (url.pathname === "/ws") {
          if (server.upgrade(req)) return undefined
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

    return this.server.port
  }

  stop(): void {
    this.server?.stop()
    this.server = null
  }

  private registerRoutes(): void {
    // Serve index.html for root and for any non-API route (SPA routing)
    // Uses embedded assets in compiled binary or filesystem in development
    this.router.get("/", async () => {
      const content = await getIndexHtml()
      if (content) {
        return new Response(content, { headers: { "Content-Type": "text/html" } })
      }
      return new Response("index.html not found", { status: 404 })
    })

    // Static file serving for kanban-vue assets
    // Using Bun.file() which works with both regular files and embedded files in compiled binaries
    this.router.get("/assets/:file", async ({ params }) => {
      const filePath = join(KANBAN_VUE_DIST, "assets", params.file)
      if (!(await embeddedFileExists(filePath))) {
        return new Response("Not found", { status: 404 })
      }
      try {
        const content = await readEmbeddedFile(filePath)
        const contentType = getContentType(params.file)
        return new Response(content, { headers: { "Content-Type": contentType } })
      } catch {
        return new Response("Failed to read file", { status: 500 })
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

    this.router.get("/api/tasks", ({ json, sessionUrlFor }) => {
      const tasks = this.db.getTasks().map((task) => normalizeTaskForClient(task, sessionUrlFor))
      return json(tasks)
    })

    this.router.post("/api/tasks", async ({ req, json, sessionUrlFor, broadcast }) => {
      const body = await req.json()
      const invalidBooleanField = getInvalidTaskBooleanField(body)
      if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.planThinkingLevel !== undefined && !isThinkingLevel(body.planThinkingLevel)) {
        return json({ error: "Invalid planThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionThinkingLevel !== undefined && !isThinkingLevel(body.executionThinkingLevel)) {
        return json({ error: "Invalid executionThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
        return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
      }
      if (body?.executionStrategy === "best_of_n") {
        const valid = validateBestOfNConfig(body.bestOfNConfig)
        if (!valid.valid) return json({ error: valid.error }, 400)
      }

      const task = this.db.createTask({
        id: randomUUID().slice(0, 8),
        name: String(body.name ?? "").trim(),
        prompt: String(body.prompt ?? ""),
        status: body.status ?? "backlog",
        branch: body.branch,
        planModel: body.planModel,
        executionModel: body.executionModel,
        planmode: body.planmode,
        autoApprovePlan: body.autoApprovePlan,
        review: body.review,
        autoCommit: body.autoCommit,
        deleteWorktree: body.deleteWorktree,
        requirements: Array.isArray(body.requirements) ? body.requirements : [],
        thinkingLevel: body.thinkingLevel,
        planThinkingLevel: body.planThinkingLevel,
        executionThinkingLevel: body.executionThinkingLevel,
        executionStrategy: body.executionStrategy,
        bestOfNConfig: body.bestOfNConfig,
        bestOfNSubstage: body.bestOfNSubstage,
        skipPermissionAsking: body.skipPermissionAsking,
      })

      const normalized = normalizeTaskForClient(task, sessionUrlFor)
      broadcast({ type: "task_created", payload: normalized })
      return json(normalized, 201)
    })

    // Create task and wait for completion (synchronous API for CI/CD integration)
    this.router.post("/api/tasks/create-and-wait", async ({ req, json, sessionUrlFor, broadcast }) => {
      const body = await req.json()
      const invalidBooleanField = getInvalidTaskBooleanField(body)
      if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.planThinkingLevel !== undefined && !isThinkingLevel(body.planThinkingLevel)) {
        return json({ error: "Invalid planThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionThinkingLevel !== undefined && !isThinkingLevel(body.executionThinkingLevel)) {
        return json({ error: "Invalid executionThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
        return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
      }
      if (body?.executionStrategy === "best_of_n") {
        const valid = validateBestOfNConfig(body.bestOfNConfig)
        if (!valid.valid) return json({ error: valid.error }, 400)
      }

      // Validate timeout (optional, default 30 minutes, max 2 hours)
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 1800000, 60000), 7200000)

      // Validate poll interval (optional, default 2 seconds, min 1s, max 30s)
      const pollIntervalMs = Math.min(Math.max(Number(body.pollIntervalMs) || 2000, 1000), 30000)

      // Create the task
      const task = this.db.createTask({
        id: randomUUID().slice(0, 8),
        name: String(body.name ?? "").trim(),
        prompt: String(body.prompt ?? ""),
        status: "backlog",
        branch: body.branch,
        planModel: body.planModel,
        executionModel: body.executionModel,
        planmode: body.planmode,
        autoApprovePlan: body.autoApprovePlan,
        review: body.review,
        autoCommit: body.autoCommit,
        deleteWorktree: body.deleteWorktree,
        requirements: Array.isArray(body.requirements) ? body.requirements : [],
        thinkingLevel: body.thinkingLevel,
        planThinkingLevel: body.planThinkingLevel,
        executionThinkingLevel: body.executionThinkingLevel,
        executionStrategy: body.executionStrategy,
        bestOfNConfig: body.bestOfNConfig,
        bestOfNSubstage: body.bestOfNSubstage,
        skipPermissionAsking: body.skipPermissionAsking,
      })

      const normalized = normalizeTaskForClient(task, sessionUrlFor)
      broadcast({ type: "task_created", payload: normalized })

      // Start the task execution
      const run = await this.onStartSingle(task.id)
      if (!run) {
        return json({ error: "Failed to start task execution" }, 500)
      }

      // Wait for completion by polling
      const startTime = Date.now()
      const terminalStatuses = ["done", "failed", "stuck"] as const

      return new Promise((resolve) => {
        const checkCompletion = () => {
          const currentTask = this.db.getTask(task.id)
          if (!currentTask) {
            resolve(json({ error: "Task was deleted during execution" }, 500))
            return
          }

          // Check if task reached a terminal state
          if (terminalStatuses.includes(currentTask.status as typeof terminalStatuses[number])) {
            const result = {
              task: normalizeTaskForClient(currentTask, sessionUrlFor),
              run: this.db.getWorkflowRun(run.id),
              completedAt: Date.now(),
              durationMs: Date.now() - startTime,
              status: currentTask.status,
            }
            resolve(json(result, 200))
            return
          }

          // Check timeout
          if (Date.now() - startTime >= timeoutMs) {
            // Attempt to stop the run
            this.onStopRun?.(run.id, { destructive: false }).catch((err: unknown) => {
              console.error(`[API /create-and-wait] Failed to stop run ${run.id} on timeout:`, err)
            })
            resolve(json({
              error: "Timeout waiting for task completion",
              task: normalizeTaskForClient(currentTask, sessionUrlFor),
              run: this.db.getWorkflowRun(run.id),
              timeoutMs,
              elapsedMs: Date.now() - startTime,
            }, 408))
            return
          }

          // Continue polling
          setTimeout(checkCompletion, pollIntervalMs)
        }

        // Start polling
        setTimeout(checkCompletion, pollIntervalMs)
      })
    })

    this.router.put("/api/tasks/reorder", async ({ req, json, broadcast }) => {
      const body = await req.json()
      if (!body?.id || typeof body.newIdx !== "number") return json({ error: "id and newIdx are required" }, 400)
      this.db.reorderTask(String(body.id), Number(body.newIdx))
      broadcast({ type: "task_reordered", payload: {} })
      return json({ ok: true })
    })

    this.router.delete("/api/tasks/done/all", ({ json, broadcast }) => {
      const doneTasks = this.db.getTasksByStatus("done")
      let archived = 0
      let deleted = 0

      for (const task of doneTasks) {
        if (this.db.hasTaskExecutionHistory(task.id)) {
          this.db.archiveTask(task.id)
          broadcast({ type: "task_archived", payload: { id: task.id } })
          archived++
        } else {
          this.db.hardDeleteTask(task.id)
          broadcast({ type: "task_deleted", payload: { id: task.id } })
          deleted++
        }
      }

      return json({ archived, deleted })
    })

    this.router.get("/api/tasks/:id", ({ params, json, sessionUrlFor }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      return json(normalizeTaskForClient(task, sessionUrlFor))
    })

    this.router.patch("/api/tasks/:id", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const existing = this.db.getTask(params.id)
      if (!existing) return json({ error: "Task not found" }, 404)

      const activeRun = this.db.getActiveWorkflowRunForTask(params.id)
      if (activeRun) {
        return json({ error: `Cannot modify task \"${existing.name}\" while it is executing in run ${activeRun.id}.` }, 409)
      }

      const body = await req.json()
      const invalidBooleanField = getInvalidTaskBooleanField(body)
      if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.planThinkingLevel !== undefined && !isThinkingLevel(body.planThinkingLevel)) {
        return json({ error: "Invalid planThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionThinkingLevel !== undefined && !isThinkingLevel(body.executionThinkingLevel)) {
        return json({ error: "Invalid executionThinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
        return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
      }
      if (body?.executionStrategy === "best_of_n" || (body?.bestOfNConfig && existing.executionStrategy === "best_of_n")) {
        const validation = validateBestOfNConfig(body.bestOfNConfig ?? existing.bestOfNConfig)
        if (!validation.valid) return json({ error: validation.error }, 400)
      }

      if (body?.status === "backlog" && body?.executionPhase === undefined) {
        body.executionPhase = "not_started"
        body.awaitingPlanApproval = false
      }
      if (body?.status === "backlog" && body?.bestOfNSubstage === undefined) {
        body.bestOfNSubstage = "idle"
      }

      const task = this.db.updateTask(params.id, body)
      if (!task) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(task, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json(normalized)
    })

    this.router.delete("/api/tasks/:id", ({ params, json, broadcast }) => {
      const existing = this.db.getTask(params.id)
      if (!existing) return json({ error: "Task not found" }, 404)

      const activeRun = this.db.getActiveWorkflowRunForTask(params.id)
      if (activeRun) {
        return json({ error: `Cannot modify task \"${existing.name}\" while it is executing in run ${activeRun.id}.` }, 409)
      }

      if (this.db.hasTaskExecutionHistory(params.id)) {
        this.db.archiveTask(params.id)
        broadcast({ type: "task_archived", payload: { id: params.id } })
        return json({ id: params.id, archived: true })
      }

      this.db.hardDeleteTask(params.id)
      broadcast({ type: "task_deleted", payload: { id: params.id } })
      return new Response(null, { status: 204 })
    })

    this.router.get("/api/options", ({ json }) => json(this.db.getOptions()))

    this.router.get("/api/version", ({ json }) => json({
      version: VERSION,
      commit: COMMIT_HASH,
      displayVersion: DISPLAY_VERSION,
      isCompiled: IS_COMPILED,
    }))

    this.router.put("/api/options", async ({ req, json, broadcast }) => {
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
      const options = this.db.updateOptions(body)
      broadcast({ type: "options_updated", payload: options })
      return json(options)
    })

    this.router.get("/api/branches", ({ json }) => {
      try {
        const branchOutput = Bun.spawnSync({ cmd: ["git", "branch", "--format=%(refname:short)"], stdout: "pipe", stderr: "pipe", cwd: this.projectRoot })
        const currentOutput = Bun.spawnSync({ cmd: ["git", "branch", "--show-current"], stdout: "pipe", stderr: "pipe", cwd: this.projectRoot })
        if (branchOutput.exitCode !== 0 || currentOutput.exitCode !== 0) {
          return json({ branches: [], current: null, error: "Failed to list git branches" })
        }
        const branches = new TextDecoder().decode(branchOutput.stdout).split("\n").map((line) => line.trim()).filter(Boolean)
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

    this.router.get("/api/runs", ({ json }) => json(this.db.getWorkflowRuns()))

    this.router.delete("/api/runs/:id", ({ params, json, broadcast }) => {
      const run = this.db.getWorkflowRun(params.id)
      if (!run || run.isArchived) return json({ error: "Run not found" }, 404)
      if (run.status === "running" || run.status === "stopping" || run.status === "paused") {
        return json({ error: "Only completed or failed workflow runs can be archived" }, 409)
      }

      const archivedRun = this.db.archiveWorkflowRun(params.id)
      if (!archivedRun) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_archived", payload: { id: params.id } })
      return json({ id: params.id, archived: true })
    })

    this.router.post("/api/start", async ({ json, broadcast }) => {
      const run = await this.onStart()
      return json(run)
    })

    this.router.post("/api/execution/start", async ({ json }) => {
      const run = await this.onStart()
      return json(run)
    })

    this.router.post("/api/stop", async ({ json, broadcast }) => {
      const result = await this.onStop()
      return json(result ?? { ok: true })
    })

    this.router.post("/api/execution/stop", async ({ json }) => {
      const result = await this.onStop()
      return json(result ?? { ok: true })
    })

    this.router.post("/api/execution/pause", async ({ json }) => {
      const active = this.db.getWorkflowRuns().find((run) => run.status === "running")
      if (!active) return json({ error: "No running workflow run" }, 404)
      const updated = this.db.updateWorkflowRun(active.id, {
        pauseRequested: true,
        status: "paused",
      })
      if (updated) this.broadcast({ type: "run_updated", payload: updated })
      return json(updated ?? { error: "Run not found" }, updated ? 200 : 404)
    })

    this.router.post("/api/tasks/:id/start", async ({ params, json, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)

      const run = await this.onStartSingle(params.id)
      return json(run)
    })

    this.router.post("/api/runs/:id/pause", async ({ params, json, broadcast }) => {
      try {
        if (this.onPauseRun) {
          const result = await this.onPauseRun(params.id)
          if (result && result.success) {
            broadcast({ type: "run_paused", payload: { runId: params.id } })
            return json({ success: true, run: result.run })
          }
        }
        // Fallback to just updating the database status
        const updated = this.db.updateWorkflowRun(params.id, { pauseRequested: true, status: "paused" })
        if (!updated) return json({ error: "Run not found" }, 404)
        broadcast({ type: "run_updated", payload: updated })
        broadcast({ type: "run_paused", payload: { runId: params.id } })
        return json({ success: true, run: updated })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: message }, 500)
      }
    })

    this.router.post("/api/runs/:id/resume", async ({ params, json, broadcast }) => {
      try {
        if (this.onResumeRun) {
          const run = await this.onResumeRun(params.id)
          if (run) {
            broadcast({ type: "run_resumed", payload: { runId: params.id } })
            return json({ success: true, run })
          }
        }
        // Fallback to just updating the database status
        const updated = this.db.updateWorkflowRun(params.id, { pauseRequested: false, status: "running" })
        if (!updated) return json({ error: "Run not found" }, 404)
        broadcast({ type: "run_updated", payload: updated })
        broadcast({ type: "run_resumed", payload: { runId: params.id } })
        return json({ success: true, run: updated })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: message }, 500)
      }
    })

    this.router.post("/api/runs/:id/stop", async ({ params, req, json, broadcast }) => {
      try {
        let body: Record<string, unknown>
        try {
          body = await req.json()
        } catch (err) {
          return json({ error: "Invalid JSON body" }, 400)
        }
        const destructive = body?.destructive === true

        if (!this.onStopRun) {
          return json({ error: "Stop handler not available" }, 503)
        }

        const result = await this.onStopRun(params.id, { destructive })
        
        // Ensure we always have a valid result
        if (!result || !result.run) {
          return json({ error: "Failed to stop run - no result from orchestrator" }, 500)
        }
        
        if (destructive) {
          broadcast({ type: "run_stopped", payload: { runId: params.id, destructive: true } })
        }
        return json(result)
      } catch (error) {
        console.error(`[API /runs/:id/stop] Error stopping run ${params.id}:`, error)
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: message }, 500)
      }
    })

    // Note: /api/runs/:id/force-stop is deprecated. Use /api/runs/:id/stop with { destructive: true } instead.
    this.router.post("/api/runs/:id/force-stop", async ({ params, json, broadcast }) => {
      try {
        // Call the unified onStopRun with destructive flag
        if (this.onStopRun) {
          const result = await this.onStopRun(params.id, { destructive: true })
          broadcast({ type: "run_stopped", payload: { runId: params.id, destructive: true } })
          return json(result)
        }
        return json({ error: "Force stop not available" }, 503)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: message }, 500)
      }
    })

    // Global paused state endpoint - returns whether any paused run exists
    this.router.get("/api/runs/paused-state", ({ json }) => {
      const pausedState = loadPausedRunState()
      return json({
        hasPausedRun: !!pausedState,
        state: pausedState,
      })
    })

    // Per-run paused state endpoint - returns paused sessions for a specific run
    this.router.get("/api/runs/:id/paused-state", ({ params, json }) => {
      const run = this.db.getWorkflowRun(params.id)
      if (!run) return json({ error: "Run not found" }, 404)

      // Collect paused states for all sessions in this run
      const pausedStates = []
      for (const taskId of run.taskOrder) {
        const task = this.db.getTask(taskId)
        if (task?.sessionId) {
          const state = loadPausedSessionState(this.db, task.sessionId)
          if (state) pausedStates.push(state)
        }
      }

      return json({
        runId: params.id,
        hasPausedSessions: pausedStates.length > 0,
        pausedSessions: pausedStates,
        runStatus: run.status,
      })
    })

    this.router.get("/api/execution-graph", ({ json }) => {
      // Use getExecutionGraphTasks to get ALL tasks that will run,
      // including those whose dependencies will be satisfied during this run
      const allExecutable = getExecutionGraphTasks(this.db.getTasks())
      if (allExecutable.length === 0) return json({ error: "No tasks in backlog" }, 400)

      const options = this.db.getOptions()
      // Pass the full task set to buildExecutionGraph
      const graph = buildExecutionGraph(this.db.getTasks(), options.parallelTasks)

      for (const node of graph.nodes) {
        const task = this.db.getTask(node.id)
        if (task?.executionStrategy === "best_of_n" && task.bestOfNConfig) {
          const cfg = task.bestOfNConfig as BestOfNConfig
          const workers = cfg.workers.reduce((sum, slot) => sum + slot.count, 0)
          const reviewers = cfg.reviewers.reduce((sum, slot) => sum + slot.count, 0)
          node.expandedWorkerRuns = workers
          node.expandedReviewerRuns = reviewers
          node.hasFinalApplier = true
          node.estimatedRunCount = workers + reviewers + 1
        } else {
          node.expandedWorkerRuns = 1
          node.expandedReviewerRuns = task?.review ? 1 : 0
          node.hasFinalApplier = false
          node.estimatedRunCount = 1 + (task?.review ? 1 : 0)
        }
      }

      graph.pendingApprovals = this.db.getTasks().filter((task) => isTaskAwaitingPlanApproval(task)).map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status,
        awaitingPlanApproval: task.awaitingPlanApproval,
        planRevisionCount: task.planRevisionCount,
      }))

      return json(graph)
    })

    this.router.get("/api/tasks/:id/runs", ({ params, json, sessionUrlFor }) => {
      if (!this.db.getTask(params.id)) return json({ error: "Task not found" }, 404)
      return json(this.db.getTaskRuns(params.id).map((run) => normalizeTaskRunForClient(run, sessionUrlFor)))
    })

    this.router.get("/api/tasks/:id/candidates", ({ params, json }) => {
      if (!this.db.getTask(params.id)) return json({ error: "Task not found" }, 404)
      return json(this.db.getTaskCandidates(params.id))
    })

    this.router.get("/api/tasks/:id/best-of-n-summary", ({ params, json }) => {
      try {
        const task = this.db.getTask(params.id)
        if (!task) return json({ error: "Task not found" }, 404)
        if (task.executionStrategy !== "best_of_n") {
          return json({ error: "Task is not a best_of_n task" }, 400)
        }

        const summary = this.db.getBestOfNSummary(params.id)
        const candidates = this.db.getTaskCandidates(params.id)
        const expandedWorkerCount = task.bestOfNConfig
          ? task.bestOfNConfig.workers.reduce((sum, slot) => sum + slot.count, 0)
          : 0
        const expandedReviewerCount = task.bestOfNConfig
          ? task.bestOfNConfig.reviewers.reduce((sum, slot) => sum + slot.count, 0)
          : 0

        return json({
          taskId: params.id,
          substage: task.bestOfNSubstage,
          workersTotal: summary.workersTotal,
          workersDone: summary.workersDone + summary.workersFailed,
          workersFailed: summary.workersFailed,
          reviewersTotal: summary.reviewersTotal,
          reviewersDone: summary.reviewersDone + summary.reviewersFailed,
          reviewersFailed: summary.reviewersFailed,
          hasFinalApplier: summary.finalApplierStatus !== "not_started",
          finalApplierDone: summary.finalApplierStatus === "done",
          finalApplierStatus: summary.finalApplierStatus,
          expandedWorkerCount,
          expandedReviewerCount,
          totalExpandedRuns: expandedWorkerCount + expandedReviewerCount + 1,
          successfulCandidateCount: candidates.length,
          selectedCandidate: candidates.find((candidate) => candidate.status === "selected")?.id ?? null,
          availableCandidates: summary.availableCandidates,
          selectedCandidates: summary.selectedCandidates,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[API /best-of-n-summary] Error getting summary for task ${params.id}:`, message)
        return json({ error: "Task not found" }, 404)
      }
    })

    this.router.post("/api/tasks/:id/best-of-n/select-candidate", async ({ params, req, json, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (task.executionStrategy !== "best_of_n") return json({ error: "Task is not a best_of_n task" }, 400)

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch (err) {
        return json({ error: "Invalid JSON body" }, 400)
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : ""
      if (!candidateId) return json({ error: "candidateId is required" }, 400)

      const candidates = this.db.getTaskCandidates(task.id)
      if (!candidates.some((candidate) => candidate.id === candidateId)) {
        return json({ error: "Candidate not found" }, 404)
      }

      const updatedCandidates = candidates
        .map((candidate) => this.db.updateTaskCandidate(candidate.id, { status: candidate.id === candidateId ? "selected" : "rejected" }))
        .filter(Boolean)

      for (const candidate of updatedCandidates) {
        broadcast({ type: "task_candidate_updated", payload: candidate })
      }

      return json({ ok: true, selectedCandidate: candidateId })
    })

    this.router.post("/api/tasks/:id/best-of-n/abort", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (task.executionStrategy !== "best_of_n") return json({ error: "Task is not a best_of_n task" }, 400)

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch (err) {
        return json({ error: "Invalid JSON body" }, 400)
      }
      const reason = typeof body?.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "Best-of-n execution aborted manually"

      const updated = this.db.updateTask(task.id, {
        status: "review",
        bestOfNSubstage: "blocked_for_manual_review",
        errorMessage: reason,
      })
      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json({ ok: true, task: normalized })
    })

    this.router.get("/api/tasks/:id/review-status", ({ params, json }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      const options = this.db.getOptions()
      return json({
        taskId: task.id,
        reviewCount: task.reviewCount,
        maxReviewRuns: options.maxReviews,
        maxReviewRunsOverride: task.maxReviewRunsOverride,
      })
    })

    this.router.post("/api/tasks/:id/approve-plan", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (!task.planmode) return json({ error: "Task is not in plan mode" }, 400)
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch (err) {
        return json({ error: "Invalid JSON body" }, 400)
      }

      const updated = this.db.updateTask(task.id, {
        status: "backlog",
        awaitingPlanApproval: false,
        executionPhase: "implementation_pending",
        errorMessage: null,
        ...(typeof body?.approvalNote === "string" && body.approvalNote.trim().length > 0
          ? { agentOutput: `${task.agentOutput}\n[user-approval-note]\n${body.approvalNote.trim()}\n` }
          : typeof body?.message === "string" && body.message.trim().length > 0
            ? { agentOutput: `${task.agentOutput}\n[user-approval-note]\n${body.message.trim()}\n` }
          : {}),
      })

      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json(normalized)
    })

    this.router.post("/api/tasks/:id/request-plan-revision", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (!task.planmode) return json({ error: "Task is not in plan mode" }, 400)
      const body = await req.json()
      if (typeof body?.feedback !== "string" || !body.feedback.trim()) {
        return json({ error: "feedback is required" }, 400)
      }

      const updated = this.db.updateTask(task.id, {
        status: "backlog",
        awaitingPlanApproval: false,
        executionPhase: "plan_revision_pending",
        planRevisionCount: (task.planRevisionCount ?? 0) + 1,
        agentOutput: `${task.agentOutput}\n[user-revision-request]\n${body.feedback.trim()}\n`,
      })

      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      broadcast({ type: "plan_revision_requested", payload: { taskId: task.id } })
      const run = await this.onStartSingle(task.id).catch(() => null)
      return json({ task: normalized, run })
    })

    this.router.post("/api/tasks/:id/request-revision", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (!task.planmode) return json({ error: "Task is not in plan mode" }, 400)
      const body = await req.json()
      if (typeof body?.feedback !== "string" || !body.feedback.trim()) {
        return json({ error: "feedback is required" }, 400)
      }

      const updated = this.db.updateTask(task.id, {
        status: "backlog",
        awaitingPlanApproval: false,
        executionPhase: "plan_revision_pending",
        planRevisionCount: (task.planRevisionCount ?? 0) + 1,
        agentOutput: `${task.agentOutput}\n[user-revision-request]\n${body.feedback.trim()}\n`,
      })

      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      broadcast({ type: "plan_revision_requested", payload: { taskId: task.id } })
      const run = await this.onStartSingle(task.id).catch(() => null)
      return json({ task: normalized, run })
    })

    this.router.post("/api/tasks/:id/reset", async ({ params, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)

      const reset = this.db.updateTask(task.id, {
        status: "backlog",
        reviewCount: 0,
        errorMessage: null,
        completedAt: null,
        sessionId: null,
        sessionUrl: null,
        worktreeDir: null,
        executionPhase: "not_started",
        awaitingPlanApproval: false,
        planRevisionCount: 0,
      })

      if (!reset) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(reset, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json(normalized)
    })

    this.router.post("/api/tasks/:id/repair-state", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch (err) {
        return json({ error: "Invalid JSON body" }, 400)
      }
      const requestedAction = typeof body?.action === "string" ? body.action : "smart"

      if (requestedAction === "smart") {
        const smart = await this.smartRepair.repair(task.id, typeof body?.smartRepairHints === "string" ? body.smartRepairHints : undefined)
        const normalizedSmart = normalizeTaskForClient(smart.task, sessionUrlFor)
        broadcast({ type: "task_updated", payload: normalizedSmart })
        return json({ ok: true, action: smart.action, reason: smart.reason, task: normalizedSmart })
      }

      const action = requestedAction as SmartRepairAction
      if (!["queue_implementation", "restore_plan_approval", "reset_backlog", "mark_done", "fail_task", "continue_with_more_reviews"].includes(action)) {
        return json({ error: `Unsupported repair action: ${requestedAction}` }, 400)
      }

      const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : "Manual repair action"

      const updated = this.smartRepair.applyAction(task.id, {
        action,
        reason,
        errorMessage: typeof body?.errorMessage === "string" && body.errorMessage.trim() ? body.errorMessage.trim() : undefined,
      })
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json({ ok: true, action, reason, task: normalized })
    })

    this.router.get("/api/sessions/:id", ({ params, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      return json(session)
    })

    this.router.get("/api/sessions/:id/messages", ({ params, url, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)

      const limit = Number(url.searchParams.get("limit") ?? 500)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      return json(this.db.getSessionMessages(params.id, { limit, offset }))
    })

    this.router.get("/api/sessions/:id/timeline", ({ params, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      return json(this.db.getSessionTimelineEntries(params.id))
    })

    this.router.get("/api/sessions/:id/usage", ({ params, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      return json(this.db.getSessionUsageRollup(params.id))
    })

    this.router.get("/api/sessions/:id/io", ({ params, url, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)

      const limit = Number(url.searchParams.get("limit") ?? 500)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      const recordType = url.searchParams.get("recordType") as SessionIORecordType | null
      return json(this.db.getSessionIO(params.id, { limit, offset, ...(recordType ? { recordType } : {}) }))
    })

    this.router.get("/api/tasks/:id/messages", ({ params, json }) => json(this.db.getSessionMessageViewsByTask(params.id)))
    this.router.get("/api/task-runs/:id/messages", ({ params, json }) => json(this.db.getSessionMessageViewsByTaskRun(params.id)))

    this.router.post("/api/pi/sessions/:id/events", async ({ params, req, json, broadcast }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)

      const body = await req.json()
      const eventType = String(body?.type ?? "")

      if (eventType === "start") {
        const updated = this.db.updateWorkflowSession(session.id, {
          status: "active",
          processPid: typeof body?.processPid === "number" ? body.processPid : session.processPid,
          piSessionId: typeof body?.piSessionId === "string" ? body.piSessionId : session.piSessionId,
          piSessionFile: typeof body?.piSessionFile === "string" ? body.piSessionFile : session.piSessionFile,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "lifecycle",
          payloadJson: { type: "session_started", ...body },
        })
        if (updated?.taskId) {
          this.db.updateTask(updated.taskId, {
            sessionId: updated.id,
            sessionUrl: this.sessionUrlFor(updated.id),
          })
        }
        broadcast({ type: "session_started", payload: updated ?? session })
        return json({ ok: true })
      }

      if (eventType === "message") {
        const message = this.db.createSessionMessage({
          sessionId: session.id,
          taskId: session.taskId,
          taskRunId: session.taskRunId,
          role: body?.role ?? "assistant",
          eventName: body?.eventName ?? body?.type ?? null,
          messageType: body?.messageType ?? "text",
          contentJson: body?.contentJson ?? { text: String(body?.text ?? "") },
          modelProvider: body?.modelProvider ?? null,
          modelId: body?.modelId ?? null,
          agentName: body?.agentName ?? null,
          rawEventJson: body,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "stdout",
          recordType: "rpc_event",
          payloadJson: body,
          payloadText: typeof body?.text === "string" ? body.text : null,
        })
        broadcast({ type: "session_message_created", payload: message })
        return json({ ok: true, message })
      }

      if (eventType === "status") {
        const updated = this.db.updateWorkflowSession(session.id, {
          status: body?.status ?? session.status,
          errorMessage: body?.errorMessage ?? session.errorMessage,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "lifecycle",
          payloadJson: { type: "session_status", ...body },
        })
        broadcast({ type: "session_status_changed", payload: updated ?? session })
        return json({ ok: true })
      }

      if (eventType === "complete") {
        const updated = this.db.updateWorkflowSession(session.id, {
          status: body?.status ?? "completed",
          finishedAt: Math.floor(Date.now() / 1000),
          exitCode: body?.exitCode ?? null,
          exitSignal: body?.exitSignal ?? null,
          errorMessage: body?.errorMessage ?? null,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "lifecycle",
          payloadJson: { type: "session_completed", ...body },
        })
        broadcast({ type: "session_completed", payload: updated ?? session })
        return json({ ok: true })
      }

      return json({ error: "Unsupported event type" }, 400)
    })

    // ---- Planning Chat Routes ----

    this.router.get("/api/planning/prompt", ({ json }) => {
      const prompt = this.db.getPlanningPrompt("default")
      if (!prompt) return json({ error: "Planning prompt not found" }, 404)
      return json(prompt)
    })

    this.router.get("/api/planning/prompts", ({ json }) => {
      return json(this.db.getAllPlanningPrompts())
    })

    this.router.put("/api/planning/prompt", async ({ req, json, broadcast }) => {
      const body = await req.json()
      const existing = this.db.getPlanningPrompt(body.key ?? "default")
      if (!existing) return json({ error: "Planning prompt not found" }, 404)

      const updated = this.db.updatePlanningPrompt(existing.id, {
        name: body.name,
        description: body.description,
        promptText: body.promptText,
        isActive: body.isActive,
      })

      broadcast({ type: "planning_prompt_updated", payload: updated })
      return json(updated)
    })

    this.router.get("/api/planning/prompt/:key/versions", ({ params, json }) => {
      return json(this.db.getPlanningPromptVersions(params.key))
    })

    this.router.get("/api/planning/sessions", ({ json }) => {
      const sessions = this.db.getPlanningSessions()
      return json(sessions.map((s) => ({ ...s, sessionUrl: this.sessionUrlFor(s.id) })))
    })

    this.router.get("/api/planning/sessions/active", ({ json }) => {
      const sessions = this.db.getActivePlanningSessions()
      return json(sessions.map((s) => ({ ...s, sessionUrl: this.sessionUrlFor(s.id) })))
    })

    this.router.post("/api/planning/sessions", async ({ req, json, broadcast }) => {
      const body = await req.json()
      const sessionKind = body.sessionKind ?? "planning"
      const promptKey = sessionKind === "container_config" ? "container_config" : "default"
      const planningPrompt = this.db.getPlanningPrompt(promptKey)
      if (!planningPrompt) {
        return json({ error: "Planning prompt not configured" }, 500)
      }

      try {
        const { session, planningSession } = await this.planningSessionManager.createSession({
          cwd: body.cwd ?? process.cwd(),
          systemPrompt: planningPrompt.promptText,
          model: body.model ?? "default",
          thinkingLevel: body.thinkingLevel ?? "default",
          sessionKind,
          onMessage: (message: SessionMessage) => {
            // Broadcast the message to all WebSocket clients
            broadcast({ type: "planning_session_message", payload: { sessionId: session.id, message } })
          },
          onStatusChange: (updatedSession) => {
            // Broadcast status changes
            const withUrl = { ...updatedSession, sessionUrl: this.sessionUrlFor(updatedSession.id) }
            broadcast({ type: "planning_session_updated", payload: withUrl })
          },
        })

        const withUrl = { ...session, sessionUrl: this.sessionUrlFor(session.id) }
        broadcast({ type: "planning_session_created", payload: withUrl })
        return json(withUrl, 201)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to create planning session: ${message}` }, 500)
      }
    })

    this.router.post("/api/planning/sessions/:id/messages", async ({ params, req, json, broadcast }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      const body = await req.json()
      const planningSession = this.planningSessionManager.getSession(params.id)
      
      if (!planningSession) {
        return json({ error: "Planning session not active" }, 400)
      }

      try {
        await planningSession.sendMessage({
          content: body.content,
          contextAttachments: body.contextAttachments as ContextAttachment[] | undefined,
        })

        return json({ ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to send message: ${message}` }, 500)
      }
    })

    this.router.post("/api/planning/sessions/:id/reconnect", async ({ params, req, json, broadcast }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      // Check if already active
      const existingSession = this.planningSessionManager.getSession(params.id)
      if (existingSession?.isActive()) {
        return json({ ...session, sessionUrl: this.sessionUrlFor(session.id) })
      }

      const body = await req.json()
      const planningPrompt = this.db.getPlanningPrompt("default")
      if (!planningPrompt) {
        return json({ error: "Planning prompt not configured" }, 500)
      }

      try {
        const result = await this.planningSessionManager.reconnectSession(params.id, {
          systemPrompt: planningPrompt.promptText,
          model: body.model ?? session.model ?? "default",
          thinkingLevel: body.thinkingLevel ?? session.thinkingLevel ?? "default",
          onMessage: (message: SessionMessage) => {
            broadcast({ type: "planning_session_message", payload: { sessionId: session.id, message } })
          },
          onStatusChange: (updatedSession) => {
            const withUrl = { ...updatedSession, sessionUrl: this.sessionUrlFor(updatedSession.id) }
            broadcast({ type: "planning_session_updated", payload: withUrl })
          },
        })

        if (!result) {
          return json({ error: "Failed to reconnect to session" }, 500)
        }

        const withUrl = { ...result.session, sessionUrl: this.sessionUrlFor(result.session.id) }
        broadcast({ type: "planning_session_updated", payload: withUrl })
        return json(withUrl)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to reconnect to session: ${message}` }, 500)
      }
    })

    this.router.post("/api/planning/sessions/:id/model", async ({ params, req, json, broadcast }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      const body = await req.json()
      
      // Validate thinking level if provided
      if (body.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      
      const planningSession = this.planningSessionManager.getSession(params.id)
      
      if (!planningSession || !planningSession.isActive()) {
        return json({ error: "Planning session not active" }, 400)
      }

      try {
        await planningSession.setModel(body.model)
        
        // Also update thinking level if provided
        if (body.thinkingLevel && body.thinkingLevel !== "default") {
          await planningSession.setThinkingLevel(body.thinkingLevel)
        }

        const updated = this.db.getWorkflowSession(params.id)
        const withUrl = updated ? { ...updated, sessionUrl: this.sessionUrlFor(updated.id) } : null
        if (withUrl) {
          broadcast({ type: "planning_session_updated", payload: withUrl })
        }
        return json({ ok: true, model: body.model, thinkingLevel: body.thinkingLevel })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to change model: ${message}` }, 500)
      }
    })

    this.router.post("/api/planning/sessions/:id/create-tasks", async ({ params, req, json, broadcast, sessionUrlFor }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      const body = await req.json()
      
      try {
        const messages = this.db.getSessionMessages(params.id, { limit: 1000, offset: 0 })
        
        const conversationHistory = messages
          .filter(m => m.messageType === "user_prompt" || m.messageType === "assistant_response")
          .map(m => ({
            role: m.role,
            content: m.contentJson?.text || "",
          }))

        const taskExtractionPrompt = `Based on the following planning conversation, extract actionable implementation tasks.

Conversation:
${conversationHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")}

Extract tasks and format them as JSON array with the following structure:
[
  {
    "name": "Short task name",
    "prompt": "Detailed implementation instructions",
    "status": "backlog",
    "requirements": ["dependency_task_name_if_any"]
  }
]

Respond ONLY with the JSON array, no other text.`

        // Use Pi to extract tasks from the conversation
        const planningSession = this.planningSessionManager.getSession(params.id)
        if (!planningSession) {
          return json({ error: "Planning session not active" }, 400)
        }

        // Send extraction request
        await planningSession.sendMessage({
          content: taskExtractionPrompt,
        })

        // The task extraction result will be available in the next assistant response
        // For now, return a placeholder response
        // In a real implementation, we'd wait for and parse the Pi response
        
        // If user provided tasks directly, use those
        const tasks = body.tasks as Array<{ name: string; prompt: string; status?: string; requirements?: string[] }> | undefined
        
        if (tasks && tasks.length > 0) {
          const createdTasks = []
          for (const taskData of tasks) {
            const task = this.db.createTask({
              id: randomUUID().slice(0, 8),
              name: taskData.name,
              prompt: taskData.prompt,
              status: (taskData.status as Task["status"]) || "backlog",
              requirements: taskData.requirements || [],
            })
            createdTasks.push(normalizeTaskForClient(task, sessionUrlFor))
            broadcast({ type: "task_created", payload: normalizeTaskForClient(task, sessionUrlFor) })
          }
          return json({ tasks: createdTasks, count: createdTasks.length })
        }

        return json({ message: "Task extraction request sent. The AI will analyze the conversation and suggest tasks in the next response." })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to create tasks: ${message}` }, 500)
      }
    })

    this.router.get("/api/planning/sessions/:id", ({ params, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)
      return json({ ...session, sessionUrl: this.sessionUrlFor(session.id) })
    })

    this.router.patch("/api/planning/sessions/:id", async ({ params, req, json, broadcast }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      const body = await req.json()
      const updated = this.db.updateWorkflowSession(params.id, {
        status: body.status,
        errorMessage: body.errorMessage,
      })

      const withUrl = { ...updated, sessionUrl: this.sessionUrlFor(updated.id) }
      broadcast({ type: "planning_session_updated", payload: withUrl })
      return json(withUrl)
    })

    this.router.post("/api/planning/sessions/:id/close", async ({ params, json, broadcast }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      await this.planningSessionManager.closeSession(params.id)

      const updated = this.db.updateWorkflowSession(params.id, {
        status: "completed",
        finishedAt: Math.floor(Date.now() / 1000),
      })

      broadcast({ type: "planning_session_closed", payload: { id: params.id } })
      return json(updated)
    })

    this.router.get("/api/planning/sessions/:id/messages", ({ params, url, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      const limit = Number(url.searchParams.get("limit") ?? 500)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      return json(this.db.getSessionMessages(params.id, { limit, offset }))
    })

    this.router.get("/api/planning/sessions/:id/timeline", ({ params, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      if (session.sessionKind !== "planning" && session.sessionKind !== "container_config") return json({ error: "Not a planning session" }, 400)

      return json(this.db.getSessionTimelineEntries(params.id))
    })

    // ---- End Planning Chat Routes ----

    // ---- Container Configuration Routes ----

    // Get all container profiles (preset configurations)
    this.router.get("/api/container/profiles", ({ json }) => {
      try {
        const profilesPath = join(__dirname, "..", "config", "container-profiles.json")
        if (!existsSync(profilesPath)) {
          return json({ profiles: [] })
        }
        const raw = readFileSync(profilesPath, "utf-8")
        const data = JSON.parse(raw)
        return json({ profiles: data.profiles || [] })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to load profiles: ${message}` }, 500)
      }
    })

    // Get container feature availability status
    this.router.get("/api/container/status", ({ json }) => {
      const enabled = this.settings?.workflow?.container?.enabled ?? false
      return json({
        enabled,
        available: !!this.imageManager,
        message: enabled
          ? (this.imageManager ? "Container mode active" : "Container mode enabled but image manager failed to initialize")
          : "Container mode is disabled. Edit .pi/settings.json and restart the server to enable.",
      })
    })

    // Get current container configuration
    this.router.get("/api/container/config", ({ json }) => {
      try {
        const config = loadContainerConfig(process.cwd())
        return json(config)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to load config: ${message}` }, 500)
      }
    })

    // Save container configuration
    this.router.put("/api/container/config", async ({ req, json, broadcast }) => {
      try {
        const body = await req.json()
        const config = {
          version: body.version ?? 1,
          baseImage: body.baseImage ?? "docker.io/alpine:3.19",
          customDockerfilePath: body.customDockerfilePath ?? ".pi/tauroboros/Dockerfile.custom",
          generatedDockerfilePath: body.generatedDockerfilePath ?? ".pi/tauroboros/Dockerfile.generated",
          packages: body.packages ?? [],
          lastBuild: body.lastBuild ?? null,
        }

        saveContainerConfig(process.cwd(), config)

        broadcast({ type: "container_config_updated", payload: config })
        return json(config)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to save config: ${message}` }, 500)
      }
    })

    // Get installed packages from database
    this.router.get("/api/container/packages", ({ json }) => {
      try {
        const packages = this.db.getContainerPackages()
        return json({ packages })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to get packages: ${message}` }, 500)
      }
    })

    // Add a package
    this.router.post("/api/container/packages", async ({ req, json, broadcast }) => {
      try {
        const body = await req.json()
        const pkg = {
          name: String(body.name ?? "").trim(),
          category: String(body.category ?? "tool"),
          versionConstraint: body.versionConstraint ? String(body.versionConstraint) : undefined,
          installOrder: Number(body.installOrder ?? 0),
          source: String(body.source ?? "manual"),
        }

        if (!pkg.name) {
          return json({ error: "Package name is required" }, 400)
        }

        const added = this.db.addContainerPackage(pkg)
        broadcast({ type: "container_package_added", payload: added })
        return json(added, 201)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to add package: ${message}` }, 500)
      }
    })

    // Remove a package
    this.router.delete("/api/container/packages/:name", ({ params, json, broadcast }) => {
      try {
        const name = decodeURIComponent(params.name)
        this.db.removeContainerPackage(name)
        broadcast({ type: "container_package_removed", payload: { name } })
        return json({ ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to remove package: ${message}` }, 500)
      }
    })

    // Validate packages (check if they exist in Alpine repos)
    this.router.post("/api/container/validate", async ({ req, json }) => {
      try {
        if (!this.imageManager) {
          return json({ error: "Container image manager not available" }, 503)
        }

        const body = await req.json()
        const packages = Array.isArray(body.packages) ? body.packages : []

        if (packages.length === 0) {
          return json({ valid: [], invalid: [], suggestions: {} })
        }

        const result = await this.imageManager.validatePackages(packages)
        return json(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Validation failed: ${message}` }, 500)
      }
    })

    // Get generated Dockerfile preview
    this.router.get("/api/container/dockerfile", ({ json }) => {
      try {
        // Create a temporary image manager to generate Dockerfile even when container mode is disabled
        const tempManager = this.imageManager ?? new ContainerImageManager({
          imageName: "pi-agent:custom",
          imageSource: "dockerfile",
          dockerfilePath: "docker/pi-agent/Dockerfile",
        cacheDir: join(process.cwd(), ".pi", "tauroboros"),
        })

        const config = tempManager.loadContainerConfig(process.cwd())
        const dockerfile = tempManager.generateDockerfile(config)
        return json({ dockerfile, config })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to generate Dockerfile: ${message}` }, 500)
      }
    })

    // Get custom Dockerfile content
    this.router.get("/api/container/dockerfile/custom", ({ json }) => {
      try {
        const customPath = join(process.cwd(), ".pi", "tauroboros", "Dockerfile.custom")
        if (!existsSync(customPath)) {
          // Return empty content with template
          return json({
            content: `# Custom Dockerfile - User Editable\n# Add your custom RUN commands here\n# These will be appended to the generated Dockerfile\n\n# Example:\n# RUN echo "Custom configuration" >> /etc/motd\n`,
            exists: false,
          })
        }
        const content = readFileSync(customPath, "utf-8")
        return json({ content, exists: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to read custom Dockerfile: ${message}` }, 500)
      }
    })

    // Save custom Dockerfile content
    this.router.put("/api/container/dockerfile/custom", async ({ req, json, broadcast }) => {
      try {
        const body = await req.json()
        const content = String(body.content ?? "")

        const customDir = join(process.cwd(), ".pi", "tauroboros")
        const customPath = join(customDir, "Dockerfile.custom")

        if (!existsSync(customDir)) {
          mkdirSync(customDir, { recursive: true })
        }

        writeFileSync(customPath, content, "utf-8")

        broadcast({ type: "container_dockerfile_custom_updated", payload: { path: customPath } })
        return json({ ok: true, path: customPath })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to save custom Dockerfile: ${message}` }, 500)
      }
    })

    // Trigger container image build
    this.router.post("/api/container/build", async ({ req, json, broadcast }) => {
      try {
        if (!this.imageManager) {
          return json({ error: "Container image manager not available" }, 503)
        }

        const body = await req.json()
        const config = this.imageManager.loadContainerConfig(process.cwd())

        // Override packages if provided
        if (body.packages) {
          config.packages = body.packages
        }

        const imageTag = body.imageTag ?? `pi-agent:custom-${Date.now()}`

        // Create build record
        const buildId = this.db.createContainerBuild({
          status: "running",
          startedAt: Math.floor(Date.now() / 1000),
          packagesHash: this.hashPackages(config.packages),
          imageTag,
        })

        broadcast({ type: "container_build_started", payload: { buildId, imageTag, status: "running" } })

        // Start build in background
        const logs: string[] = []

        this.imageManager.buildCustomImage(
          config,
          imageTag,
          {
            onLog: (line) => {
              logs.push(line)
              // Send periodic updates
              if (logs.length % 10 === 0) {
                broadcast({
                  type: "container_build_progress",
                  payload: { buildId, logs: logs.slice(-10), status: "running" },
                })
              }
            },
            onStatus: (status) => {
              const finalStatus = status.status === "success" ? "success" : status.status === "failed" ? "failed" : "running"
              this.db.updateContainerBuild(buildId, {
                status: finalStatus,
                completedAt: Math.floor(Date.now() / 1000),
              })

              if (status.status === "success") {
                // Update config with last build info
                config.lastBuild = {
                  timestamp: new Date().toISOString(),
                  imageTag,
                  success: true,
                }
                this.imageManager.saveContainerConfig(process.cwd(), config)
              }

              broadcast({
                type: "container_build_completed",
                payload: { buildId, status: finalStatus, logs, imageTag },
              })
            },
            isCancelled: () => false,
          }
        ).then((result) => {
          // Final update will be handled by onStatus callback
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.db.updateContainerBuild(buildId, {
            status: "failed",
            completedAt: Math.floor(Date.now() / 1000),
            errorMessage: message,
          })
          broadcast({
            type: "container_build_completed",
            payload: { buildId, status: "failed", logs, imageTag, error: message },
          })
        })

        return json({ buildId, status: "running", imageTag })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to start build: ${message}` }, 500)
      }
    })

    // Get build status
    this.router.get("/api/container/build-status", ({ url, json }) => {
      try {
        const limit = Number(url.searchParams.get("limit") ?? 10)
        const builds = this.db.getContainerBuilds(limit)
        return json({ builds })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to get builds: ${message}` }, 500)
      }
    })

    // Cancel running build
    this.router.post("/api/container/build/cancel", async ({ req, json, broadcast }) => {
      try {
        const body = await req.json()
        const buildId = body.buildId

        if (!buildId) {
          return json({ error: "buildId is required" }, 400)
        }

        this.db.updateContainerBuild(buildId, {
          status: "cancelled",
          completedAt: Math.floor(Date.now() / 1000),
        })

        broadcast({ type: "container_build_cancelled", payload: { buildId } })
        return json({ ok: true, buildId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to cancel build: ${message}` }, 500)
      }
    })

    // Apply a preset profile
    this.router.post("/api/container/profiles/:id/apply", async ({ params, req, json, broadcast }) => {
      try {
        const profileId = params.id
        const profilesPath = join(__dirname, "..", "config", "container-profiles.json")

        if (!existsSync(profilesPath)) {
          return json({ error: "Profiles not found" }, 404)
        }

        const raw = readFileSync(profilesPath, "utf-8")
        const data = JSON.parse(raw)
        const profile = data.profiles.find((p: { id: string }) => p.id === profileId)

        if (!profile) {
          return json({ error: `Profile '${profileId}' not found` }, 404)
        }

        const config = loadContainerConfig(process.cwd())

        // Handle profile extension
        let packagesToAdd = [...profile.packages]
        if (profile.extends) {
          const parentProfile = data.profiles.find((p: { id: string }) => p.id === profile.extends)
          if (parentProfile) {
            packagesToAdd = [...parentProfile.packages, ...packagesToAdd]
          }
        }

        // Convert to PackageDefinition format
        const packageDefs = packagesToAdd.map((pkg: { name: string; category: string }, idx: number) => ({
          name: pkg.name,
          category: pkg.category,
          installOrder: config.packages.length + idx,
        }))

        // Merge with existing packages
        const existingNames = new Set(config.packages.map(p => p.name))
        const newPackages = packageDefs.filter((p: { name: string }) => !existingNames.has(p.name))
        config.packages = [...config.packages, ...newPackages]

        // Save updated config
        saveContainerConfig(process.cwd(), config)

        // Save to database
        for (const pkg of newPackages) {
          this.db.addContainerPackage({
            name: pkg.name,
            category: pkg.category,
            installOrder: pkg.installOrder,
            source: `profile:${profileId}`,
          })
        }

        broadcast({
          type: "container_profile_applied",
          payload: { profileId, packagesAdded: newPackages.length, config },
        })

        return json({
          ok: true,
          profileId,
          packagesAdded: newPackages.length,
          packages: config.packages,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: `Failed to apply profile: ${message}` }, 500)
      }
    })

    // ---- End Container Configuration Routes ----
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
}
