import { Effect, Schema } from "effect"

export class StructuredOutputNotFoundError extends Schema.TaggedError<StructuredOutputNotFoundError>()(
  "StructuredOutputNotFoundError",
  {
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class StructuredOutputParseError extends Schema.TaggedError<StructuredOutputParseError>()(
  "StructuredOutputParseError",
  {
    toolName: Schema.String,
    message: Schema.String,
    rawEvent: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * Extract structured output from tool_execution_end events in the RPC event stream.
 *
 * Pi extension tools return structured data via `result.details` in the
 * `tool_execution_end` event. This extractor searches the collected RPC events
 * for a matching tool execution and returns the validated structured data.
 */
export class StructuredOutputExtractor {
  /**
   * Extract structured output from a list of RPC events.
   * Searches for the first `tool_execution_end` event with a matching toolName
   * and returns its `result.details`.
   */
  extractFromEvents<T>(events: Record<string, unknown>[], toolName: string): T | null {
    for (const event of events) {
      if (event.type === "tool_execution_end" && event.toolName === toolName) {
        const result = event.result as Record<string, unknown> | undefined
        if (result?.details !== undefined && result?.details !== null) {
          return result.details as T
        }
      }
    }
    return null
  }

  /**
   * Extract structured output as an Effect, failing with StructuredOutputNotFoundError
   * if no matching tool execution is found.
   */
  extractFromEventsEffect<T>(
    events: Record<string, unknown>[],
    toolName: string,
  ): Effect.Effect<T, StructuredOutputNotFoundError> {
    const result = this.extractFromEvents<T>(events, toolName)
    if (result === null) {
      return Effect.fail(
        new StructuredOutputNotFoundError({
          toolName,
          message: `No tool_execution_end event found for tool "${toolName}" in ${events.length} events`,
        }),
      )
    }
    return Effect.succeed(result)
  }
}