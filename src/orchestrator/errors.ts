import { Schema } from "effect"
import { ErrorCode } from "../shared/error-codes.ts"

/**
 * Error type for orchestrator operations.
 * Tagged error following Effect best practices.
 */
export class OrchestratorOperationError extends Schema.TaggedError<OrchestratorOperationError>()(
  "OrchestratorOperationError",
  {
    operation: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.Enums(ErrorCode)),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * Type for container image operations.
 */
export type ContainerImageOperations = {
  checkImageExists(imageName: string): import("effect").Effect.Effect<boolean, unknown>
  deleteImage(imageName: string): import("effect").Effect.Effect<{ success: boolean; error?: string }, unknown>
}
