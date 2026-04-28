import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { SessionMessage } from "../types.ts"
import { Effect, Schema } from "effect"
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
  /**
   * Pi session file path for conversation history persistence.
   * If not specified, uses the session's piSessionFile.
   */
  piSessionFile?: string
  /**
   * Paths to Pi extension files to load via --extension flag.
   */
  extensionPaths?: string[]
}

/**
 * Runtime mode for pi processes.
 */
export type PiRuntimeMode = "native" | "container"

export class PiProcessFactoryError extends Schema.TaggedError<PiProcessFactoryError>()(
  "PiProcessFactoryError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Get the configured runtime mode from settings.
 * Container mode is the default. Mode must be explicitly disabled to use native.
 */
export function getConfiguredRuntime(settings?: InfrastructureSettings): PiRuntimeMode {
  // Explicitly check for native mode - container is the default
  if (settings?.workflow?.container?.enabled === false) return "native"
  return "container" // Default to container
}

export const createPiProcessEffect = Effect.fn("createPiProcessEffect")(
  function* (options: UnifiedPiProcessOptions) {
    const runtime = options.forceRuntime || getConfiguredRuntime(options.settings)

    if (runtime === "container") {
      if (!options.containerManager) {
        return yield* new PiProcessFactoryError({
          operation: "createPiProcess",
          message:
            "Container runtime requires a PiContainerManager instance. Make sure to pass containerManager when creating the process.",
        })
      }

      if (!options.session.worktreeDir) {
        return yield* new PiProcessFactoryError({
          operation: "createPiProcess",
          message:
            "Container runtime requires a worktree directory. Task cannot execute outside a container when container mode is enabled.",
        })
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
        extensionPaths: options.extensionPaths,
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
      piSessionFile: options.piSessionFile,
      extensionPaths: options.extensionPaths,
    })
  },
)

export const isContainerRuntimeAvailableEffect = Effect.fn("isContainerRuntimeAvailableEffect")(
  function* (containerManager?: PiContainerManager) {
    if (!containerManager) {
      return false
    }

    const status = yield* containerManager.validateSetup()

    return status.podman && status.image
  },
)

export const validateContainerSetupEffect = Effect.fn("validateContainerSetupEffect")(
  function* (
    containerManager: PiContainerManager,
    settings?: InfrastructureSettings,
  ) {
    const status = yield* containerManager.validateSetup()
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
  },
)
