# Structured Agent Output via Pi Extension Tools

## Problem

We currently rely on the agent to output free-text JSON, which we then parse with `parseStrictJsonObject()` (a fragile brace-counting scanner in `src/runtime/strict-json.ts`). This fails when:

- The agent wraps JSON in markdown code blocks (despite prompt instructions)
- The agent adds explanatory text before/after the JSON
- Special characters in string values break JSON parsing
- The agent outputs partial/incomplete JSON
- The agent's JSON has subtle syntax issues (trailing commas, unescaped chars)

The review session (`src/runtime/review-session.ts:118-162`) has retry logic for JSON parse failures, but this is a band-aid — the root cause is that we're asking the LLM to produce structured output through free-text generation, which is inherently unreliable.

## Solution: Pi Extension Tools with Schema Validation

Pi already has a **tool-based structured output mechanism** via `defineTool()` with TypeBox schema validation. When the LLM calls a tool, Pi validates the arguments against the schema **before** execution — so we get guaranteed type-safe, schema-validated output.

The RPC protocol emits `tool_execution_end` events with `result.details` containing the structured data. We can listen for these events instead of parsing free-text JSON.

### How Pi Tools Work (from pi-mono analysis)

1. **Define a tool** with `defineTool()` specifying a TypeBox schema for parameters
2. **Register the tool** via `pi.registerTool()` in an extension factory
3. **LLM calls the tool** — Pi validates args against the schema automatically
4. **Tool executes** and returns `{ details: <structured-data>, terminate: true }`
5. **RPC stream** emits `tool_execution_end` event with `result.details`
6. **`terminate: true`** stops the agent immediately without an extra LLM turn

### Key Files in Pi

| File | Purpose |
|------|---------|
| `packages/coding-agent/src/core/extensions/types.ts` | `ToolDefinition`, `defineTool()`, `ExtensionAPI` |
| `packages/coding-agent/examples/extensions/structured-output.ts` | Reference implementation |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | RPC mode — subscribes to session events and outputs them |
| `packages/coding-agent/src/cli/args.ts` | `--extension`/`-e` flag for loading extensions |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      tauroboros                              │
│                                                              │
│  ┌─────────────┐   ┌──────────────────┐   ┌──────────────┐  │
│  │ Review       │   │ Smart Repair     │   │ Best-of-N    │  │
│  │ Session      │   │ Service          │   │ Reviewer     │  │
│  └──────┬───────┘   └──────┬───────────┘   └──────┬───────┘  │
│         │                  │                       │          │
│         ▼                  ▼                       ▼          │
│  ┌─────────────────────────────────────────────────────┐     │
│  │            Structured Output Extractor               │     │
│  │  (listens for tool_execution_end events in RPC       │     │
│  │   stream, extracts result.details, validates with    │     │
│  │   Effect Schema)                                     │     │
│  └──────────────────────┬──────────────────────────────┘     │
│                         │                                     │
│                         ▼                                     │
│  ┌─────────────────────────────────────────────────────┐     │
│  │              PiRpcProcess (unchanged)                │     │
│  │  spawns pi --mode rpc --extension <tools.ts>        │     │
│  └──────────────────────┬──────────────────────────────┘     │
│                         │ stdin/stdout (JSONL RPC)            │
└─────────────────────────┼───────────────────────────────────┘
                          │
                          ▼
              ┌─────────────────────────┐
              │   pi agent (RPC mode)   │
              │                         │
              │  Has registered tools:  │
              │  - emit_review_result   │
              │  - emit_repair_decision │
              │  - emit_best_of_n_vote  │
              │  - emit_plan            │
              │                         │
              │  LLM calls tool →       │
              │  schema validated →     │
              │  tool returns details   │
              └─────────────────────────┘
```

## Phase 1: Create Pi Extension Tools

### File: `extensions/pi-tools/structured-output.ts`

Create a Pi extension file that registers all structured output tools. This file is loaded by `pi --extension` when starting the agent.

**Tools to define:**

1. **`emit_review_result`** — For review sessions
   ```typescript
   parameters: Type.Object({
     status: Type.Union([Type.Literal("pass"), Type.Literal("gaps_found"), Type.Literal("blocked")]),
     summary: Type.String({ description: "Brief summary of review findings" }),
     gaps: Type.Array(Type.String(), { description: "Specific gaps or issues found" }),
     recommendedPrompt: Type.String({ description: "Specific prompt to address gaps, or empty string if no gaps" }),
   })
   ```

2. **`emit_repair_decision`** — For smart repair
   ```typescript
   parameters: Type.Object({
     action: Type.Union([
       Type.Literal("queue_implementation"),
       Type.Literal("restore_plan_approval"),
       Type.Literal("reset_backlog"),
       Type.Literal("mark_done"),
       Type.Literal("fail_task"),
       Type.Literal("continue_with_more_reviews"),
       Type.Literal("skip_code_style"),
       Type.Literal("return_to_review"),
     ]),
     reason: Type.String({ description: "Why this action was chosen" }),
     errorMessage: Type.Optional(Type.String({ description: "Error message for fail_task action" })),
   })
   ```

3. **`emit_best_of_n_vote`** — For best-of-n reviewer
   ```typescript
   parameters: Type.Object({
     status: Type.Union([Type.Literal("pass"), Type.Literal("needs_manual_review")]),
     summary: Type.String(),
     bestCandidateIds: Type.Array(Type.String()),
     gaps: Type.Array(Type.String()),
     recommendedFinalStrategy: Type.Union([
       Type.Literal("pick_best"),
       Type.Literal("synthesize"),
       Type.Literal("pick_or_synthesize"),
     ]),
     recommendedPrompt: Type.Optional(Type.String()),
   })
   ```

4. **`emit_plan`** — For planning sessions (if needed)
   ```typescript
   parameters: Type.Object({
     plan: Type.String({ description: "The plan text" }),
     tasks: Type.Optional(Type.Array(Type.Object({
       name: Type.String(),
       description: Type.String(),
     }))),
   })
   ```

**All tools use `terminate: true`** to stop the agent immediately after emitting the structured result.

### File: `extensions/pi-tools/package.json`

A minimal package.json so Pi can discover the extension:
```json
{
  "name": "tauroboros-structured-output",
  "type": "module",
  "pi": {
    "extensions": ["structured-output.ts"]
  }
}
```

## Phase 2: Update Pi Process Startup

### Changes to `src/runtime/pi-process.ts`

Add `--extension` arg pointing to our tools file when spawning Pi:

```typescript
// In start(), after args setup:
if (this.structuredOutputToolsPath) {
  args.push("--extension", this.structuredOutputToolsPath)
}
```

The path should be resolved relative to the project root. Use a setting or a well-known path like `extensions/pi-tools/structured-output.ts`.

### Changes to `src/runtime/pi-process-factory.ts`

Pass the extension path through `UnifiedPiProcessOptions`:
```typescript
export interface UnifiedPiProcessOptions {
  // ... existing fields ...
  structuredOutputToolsPath?: string
}
```

## Phase 3: Structured Output Extractor

### New File: `src/runtime/structured-output-extractor.ts`

A utility that listens for `tool_execution_end` events in the RPC stream and extracts structured data:

```typescript
export class StructuredOutputExtractor {
  /**
   * Extract structured output from tool execution events.
   * Searches collected events for tool_execution_end with matching toolName.
   */
  extractFromEvents<T>(
    events: Record<string, unknown>[],
    toolName: string,
  ): T | null {
    for (const event of events) {
      if (event.type === "tool_execution_end" && event.toolName === toolName) {
        const result = event.result as Record<string, unknown> | undefined
        if (result?.details) {
          return result.details as T
        }
      }
    }
    return null
  }

  /**
   * Extract structured output from the last message's tool calls.
   * Falls back to scanning events when the tool was the final action.
   */
  extractFromResponse<T>(
    responseText: string,
    events: Record<string, unknown>[],
    toolName: string,
  ): T | null {
    // First try tool_execution_end events (the tool was actually called)
    const fromEvents = this.extractFromEvents<T>(events, toolName)
    if (fromEvents) return fromEvents

    // Fallback: check if the tool result is embedded in response text
    // (for backward compatibility during transition)
    return null
  }
}
```

### Integration with `src/runtime/session-manager.ts`

The `executePrompt()` method already returns `events: Record<string, unknown>[]`. We can add a helper method to extract structured output from the events:

```typescript
export class PiSessionManager {
  // ... existing code ...

  /**
   * Execute a prompt and extract structured output from tool execution.
   */
  executePromptStructured<T>(
    input: ExecuteSessionPromptInput & { toolName: string },
  ): Effect.Effect<{
    session: PiWorkflowSession
    responseText: string
    structuredOutput: T
    events: Record<string, unknown>[]
  }, SessionManagerExecuteError | PiProcessError> {
    return Effect.gen(function* () {
      const result = yield* self.executePrompt(input)
      const extractor = new StructuredOutputExtractor()
      const output = extractor.extractFromEvents<T>(result.events, input.toolName)
      if (!output) {
        return yield* new StructuredOutputNotFoundError({
          toolName: input.toolName,
          message: `No ${input.toolName} tool execution found in events`,
        })
      }
      return { ...result, structuredOutput: output }
    })
  }
}
```

### New Error Type

```typescript
export class StructuredOutputNotFoundError extends Schema.TaggedError<StructuredOutputNotFoundError>()(
  "StructuredOutputNotFoundError",
  {
    toolName: Schema.String,
    message: Schema.String,
  },
) {}
```

## Phase 4: Update Review Session

### Changes to `src/runtime/review-session.ts`

Replace the `parseStrictJsonObject()` + `asReviewResultEffect()` flow with tool-based extraction:

```typescript
run(input: RunReviewScratchInput): Effect.Effect<RunReviewScratchResult, ReviewSessionError> {
  return Effect.gen(function* () {
    // ... existing setup (render prompt, resolve image) ...

    // Use executePromptStructured instead of executePrompt
    const response = yield* self.sessions.executePromptStructured({
      // ... existing input fields ...
      toolName: "emit_review_result",
    }).pipe(
      Effect.mapError(/* ... */),
    )

    const structuredOutput = response.structuredOutput as {
      status: string
      summary: string
      gaps: string[]
      recommendedPrompt: string
    }

    return {
      reviewResult: {
        status: structuredOutput.status as ReviewResult["status"],
        summary: structuredOutput.summary,
        gaps: structuredOutput.gaps,
        recommendedPrompt: structuredOutput.recommendedPrompt,
      },
      responseText: response.responseText,
      sessionId: response.session.id,
      jsonParseRetryCount: 0, // No more JSON parse retries needed
    }
  })
}
```

**The `jsonParseRetryCount` / `maxJsonParseRetries` / `json_parse_max_retries` status can be removed** since schema validation is now guaranteed by Pi's TypeBox validation.

## Phase 5: Update Smart Repair

### Changes to `src/runtime/smart-repair.ts`

Replace `parseRepairDecisionEffect()` with tool-based extraction:

```typescript
decide(taskId: string): Effect.Effect<SmartRepairDecision, SmartRepairError> {
  return Effect.gen(function* () {
    // ... existing setup ...

    const session = yield* self.sessions.executePromptStructured({
      // ... existing input fields ...
      toolName: "emit_repair_decision",
    })

    return session.structuredOutput as SmartRepairDecision
  })
}
```

## Phase 6: Update Prompts

### Changes to `src/prompts/prompt-catalog.json`

Update prompts to instruct the agent to use the tool instead of outputting free-text JSON:

**Review prompt** (line 205-241):
- Replace `"IMPORTANT: Your ENTIRE response must be a single JSON object..."` with instructions to call the `emit_review_result` tool
- Example: `"Your final action MUST be to call the emit_review_result tool with the review findings. Do not output JSON in your response text."`

**Repair prompt** (line 269-308):
- Replace `"Return strict JSON: {...}"` with instructions to call `emit_repair_decision`

**Best-of-N reviewer prompt** (line 340-372):
- Replace JSON output contract with instructions to call `emit_best_of_n_vote`

## Phase 7: Clean Up

### Remove or Reduce `strict-json.ts`

After migration, `parseStrictJsonObject` is no longer needed for structured output paths. It can be:
- Removed entirely if no code paths use it
- Kept as a fallback during transition, then removed in a follow-up

### Remove JSON Parse Retry Logic

The `jsonParseRetryCount`, `maxJsonParseRetries`, `currentJsonParseRetryCount`, and `json_parse_max_retries` status in:
- `src/runtime/review-session.ts`
- `src/db/migrations.ts` (`json_parse_retry_count` column)
- `src/orchestrator.ts` (review loop retry logic)

## Taskplane-Inspired Patterns to Also Adopt

While not part of this plan's core scope, the following patterns from taskplane are worth noting:

1. **Exit classification with precedence** — `diagnostics.ts` has a 10-class deterministic hierarchy
2. **Bounded payload truncation** — `truncatePayload()` for durable logs
3. **Exit interception** — Ability to intercept agent "exit" and consult supervisor
4. **Retry with backoff** — Tier0 retry budgets with configurable cooldowns

These could be layered on top after the core structured output migration is complete.

## Migration Strategy

### Phase A (parallel): Tool definition + backward-compatible prompts

1. Create the extension tools file
2. Add `--extension` to Pi startup
3. Update prompts to mention both tool and JSON fallback
4. Add `StructuredOutputExtractor` that checks tool events first, falls back to JSON parsing

### Phase B (cutover): Remove JSON parsing

1. Remove JSON fallback from structured output paths
2. Remove `strict-json.ts` usage from review/repair/best-of-n
3. Remove JSON parse retry logic
4. Clean up unused code

## Files Changed Summary

| File | Change |
|------|--------|
| `extensions/pi-tools/structured-output.ts` | **NEW** — Pi extension with all structured output tools |
| `extensions/pi-tools/package.json` | **NEW** — Extension package manifest |
| `src/runtime/structured-output-extractor.ts` | **NEW** — Extract structured data from tool events |
| `src/runtime/pi-process.ts` | Add `--extension` arg when spawning Pi |
| `src/runtime/pi-process-factory.ts` | Pass extension path through options |
| `src/runtime/session-manager.ts` | Add `executePromptStructured()` method |
| `src/runtime/review-session.ts` | Use tool-based extraction, remove JSON retry |
| `src/runtime/smart-repair.ts` | Use tool-based extraction |
| `src/runtime/planning-session.ts` | Use tool-based extraction (if applicable) |
| `src/prompts/prompt-catalog.json` | Update review/repair/best-of-n prompts |
| `src/types.ts` | Remove `json_parse_max_retries` from `ReviewResult` |
| `src/db/migrations.ts` | Remove `json_parse_retry_count` column |
| `src/orchestrator.ts` | Remove JSON parse retry logic from review loop |
| `src/runtime/strict-json.ts` | Remove or reduce to fallback-only |

## Key Design Decisions

1. **Tools over JSON mode** — Pi does not support native LLM JSON mode (no `response_format: { type: "json_object" }`). Tools are the only structured output mechanism Pi provides.

2. **`terminate: true`** — All structured output tools use `terminate: true` so the agent stops immediately after emitting the result, avoiding an extra LLM turn that could add commentary.

3. **Extension file, not inline** — Pi loads extensions from files via `--extension`. We create a standalone `.ts` file rather than trying to inject tools programmatically (which would require modifying Pi's source).

4. **`details` field, not `content`** — Structured data goes in `result.details`, not `result.content` (which is for human-readable text). The RPC event `tool_execution_end` includes `result.details` with the full structured object.

5. **Backward-compatible Phase A** — During migration, the JSON parsing fallback remains active so both old and new sessions work. Phase B removes the fallback after validation.

6. **No changes to Pi source** — Everything is done through Pi's extension API. No fork or patch of pi-mono is needed.
</file_path>
</content>