import { Schema } from "effect";
export type PromptTemplateKey = "execution" | "planning" | "plan_revision" | "review" | "review_fix" | "repair" | "best_of_n_worker" | "best_of_n_reviewer" | "best_of_n_final_applier" | "commit";
export type SystemPromptKey = "planning" | "container_config" | "self_healing";
export interface PromptTemplate {
    key: PromptTemplateKey;
    name: string;
    description: string;
    templateText: string;
    variablesJson: string[];
}
export interface SystemPrompt {
    key: SystemPromptKey;
    name: string;
    description: string;
    promptText: string;
}
declare const PromptCatalogError_base: Schema.TaggedErrorClass<PromptCatalogError, "PromptCatalogError", {
    readonly _tag: Schema.tag<"PromptCatalogError">;
} & {
    operation: typeof Schema.String;
    message: typeof Schema.String;
    key: Schema.optional<typeof Schema.String>;
    cause: Schema.optional<typeof Schema.Unknown>;
}>;
/**
 * Error for prompt catalog/template failures
 */
export declare class PromptCatalogError extends PromptCatalogError_base {
}
/**
 * Join an array of prompt lines into a single string
 */
export declare function joinPrompt(lines: string[]): string;
/**
 * Get a prompt template from the catalog
 */
export declare function getPromptTemplate(key: PromptTemplateKey): PromptTemplate;
/**
 * Get all prompt templates from the catalog
 */
export declare function getAllPromptTemplates(): PromptTemplate[];
/**
 * Get a system prompt from the catalog
 */
export declare function getSystemPrompt(key: SystemPromptKey): SystemPrompt;
/**
 * Render a prompt template with variables
 */
export declare function renderPromptTemplate(template: string, variables: Record<string, string>): string;
export type PromptCatalog = {
    defaultCommitPromptLines: string[];
    defaultCodeStylePromptLines: string[];
    resumeTaskContinuationPromptLines: string[];
    mergeConflictRepairPromptLines: string[];
    taskSetupPromptLines: string[];
    mockClassificationPromptLines: string[];
};
/**
 * Legacy access to simple prompt line arrays
 */
export declare const PROMPT_CATALOG: PromptCatalog;
export {};
//# sourceMappingURL=catalog.d.ts.map