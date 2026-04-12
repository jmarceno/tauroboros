import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import {
  PiContainerManager,
  type ContainerConfig,
  type ContainerProcess,
} from "./container-manager.ts"
import type { PiEventListener, ExtensionUIRequestHandler } from "./pi-process.ts"
import type { PiRpcRequest, PiRpcResponse } from "./pi-rpc.ts"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pullResponseText(result: Record<string, unknown>): string {
  if (typeof result.text === "string") return result.text
  if (typeof result.output === "string") return result.output
  const message = result.message
  if (typeof message === "string") return message
  if (message && typeof message === "object") {
    const messageText = (message as Record<string, unknown>).text
    if (typeof messageText === "string") return messageText
  }
  return ""
}

/**
 * ContainerPiProcess - Docker/gVisor backed Pi process implementation.
 *
 * This backend runs the pi agent inside a gVisor container for isolation:
 * - Filesystem isolation: Can only access worktree and repo (read-only)
 * - Port isolation: Runs in separate network namespace
 * - Security: Drops all capabilities, no new privileges
 */
export class ContainerPiProcess {
  private readonly db: PiKanbanDB
  private readonly session: PiWorkflowSession
  private readonly containerManager: PiContainerManager
  private readonly onOutput?: (chunk: string) => void
  private readonly onSessionMessage?: (
    message: import("../types.ts").SessionMessage,
  ) => void
  private readonly settings?: InfrastructureSettings

  private containerProcess: ContainerProcess | null = null
  private requestId = 0
  private readonly pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private eventListeners: PiEventListener[] = []
  private extensionUIHandler: ExtensionUIRequestHandler | null = null
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private isIdle = true
  private abortController: AbortController | null = null
  private existingContainerId: string | null = null
  private containerImage: string | null = null

  constructor(args: {
    db: PiKanbanDB
    session: PiWorkflowSession
    containerManager: PiContainerManager
    onOutput?: (chunk: string) => void
    onSessionMessage?: (message: import("../types.ts").SessionMessage) => void
    settings?: InfrastructureSettings
    existingContainerId?: string | null
    containerImage?: string | null
  }) {
    this.db = args.db
    this.session = args.session
    this.containerManager = args.containerManager
    this.onOutput = args.onOutput
    this.onSessionMessage = args.onSessionMessage
    this.settings = args.settings
    this.existingContainerId = args.existingContainerId ?? null
    this.containerImage = args.containerImage ?? null
  }

  /**
   * Start the containerized pi process.
   */
  async start(): Promise<void> {
    if (this.containerProcess) return

    // Determine container configuration from settings or resume parameters
    const containerSettings = this.settings?.workflow?.container
    // Use containerImage from resume if provided, otherwise fall back to settings
    const imageName = this.containerImage || containerSettings?.image || "pi-agent:alpine"
    const runtime = "runc" // Always use runc now, removed gVisor dependency
    const memoryMb = containerSettings?.memoryMb || 512
    const cpuCount = containerSettings?.cpuCount || 1

    const worktreeDir = this.session.worktreeDir
    if (!worktreeDir) {
      throw new Error("ContainerPiProcess requires a worktree directory")
    }

    const repoRoot = worktreeDir.replace(/\/\.worktrees\/[^/]+$/, "")

    // Check if we have an existing container to reuse (for resume operations)
    if (this.existingContainerId) {
      const containerInfo = await this.containerManager.checkContainerById(this.existingContainerId)
      if (containerInfo?.running) {
        console.log(`[container-pi-process] Attaching to existing container ${this.existingContainerId}`)
        // Try to attach to the existing container to preserve all state
        const attachedProcess = await this.containerManager.attachToContainer(
          this.existingContainerId,
          this.session.id
        )
        if (attachedProcess) {
          this.containerProcess = attachedProcess
          console.log(`[container-pi-process] Successfully attached to container ${this.existingContainerId}`)
          
          this.db.updateWorkflowSession(this.session.id, {
            status: "active",
          })
          this.db.appendSessionIO({
            sessionId: this.session.id,
            stream: "server",
            recordType: "lifecycle",
            payloadJson: {
              type: "container_attached",
              containerId: this.containerProcess.containerId,
              image: imageName,
              runtime,
            },
          })

          this.abortController = new AbortController()
          this.captureStdout()
          this.captureStderr()

          await new Promise((resolve) => setTimeout(resolve, 1000))
          return
        } else {
          console.log(`[container-pi-process] Failed to attach to container ${this.existingContainerId}, will create new one`)
        }
      } else {
        console.log(`[container-pi-process] Existing container ${this.existingContainerId} not running, creating new one`)
      }
    }

    const containerConfig: ContainerConfig = {
      sessionId: this.session.id,
      worktreeDir,
      repoRoot,
      imageName,
      memoryMb,
      cpuCount,
    }

    this.containerProcess = await this.containerManager.createContainer(
      containerConfig,
    )

    this.db.updateWorkflowSession(this.session.id, {
      status: "active",
    })
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "server",
      recordType: "lifecycle",
      payloadJson: {
        type: "container_started",
        containerId: this.containerProcess.containerId,
        image: imageName,
        runtime,
      },
    })

    this.abortController = new AbortController()

    this.captureStdout()
    this.captureStderr()

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  /**
   * Subscribe to agent events.
   */
  onEvent(listener: PiEventListener): () => void {
    this.eventListeners.push(listener)
    return () => {
      const index = this.eventListeners.indexOf(listener)
      if (index !== -1) {
        this.eventListeners.splice(index, 1)
      }
    }
  }

  /**
   * Set handler for extension UI requests.
   */
  setExtensionUIHandler(handler: ExtensionUIRequestHandler): void {
    this.extensionUIHandler = handler
  }

  /**
   * Send a command and wait for response.
   */
  async send(
    command: { type: string } & Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    if (!this.containerProcess) {
      throw new Error("Container process not started")
    }

    const id = `req_${++this.requestId}`
    const payload: PiRpcRequest = { ...command, id }
    const line = `${JSON.stringify(payload)}\n`

    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stdin",
      recordType: "rpc_command",
      payloadJson: payload,
      payloadText: JSON.stringify(payload),
    })

    // Write to container stdin
    const writer = this.containerProcess.stdin.getWriter()
    await writer.write(new TextEncoder().encode(line))
    writer.releaseLock()

    if (
      command.type === "prompt" ||
      command.type === "steer" ||
      command.type === "follow_up"
    ) {
      this.isIdle = false
    }

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC timeout for command ${command.type}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  /**
   * Send a prompt (returns immediately, use onEvent/waitForIdle for results).
   */
  async prompt(message: string): Promise<void> {
    await this.send({ type: "prompt", message }, 10_000)
  }

  /**
   * Wait for agent to become idle.
   */
  waitForIdle(timeoutMs = 600_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isIdle) {
        resolve()
        return
      }

      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timeout waiting for agent to become idle`))
      }, timeoutMs)

      const unsubscribe = this.onEvent((event) => {
        if (event.type === "agent_end") {
          this.isIdle = true
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
  }

  /**
   * Collect all events until agent becomes idle.
   */
  collectEvents(timeoutMs = 600_000): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const events: Record<string, unknown>[] = []

      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timeout collecting events`))
      }, timeoutMs)

      const unsubscribe = this.onEvent((event) => {
        events.push(event)
        if (event.type === "agent_end") {
          this.isIdle = true
          clearTimeout(timer)
          unsubscribe()
          resolve(events)
        }
      })
    })
  }

  /**
   * Send prompt and wait for completion.
   */
  async promptAndWait(
    message: string,
    timeoutMs = 600_000,
  ): Promise<Record<string, unknown>[]> {
    const eventsPromise = this.collectEvents(timeoutMs)
    await this.prompt(message)
    return eventsPromise
  }

  /**
   * Close the container process.
   */
  async close(): Promise<void> {
    if (!this.containerProcess) return

    const process = this.containerProcess
    this.containerProcess = null

    // Signal stream readers to stop
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    // Reject all pending requests
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(
        new Error(`Container process closed before RPC response (${id})`),
      )
      this.pending.delete(id)
    }

    // Kill container
    try {
      await process.kill()
    } catch {
      // Container may already be stopped
    }

    this.db.updateWorkflowSession(this.session.id, {
      status: "completed",
      finishedAt: Math.floor(Date.now() / 1000),
    })
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "server",
      recordType: "lifecycle",
      payloadJson: {
        type: "container_stopped",
      },
    })
  }

  /**
   * Force kill the container immediately without waiting for graceful shutdown.
   * Used for emergency stop and destructive operations.
   */
  async forceKill(): Promise<void> {
    if (!this.containerProcess) return

    const process = this.containerProcess
    this.containerProcess = null

    // Signal stream readers to stop
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    // Reject all pending requests immediately
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`Container process force killed (${id})`))
      this.pending.delete(id)
    }

    // Force kill the container
    try {
      await process.kill()
    } catch {
      // Container may already be stopped
    }

    // Don't wait for exit - force kill is immediate
    this.db.updateWorkflowSession(this.session.id, {
      status: "aborted",
      finishedAt: Math.floor(Date.now() / 1000),
      exitCode: -1,
      exitSignal: "SIGKILL",
    })
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "server",
      recordType: "lifecycle",
      payloadJson: {
        type: "container_force_killed",
      },
    })
  }

  /**
   * Get the container ID for this process.
   * Used for pause/resume operations.
   */
  async getContainerId(): Promise<string | null> {
    return this.containerProcess?.containerId ?? null
  }

  private captureStdout(): void {
    if (!this.containerProcess || !this.abortController) return

    const reader = this.containerProcess.stdout.getReader()
    const decoder = new TextDecoder()
    const signal = this.abortController.signal

    const loop = async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done || signal.aborted) break
          this.stdoutBuffer += decoder.decode(value, { stream: true })
          this.consumeStdoutLines()
        }
        if (this.stdoutBuffer.trim() && !signal.aborted) {
          this.handleStdoutLine(this.stdoutBuffer.trim())
          this.stdoutBuffer = ""
        }
      } finally {
        reader.releaseLock()
      }
    }

    void loop()
  }

  private consumeStdoutLines(): void {
    while (true) {
      const newlineIdx = this.stdoutBuffer.indexOf("\n")
      if (newlineIdx < 0) break
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1)
      if (!line) continue
      this.handleStdoutLine(line)
    }
  }

  private async handleStdoutLine(line: string): Promise<void> {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not JSON, treat as text event
      parsed = { type: "text", text: line }
    }

    const id = typeof parsed.id === "string" ? parsed.id : null
    const isResponse = parsed.type === "response" && id !== null
    const isExtensionUIRequest =
      parsed.type === "extension_ui_request" && id !== null

    // Record in database first
    const recordType = isResponse ? "rpc_response" : "rpc_event"
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stdout",
      recordType,
      payloadJson: parsed,
      payloadText: line,
    })

    if (isResponse && id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(pending.timer)

      const response = parsed as unknown as PiRpcResponse
      if (response.success === false) {
        const errorMsg =
          typeof response.error === "string"
            ? response.error
            : JSON.stringify(response.error)
        pending.reject(new Error(errorMsg))
      } else {
        pending.resolve(asRecord(response.data))
      }
      return
    }

    if (isExtensionUIRequest && this.extensionUIHandler) {
      try {
        const response = await this.extensionUIHandler(
          parsed as { id: string; method: string; [key: string]: unknown },
        )
        await this.send(response, 10_000)
      } catch {
        // Send cancelled response if handler fails
        await this.send(
          {
            type: "extension_ui_response",
            id: parsed.id,
            cancelled: true,
          },
          10_000,
        ).catch(() => {})
      }
      return
    }

    // Broadcast to event listeners
    for (const listener of this.eventListeners) {
      try {
        listener(parsed)
      } catch {
        // Ignore listener errors
      }
    }

    // Output handling
    const text = pullResponseText(parsed)
    if (text && this.onOutput) {
      this.onOutput(text)
    }

    // Session message projection would go here if needed
    // For now, we rely on the event listeners and IO logging
  }

  private captureStderr(): void {
    if (!this.containerProcess || !this.abortController) return

    const reader = this.containerProcess.stderr.getReader()
    const decoder = new TextDecoder()
    const signal = this.abortController.signal

    const loop = async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done || signal.aborted) break
          this.stderrBuffer += decoder.decode(value, { stream: true })
          this.consumeStderrLines()
        }
        if (this.stderrBuffer.trim() && !signal.aborted) {
          this.persistStderr(this.stderrBuffer.trim())
          this.stderrBuffer = ""
        }
      } finally {
        reader.releaseLock()
      }
    }

    void loop()
  }

  private consumeStderrLines(): void {
    while (true) {
      const newlineIdx = this.stderrBuffer.indexOf("\n")
      if (newlineIdx < 0) break
      const line = this.stderrBuffer.slice(0, newlineIdx).trim()
      this.stderrBuffer = this.stderrBuffer.slice(newlineIdx + 1)
      if (!line) continue
      this.persistStderr(line)
    }
  }

  private persistStderr(line: string): void {
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stderr",
      recordType: "stderr_chunk",
      payloadText: line,
      payloadJson: { line },
    })
  }
}
