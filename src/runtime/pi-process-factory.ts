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
}

/**
 * Runtime mode for pi processes.
 */
export type PiRuntimeMode = "native" | "container"

/**
 * Get the configured runtime mode from environment.
 */
export function getConfiguredRuntime(): PiRuntimeMode {
  const envRuntime = process.env.PI_EASY_WORKFLOW_RUNTIME
  if (envRuntime === "container") return "container"
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
  const runtime = options.forceRuntime || getConfiguredRuntime()

  if (runtime === "container") {
    if (!options.containerManager) {
      throw new Error(
        "Container runtime requires a PiContainerManager instance. " +
          "Make sure to pass containerManager when creating the process.",
      )
    }

    // Check if session has a worktree directory (required for containers)
    if (!options.session.worktreeDir) {
      console.warn(
        "Container runtime requires a worktree directory. Falling back to native runtime.",
      )
      return new PiRpcProcess({
        db: options.db,
        session: options.session,
        onOutput: options.onOutput,
        onSessionMessage: options.onSessionMessage,
      })
    }

    return new ContainerPiProcess({
      db: options.db,
      session: options.session,
      containerManager: options.containerManager,
      onOutput: options.onOutput,
      onSessionMessage: options.onSessionMessage,
    })
  }

  return new PiRpcProcess({
    db: options.db,
    session: options.session,
    onOutput: options.onOutput,
    onSessionMessage: options.onSessionMessage,
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
): Promise<{
  available: boolean
  runtime: PiRuntimeMode
  issues: string[]
}> {
  const status = await containerManager.validateSetup()
  const configuredRuntime = getConfiguredRuntime()

  const issues: string[] = [...status.errors]

  if (configuredRuntime === "container" && !status.gvisor) {
    issues.push(
      "Container runtime is configured but gVisor is not available. " +
        "Install gVisor or set PI_EASY_WORKFLOW_RUNTIME=native",
    )
  }

  return {
    available: status.docker && status.gvisor && status.image,
    runtime: configuredRuntime,
    issues,
  }
}
