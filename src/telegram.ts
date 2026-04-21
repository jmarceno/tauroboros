import { formatTimestampForNotification } from "./utils/date-format.ts"
import type { TelegramNotificationLevel, TaskStatus } from "./types.ts"
import { Effect, Schema } from "effect"

export type { TelegramNotificationLevel }

export const NOTIFICATION_LEVELS: TelegramNotificationLevel[] = [
  "all",
  "failures",
  "done_and_failures",
  "workflow_done_and_failures",
]

export class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface TelegramConfig {
  botToken: string
  chatId: string
}

export interface TelegramSendResult {
  success: boolean
  messageId?: number
  error?: string
}

interface TelegramApiResponse {
  ok: boolean
  result?: {
    message_id?: number
  }
}

export interface NotificationContext {
  isWorkflowDone?: boolean
  hasFailures?: boolean
}

/**
 * Determines whether a notification should be sent based on the notification level.
 *
 * @param level - The notification level setting
 * @param oldStatus - The previous task status
 * @param newStatus - The new task status
 * @param context - Additional context (workflow completion, failures, etc.)
 * @returns true if the notification should be sent
 */
export function shouldSendNotification(
  level: TelegramNotificationLevel,
  oldStatus: TaskStatus,
  newStatus: TaskStatus,
  context: NotificationContext = {},
): boolean {
  switch (level) {
    case "all":
      return true

    case "failures":
      return newStatus === "failed" || newStatus === "stuck"

    case "done_and_failures":
      return newStatus === "done" || newStatus === "failed" || newStatus === "stuck"

    case "workflow_done_and_failures":
      // Send on workflow completion OR on task failures
      if (context.isWorkflowDone === true) {
        return true
      }
      return newStatus === "failed" || newStatus === "stuck"

    default:
      throw new TelegramError({
        operation: "shouldSendNotification",
        message: `Unsupported telegram notification level: ${String(level)}`,
      })
  }
}

const STATUS_EMOJI: Record<TaskStatus, string> = {
  template: "📄",
  backlog: "📌",
  queued: "⏳",
  executing: "▶️",
  review: "🧩",
  "code-style": "🧹",
  done: "✅",
  failed: "❌",
  stuck: "🚫",
}

function buildMessage(taskName: string, oldStatus: TaskStatus, newStatus: TaskStatus): string {
  const emoji = STATUS_EMOJI[newStatus]
  const time = formatTimestampForNotification()
  return [
    `${emoji} *Task State Update*`,
    ``,
    `*Task:* ${taskName}`,
    `*From:* \`${oldStatus}\` → *To:* \`${newStatus}\``,
    ``,
    `_${time}_`,
  ].join("\n")
}

function buildWorkflowSummaryMessage(
  runName: string,
  totalTasks: number,
  completedTasks: number,
  failedTasks: number,
  stuckTasks: number,
): string {
  const time = formatTimestampForNotification()
  const status = failedTasks > 0 || stuckTasks > 0 ? "❌ FAILED" : "✅ COMPLETED"

  return [
    `🏁 *Workflow ${status}*`,
    ``,
    `*Run:* ${runName}`,
    ``,
    `📊 *Summary:*`,
    `  • Total: ${totalTasks}`,
    `  • Completed: ${completedTasks}`,
    `  • Failed: ${failedTasks}`,
    `  • Stuck: ${stuckTasks}`,
    ``,
    `_${time}_`,
  ].join("\n")
}

function sendTelegramMessageEffect(
  config: TelegramConfig,
  message: string,
): Effect.Effect<TelegramSendResult, TelegramError> {
  return Effect.gen(function* () {
    if (!config.botToken || !config.chatId) {
      return yield* new TelegramError({
        operation: "send",
        message: "Telegram bot token or chat ID not configured",
      })
    }

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

    return yield* Effect.tryPromise({
      try: async () => {
        const body = new URLSearchParams({
          chat_id: config.chatId,
          text: message,
          parse_mode: "Markdown",
        })
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        })

        if (!response.ok) {
          const body = await response.text()
          throw new TelegramError({
            operation: "send",
            message: `HTTP ${response.status}: ${body}`,
          })
        }

        const data = await response.json() as TelegramApiResponse
        if (!data.ok) {
          throw new TelegramError({
            operation: "send",
            message: "Telegram API returned ok=false for sendMessage",
            cause: data,
          })
        }

        return { success: true, messageId: data.result?.message_id } as TelegramSendResult
      },
      catch: (cause) =>
        new TelegramError({
          operation: "send",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })
  })
}

export function sendTelegramNotificationEffect(
  config: TelegramConfig,
  taskName: string,
  oldStatus: TaskStatus,
  newStatus: TaskStatus,
): Effect.Effect<TelegramSendResult, TelegramError> {
  const message = buildMessage(taskName, oldStatus, newStatus)
  return sendTelegramMessageEffect(config, message)
}

export function sendTelegramWorkflowSummaryEffect(
  config: TelegramConfig,
  runName: string,
  totalTasks: number,
  completedTasks: number,
  failedTasks: number,
  stuckTasks: number,
): Effect.Effect<TelegramSendResult, TelegramError> {
  const message = buildWorkflowSummaryMessage(runName, totalTasks, completedTasks, failedTasks, stuckTasks)
  return sendTelegramMessageEffect(config, message)
}
