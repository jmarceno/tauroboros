import { inspect } from "node:util"
/**
 * Structured logging service using Effect.
 * 
 * This module provides the centralized logging infrastructure for the application.
 * All operational logging should use Effect.log with structured metadata.
 */

import { Effect, Context, Layer, Logger } from "effect"

/**
 * Log metadata for structured logging.
 */
export interface LogMetadata {
  readonly runId?: string
  readonly taskId?: string
  readonly taskRunId?: string
  readonly sessionId?: string
  readonly containerId?: string
  readonly routeName?: string
  readonly operation?: string
  readonly [key: string]: unknown
}

/**
 * Logger service interface.
 */
export interface LoggerService {
  /**
   * Log a debug message.
   */
  readonly debug: (message: string, metadata?: LogMetadata) => Effect.Effect<void>

  /**
   * Log an info message.
   */
  readonly info: (message: string, metadata?: LogMetadata) => Effect.Effect<void>

  /**
   * Log a warning message.
   */
  readonly warn: (message: string, metadata?: LogMetadata) => Effect.Effect<void>

  /**
   * Log an error message.
   */
  readonly error: (message: string, cause?: unknown, metadata?: LogMetadata) => Effect.Effect<void>

  /**
   * Log with custom annotation.
   */
  readonly log: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, metadata?: LogMetadata) => Effect.Effect<void>
}

/**
 * Logger service tag for dependency injection.
 */
export const LoggerService = Context.GenericTag<LoggerService>("LoggerService")

/**
 * Create a logger effect with metadata.
 */
const withMetadata = (
  effect: Effect.Effect<void>,
  metadata?: LogMetadata
): Effect.Effect<void> => {
  if (!metadata) return effect

  return Effect.gen(function* () {
    const annotations: Record<string, string> = {}
    
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) {
        annotations[key] = typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: Infinity })
      }
    }

    return yield* Effect.annotateLogs(annotations)(effect)
  })
}

/**
 * Live implementation of the logger service.
 */
export const LiveLoggerService = Layer.succeed(
  LoggerService,
  {
    debug: (message, metadata) =>
      withMetadata(Effect.logDebug(message), metadata),
    
    info: (message, metadata) =>
      withMetadata(Effect.logInfo(message), metadata),
    
    warn: (message, metadata) =>
      withMetadata(Effect.logWarning(message), metadata),
    
    error: (message, cause, metadata) =>
      withMetadata(
        cause instanceof Error
          ? Effect.logError(message).pipe(Effect.annotateLogs({ error: cause.message, stack: cause.stack }))
          : Effect.logError(message),
        metadata
      ),
    
    log: (level, message, metadata) => {
      const effect = level === "DEBUG" 
        ? Effect.logDebug(message)
        : level === "INFO"
        ? Effect.logInfo(message)
        : level === "WARN"
        ? Effect.logWarning(message)
        : Effect.logError(message)
      return withMetadata(effect, metadata)
    },
  }
)

/**
 * Logger layer with default configuration.
 */
export const LoggerLayer = LiveLoggerService

/**
 * Helper to create a logger with preset metadata.
 * Useful for creating contextual loggers within services.
 */
export const withContext = (
  baseMetadata: LogMetadata
): LoggerService => ({
  debug: (message, metadata) =>
    withMetadata(Effect.logDebug(message), { ...baseMetadata, ...metadata }),
  
  info: (message, metadata) =>
    withMetadata(Effect.logInfo(message), { ...baseMetadata, ...metadata }),
  
  warn: (message, metadata) =>
    withMetadata(Effect.logWarning(message), { ...baseMetadata, ...metadata }),
  
  error: (message, cause, metadata) =>
    withMetadata(
      cause instanceof Error
        ? Effect.logError(message).pipe(Effect.annotateLogs({ error: cause.message, stack: cause.stack }))
        : Effect.logError(message),
      { ...baseMetadata, ...metadata },
    ),
  
  log: (level, message, metadata) =>
    withMetadata(
      level === "DEBUG"
        ? Effect.logDebug(message)
        : level === "INFO"
          ? Effect.logInfo(message)
          : level === "WARN"
            ? Effect.logWarning(message)
            : Effect.logError(message),
      { ...baseMetadata, ...metadata },
    ),
})
