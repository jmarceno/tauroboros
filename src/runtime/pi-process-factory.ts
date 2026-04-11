import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { SessionMessage } from "../types.ts"
import { ContainerPiProcess } from "./container-pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { PiRpcProcess } from "./pi-process.ts"

export interface UnifiedPiProcessOptions {
  db: PiKanbanDB
  session: PiWorkflowSession
  containerManager?: PiContainerManager
  onOutput?: (chunk: string) => void
  onSessionMessage?: (message: SessionMessage) => void
  forceRuntime?: "native" | "container"
  settings?: InfrastructureSettings
  systemPrompt?: string
  disableAutoSessionMessages?: boolean
}

/**
 * Runtime mode for pi processes.
 */
export type PiRuntimeMode = "native" | "container"

/**
 * Get the configured runtime mode from settings.
 */
export function getConfiguredRuntime(settings?: InfrastructureSettings): PiRuntimeMode {
  if (settings?.workflow?.runtime?.mode === "container") return "container"
  return "native" // Default to native
}

/**
 * Create a pi process (native or containerized) based on configuration.
 *
 * Native mode: Spawns pi directly on the host (current behavior)
 * Container mode: Runs pi inside a gVisor container for isolation
 */
export function createPiProcess(
  options: UnifiedPiProcessOptions,
): PiRpcProcess | ContainerPiProcess {
  const runtime = options.forceRuntime || getConfiguredRuntime(options.settings)

  if (runtime === "container") {
    if (!options.containerManager) {
      throw new Error(
        "Container runtime requires a PiContainerManager instance. " +
          "Make sure to pass containerManager when creating the process.",
      )
    }

    if (!options.session.worktreeDir) {
      console.warn(
        "Container runtime requires a worktree directory. Falling back to native runtime.",
      )
      return new PiRpcProcess({
        db: options.db,
        session: options.session,
        onOutput: options.onOutput,
        onSessionMessage: options.onSessionMessage,
        settings: options.settings,
        systemPrompt: options.systemPrompt,
        disableAutoSessionMessages: options.disableAutoSessionMessages,
      })
    }

    return new ContainerPiProcess({
      db: options.db,
      session: options.session,
      containerManager: options.containerManager,
      onOutput: options.onOutput,
      onSessionMessage: options.onSessionMessage,
      settings: options.settings,
    })
  }

  return new PiRpcProcess({
    db: options.db,
    session: options.session,
    onOutput: options.onOutput,
    onSessionMessage: options.onSessionMessage,
    settings: options.settings,
    systemPrompt: options.systemPrompt,
    disableAutoSessionMessages: options.disableAutoSessionMessages,
  })
}

/**
 * Check if container runtime is available and properly configured.
 */
export async function isContainerRuntimeAvailable(
  containerManager?: PiContainerManager,
): Promise<boolean> {
  if (!containerManager) return false

  try {
    const status = await containerManager.validateSetup()
    return status.docker && status.gvisor && status.image
  } catch {
    return false
  }
}

/**
 * Validate container runtime setup and return detailed status.
 */
export async function validateContainerSetup(
  containerManager: PiContainerManager,
  settings?: InfrastructureSettings,
): Promise<{
  available: boolean
  runtime: PiRuntimeMode
  issues: string[]
}> {
  const status = await containerManager.validateSetup()
  const configuredRuntime = getConfiguredRuntime(settings)

  const issues: string[] = [...status.errors]

  if (configuredRuntime === "container" && !status.gvisor) {
    issues.push(
      "Container runtime is configured but gVisor is not available. " +
        "Update .pi/settings.json workflow.runtime.mode to 'native' or install gVisor",
    )
  }

  return {
    available: status.docker && status.gvisor && status.image,
    runtime: configuredRuntime,
    issues,
  }
}
