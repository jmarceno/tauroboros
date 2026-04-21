import { Effect, Schema } from "effect"
import promptCatalog from "./prompt-catalog.json"

type PromptCatalog = {
  defaultCommitPromptLines: string[]
  defaultCodeStylePromptLines: string[]
  resumeTaskContinuationPromptLines: string[]
  mergeConflictRepairPromptLines: string[]
  taskSetupPromptLines: string[]
  mockClassificationPromptLines: string[]
}

export const PROMPT_CATALOG = promptCatalog as PromptCatalog

/**
 * Error for prompt catalog/template failures
 */
export class PromptCatalogError extends Schema.TaggedError<PromptCatalogError>()("PromptCatalogError", {
  operation: Schema.String,
  message: Schema.String,
  key: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export function joinPrompt(lines: string[]): string {
  return lines.join("\n")
}

export function renderPromptTemplateEffect(template: string, variables: Record<string, string>): Effect.Effect<string, PromptCatalogError> {
  return Effect.gen(function* () {
    // Extract all variable keys from template
    const matches = template.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) ?? []
    const keys = matches.map(m => m.replace(/\{\{\s*|\s*\}\}/g, ""))

    // Validate all variables are present
    for (const key of keys) {
      if (!(key in variables)) {
        return yield* new PromptCatalogError({
          operation: "renderPromptTemplate",
          message: `Missing prompt variable: ${key}`,
          key,
        })
      }
    }

    // Replace variables
    const result = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      return variables[key] ?? ""
    })
    return result
  })
}

/** @deprecated Use renderPromptTemplateEffect instead */
export function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  const result = Effect.runSync(renderPromptTemplateEffect(template, variables).pipe(
    Effect.catchAll((error: PromptCatalogError) => Effect.fail(new Error(error.message))),
    Effect.either,
  ))
  if (result._tag === "Left") {
    throw result.left
  }
  return result.right
}
