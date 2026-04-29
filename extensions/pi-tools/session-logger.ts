import { type ExtensionAPI, type AgentMessage, type AssistantMessage, type ToolResultMessage } from "@mariozechner/pi-coding-agent"

const PORT = Number(process.env.TAUROBOROS_PORT) || 3789
const SESSION_ID = process.env.TAUROBOROS_SESSION_ID || ""
const TASK_ID = process.env.TAUROBOROS_TASK_ID || ""
const TASK_RUN_ID = process.env.TAUROBOROS_TASK_RUN_ID || ""

const API_URL = `http://localhost:${PORT}/internal/session-messages`

function extractText(msg: AgentMessage): string {
  const content = msg.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ")
  }
  return ""
}

function serializeContent(msg: AgentMessage): any {
  return { text: extractText(msg) }
}

async function postMessage(payload: Record<string, unknown>) {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "unknown")
      console.error(`[session-logger] POST failed (${res.status}): ${body}`)
    }
  } catch {
    // Silently ignore — server might be starting up or shutting down
  }
}

export default function (pi: ExtensionAPI) {
  if (!SESSION_ID) {
    return
  }

  pi.on("message_end", async (event) => {
    const msg = event.message as AgentMessage
    const role = msg.role

    if (role === "user") {
      // User messages are already persisted by the backend's send_message handler.
      return
    }

    if (role === "assistant") {
      const asstMsg = msg as AssistantMessage
      const modelProvider = asstMsg.provider
      const modelId = asstMsg.model
      const usage = asstMsg.usage

      const contentParts = Array.isArray(msg.content) ? msg.content : []
      const thinkingParts = contentParts.filter((c: any) => c.type === "thinking")

      await postMessage({
        type: "message",
        sessionId: SESSION_ID,
        taskId: TASK_ID || undefined,
        taskRunId: TASK_RUN_ID || undefined,
        messageId: msg.id || asstMsg.responseId || crypto.randomUUID(),
        role: "assistant",
        messageType: "assistant_response",
        eventName: "message_end",
        content: serializeContent(msg),
        text: extractText(msg),
        timestamp: asstMsg.timestamp || Date.now(),
        modelProvider,
        modelId,
        agentName: undefined,
        usage: usage
          ? {
              input: usage.inputTokens ?? usage.input ?? 0,
              output: usage.outputTokens ?? usage.output ?? 0,
              cacheRead: usage.cacheRead ?? 0,
              cacheWrite: usage.cacheWrite ?? 0,
              totalTokens: usage.totalTokens ?? 0,
            }
          : undefined,
        cost: usage?.cost
          ? {
              input: usage.cost.input ?? 0,
              output: usage.cost.output ?? 0,
              cacheRead: usage.cost.cacheRead ?? 0,
              cacheWrite: usage.cost.cacheWrite ?? 0,
              total: usage.cost.total ?? 0,
            }
          : undefined,
        thinking: thinkingParts.length > 0 ? thinkingParts.map((t: any) => t.thinking).join("\n") : undefined,
      })
    } else if (role === "toolResult" || role === "tool") {
      const toolMsg = msg as ToolResultMessage
      await postMessage({
        type: "message",
        sessionId: SESSION_ID,
        taskId: TASK_ID || undefined,
        taskRunId: TASK_RUN_ID || undefined,
        messageId: msg.id || crypto.randomUUID(),
        role: "tool",
        messageType: "tool_result",
        eventName: "message_end",
        content: serializeContent(msg),
        text: extractText(msg),
        timestamp: toolMsg.timestamp || Date.now(),
        toolCallId: toolMsg.toolCallId,
        toolName: toolMsg.toolName,
        toolIsError: toolMsg.isError,
      })
    }
  })

  pi.on("tool_execution_end", async (event) => {
    await postMessage({
      type: "tool_execution",
      sessionId: SESSION_ID,
      taskId: TASK_ID || undefined,
      taskRunId: TASK_RUN_ID || undefined,
      messageId: crypto.randomUUID(),
      role: "tool",
      messageType: "tool_call",
      eventName: "tool_execution_end",
      text: "",
      timestamp: Date.now(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      toolArgs: event.args,
      toolResult: event.result,
      toolIsError: event.isError,
    })
  })

  pi.on("agent_start", async () => {
    await postMessage({
      type: "lifecycle",
      sessionId: SESSION_ID,
      taskId: TASK_ID || undefined,
      taskRunId: TASK_RUN_ID || undefined,
      messageId: crypto.randomUUID(),
      role: "system",
      messageType: "step_start",
      eventName: "agent_start",
      text: "",
      timestamp: Date.now(),
    })
  })

  pi.on("agent_end", async () => {
    await postMessage({
      type: "lifecycle",
      sessionId: SESSION_ID,
      taskId: TASK_ID || undefined,
      taskRunId: TASK_RUN_ID || undefined,
      messageId: crypto.randomUUID(),
      role: "system",
      messageType: "step_finish",
      eventName: "agent_end",
      text: "",
      timestamp: Date.now(),
    })
  })
}
