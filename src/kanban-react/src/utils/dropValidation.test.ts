import { describe, it, expect } from "vitest"
import { validateTaskDrop, canDragFromColumn, validateGroupDrop, canDragFromGroup } from "./dropValidation"
import type { Task } from "@/types"

function createMockTask(status: Task["status"], groupId?: string | null): Task {
  return {
    id: "task-1",
    idx: 1,
    name: "Test Task",
    prompt: "Test prompt",
    status,
    branch: "main",
    planmode: false,
    autoApprovePlan: false,
    review: false,
    autoCommit: false,
    deleteWorktree: false,
    skipPermissionAsking: false,
    requirements: [],
    thinkingLevel: "default",
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
    groupId: groupId ?? undefined,
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

describe('validateGroupDrop', () => {
  describe('backlog to group', () => {
    it('allows backlog → group when task has no group', () => {
      const task = createMockTask('backlog', null)
      const result = validateGroupDrop(task, 'backlog', 'group-1', null)
      expect(result.allowed).toBe(true)
      expect(result.action).toBe('add-to-group')
    })

    it('prevents backlog → group when task is already in a different group', () => {
      const task = createMockTask('backlog', 'group-2')
      const result = validateGroupDrop(task, 'backlog', 'group-1', 'group-2')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('Task is already in a group')
    })

    it('returns no-change when dropping on same group', () => {
      const task = createMockTask('backlog', 'group-1')
      const result = validateGroupDrop(task, 'backlog', 'group-1', 'group-1')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('no-change')
    })
  })

  describe('group to backlog', () => {
    it('allows group → backlog (remove from group)', () => {
      const task = createMockTask('backlog', 'group-1')
      const result = validateGroupDrop(task, 'group', null, 'group-1')
      expect(result.allowed).toBe(true)
      expect(result.action).toBe('remove-from-group')
    })
  })

  describe('between groups', () => {
    it('prevents group A → group B', () => {
      const task = createMockTask('backlog', 'group-1')
      const result = validateGroupDrop(task, 'group', 'group-2', 'group-1')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('Cannot move between groups')
    })

    it('returns no-change when dropping on same group from group', () => {
      const task = createMockTask('backlog', 'group-1')
      const result = validateGroupDrop(task, 'group', 'group-1', 'group-1')
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('no-change')
    })
  })

  describe('invalid operations', () => {
    it('rejects invalid source context', () => {
      const task = createMockTask('backlog', null)
      // Testing an edge case with mismatched context
      const result = validateGroupDrop(task, 'group', 'group-1', null)
      // When source is 'group' but task has no groupId, should fail
      expect(result.allowed).toBe(false)
    })
  })
})

describe('canDragFromGroup', () => {
  it('allows dragging when task has a groupId', () => {
    expect(canDragFromGroup('group-1')).toBe(true)
    expect(canDragFromGroup('some-group-id')).toBe(true)
  })

  it('prevents dragging when task has no groupId', () => {
    expect(canDragFromGroup(null)).toBe(false)
    expect(canDragFromGroup(undefined)).toBe(false)
  })
})
