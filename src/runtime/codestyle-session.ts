import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import { resolveContainerImage, type Task, type ThinkingLevel, resolveCodeStylePrompt } from "../types.ts"
import { PiSessionManager } from "./session-manager.ts"
import type { PiContainerManager } from "./container-manager.ts"

export interface RunCodeStyleInput {
  task: Task
  cwd: string
  worktreeDir: string
  branch: string
  codeStylePrompt: string
  model: string
  thinkingLevel: ThinkingLevel
  onOutput?: (chunk: string) => void
  onSessionCreated?: (process: import("./container-pi-process.ts").ContainerPiProcess | import("./pi-process.ts").PiRpcProcess, session: import("../db/types.ts").PiWorkflowSession) => void
}

export interface RunCodeStyleResult {
  success: boolean
  responseText: string
  sessionId: string
  errorMessage?: string
}

/**
 * CodeStyleSessionRunner - Manages a single-pass code style check session
 *
 * Similar to PiReviewSessionRunner but:
 * - Uses reviewModel and reviewThinkingLevel from options
 * - Runs a single pass (no retry loop)
 * - The agent uses edit tool to apply fixes directly
 */
export class CodeStyleSessionRunner {
  private readonly sessions: PiSessionManager

  constructor(
    private readonly db: PiKanbanDB,
    private readonly settings?: InfrastructureSettings,
    containerManager?: PiContainerManager,
    externalSessionManager?: PiSessionManager,
  ) {
    this.sessions = externalSessionManager ?? new PiSessionManager(db, containerManager, settings)
  }

  async run(input: RunCodeStyleInput): Promise<RunCodeStyleResult> {
    const promptText = resolveCodeStylePrompt(input.codeStylePrompt)
    const imageToUse = resolveContainerImage(input.task, this.settings?.workflow?.container?.image)

    const response = await this.sessions.executePrompt({
      taskId: input.task.id,
      sessionKind: "task_run_reviewer",
      cwd: input.cwd,
      worktreeDir: input.worktreeDir,
      branch: input.branch,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      promptText,
      containerImage: imageToUse,
      onOutput: input.onOutput,
      onSessionCreated: input.onSessionCreated,
    })

    const session = this.db.getWorkflowSession(response.session.id)
    const finalStatus = session?.status ?? "completed"

    const success = finalStatus === "completed"

    return {
      success,
      responseText: response.responseText,
      sessionId: response.session.id,
      errorMessage: success ? undefined : session?.errorMessage ?? undefined,
    }
  }
}
