import { Schema } from "effect"
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

export function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  const matches = template.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) ?? []
  const keys = matches.map((match) => match.replace(/\{\{\s*|\s*\}\}/g, ""))

  for (const key of keys) {
    if (!(key in variables)) {
      throw new PromptCatalogError({
        operation: "renderPromptTemplate",
        message: `Missing prompt variable: ${key}`,
        key,
      })
    }
  }

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? "")
}
