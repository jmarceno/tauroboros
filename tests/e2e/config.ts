/**
 * E2E Test Configuration
 *
 * Central configuration for end-to-end tests.
 * Edit this file to change test models, thinking levels, etc.
 */

export const E2E_CONFIG = {
  /**
   * Model to use for E2E tests
   * Format: "provider/model-id"
   */
  model: "minimax/MiniMax-M2.7",

  /**
   * Thinking level for E2E tests
   * Options: "default" | "low" | "medium" | "high"
   */
  thinkingLevel: "low",

  /**
   * Container image to use
   */
  containerImage: "pi-agent:alpine",

  /**
   * Timeout for workflow completion (in milliseconds)
   */
  workflowTimeoutMs: 300000, // 5 minutes

  /**
   * Timeout for individual task execution (in milliseconds)
   */
  taskTimeoutMs: 120000, // 2 minutes

  /**
   * Whether to clean up worktrees after tests
   */
  cleanupWorktrees: true,

  /**
   * Whether to run in container mode (vs native)
   */
  containerMode: true,
} as const

/**
 * Get model configuration for task creation
 */
export function getModelConfig() {
  return {
    planModel: E2E_CONFIG.model,
    executionModel: E2E_CONFIG.model,
    thinkingLevel: E2E_CONFIG.thinkingLevel,
  }
}
