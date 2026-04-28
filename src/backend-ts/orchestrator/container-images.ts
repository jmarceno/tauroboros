import { Effect } from "effect"
import { BASE_IMAGES } from "../config/base-images.ts"
import { resolveContainerImage, type Task } from "../types.ts"
import type { OrchestratorOperationError, ContainerImageOperations } from "./errors.ts"
import { OrchestratorOperationError as OrchestratorOperationErrorClass } from "./errors.ts"

/**
 * Context needed for image operations.
 */
export interface ImageValidationContext {
  containerManager?: { checkImageExists(imageName: string): Effect.Effect<boolean, unknown> }
  settingsWorkflowContainer?: { enabled?: boolean; image?: string }
  getTask(taskId: string): Task | null
}

/**
 * Check if a container image exists.
 * Uses the container manager if available, otherwise falls back to podman check.
 */
export function checkImageExistsEffect(
  imageName: string,
  context: ImageValidationContext,
): Effect.Effect<boolean, OrchestratorOperationError> {
  if (context.containerManager) {
    return context.containerManager.checkImageExists(imageName).pipe(
      Effect.mapError((cause) => new OrchestratorOperationErrorClass({
        operation: "checkImageExists",
        message: cause instanceof Error ? cause.message : String(cause),
      })),
    )
  }

  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["podman", "image", "exists", imageName], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      return exitCode === 0
    },
    catch: (cause) => new OrchestratorOperationErrorClass({
      operation: "checkImageExists",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  })
}

/**
 * Validate that all container images for the given tasks exist.
 * Returns an object with valid flag and list of invalid tasks.
 * Skips validation when container mode is disabled.
 */
export function validateWorkflowImagesEffect(
  taskIds: string[],
  context: ImageValidationContext,
): Effect.Effect<{
  valid: boolean
  invalid: { taskId: string; taskName: string; image: string }[]
}, OrchestratorOperationError> {
  return Effect.gen(function* () {
    const containerEnabled = context.settingsWorkflowContainer?.enabled !== false
    if (!containerEnabled) {
      return { valid: true, invalid: [] }
    }

    const invalid: { taskId: string; taskName: string; image: string }[] = []

    for (const taskId of taskIds) {
      const task = context.getTask(taskId)
      if (!task) continue

      const imageToCheck = resolveContainerImage(task, context.settingsWorkflowContainer?.image)

      if (imageToCheck) {
        const exists = yield* checkImageExistsEffect(imageToCheck, context)
        if (!exists) {
          invalid.push({
            taskId,
            taskName: task.name,
            image: imageToCheck,
          })
        }
      }
    }

    return { valid: invalid.length === 0, invalid }
  })
}

/**
 * Check if a container image is a "custom" image that was built for a specific workflow.
 * Custom images follow naming patterns like:
 *   - pi-agent:custom-{timestamp}
 *   - pi-agent:{profileId}-{timestamp}
 *
 * The default base image is NOT considered custom and should never be deleted.
 */
export function isCustomImage(imageName: string): boolean {
  if (!imageName) return false
  if (imageName === BASE_IMAGES.piAgent) return false
  const customPattern = /^pi-agent:[a-zA-Z]+-\d+$/
  return customPattern.test(imageName)
}

/**
 * Get container image operations or fail if container manager is not available.
 */
export function getContainerImageOperations(
  operation: string,
  containerManager?: { checkImageExists(imageName: string): Effect.Effect<boolean, unknown>; deleteImage(imageName: string): Effect.Effect<{ success: boolean; error?: string }, unknown> },
): Effect.Effect<ContainerImageOperations, OrchestratorOperationError> {
  if (!containerManager) {
    return Effect.fail(new OrchestratorOperationErrorClass({
      operation,
      message: "Container manager is not configured",
    }))
  }

  return Effect.succeed(containerManager as ContainerImageOperations)
}
