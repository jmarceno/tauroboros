import type { Task, TaskStatus } from '@/types'

export type DropValidationResult =
  | { allowed: true; action: 'move-to-done' | 'reset-to-backlog' | 'move-to-review' }
  | { allowed: false; reason: string }

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
