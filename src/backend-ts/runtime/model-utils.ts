/**
 * Shared utility for parsing and validating model selections.
 * This ensures consistent model format handling across the application.
 */

export interface ModelSelection {
  provider: string
  modelId: string
}

/**
 * Parse a model string into provider and modelId components.
 * Supports models with multiple slashes in the modelId (e.g., fireworks/accounts/fireworks/routers/kimi-k2p5-turbo)
 *
 * Expected format: provider/modelId
 * - provider: The first segment before the first slash
 * - modelId: Everything after the first slash (can contain additional slashes)
 *
 * Examples:
 * - "openai/gpt-4" -> { provider: "openai", modelId: "gpt-4" }
 * - "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo" -> { provider: "fireworks", modelId: "accounts/fireworks/routers/kimi-k2p5-turbo" }
 * - "anthropic/claude-3-opus-20240229" -> { provider: "anthropic", modelId: "claude-3-opus-20240229" }
 */
export function parseModelSelection(model: string): ModelSelection | null {
  if (!model || model === "default" || model.trim() === "") {
    return null
  }

  const trimmed = model.trim()
  const firstSlashIndex = trimmed.indexOf("/")

  if (firstSlashIndex === -1) {
    // No slash found - invalid format
    return null
  }

  const provider = trimmed.substring(0, firstSlashIndex)
  const modelId = trimmed.substring(firstSlashIndex + 1)

  if (!provider || !modelId) {
    return null
  }

  return { provider, modelId }
}

/**
 * Validate if a model string is in the correct format.
 */
export function isValidModelFormat(model: string): boolean {
  return parseModelSelection(model) !== null
}

/**
 * Get the display name for a model by extracting just the model name portion.
 * For models with complex paths, returns the last segment.
 *
 * Examples:
 * - "openai/gpt-4" -> "gpt-4"
 * - "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo" -> "kimi-k2p5-turbo"
 */
export function getModelDisplayName(model: string): string {
  const parsed = parseModelSelection(model)
  if (!parsed) return model

  // For modelId with multiple slashes, get the last segment
  const segments = parsed.modelId.split("/")
  return segments[segments.length - 1] || parsed.modelId
}

/**
 * Get just the provider name from a model string.
 */
export function getModelProvider(model: string): string | null {
  const parsed = parseModelSelection(model)
  return parsed?.provider ?? null
}
