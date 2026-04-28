import { Effect, Schema } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import {
  buildBestOfNFinalApplierVariables,
  buildBestOfNReviewerVariables,
  buildBestOfNWorkerVariables,
} from "../prompts/index.ts"
import {
  resolveContainerImage,
  type AggregatedReviewResult,
  type Options,
  type ReviewerOutput,
  type SelectionMode,
  type Task,
  type TaskCandidate,
  type TaskRun,
  type WSMessage,
} from "../types.ts"
import { parseStrictJsonObject } from "./strict-json.ts"
import { PiSessionManager } from "./session-manager.ts"
import { StructuredOutputExtractor } from "./structured-output-extractor.ts"
import { getChangedFiles, getDiffStats, resolveTargetBranch, WorktreeLifecycle } from "./worktree.ts"
import type { PiContainerManager } from "./container-manager.ts"

export class BestOfNError extends Schema.TaggedError<BestOfNError>()("BestOfNError", {
  operation: Schema.String,
  message: Schema.String,
  taskId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

function failBestOfN(operation: string, message: string, taskId?: string, cause?: unknown): never {
  throw new BestOfNError({ operation, message, taskId, cause })
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function appendTaggedOutput(db: PiKanbanDB, taskId: string, tag: string, text: string): string {
  const output = trimText(text)
  if (!output) return ""
  const chunk = `\n[${tag}]\n${output}\n`
  db.appendAgentOutput(taskId, chunk)
  return chunk
}

function summaryText(value: string, maxLength: number): string {
  if (!value) return ""
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}

function toReviewerOutput(text: string, events?: Record<string, unknown>[]): ReviewerOutput {
  // Phase A: Try structured output from tool events first
  if (events && events.length > 0) {
    const extractor = new StructuredOutputExtractor()
    const toolResult = extractor.extractFromEvents<{
      status: string
      summary: string
      bestCandidateIds: string[]
      gaps: string[]
      recommendedFinalStrategy: string
      recommendedPrompt?: string
    }>(events, "emit_best_of_n_vote")

    if (toolResult) {
      const status = toolResult.status
      if (status !== "pass" && status !== "needs_manual_review") {
        failBestOfN("toReviewerOutput", `Reviewer tool response must include status=pass|needs_manual_review, got: ${String(status)}`)
      }

      if (!Array.isArray(toolResult.bestCandidateIds)) {
        failBestOfN("toReviewerOutput", "Reviewer tool response must include bestCandidateIds as an array")
      }

      if (!Array.isArray(toolResult.gaps)) {
        failBestOfN("toReviewerOutput", "Reviewer tool response must include gaps as an array")
      }

      const recommendedFinalStrategy = toolResult.recommendedFinalStrategy
      if (
        recommendedFinalStrategy !== "pick_best"
        && recommendedFinalStrategy !== "synthesize"
        && recommendedFinalStrategy !== "pick_or_synthesize"
      ) {
        failBestOfN(
          "toReviewerOutput",
          `Reviewer tool response must include recommendedFinalStrategy=pick_best|synthesize|pick_or_synthesize, got: ${String(recommendedFinalStrategy)}`,
        )
      }

      const summary = trimText(toolResult.summary)
      if (!summary) {
        failBestOfN("toReviewerOutput", "Reviewer tool response must include a non-empty summary")
      }

      return {
        status,
        summary,
        bestCandidateIds: toolResult.bestCandidateIds.map((item) => String(item)).filter(Boolean),
        gaps: toolResult.gaps.map((item) => String(item)).filter(Boolean),
        recommendedFinalStrategy,
        recommendedPrompt: trimText(toolResult.recommendedPrompt) || null,
      }
    }
  }

  // Fallback: Parse JSON from response text (backward compatibility)
  const parsed = parseStrictJsonObject(text, "Best-of-n reviewer response")

  const status = parsed.status
  if (status !== "pass" && status !== "needs_manual_review") {
    failBestOfN("toReviewerOutput", `Reviewer response must include status=pass|needs_manual_review, got: ${String(status)}`)
  }

  if (!Array.isArray(parsed.bestCandidateIds)) {
    failBestOfN("toReviewerOutput", "Reviewer response must include bestCandidateIds as an array")
  }
  const bestCandidateIds = parsed.bestCandidateIds.map((item) => String(item)).filter(Boolean)

  if (!Array.isArray(parsed.gaps)) {
    failBestOfN("toReviewerOutput", "Reviewer response must include gaps as an array")
  }
  const gaps = parsed.gaps.map((item) => String(item)).filter(Boolean)

  const recommendedFinalStrategy = parsed.recommendedFinalStrategy
  if (
    recommendedFinalStrategy !== "pick_best"
    && recommendedFinalStrategy !== "synthesize"
    && recommendedFinalStrategy !== "pick_or_synthesize"
  ) {
    failBestOfN(
      "toReviewerOutput",
      `Reviewer response must include recommendedFinalStrategy=pick_best|synthesize|pick_or_synthesize, got: ${String(recommendedFinalStrategy)}`,
    )
  }

  const summary = trimText(parsed.summary)
  if (!summary) {
    failBestOfN("toReviewerOutput", "Reviewer response must include a non-empty summary")
  }

  return {
    status,
    summary,
    bestCandidateIds,
    gaps,
    recommendedFinalStrategy,
    recommendedPrompt: trimText(parsed.recommendedPrompt) || null,
  }
}

function aggregateReviewerOutputs(outputs: ReviewerOutput[]): AggregatedReviewResult {
  const candidateVoteCounts: Record<string, number> = {}
  const recurringGaps: string[] = []
  const recurringRisks: string[] = []
  const strategyVotes: Record<SelectionMode, number> = {
    pick_best: 0,
    synthesize: 0,
    pick_or_synthesize: 0,
  }

  for (const output of outputs) {
    strategyVotes[output.recommendedFinalStrategy] += 1
    for (const candidateId of output.bestCandidateIds) {
      candidateVoteCounts[candidateId] = (candidateVoteCounts[candidateId] || 0) + 1
    }
    for (const gap of output.gaps) {
      if (!recurringGaps.includes(gap)) recurringGaps.push(gap)
    }
  }

  const voteEntries = Object.entries(candidateVoteCounts)
  const topVote = voteEntries.sort(([, left], [, right]) => right - left)[0]
  const consensusReached = Boolean(topVote && topVote[1] === outputs.length && outputs.length > 0)

  const recommendedFinalStrategy = (Object.entries(strategyVotes)
    .sort(([, left], [, right]) => right - left)[0]?.[0] as SelectionMode | undefined)
    ?? "synthesize"

  return {
    candidateVoteCounts,
    recurringRisks,
    recurringGaps,
    consensusReached,
    recommendedFinalStrategy,
    usableResults: outputs,
  }
}

function expandSlots(slots: Array<{ model: string; count: number; taskSuffix?: string | null }>): Array<{
  slotIndex: number
  attemptIndex: number
  model: string
  taskSuffix?: string
}> {
  const expanded: Array<{ slotIndex: number; attemptIndex: number; model: string; taskSuffix?: string }> = []
  let slotIndex = 0
  for (const slot of slots) {
    for (let attemptIndex = 0; attemptIndex < slot.count; attemptIndex++) {
      expanded.push({ slotIndex, attemptIndex, model: slot.model, taskSuffix: slot.taskSuffix ?? undefined })
      slotIndex++
    }
  }
  return expanded
}

export class BestOfNRunner {
  private readonly sessions: PiSessionManager

  constructor(private readonly deps: {
    db: PiKanbanDB
    projectRoot: string
    worktree: WorktreeLifecycle
    broadcast: (message: WSMessage) => void
    sessionUrlFor: (sessionId: string) => string
    containerManager?: PiContainerManager
    settings?: InfrastructureSettings
    externalSessionManager?: PiSessionManager
    onSessionCreated?: (process: import("./container-pi-process.ts").ContainerPiProcess | import("./pi-process.ts").PiRpcProcess, session: import("../db/types.ts").PiWorkflowSession) => void
  }) {
    this.sessions = deps.externalSessionManager ?? new PiSessionManager(this.deps.db, this.deps.containerManager, this.deps.settings)
  }

  run(task: Task, options: Options): Effect.Effect<void, BestOfNError> {
    const self = this
    return Effect.gen(function* () {
      if (!task.bestOfNConfig) {
        return yield* new BestOfNError({
          operation: "run",
          message: `Task ${task.id} has executionStrategy=best_of_n but missing bestOfNConfig`,
          taskId: task.id,
        })
      }

      const targetBranch = yield* resolveTargetBranch({
        baseDirectory: self.deps.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      }).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "resolveTargetBranch",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId: task.id,
          cause,
        })),
      )

      self.deps.db.updateTask(task.id, {
        status: "executing",
        bestOfNSubstage: "workers_running",
        errorMessage: null,
        agentOutput: "",
      })
      self.broadcastTask(task.id)

      const workerRuns = expandSlots(task.bestOfNConfig.workers)
      for (const worker of workerRuns) {
        const run = self.deps.db.createTaskRun({
          taskId: task.id,
          phase: "worker",
          slotIndex: worker.slotIndex,
          attemptIndex: worker.attemptIndex,
          model: worker.model,
          taskSuffix: worker.taskSuffix ?? null,
          status: "pending",
        })
        self.deps.broadcast({ type: "task_run_created", payload: run })
      }

      yield* Effect.forEach(
        self.deps.db.getTaskRunsByPhase(task.id, "worker"),
        (run) => self.runWorker(task.id, run, options, targetBranch),
        { concurrency: Math.max(1, workerRuns.length), discard: true },
      )

      const successfulWorkers = self.deps.db.getTaskRunsByPhase(task.id, "worker").filter((run) => run.status === "done")
      if (successfulWorkers.length < task.bestOfNConfig.minSuccessfulWorkers) {
        return yield* new BestOfNError({
          operation: "run",
          message: `Best-of-n failed: ${successfulWorkers.length} successful workers < required ${task.bestOfNConfig.minSuccessfulWorkers}`,
          taskId: task.id,
        })
      }

      const candidates = self.deps.db.getTaskCandidates(task.id)
      let aggregatedReview: AggregatedReviewResult = {
        candidateVoteCounts: {},
        recurringRisks: [],
        recurringGaps: [],
        consensusReached: false,
        recommendedFinalStrategy: task.bestOfNConfig.selectionMode,
        usableResults: [],
      }

      if (task.bestOfNConfig.reviewers.length > 0) {
        self.deps.db.updateTask(task.id, { bestOfNSubstage: "reviewers_running" })
        self.broadcastTask(task.id)

        const reviewerRuns = expandSlots(task.bestOfNConfig.reviewers)
        for (const reviewer of reviewerRuns) {
          const run = self.deps.db.createTaskRun({
            taskId: task.id,
            phase: "reviewer",
            slotIndex: reviewer.slotIndex,
            attemptIndex: reviewer.attemptIndex,
            model: reviewer.model,
            taskSuffix: reviewer.taskSuffix ?? null,
            status: "pending",
          })
          self.deps.broadcast({ type: "task_run_created", payload: run })
        }

        yield* Effect.forEach(
          self.deps.db.getTaskRunsByPhase(task.id, "reviewer"),
          (run) => self.runReviewer(task.id, run, candidates, options),
          { concurrency: Math.max(1, reviewerRuns.length), discard: true },
        )

        const usableResults = self.deps.db
          .getTaskRunsByPhase(task.id, "reviewer")
          .filter((run) => run.status === "done" && Boolean(run.metadataJson?.reviewerOutput))
          .map((run) => run.metadataJson?.reviewerOutput as ReviewerOutput)

        if (usableResults.length === 0) {
          self.deps.db.updateTask(task.id, {
            status: "review",
            bestOfNSubstage: "blocked_for_manual_review",
            errorMessage: "No usable reviewer results available",
          })
          self.broadcastTask(task.id)
          return
        }

        aggregatedReview = aggregateReviewerOutputs(usableResults)

        const reviewerRequestedManual = usableResults.some((result) => result.status === "needs_manual_review")
        if (reviewerRequestedManual || (!aggregatedReview.consensusReached && task.bestOfNConfig.selectionMode === "pick_best")) {
          self.deps.db.updateTask(task.id, {
            status: "review",
            bestOfNSubstage: "blocked_for_manual_review",
            errorMessage: reviewerRequestedManual
              ? "One or more reviewers requested manual review"
              : "Reviewer consensus missing for pick_best mode",
          })
          self.broadcastTask(task.id)
          return
        }
      }

      self.deps.db.updateTask(task.id, { bestOfNSubstage: "final_apply_running" })
      self.broadcastTask(task.id)

      const finalRun = self.deps.db.createTaskRun({
        taskId: task.id,
        phase: "final_applier",
        slotIndex: 0,
        attemptIndex: 0,
        model: task.bestOfNConfig.finalApplier.model,
        taskSuffix: task.bestOfNConfig.finalApplier.taskSuffix ?? null,
        status: "pending",
      })
      self.deps.broadcast({ type: "task_run_created", payload: finalRun })

      yield* self.runFinalApplier(task.id, finalRun.id, candidates, aggregatedReview, options, targetBranch)

      self.deps.db.updateTask(task.id, {
        status: "done",
        bestOfNSubstage: "completed",
        completedAt: nowUnix(),
        errorMessage: null,
      })
      self.broadcastTask(task.id)
    })
  }

  private runWorker(taskId: string, workerRun: TaskRun, options: Options, targetBranch: string): Effect.Effect<void, BestOfNError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.deps.db.getTask(taskId)
      if (!task || !task.bestOfNConfig) return
      const bestOfNConfig = task.bestOfNConfig

      let worktreeDir: string | null = null

      self.deps.db.updateTaskRun(workerRun.id, { status: "running" })
      self.broadcastRun(workerRun.id)

      const worktreeInfo = yield* self.deps.worktree.createForRun(workerRun.id, "bon-worker", targetBranch).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "runWorker.createWorktree",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId,
          cause,
        })),
      )
      worktreeDir = worktreeInfo.directory
      self.deps.db.updateTaskRun(workerRun.id, { worktreeDir })
      self.broadcastRun(workerRun.id)

      const prompt = self.deps.db.renderPrompt(
        "best_of_n_worker",
        buildBestOfNWorkerVariables(task, workerRun.slotIndex, workerRun.model, options.extraPrompt, workerRun.taskSuffix ?? undefined),
      )
      const outputChunks: string[] = []
      const workerImageToUse = resolveContainerImage(task, self.deps.settings?.workflow?.container?.image)

      const response = yield* self.sessions.executePrompt({
        taskId,
        taskRunId: workerRun.id,
        sessionKind: "task_run_worker",
        cwd: worktreeDir,
        worktreeDir,
        branch: worktreeInfo.branch,
        model: workerRun.model,
        thinkingLevel: task.executionThinkingLevel,
        promptText: prompt.renderedText,
        containerImage: workerImageToUse,
      }, {
        onOutput: (chunk: string) => {
          if (!trimText(chunk)) return
          outputChunks.push(chunk)
          appendTaggedOutput(self.deps.db, taskId, `worker-${workerRun.slotIndex}`, chunk)
        },
        onSessionCreated: self.deps.onSessionCreated,
      }).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "runWorker.executePrompt",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId,
          cause,
        })),
      )

      self.deps.db.updateTaskRun(workerRun.id, {
        sessionId: response.session.id,
        sessionUrl: self.deps.sessionUrlFor(response.session.id),
      })
      self.broadcastRun(workerRun.id)

      const verificationJson = yield* self.runVerificationCommand(
        trimText(bestOfNConfig.verificationCommand),
        worktreeDir,
      )

      const changedFiles = yield* getChangedFiles(worktreeDir).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "runWorker.getChangedFiles",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId,
          cause,
        })),
      )

      const diff = yield* getDiffStats(worktreeDir).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "runWorker.getDiffStats",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId,
          cause,
        })),
      )

      const diffStatsJson: Record<string, number> = {}
      for (const [filePath, stat] of Object.entries(diff.fileStats)) {
        diffStatsJson[filePath] = stat.insertions + stat.deletions
      }

      const summary = trimText(response.responseText) || summaryText(outputChunks.join("\n"), 1000)
      const candidate = self.deps.db.createTaskCandidate({
        taskId,
        workerRunId: workerRun.id,
        status: "available",
        changedFilesJson: changedFiles,
        diffStatsJson,
        verificationJson,
        summary: summaryText(summary, 1000) || null,
        errorMessage: null,
      })
      self.deps.broadcast({ type: "task_candidate_created", payload: candidate })

      self.deps.db.updateTaskRun(workerRun.id, {
        status: "done",
        summary: summaryText(summary, 500) || null,
        candidateId: candidate.id,
        metadataJson: {
          verificationJson,
          changedFiles,
          diff,
        },
        completedAt: nowUnix(),
      })
      self.broadcastRun(workerRun.id)
    }).pipe(
      Effect.catchAll((error: unknown) => {
        const message = error instanceof BestOfNError
          ? error.message
          : error instanceof Error ? error.message : String(error)
        self.deps.db.updateTaskRun(workerRun.id, {
          status: "failed",
          errorMessage: message,
          completedAt: nowUnix(),
        })
        self.broadcastRun(workerRun.id)
        return Effect.fail(error instanceof BestOfNError ? error : new BestOfNError({
          operation: "runWorker",
          message,
          taskId,
          cause: error,
        }))
      }),
      Effect.ensuring(
        Effect.gen(function* () {
          const task = self.deps.db.getTask(taskId)
          if (!task) return
          const run = self.deps.db.getTaskRun(workerRun.id)
          if (!run) return
          if (run.worktreeDir && task.deleteWorktree !== false) {
            yield* self.deps.worktree.complete(run.worktreeDir, {
              branch: "",
              targetBranch: "",
              shouldMerge: false,
              shouldRemove: true,
            }).pipe(Effect.catchTag("WorktreeError", () => Effect.void))
          }
        }),
      ),
    )
  }

  private runReviewer(taskId: string, reviewerRun: TaskRun, candidates: TaskCandidate[], options: Options): Effect.Effect<void, BestOfNError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.deps.db.getTask(taskId)
      if (!task) return

      yield* Effect.gen(function* () {
        self.deps.db.updateTaskRun(reviewerRun.id, { status: "running" })
        self.broadcastRun(reviewerRun.id)

        const prompt = self.deps.db.renderPrompt(
          "best_of_n_reviewer",
          buildBestOfNReviewerVariables(task, candidates, options.extraPrompt, reviewerRun.taskSuffix ?? undefined),
        )

        const reviewerImageToUse = resolveContainerImage(task, self.deps.settings?.workflow?.container?.image)

        const response = yield* self.sessions.executePrompt({
          taskId,
          taskRunId: reviewerRun.id,
          sessionKind: "task_run_reviewer",
          cwd: self.deps.projectRoot,
          model: reviewerRun.model,
          thinkingLevel: task.executionThinkingLevel,
          promptText: prompt.renderedText,
          containerImage: reviewerImageToUse,
        }, {
          onSessionCreated: self.deps.onSessionCreated,
        }).pipe(
          Effect.mapError((cause) => new BestOfNError({
            operation: "runReviewer.executePrompt",
            message: cause instanceof Error ? cause.message : String(cause),
            taskId,
            cause,
          })),
        )

        const reviewerOutput = toReviewerOutput(response.responseText, response.events)
        self.deps.db.updateTaskRun(reviewerRun.id, {
          status: "done",
          sessionId: response.session.id,
          sessionUrl: self.deps.sessionUrlFor(response.session.id),
          summary: summaryText(reviewerOutput.summary, 500),
          metadataJson: { reviewerOutput },
          completedAt: nowUnix(),
        })
        self.broadcastRun(reviewerRun.id)
      }).pipe(
        Effect.catchAll((error: unknown) => {
          const message = error instanceof BestOfNError
            ? error.message
            : error instanceof Error ? error.message : String(error)
          self.deps.db.updateTaskRun(reviewerRun.id, {
            status: "failed",
            errorMessage: message,
            completedAt: nowUnix(),
          })
          self.broadcastRun(reviewerRun.id)
          return Effect.fail(error instanceof BestOfNError ? error : new BestOfNError({
            operation: "runReviewer",
            message,
            taskId,
            cause: error,
          }))
        }),
      )
    })
  }

  private runFinalApplier(
    taskId: string,
    finalRunId: string,
    candidates: TaskCandidate[],
    aggregatedReview: AggregatedReviewResult,
    options: Options,
    targetBranch: string,
  ): Effect.Effect<void, BestOfNError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.deps.db.getTask(taskId)
      if (!task || !task.bestOfNConfig) return
      const bestOfNConfig = task.bestOfNConfig

      const finalRun = self.deps.db.getTaskRun(finalRunId)
      if (!finalRun) {
        return yield* new BestOfNError({
          operation: "runFinalApplier",
          message: "Final applier run not found",
          taskId,
        })
      }

      let worktreeDir: string | null = null

      self.deps.db.updateTaskRun(finalRun.id, { status: "running" })
      self.broadcastRun(finalRun.id)

      const worktreeInfo = yield* self.deps.worktree.createForRun(finalRun.id, "bon-final", targetBranch).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "runFinalApplier.createWorktree",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId,
          cause,
        })),
      )
      worktreeDir = worktreeInfo.directory
      self.deps.db.updateTaskRun(finalRun.id, { worktreeDir })
      self.broadcastRun(finalRun.id)

      const selectionMode: SelectionMode = bestOfNConfig.selectionMode === "pick_or_synthesize"
        ? (aggregatedReview.recommendedFinalStrategy || "pick_or_synthesize")
        : bestOfNConfig.selectionMode

      const prompt = self.deps.db.renderPrompt(
        "best_of_n_final_applier",
        buildBestOfNFinalApplierVariables(
          task,
          candidates,
          aggregatedReview,
          selectionMode,
          options.extraPrompt,
          finalRun.taskSuffix ?? undefined,
        ),
      )

      const outputChunks: string[] = []
      const finalImageToUse = resolveContainerImage(task, self.deps.settings?.workflow?.container?.image)

      const response = yield* self.sessions.executePrompt({
        taskId,
        taskRunId: finalRun.id,
        sessionKind: "task_run_final_applier",
        cwd: worktreeDir,
        worktreeDir,
        branch: worktreeInfo.branch,
        model: finalRun.model,
        thinkingLevel: task.executionThinkingLevel,
        promptText: prompt.renderedText,
        containerImage: finalImageToUse,
      }, {
        onOutput: (chunk: string) => {
          if (!trimText(chunk)) return
          outputChunks.push(chunk)
          appendTaggedOutput(self.deps.db, taskId, "final-applier", chunk)
        },
        onSessionCreated: self.deps.onSessionCreated,
      }).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "runFinalApplier.executePrompt",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId,
          cause,
        })),
      )

      self.deps.db.updateTaskRun(finalRun.id, {
        sessionId: response.session.id,
        sessionUrl: self.deps.sessionUrlFor(response.session.id),
      })
      self.broadcastRun(finalRun.id)

      const verificationJson = yield* self.runVerificationCommand(trimText(bestOfNConfig.verificationCommand), worktreeDir)

      if (Object.keys(aggregatedReview.candidateVoteCounts).length > 0) {
        const votedCandidateId = Object.entries(aggregatedReview.candidateVoteCounts)
          .sort(([, left], [, right]) => right - left)[0]?.[0]
        const selectedCandidateId = candidates.some((candidate) => candidate.id === votedCandidateId)
          ? votedCandidateId
          : candidates[0]?.id
        if (selectedCandidateId) {
          for (const candidate of candidates) {
            const nextStatus = candidate.id === selectedCandidateId ? "selected" : "rejected"
            const updated = self.deps.db.updateTaskCandidate(candidate.id, { status: nextStatus })
            if (updated) self.deps.broadcast({ type: "task_candidate_updated", payload: updated })
          }
        }
      }

      yield* self.deps.worktree.complete(worktreeDir, {
        branch: worktreeInfo.branch,
        targetBranch,
        shouldMerge: true,
        shouldRemove: task.deleteWorktree !== false,
      }).pipe(
        Effect.mapError((cause) => new BestOfNError({
          operation: "runFinalApplier.completeWorktree",
          message: cause instanceof Error ? cause.message : String(cause),
          taskId,
          cause,
        })),
      )

      const summary = trimText(response.responseText) || summaryText(outputChunks.join("\n"), 1000)
      self.deps.db.updateTaskRun(finalRun.id, {
        status: "done",
        summary: summaryText(summary, 500),
        metadataJson: { verificationJson },
        completedAt: nowUnix(),
      })
      self.broadcastRun(finalRun.id)
    }).pipe(
      Effect.catchAll((error: unknown) => {
        const message = error instanceof BestOfNError
          ? error.message
          : error instanceof Error ? error.message : String(error)
        self.deps.db.updateTaskRun(finalRunId, {
          status: "failed",
          errorMessage: message,
          completedAt: nowUnix(),
        })
        self.broadcastRun(finalRunId)
        return Effect.fail(error instanceof BestOfNError ? error : new BestOfNError({
          operation: "runFinalApplier",
          message: `Best-of-n final applier failed: ${message}`,
          taskId,
          cause: error,
        }))
      }),
      Effect.ensuring(
        Effect.gen(function* () {
          const task = self.deps.db.getTask(taskId)
          if (!task) return
          const run = self.deps.db.getTaskRun(finalRunId)
          if (!run) return
          if (run.worktreeDir && task.deleteWorktree !== false) {
            yield* self.deps.worktree.complete(run.worktreeDir, {
              branch: "",
              targetBranch: "",
              shouldMerge: false,
              shouldRemove: true,
            }).pipe(Effect.catchTag("WorktreeError", () => Effect.void))
          }
        }),
      ),
    )
  }

  private runVerificationCommand(command: string, cwd: string): Effect.Effect<
    Record<string, unknown>,
    BestOfNError
  > {
    if (!command) return Effect.succeed({ status: "skipped", reason: "No verification command configured" })

    return Effect.gen(function* () {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
      )

      return {
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        stdout: summaryText(stdout, 8_000),
        stderr: summaryText(stderr, 8_000),
      } as Record<string, unknown>
    }).pipe(
      Effect.mapError((cause: unknown) => new BestOfNError({
        operation: "runVerificationCommand",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      })),
    )
  }

  private broadcastTask(taskId: string): void {
    const task = this.deps.db.getTask(taskId)
    if (!task) return
    this.deps.broadcast({ type: "task_updated", payload: task })
  }

  private broadcastRun(taskRunId: string): void {
    const run = this.deps.db.getTaskRun(taskRunId)
    if (!run) return
    this.deps.broadcast({ type: "task_run_updated", payload: run })
  }
}
