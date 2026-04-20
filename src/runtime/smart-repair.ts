import { existsSync } from "fs"
import { execFileSync } from "child_process"
import { Effect, Schema } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import { resolveContainerImage, type Task } from "../types.ts"
import type { TaskRepairAction } from "../task-state.ts"
import { chooseDeterministicRepairAction } from "../task-state.ts"
import { buildRepairVariables } from "../prompts/index.ts"
import { PiSessionManager, SessionManagerExecuteError } from "./session-manager.ts"
import { parseStrictJsonObject } from "./strict-json.ts"
import { formatLocalDateTime } from "../utils/date-format.ts"
import { PiProcessError } from "./pi-process.ts"

export type SmartRepairAction = TaskRepairAction

export class SmartRepairError extends Schema.TaggedError<SmartRepairError>()("SmartRepairError", {
  operation: Schema.String,
  message: Schema.String,
  taskId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface SmartRepairDecision {
  action: SmartRepairAction
  reason: string
  errorMessage?: string
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function trimForContext(value: string, max = 1200): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}...`
}

function getGitStatusPorcelain(worktreeDir: string | null): string {
  if (!worktreeDir || !existsSync(worktreeDir)) return "(no worktree available)"
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreeDir,
      encoding: "utf-8",
      stdio: "pipe",
    })
    return status.trim() || "(clean)"
  } catch (error) {
    return `(failed to read git status: ${error instanceof Error ? error.message : String(error)})`
  }
}

function buildSessionHistoryText(db: PiKanbanDB, taskId: string): string {
  const sessions = db.getWorkflowSessionsByTask(taskId)
  if (sessions.length === 0) return "(none)"
  return sessions
    .map((session) => {
      const started = formatLocalDateTime(session.startedAt)
      const finished = session.finishedAt ? formatLocalDateTime(session.finishedAt) : "ongoing"
      return `${session.id}: kind=${session.sessionKind}, status=${session.status}, started=${started}, finished=${finished}, model=${session.model}`
    })
    .join("\n")
}

function buildRecentMessagesText(db: PiKanbanDB, taskId: string): string {
  const messages = db.getSessionMessageViewsByTask(taskId)
  if (messages.length === 0) return "(none)"
  return messages
    .slice(-12)
    .map((message) => {
      const content = typeof message.contentJson?.text === "string"
        ? message.contentJson.text
        : JSON.stringify(message.contentJson)
      return `${message.sessionId} [${message.role}/${message.messageType}]: ${trimForContext(content, 320)}`
    })
    .join("\n")
}

function buildLatestTaggedOutputText(task: Task): string {
  const lines = task.agentOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return "(none)"
  return trimForContext(lines.slice(-30).join("\n"), 3000)
}

function parseRepairDecisionEffect(responseText: string): Effect.Effect<SmartRepairDecision, SmartRepairError> {
  return Effect.try({
    try: () => {
      const parsed = parseStrictJsonObject(responseText, "Repair response")
      const action = parsed.action
      if (
        action !== "queue_implementation"
        && action !== "restore_plan_approval"
        && action !== "reset_backlog"
        && action !== "mark_done"
        && action !== "fail_task"
        && action !== "continue_with_more_reviews"
        && action !== "skip_code_style"
        && action !== "return_to_review"
      ) {
        throw new SmartRepairError({
          operation: "parseRepairDecision",
          message: `Repair response JSON contains unsupported action: ${String(action)}`,
        })
      }

      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "No reason provided"
      const errorMessage = typeof parsed.errorMessage === "string" && parsed.errorMessage.trim()
        ? parsed.errorMessage.trim()
        : undefined

      return { action, reason, errorMessage }
    },
    catch: (cause) => new SmartRepairError({
      operation: "parseRepairDecision",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  })
}

export class SmartRepairService {
  private readonly sessions: PiSessionManager

  constructor(
    private readonly db: PiKanbanDB,
    private readonly settings?: InfrastructureSettings,
  ) {
    this.sessions = new PiSessionManager(db, undefined, settings)
  }

  decide(taskId: string): Effect.Effect<SmartRepairDecision, SmartRepairError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.db.getTask(taskId)
      if (!task) {
        return yield* new SmartRepairError({
          operation: "decide",
          message: `Task not found: ${taskId}`,
          taskId,
        })
      }

      const options = self.db.getOptions()
      const worktreeStatus = getGitStatusPorcelain(task.worktreeDir)
      const sessionHistory = [
        "Workflow sessions:",
        buildSessionHistoryText(self.db, task.id),
        "",
        "Recent session messages:",
        buildRecentMessagesText(self.db, task.id),
        task.smartRepairHints?.trim() ? `\nUser hints:\n${task.smartRepairHints.trim()}` : "",
      ].join("\n")

      const latestOutput = buildLatestTaggedOutputText(task)
      const promptVars = buildRepairVariables(task, worktreeStatus, sessionHistory, latestOutput)
      const prompt = self.db.renderPrompt("repair", promptVars)

      const repairImageToUse = resolveContainerImage(task, self.settings?.workflow?.container?.image)

      const session = yield* self.sessions.executePrompt({
        taskId: task.id,
        sessionKind: "repair",
        cwd: task.worktreeDir ?? process.cwd(),
        worktreeDir: task.worktreeDir,
        branch: task.branch,
        model: options.repairModel,
        thinkingLevel: options.repairThinkingLevel,
        promptText: prompt.renderedText,
        containerImage: repairImageToUse,
      }).pipe(
        Effect.mapError((cause) =>
          new SmartRepairError({
            operation: cause instanceof SessionManagerExecuteError ? cause.operation : cause instanceof PiProcessError ? cause.operation : "decide",
            message: cause instanceof Error ? cause.message : String(cause),
            taskId,
            cause,
          }),
        ),
      )

      return yield* parseRepairDecisionEffect(session.responseText)
    })
  }

  applyAction(taskId: string, decision: SmartRepairDecision): Effect.Effect<Task, SmartRepairError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.db.getTask(taskId)
      if (!task) {
        return yield* new SmartRepairError({
          operation: "applyAction",
          message: `Task not found: ${taskId}`,
          taskId,
        })
      }

      const now = nowUnix()
      const reasonNote = `[repair] action=${decision.action} reason=${decision.reason}\n`
      let update: Record<string, unknown>

      if (decision.action === "queue_implementation") {
        update = {
          status: "executing",
          executionPhase: "implementation_pending",
          awaitingPlanApproval: false,
          errorMessage: null,
        }
      } else if (decision.action === "restore_plan_approval") {
        update = {
          status: "review",
          awaitingPlanApproval: true,
          executionPhase: "plan_complete_waiting_approval",
          errorMessage: null,
        }
      } else if (decision.action === "mark_done") {
        update = {
          status: "done",
          completedAt: now,
          errorMessage: null,
          awaitingPlanApproval: false,
          reviewActivity: "idle",
        }
      } else if (decision.action === "fail_task") {
        update = {
          status: "failed",
          errorMessage: decision.errorMessage || decision.reason,
          awaitingPlanApproval: false,
          reviewActivity: "idle",
        }
      } else if (decision.action === "continue_with_more_reviews") {
        update = {
          status: "backlog",
          reviewCount: 0,
          errorMessage: null,
          reviewActivity: "idle",
        }
      } else if (decision.action === "skip_code_style") {
        update = {
          status: "done",
          completedAt: now,
          errorMessage: null,
          awaitingPlanApproval: false,
          reviewActivity: "idle",
        }
      } else if (decision.action === "return_to_review") {
        update = {
          status: "review",
          errorMessage: null,
          reviewActivity: "idle",
          reviewCount: 0,
        }
      } else {
        update = {
          status: "backlog",
          reviewCount: 0,
          agentOutput: "",
          errorMessage: null,
          completedAt: null,
          sessionId: null,
          sessionUrl: null,
          worktreeDir: null,
          executionPhase: "not_started",
          awaitingPlanApproval: false,
          planRevisionCount: 0,
          bestOfNSubstage: "idle",
          reviewActivity: "idle",
        }
      }

      const updated = self.db.updateTask(taskId, update)
      if (!updated) {
        return yield* new SmartRepairError({
          operation: "applyAction",
          message: `Task not found after update: ${taskId}`,
          taskId,
        })
      }
      self.db.appendAgentOutput(taskId, reasonNote)
      return self.db.getTask(taskId) ?? updated
    })
  }

  repair(taskId: string, smartRepairHints?: string): Effect.Effect<SmartRepairDecision & { task: Task }, SmartRepairError> {
    const self = this
    return Effect.gen(function* () {
      const task = self.db.getTask(taskId)
      if (!task) {
        return yield* new SmartRepairError({
          operation: "repair",
          message: `Task not found: ${taskId}`,
          taskId,
        })
      }

      if (typeof smartRepairHints === "string") {
        self.db.updateTask(taskId, { smartRepairHints })
      }

      const decision = yield* self.decide(taskId)
      const updated = yield* self.applyAction(taskId, decision)
      return { ...decision, task: updated }
    })
  }
}