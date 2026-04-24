import { existsSync, mkdirSync } from "fs"
import { dirname, join, resolve } from "path"
import { Effect, Schema, Either } from "effect"
import { inspect } from "node:util"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { Task, WorkflowRun } from "../types.ts"
import { resolveContainerImage } from "../types.ts"
import { VERSION, IS_COMPILED } from "../server/version.ts"
import { PiSessionManager } from "./session-manager.ts"
import { parseStrictJsonObject } from "./strict-json.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { getSystemPrompt, renderPromptTemplate } from "../prompts/catalog.ts"

export class SelfHealingError extends Schema.TaggedError<SelfHealingError>()("SelfHealingError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

class GitCloneError extends Schema.TaggedError<GitCloneError>()("GitCloneError", {
  message: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
}) {}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

type SourceMode = "local" | "github_clone" | "github_metadata_only"

interface SourceContext {
  sourceMode: SourceMode
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
  isTauroborosBug: boolean
  confidence: "high" | "medium" | "low"
  diagnosticsSummary: string
  rootCause: {
    description: string
    affectedFiles: readonly string[]
    codeSnippet: string
  }
  proposedSolution: string
  implementationPlan: readonly string[]
  externalFactors: readonly string[]
}

const ConfidenceSchema = Schema.Literal("high", "medium", "low")
const SourceModeSchema = Schema.Literal("local", "github_clone", "github_metadata_only")

const RootCauseSchema = Schema.Struct({
  description: Schema.String,
  affectedFiles: Schema.Array(Schema.String),
  codeSnippet: Schema.String,
})

const SelfHealResponseSchema = Schema.Struct({
  diagnosticsSummary: Schema.String,
  isTauroborosBug: Schema.Boolean,
  rootCause: RootCauseSchema,
  proposedSolution: Schema.String,
  implementationPlan: Schema.Array(Schema.String),
  confidence: ConfidenceSchema,
  externalFactors: Schema.Array(Schema.String),
})

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
            operation: "investigateFailure",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        ),
      )

      const rawParsed = yield* Effect.try({
        try: () => parseStrictJsonObject(session.responseText, "Self-heal diagnostics response"),
        catch: (cause) => new SelfHealingError({
          operation: "parseDiagnosticsResponse",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      const validationResult = Schema.decodeUnknownEither(SelfHealResponseSchema)(rawParsed)
      const validated = yield* Either.match(validationResult, {
        onLeft: (decodeError) => new SelfHealingError({
          operation: "validateDiagnosticsResponse",
          message: `Invalid self-heal response structure: ${JSON.stringify(decodeError)}`,
          cause: decodeError,
        }),
        onRight: (value) => Effect.succeed(value),
      })

      const report = self.db.createSelfHealReport({
        id: `${input.run.id}-${input.task.id}-${nowUnix()}`,
        runId: input.run.id,
        taskId: input.task.id,
        taskStatus: input.task.status,
        errorMessage: input.errorMessage,
        diagnosticsSummary: validated.diagnosticsSummary,
        isTauroborosBug: validated.isTauroborosBug,
        rootCause: validated.rootCause,
        proposedSolution: validated.proposedSolution,
        implementationPlan: validated.implementationPlan,
        confidence: validated.confidence,
        externalFactors: validated.externalFactors,
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
        isTauroborosBug: validated.isTauroborosBug,
        confidence: validated.confidence,
        diagnosticsSummary: validated.diagnosticsSummary,
        rootCause: validated.rootCause,
        proposedSolution: validated.proposedSolution,
        implementationPlan: validated.implementationPlan,
        externalFactors: validated.externalFactors,
      }
    })
  }

  private resolveSourceContextEffect(runId: string): Effect.Effect<SourceContext, SelfHealingError> {
    const self = this
    return Effect.gen(function* () {
      const hasGitDir = existsSync(join(self.projectRoot, ".git"))
      const hasSourceFiles = existsSync(join(self.projectRoot, "src", "orchestrator.ts"))

      if (hasGitDir && hasSourceFiles) {
        return {
          sourceMode: "local" satisfies SourceMode,
          sourcePath: self.projectRoot,
          githubUrl: self.githubUrl,
          notes: "Running in development/source mode, local repository used.",
        } satisfies SourceContext
      }

      const cloneDir = resolve(self.projectRoot, ".tauroboros", "self-heal-source", `${VERSION}-${runId}`)
      mkdirSync(dirname(cloneDir), { recursive: true })

      if (!existsSync(cloneDir)) {
        const cloneResult = yield* runCommandEffect(["git", "clone", "--depth", "1", self.githubUrl, cloneDir], self.projectRoot)
        if (cloneResult.exitCode !== 0) {
          return yield* new GitCloneError({
            message: "git clone failed",
            stdout: cloneResult.stdout,
            stderr: cloneResult.stderr,
          }).pipe(
            Effect.mapError((err) => new SelfHealingError({
              operation: "resolveSourceContext",
              message: err.message,
              cause: err,
            })),
          )
        }
      }

      return {
        sourceMode: "github_clone" satisfies SourceMode,
        sourcePath: cloneDir,
        githubUrl: self.githubUrl,
        notes: `Cloned source for diagnostics at ${cloneDir}`,
      } satisfies SourceContext
    }).pipe(
      Effect.catchAll((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return Effect.succeed<SourceContext>({
          sourceMode: "github_metadata_only",
          sourcePath: null,
          githubUrl: self.githubUrl,
          notes: `Unable to clone source locally: ${errorMessage}. Self-healing will proceed with metadata-only analysis.`,
        })
      }),
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
