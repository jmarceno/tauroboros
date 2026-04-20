/**
 * Shared module exports.
 * 
 * This module provides shared utilities for the Effect migration:
 * - Domain errors (Schema.TaggedError based)
 * - Logging service
 * - Service tags for dependency injection
 * - Error codes (legacy, being migrated to typed errors)
 */

export * from "./errors.ts"
export * from "./logger.ts"
export * from "./services.ts"
export * from "./error-codes.ts"
