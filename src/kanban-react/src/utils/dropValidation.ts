import type { Task, TaskStatus } from "@/types"

export type DropTargetType = "column" | "group" | "invalid"

export type DropAction = "move-to-done" | "reset-to-backlog" | "move-to-review" | "add-to-group" | "remove-from-group"

export type DropValidationResult =
  | { allowed: true; action: DropAction }
  | { allowed: false; reason: string }

export type GroupDropSource = 'backlog' | 'group'

export interface GroupDropValidationResult {
  allowed: boolean
  action?: 'add-to-group' | 'remove-from-group'
  reason?: string
}

/**
 * Validates whether a task can be dropped onto a target column.
 * Enforces workflow constraints:
 * - Code-style column is workflow-managed only (no manual drops)
 * - Tasks can be moved from code-style to other columns
 * - Specific rules for other column transitions
 */
export function validateTaskDrop(
  task: Task,
  targetStatus: TaskStatus,
  isTaskMutationLocked: boolean
): DropValidationResult {
  // Prevent manual drops into the code-style column (workflow-managed only)
  if (targetStatus === 'code-style') {
    return { allowed: false, reason: 'Code Style column is workflow-managed' }
  }

  // Check if task is locked (executing)
  if (isTaskMutationLocked) {
    return { allowed: false, reason: 'This task is currently executing and cannot be moved' }
  }

  // No change needed if same status
  if (task.status === targetStatus) {
    return { allowed: false, reason: 'no-change' }
  }

  const canMoveToDone = ['stuck', 'review', 'code-style'].includes(task.status)
  const canMoveToBacklog = ['stuck', 'failed', 'done', 'review', 'code-style'].includes(task.status)
  const canMoveToReview = ['backlog', 'stuck', 'failed', 'code-style'].includes(task.status)

  if (targetStatus === 'done' && canMoveToDone) {
    return { allowed: true, action: 'move-to-done' }
  }

  if (targetStatus === 'backlog' && canMoveToBacklog) {
    return { allowed: true, action: 'reset-to-backlog' }
  }

  if (targetStatus === 'review' && canMoveToReview) {
    return { allowed: true, action: 'move-to-review' }
  }

  return { allowed: false, reason: `Cannot move task from ${task.status} to ${targetStatus}` }
}

/**
 * Determines if a task can be dragged from a specific column.
 * Tasks in code-style can be dragged OUT but not IN.
 */
export function canDragFromColumn(
  status: TaskStatus,
  isTaskMutationLocked: boolean,
  currentSort: string
): boolean {
  // Can drag from backlog or code-style if not locked and sorted manually
  return (status === 'backlog' || status === 'code-style') &&
         !isTaskMutationLocked &&
         currentSort === 'manual'
}

/**
 * Validates whether a task can be dropped onto a group panel.
 * Enforces group workflow constraints:
 * - Backlog → Group: Allowed if task has no group (add to group)
 * - Group → Backlog: Always allowed (remove from group)
 * - Group A → Group B: Not allowed (prevented for now)
 * - Group → Same Group: No change
 */
export function validateGroupDrop(
  task: Task,
  sourceContext: GroupDropSource,
  targetGroupId: string | null,
  taskGroupId: string | null
): GroupDropValidationResult {
  // Dragging from backlog to a group panel
  if (sourceContext === 'backlog') {
    // If task is already in a group, prevent adding to another group
    if (taskGroupId !== null && taskGroupId !== targetGroupId) {
      return { allowed: false, reason: 'Task is already in a group' }
    }
    // If dropping on the same group, it's a no-op
    if (taskGroupId === targetGroupId && targetGroupId !== null) {
      return { allowed: false, reason: 'no-change' }
    }
    // Valid: Add task to group
    return { allowed: true, action: 'add-to-group' }
  }

  // Dragging from a group panel
  if (sourceContext === 'group') {
    // Dropping back to backlog (targetGroupId is null for backlog)
    if (targetGroupId === null) {
      return { allowed: true, action: 'remove-from-group' }
    }
    // Dropping from one group to another - not allowed for now
    if (taskGroupId !== null && taskGroupId !== targetGroupId) {
      return { allowed: false, reason: 'Cannot move between groups' }
    }
    // Dropping on the same group - no change
    if (taskGroupId === targetGroupId) {
      return { allowed: false, reason: 'no-change' }
    }
  }

  return { allowed: false, reason: 'Invalid drop operation' }
}

/**
 * Determines if a task can be dragged from a group panel.
 * Tasks in groups can be dragged out to backlog.
 */
export function canDragFromGroup(taskGroupId: string | null): boolean {
  // Can drag from group if task is actually in a group
  return taskGroupId !== null && taskGroupId !== undefined
}
