import { describe, expect, it } from 'vitest'
import type { Task } from '@/types'
import { getTaskCardActionVisibility } from './taskCardActions'

function createMockTask(status: Task['status'], overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Task 1',
    idx: 0,
    prompt: 'prompt',
    branch: 'main',
    planModel: 'plan-model',
    executionModel: 'exec-model',
    planmode: false,
    autoApprovePlan: false,
    review: false,
    autoCommit: false,
    deleteWorktree: false,
    status,
    requirements: [],
    agentOutput: '',
    reviewCount: 0,
    jsonParseRetryCount: 0,
    sessionId: null,
    sessionUrl: null,
    worktreeDir: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    thinkingLevel: 'default',
    planThinkingLevel: 'default',
    executionThinkingLevel: 'default',
    executionPhase: 'not_started',
    awaitingPlanApproval: false,
    planRevisionCount: 0,
    executionStrategy: 'standard',
    bestOfNConfig: null,
    bestOfNSubstage: 'idle',
    skipPermissionAsking: false,
    maxReviewRunsOverride: null,
    smartRepairHints: null,
    reviewActivity: 'idle',
    isArchived: false,
    archivedAt: null,
    codeStyleReview: false,
    ...overrides,
  }
}

describe('getTaskCardActionVisibility', () => {
  it('keeps failed tasks actionable even when locked', () => {
    const visibility = getTaskCardActionVisibility({
      task: createMockTask('failed', { errorMessage: 'boom' }),
      isLocked: true,
      isAnomalousReviewTask: false,
    })

    expect(visibility.showInlineActionBar).toBe(true)
    expect(visibility.showResetButton).toBe(true)
    expect(visibility.showMarkDoneIcon).toBe(true)
    expect(visibility.showInlineMarkDoneButton).toBe(true)
  })

  it('keeps done tasks resettable even when locked', () => {
    const visibility = getTaskCardActionVisibility({
      task: createMockTask('done'),
      isLocked: true,
      isAnomalousReviewTask: false,
    })

    expect(visibility.showInlineActionBar).toBe(false)
    expect(visibility.showResetButton).toBe(true)
    expect(visibility.showMarkDoneIcon).toBe(false)
    expect(visibility.showInlineMarkDoneButton).toBe(false)
  })

  it('preserves review behavior for anomalous review tasks', () => {
    const visibility = getTaskCardActionVisibility({
      task: createMockTask('review'),
      isLocked: false,
      isAnomalousReviewTask: true,
    })

    expect(visibility.showInlineActionBar).toBe(true)
    expect(visibility.showResetButton).toBe(false)
    expect(visibility.showMarkDoneIcon).toBe(true)
    expect(visibility.showInlineMarkDoneButton).toBe(true)
  })

  it('does not surface failed-only actions for unrelated locked tasks', () => {
    const visibility = getTaskCardActionVisibility({
      task: createMockTask('review'),
      isLocked: true,
      isAnomalousReviewTask: false,
    })

    expect(visibility.showInlineActionBar).toBe(false)
    expect(visibility.showResetButton).toBe(false)
    expect(visibility.showMarkDoneIcon).toBe(false)
    expect(visibility.showInlineMarkDoneButton).toBe(false)
  })
})