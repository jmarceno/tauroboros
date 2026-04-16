import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { SessionMessage } from "../types.ts"
import { ContainerPiProcess } from "./container-pi-process.ts"
import type { PiContainerManager } from "./container-manager.ts"
import { PiRpcProcess } from "./pi-process.ts"
import { BASE_IMAGES } from "../config/base-images.ts"

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
  /**
   * Existing container ID to reuse (for resume operations).
   */
  existingContainerId?: string | null
  /**
   * Container image to use when creating a new container (for resume operations).
   * If not specified, uses the default image from settings.
   */
  containerImage?: string | null
}

/**
 * Runtime mode for pi processes.
 */
export type PiRuntimeMode = "native" | "container"

/**
 * Get the configured runtime mode from settings.
 * Container mode is the default. Mode must be explicitly disabled to use native.
 */
export function getConfiguredRuntime(settings?: InfrastructureSettings): PiRuntimeMode {
  // Explicitly check for native mode - container is the default
  if (settings?.workflow?.container?.enabled === false) return "native"
  return "container" // Default to container
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
      throw new Error(
        "Container runtime requires a worktree directory. " +
          "Task cannot execute outside a container when container mode is enabled."
      )
    }

    return new ContainerPiProcess({
      db: options.db,
      session: options.session,
      containerManager: options.containerManager,
      onOutput: options.onOutput,
      onSessionMessage: options.onSessionMessage,
      settings: options.settings,
      systemPrompt: options.systemPrompt,
      disableAutoSessionMessages: options.disableAutoSessionMessages,
      existingContainerId: options.existingContainerId,
      containerImage: options.containerImage,
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
    return status.podman && status.image
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

  if (configuredRuntime === "container" && !status.podman) {
    issues.push(
      "Container runtime is configured but Podman is not available. " +
        "Install Podman or set workflow.container.enabled to false in .tauroboros/settings.json",
    )
  }

  if (configuredRuntime === "container" && !status.image) {
    issues.push(
      `Container runtime is configured but the image is not available. ` +
        `Build it with: podman build -t ${settings?.workflow?.container?.image ?? BASE_IMAGES.piAgent} -f docker/pi-agent/Dockerfile .`,
    )
  }

  return {
    available: status.podman && status.image,
    runtime: configuredRuntime,
    issues,
  }
}
