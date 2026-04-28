import { Schema } from "effect";
import promptCatalog from "./prompt-catalog.json";
// ============================================================================
// Catalog Data Access
// ============================================================================
const CATALOG = promptCatalog;
/**
 * Error for prompt catalog/template failures
 */
export class PromptCatalogError extends Schema.TaggedError()("PromptCatalogError", {
    operation: Schema.String,
    message: Schema.String,
    key: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
}) {
}
/**
 * Join an array of prompt lines into a single string
 */
export function joinPrompt(lines) {
    return lines.join("\n");
}
/**
 * Get a prompt template from the catalog
 */
export function getPromptTemplate(key) {
    const template = CATALOG.templates[key];
    if (!template) {
        throw new PromptCatalogError({
            operation: "getPromptTemplate",
            message: `Template not found: ${key}`,
            key,
        });
    }
    return {
        key: template.key,
        name: template.name,
        description: template.description,
        templateText: joinPrompt(template.templateText),
        variablesJson: template.variables,
    };
}
/**
 * Get all prompt templates from the catalog
 */
export function getAllPromptTemplates() {
    return Object.values(CATALOG.templates).map((template) => ({
        key: template.key,
        name: template.name,
        description: template.description,
        templateText: joinPrompt(template.templateText),
        variablesJson: template.variables,
    }));
}
/**
 * Get a system prompt from the catalog
 */
export function getSystemPrompt(key) {
    const prompt = CATALOG.systemPrompts[key];
    if (!prompt) {
        throw new PromptCatalogError({
            operation: "getSystemPrompt",
            message: `System prompt not found: ${key}`,
            key,
        });
    }
    return {
        key: prompt.key,
        name: prompt.name,
        description: prompt.description,
        promptText: joinPrompt(prompt.promptText),
    };
}
/**
 * Render a prompt template with variables
 */
export function renderPromptTemplate(template, variables) {
    const matches = template.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) ?? [];
    const keys = matches.map((match) => match.replace(/\{\{\s*|\s*\}\}/g, ""));
    for (const key of keys) {
        if (!(key in variables)) {
            throw new PromptCatalogError({
                operation: "renderPromptTemplate",
                message: `Missing prompt variable: ${key}`,
                key,
            });
        }
    }
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => variables[key] ?? "");
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
};
//# sourceMappingURL=catalog.js.map