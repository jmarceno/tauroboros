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

export function joinPrompt(lines: string[]): string {
  return lines.join("\n")
}

export function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable: ${key}`)
    }
    return variables[key] ?? ""
  })
}
