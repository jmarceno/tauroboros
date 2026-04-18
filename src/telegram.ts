import { formatTimestampForNotification } from "./utils/date-format.ts"
import type { TelegramNotificationLevel, TaskStatus } from "./types.ts"

export type { TelegramNotificationLevel }

export const NOTIFICATION_LEVELS: TelegramNotificationLevel[] = [
  "all",
  "failures",
  "done_and_failures",
  "workflow_done_and_failures",
]

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
      // Unknown level - treat as 'all' for backwards compatibility
      return true
  }
}

const STATUS_EMOJI: Record<string, string> = {
  template: "📄",
  backlog: "📌",
  executing: "▶️",
  review: "🧩",
  done: "✅",
  failed: "❌",
  stuck: "🚫",
}

function buildMessage(taskName: string, oldStatus: string, newStatus: string): string {
  const emoji = STATUS_EMOJI[newStatus] ?? "💬"
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

export async function sendTelegramNotification(
  config: TelegramConfig,
  taskName: string,
  oldStatus: string,
  newStatus: string,
  logger: (msg: string) => void = console.log
): Promise<TelegramSendResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, error: "not configured" }
  }

  const message = buildMessage(taskName, oldStatus, newStatus)
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      logger(`[telegram] send failed: ${response.status} ${body}`)
      return { success: false, error: `HTTP ${response.status}: ${body}` }
    }

    let messageId: number | undefined
    try {
      const data = await response.json() as TelegramApiResponse
      messageId = data.result?.message_id
    } catch {
      // JSON parsing failed - notification was still sent successfully
    }

    logger(`[telegram] notification sent for "${taskName}" (${oldStatus} → ${newStatus})`)
    return { success: true, messageId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger(`[telegram] send error: ${msg}`)
    return { success: false, error: msg }
  }
}

/**
 * Send a workflow completion summary notification.
 */
export async function sendTelegramWorkflowSummary(
  config: TelegramConfig,
  runName: string,
  totalTasks: number,
  completedTasks: number,
  failedTasks: number,
  stuckTasks: number,
  logger: (msg: string) => void = console.log
): Promise<TelegramSendResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, error: "not configured" }
  }

  const message = buildWorkflowSummaryMessage(runName, totalTasks, completedTasks, failedTasks, stuckTasks)
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      logger(`[telegram] workflow summary send failed: ${response.status} ${body}`)
      return { success: false, error: `HTTP ${response.status}: ${body}` }
    }

    let messageId: number | undefined
    try {
      const data = await response.json() as TelegramApiResponse
      messageId = data.result?.message_id
    } catch {
      // JSON parsing failed - notification was still sent successfully
    }

    logger(`[telegram] workflow summary sent for "${runName}" (${completedTasks}/${totalTasks} done, ${failedTasks} failed, ${stuckTasks} stuck)`)
    return { success: true, messageId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger(`[telegram] workflow summary send error: ${msg}`)
    return { success: false, error: msg }
  }
}
