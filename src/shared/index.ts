/**
 * Shared module exports.
 *
 * This module provides shared utilities for the Effect-first architecture:
 * - Domain errors (Schema.TaggedError based)
 * - Logging service
 * - Service tags for dependency injection
 * - Error codes (for API compatibility with frontend)
 */

export * from "./errors.ts"
export * from "./logger.ts"
export * from "./services.ts"
export * from "./error-codes.ts"
