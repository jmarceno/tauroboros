/**
 * Types Index - browser-safe shared type exports for the Solid frontend.
 */

import promptCatalog from '../../../backend-ts/prompts/prompt-catalog.json'

type PromptCatalogData = {
	defaultCodeStylePromptLines: string[]
}

const catalog = promptCatalog as PromptCatalogData

export type * from '@shared-types'

export const DEFAULT_CODE_STYLE_PROMPT = catalog.defaultCodeStylePromptLines.join('\n')
