import { Schema } from "effect"
import promptCatalog from "./prompt-catalog.json"

// ============================================================================
// Types
// ============================================================================

export type PromptTemplateKey =
  | "execution"
  | "planning"
  | "plan_revision"
  | "review"
  | "review_fix"
  | "repair"
  | "best_of_n_worker"
  | "best_of_n_reviewer"
  | "best_of_n_final_applier"
  | "commit"

export type SystemPromptKey = "planning" | "container_config" | "self_healing"

export interface PromptTemplate {
  key: PromptTemplateKey
  name: string
  description: string
  templateText: string
  variablesJson: string[]
}

export interface SystemPrompt {
  key: SystemPromptKey
  name: string
  description: string
  promptText: string
}

// ============================================================================
// Catalog Structure Types
// ============================================================================

type CatalogTemplate = {
  key: string
  name: string
  description: string
  templateText: string[]
  variables: string[]
}

type CatalogSystemPrompt = {
  key: string
  name: string
  description: string
  promptText: string[]
}

type PromptCatalogData = {
  defaultCommitPromptLines: string[]
  defaultCodeStylePromptLines: string[]
  resumeTaskContinuationPromptLines: string[]
  mergeConflictRepairPromptLines: string[]
  taskSetupPromptLines: string[]
  mockClassificationPromptLines: string[]
  templates: Record<string, CatalogTemplate>
  systemPrompts: Record<string, CatalogSystemPrompt>
}

// ============================================================================
// Catalog Data Access
// ============================================================================

const CATALOG = promptCatalog as PromptCatalogData

/**
 * Error for prompt catalog/template failures
 */
export class PromptCatalogError extends Schema.TaggedError<PromptCatalogError>()("PromptCatalogError", {
  operation: Schema.String,
  message: Schema.String,
  key: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Join an array of prompt lines into a single string
 */
export function joinPrompt(lines: string[]): string {
  return lines.join("\n")
}

/**
 * Get a prompt template from the catalog
 */
export function getPromptTemplate(key: PromptTemplateKey): PromptTemplate {
  const template = CATALOG.templates[key]
  if (!template) {
    throw new PromptCatalogError({
      operation: "getPromptTemplate",
      message: `Template not found: ${key}`,
      key,
    })
  }

  return {
    key: template.key as PromptTemplateKey,
    name: template.name,
    description: template.description,
    templateText: joinPrompt(template.templateText),
    variablesJson: template.variables,
  }
}

/**
 * Get all prompt templates from the catalog
 */
export function getAllPromptTemplates(): PromptTemplate[] {
  return Object.values(CATALOG.templates).map((template) => ({
    key: template.key as PromptTemplateKey,
    name: template.name,
    description: template.description,
    templateText: joinPrompt(template.templateText),
    variablesJson: template.variables,
  }))
}

/**
 * Get a system prompt from the catalog
 */
export function getSystemPrompt(key: SystemPromptKey): SystemPrompt {
  const prompt = CATALOG.systemPrompts[key]
  if (!prompt) {
    throw new PromptCatalogError({
      operation: "getSystemPrompt",
      message: `System prompt not found: ${key}`,
      key,
    })
  }

  return {
    key: prompt.key as SystemPromptKey,
    name: prompt.name,
    description: prompt.description,
    promptText: joinPrompt(prompt.promptText),
  }
}

/**
 * Render a prompt template with variables
 */
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

// ============================================================================
// Legacy Simple Prompt Access
// ============================================================================

export type PromptCatalog = {
  defaultCommitPromptLines: string[]
  defaultCodeStylePromptLines: string[]
  resumeTaskContinuationPromptLines: string[]
  mergeConflictRepairPromptLines: string[]
  taskSetupPromptLines: string[]
  mockClassificationPromptLines: string[]
}

/**
 * Legacy access to simple prompt line arrays
 */
export const PROMPT_CATALOG = {
  defaultCommitPromptLines: CATALOG.defaultCommitPromptLines,
  defaultCodeStylePromptLines: CATALOG.defaultCodeStylePromptLines,
  resumeTaskContinuationPromptLines: CATALOG.resumeTaskContinuationPromptLines,
  mergeConflictRepairPromptLines: CATALOG.mergeConflictRepairPromptLines,
  taskSetupPromptLines: CATALOG.taskSetupPromptLines,
  mockClassificationPromptLines: CATALOG.mockClassificationPromptLines,
} as PromptCatalog
