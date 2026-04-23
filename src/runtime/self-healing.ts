import { existsSync, mkdirSync } from "fs"
import { dirname, join, resolve } from "path"
import { Effect, Schema } from "effect"
import { inspect } from "node:util"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { Task, WorkflowRun } from "../types.ts"
import { resolveContainerImage } from "../types.ts"
import { VERSION, IS_COMPILED } from "../server/version.ts"
import { PiSessionManager, SessionManagerExecuteError } from "./session-manager.ts"
import { parseStrictJsonObject } from "./strict-json.ts"
import { PiProcessError } from "./pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { getSystemPrompt, renderPromptTemplate } from "../prompts/catalog.ts"

export class SelfHealingError extends Schema.TaggedError<SelfHealingError>()("SelfHealingError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

interface SourceContext {
  sourceMode: "local" | "github_clone" | "github_metadata_only"
  sourcePath: string | null
  githubUrl: string
  notes: string
}

interface InvestigateFailureInput {
  run: WorkflowRun
  task: Task
  errorMessage: string
  hasOtherActiveTasks: boolean
}

export interface SelfHealingInvestigationResult {
  reportId: string
  recoverable: boolean
  recommendedAction: "restart_task" | "keep_failed"
  diagnosticsSummary: string
  actionRationale: string
}

export class SelfHealingService {
  private readonly sessions: PiSessionManager
  private readonly githubUrl = "https://github.com/jmarceno/tauroboros"

  constructor(
    private readonly db: PiKanbanDB,
    private readonly projectRoot: string,
    private readonly settings?: InfrastructureSettings,
    private readonly containerManager?: PiContainerManager,
  ) {
    this.sessions = new PiSessionManager(db, containerManager, settings)
  }

  investigateFailure(input: InvestigateFailureInput): Effect.Effect<SelfHealingInvestigationResult, SelfHealingError> {
    const self = this
    return Effect.gen(function* () {
      const options = self.db.getOptions()
      const source = yield* self.resolveSourceContextEffect(input.run.id)

      const schemaSnapshot = self.db.getSchemaSnapshot()
      const schemaJson = inspect(schemaSnapshot, { depth: null, breakLength: Infinity })

      const selfHealingPrompt = getSystemPrompt("self_healing")
      const prompt = renderPromptTemplate(selfHealingPrompt.promptText, {
        run_id: input.run.id,
        task_id: input.task.id,
        task_name: input.task.name,
        task_status: input.task.status,
        run_status: input.run.status,
        error_message: input.errorMessage,
        has_other_active_tasks: input.hasOtherActiveTasks ? "yes" : "no",
        db_path: self.db.getDatabasePath(),
        version: VERSION,
        is_compiled: IS_COMPILED ? "yes" : "no",
        github_url: self.githubUrl,
        source_mode: source.sourceMode,
        source_notes: source.notes,
        schema_json: schemaJson,
      })

      const imageToUse = resolveContainerImage(input.task, self.settings?.workflow?.container?.image)

      const session = yield* self.sessions.executePrompt({
        taskId: input.task.id,
        sessionKind: "review_scratch",
        cwd: source.sourcePath ?? self.projectRoot,
        worktreeDir: source.sourcePath,
        branch: input.task.branch,
        model: options.reviewModel,
        thinkingLevel: options.reviewThinkingLevel,
        promptText: prompt,
        containerImage: imageToUse,
      }).pipe(
        Effect.mapError((cause) =>
          new SelfHealingError({
            operation: cause instanceof SessionManagerExecuteError ? cause.operation : cause instanceof PiProcessError ? cause.operation : "investigateFailure",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        ),
      )

      const parsed = yield* Effect.try({
        try: () => parseStrictJsonObject(session.responseText, "Self-heal diagnostics response"),
        catch: (cause) => new SelfHealingError({
          operation: "parseDiagnosticsResponse",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      const diagnosticsSummary =
        typeof parsed.diagnosticsSummary === "string" && parsed.diagnosticsSummary.trim().length > 0
          ? parsed.diagnosticsSummary.trim()
          : "Self-heal diagnostics returned no summary"

      const rootCausesRaw = Array.isArray(parsed.rootCauses) ? parsed.rootCauses : []
      const rootCauses = rootCausesRaw
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())

      const proposedSolution =
        typeof parsed.proposedSolution === "string" && parsed.proposedSolution.trim().length > 0
          ? parsed.proposedSolution.trim()
          : "No permanent solution provided"

      const implementationPlanRaw = Array.isArray(parsed.implementationPlan) ? parsed.implementationPlan : []
      const implementationPlan = implementationPlanRaw
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())

      const recoverabilityRaw = parsed.recoverability && typeof parsed.recoverability === "object"
        ? parsed.recoverability as Record<string, unknown>
        : {}

      const recoverable = recoverabilityRaw.recoverable === true
      const recommendedAction: SelfHealingInvestigationResult["recommendedAction"] = recoverabilityRaw.recommendedAction === "restart_task" ? "restart_task" : "keep_failed"
      const actionRationale =
        typeof recoverabilityRaw.rationale === "string" && recoverabilityRaw.rationale.trim().length > 0
          ? recoverabilityRaw.rationale.trim()
          : "No recoverability rationale provided"

      const report = self.db.createSelfHealReport({
        id: `${input.run.id}-${input.task.id}-${nowUnix()}`,
        runId: input.run.id,
        taskId: input.task.id,
        taskStatus: input.task.status,
        errorMessage: input.errorMessage,
        diagnosticsSummary,
        rootCauses,
        proposedSolution,
        implementationPlan,
        recoverable,
        recommendedAction,
        actionRationale,
        sourceMode: source.sourceMode,
        sourcePath: source.sourcePath,
        githubUrl: source.githubUrl,
        tauroborosVersion: VERSION,
        dbPath: self.db.getDatabasePath(),
        dbSchemaJson: schemaSnapshot,
        rawResponse: session.responseText,
      })

      return {
        reportId: report.id,
        recoverable,
        recommendedAction,
        diagnosticsSummary,
        actionRationale,
      }
    })
  }

  private resolveSourceContextEffect(runId: string): Effect.Effect<SourceContext, SelfHealingError> {
    const self = this
    return Effect.gen(function* () {
      const localLooksLikeSource = existsSync(join(self.projectRoot, ".git")) && existsSync(join(self.projectRoot, "src", "orchestrator.ts"))

      if (localLooksLikeSource) {
        return {
          sourceMode: "local" as const,
          sourcePath: self.projectRoot,
          githubUrl: self.githubUrl,
          notes: "Running in development/source mode, local repository used.",
        }
      }

      const cloneDir = resolve(self.projectRoot, ".tauroboros", "self-heal-source", `${VERSION}-${runId}`)
      mkdirSync(dirname(cloneDir), { recursive: true })

      if (!existsSync(cloneDir)) {
        const cloneResult = yield* runCommandEffect(["git", "clone", "--depth", "1", self.githubUrl, cloneDir], self.projectRoot)
        if (cloneResult.exitCode !== 0) {
          return yield* new SelfHealingError({
            operation: "resolveSourceContext",
            message: `git clone failed: ${cloneResult.stderr || cloneResult.stdout || "unknown error"}`,
          })
        }
      }

      return {
        sourceMode: "github_clone" as const,
        sourcePath: cloneDir,
        githubUrl: self.githubUrl,
        notes: `Cloned source for diagnostics at ${cloneDir}`,
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          sourceMode: "github_metadata_only" as const,
          sourcePath: null,
          githubUrl: self.githubUrl,
          notes: `Unable to clone source locally: ${error instanceof Error ? error.message : String(error)}`,
        })
      ),
    )
  }
}

function runCommandEffect(command: string[], cwd: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, SelfHealingError> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(command, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    },
    catch: (cause) => new SelfHealingError({
      operation: "runCommand",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  })
}
