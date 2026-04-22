/**
 * Shared domain errors for the Effect migration.
 * 
 * This module provides the base error types used across the application.
 * All domain errors should use Schema.TaggedError for type-safe error handling.
 */

import { Schema } from "effect"

/**
 * Base error for all domain failures.
 * All specific domain errors should extend this pattern.
 */
export class DomainError extends Schema.TaggedError<DomainError>()("DomainError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for configuration/validation failures.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for database operations.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for runtime/execution failures.
 */
export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
  operation: Schema.String,
  message: Schema.String,
  context: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for network/HTTP operations.
 */
export class NetworkError extends Schema.TaggedError<NetworkError>()("NetworkError", {
  operation: Schema.String,
  message: Schema.String,
  statusCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for orchestration/workflow failures.
 */
export class OrchestrationError extends Schema.TaggedError<OrchestrationError>()("OrchestrationError", {
  operation: Schema.String,
  message: Schema.String,
  runId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for validation failures.
 */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
  field: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for not-found scenarios.
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  resource: Schema.String,
  id: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

/**
 * Error for conflict scenarios (e.g., duplicate resources).
 */
export class ConflictError extends Schema.TaggedError<ConflictError>()("ConflictError", {
  resource: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for timeout scenarios.
 */
export class TimeoutError extends Schema.TaggedError<TimeoutError>()("TimeoutError", {
  operation: Schema.String,
  message: Schema.String,
  timeoutMs: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for container operations.
 */
export class ContainerError extends Schema.TaggedError<ContainerError>()("ContainerError", {
  operation: Schema.String,
  message: Schema.String,
  containerId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error for process operations.
 */
export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  operation: Schema.String,
  message: Schema.String,
  processId: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Union type of all domain errors.
 * Use this for functions that can fail with multiple error types.
 */
export type ApplicationError =
  | DomainError
  | ConfigError
  | DatabaseError
  | RuntimeError
  | NetworkError
  | OrchestrationError
  | ValidationError
  | NotFoundError
  | ConflictError
  | TimeoutError
  | ContainerError
  | ProcessError
