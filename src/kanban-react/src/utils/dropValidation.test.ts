import { describe, it, expect } from 'bun:test'
import { validateTaskDrop, canDragFromColumn } from './dropValidation'
import type { Task } from '@/types'

function createMockTask(status: Task['status']): Task {
  return {
    id: 'task-1',
    idx: 1,
    name: 'Test Task',
    prompt: 'Test prompt',
    status,
    branch: 'main',
    planmode: false,
    autoApprovePlan: false,
    review: false,
    autoCommit: false,
    deleteWorktree: false,
    skipPermissionAsking: false,
    requirements: [],
    thinkingLevel: 'default',
    planThinkingLevel: 'default',
    executionThinkingLevel: 'default',
    executionStrategy: 'standard',
    reviewCount: 0,
    jsonParseRetryCount: 0,
    planRevisionCount: 0,
    executionPhase: 'not_started',
    awaitingPlanApproval: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('validateTaskDrop', () => {
  describe('code-style column restrictions', () => {
    it('rejects drops to code-style from any source status', () => {
      const sourceStatuses: Task['status'][] = ['template', 'backlog', 'executing', 'review', 'done', 'failed', 'stuck']

      for (const sourceStatus of sourceStatuses) {
        const task = createMockTask(sourceStatus)
        const result = validateTaskDrop(task, 'code-style', false)

        expect(result.allowed).toBe(false)
        expect(result.allowed === false && result.reason).toBe('Code Style column is workflow-managed')
      }
    })

    it('allows dragging from code-style to review', () => {
      const task = createMockTask('code-style')
      const result = validateTaskDrop(task, 'review', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('move-to-review')
    })

    it('allows dragging from code-style to done', () => {
      const task = createMockTask('code-style')
      const result = validateTaskDrop(task, 'done', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('move-to-done')
    })

    it('allows dragging from code-style to backlog via reset', () => {
      const task = createMockTask('code-style')
      const result = validateTaskDrop(task, 'backlog', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('reset-to-backlog')
    })
  })

  describe('task mutation lock', () => {
    it('rejects drops when task is mutation locked', () => {
      const task = createMockTask('backlog')
      const result = validateTaskDrop(task, 'review', true)

      expect(result.allowed).toBe(false)
      expect(result.allowed === false && result.reason).toBe('This task is currently executing and cannot be moved')
    })
  })

  describe('no-change detection', () => {
    it('returns no-change when source and target are the same', () => {
      const task = createMockTask('backlog')
      const result = validateTaskDrop(task, 'backlog', false)

      expect(result.allowed).toBe(false)
      expect(result.allowed === false && result.reason).toBe('no-change')
    })
  })

  describe('valid transitions', () => {
    it('allows moving from stuck to done', () => {
      const task = createMockTask('stuck')
      const result = validateTaskDrop(task, 'done', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('move-to-done')
    })

    it('allows moving from review to done', () => {
      const task = createMockTask('review')
      const result = validateTaskDrop(task, 'done', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('move-to-done')
    })

    it('allows resetting from stuck to backlog', () => {
      const task = createMockTask('stuck')
      const result = validateTaskDrop(task, 'backlog', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('reset-to-backlog')
    })

    it('allows resetting from failed to backlog', () => {
      const task = createMockTask('failed')
      const result = validateTaskDrop(task, 'backlog', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('reset-to-backlog')
    })

    it('allows resetting from done to backlog', () => {
      const task = createMockTask('done')
      const result = validateTaskDrop(task, 'backlog', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('reset-to-backlog')
    })

    it('allows resetting from review to backlog', () => {
      const task = createMockTask('review')
      const result = validateTaskDrop(task, 'backlog', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('reset-to-backlog')
    })

    it('allows moving from backlog to review', () => {
      const task = createMockTask('backlog')
      const result = validateTaskDrop(task, 'review', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('move-to-review')
    })

    it('allows moving from stuck to review', () => {
      const task = createMockTask('stuck')
      const result = validateTaskDrop(task, 'review', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('move-to-review')
    })

    it('allows moving from failed to review', () => {
      const task = createMockTask('failed')
      const result = validateTaskDrop(task, 'review', false)

      expect(result.allowed).toBe(true)
      expect(result.allowed === true && result.action).toBe('move-to-review')
    })
  })

  describe('invalid transitions', () => {
    it('rejects moving from backlog to done directly', () => {
      const task = createMockTask('backlog')
      const result = validateTaskDrop(task, 'done', false)

      expect(result.allowed).toBe(false)
      expect(result.allowed === false && result.reason).toBe('Cannot move task from backlog to done')
    })

    it('rejects moving from template to any column', () => {
      const task = createMockTask('template')
      const result = validateTaskDrop(task, 'backlog', false)

      expect(result.allowed).toBe(false)
      expect(result.allowed === false && result.reason).toBe('Cannot move task from template to backlog')
    })

    it('rejects moving from executing to any column', () => {
      const task = createMockTask('executing')
      const result = validateTaskDrop(task, 'done', false)

      expect(result.allowed).toBe(false)
      expect(result.allowed === false && result.reason).toBe('Cannot move task from executing to done')
    })
  })
})

describe('canDragFromColumn', () => {
  it('allows dragging from backlog when not locked and sorted manually', () => {
    expect(canDragFromColumn('backlog', false, 'manual')).toBe(true)
  })

  it('allows dragging from code-style when not locked and sorted manually', () => {
    expect(canDragFromColumn('code-style', false, 'manual')).toBe(true)
  })

  it('prevents dragging when task is mutation locked', () => {
    expect(canDragFromColumn('backlog', true, 'manual')).toBe(false)
    expect(canDragFromColumn('code-style', true, 'manual')).toBe(false)
  })

  it('prevents dragging when not manually sorted', () => {
    expect(canDragFromColumn('backlog', false, 'name-asc')).toBe(false)
    expect(canDragFromColumn('code-style', false, 'created-desc')).toBe(false)
  })

  it('prevents dragging from other columns', () => {
    expect(canDragFromColumn('template', false, 'manual')).toBe(false)
    expect(canDragFromColumn('executing', false, 'manual')).toBe(false)
    expect(canDragFromColumn('review', false, 'manual')).toBe(false)
    expect(canDragFromColumn('done', false, 'manual')).toBe(false)
    expect(canDragFromColumn('failed', false, 'manual')).toBe(false)
    expect(canDragFromColumn('stuck', false, 'manual')).toBe(false)
  })
})
