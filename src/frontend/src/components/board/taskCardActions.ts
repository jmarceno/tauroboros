import type { Task } from '@/types'

interface TaskCardActionVisibilityParams {
  task: Task
  isLocked: boolean
  isAnomalousReviewTask: boolean
}

export interface TaskCardActionVisibility {
  showInlineActionBar: boolean
  showResetButton: boolean
  showMarkDoneIcon: boolean
  showInlineMarkDoneButton: boolean
}

export function getTaskCardActionVisibility(
  params: TaskCardActionVisibilityParams
): TaskCardActionVisibility {
  const { task, isLocked, isAnomalousReviewTask } = params

  const showInlineActionBar =
    task.status === 'failed' ||
    (!isLocked &&
      (task.status === 'review' || task.status === 'executing' || task.status === 'stuck'))

  const showResetButton =
    task.status === 'failed' ||
    task.status === 'done' ||
    (!showInlineActionBar &&
      !isLocked &&
      (task.status === 'stuck' || task.status === 'review'))

  const showMarkDoneIcon =
    task.status === 'failed' ||
    task.status === 'stuck' ||
    (!isLocked && isAnomalousReviewTask)

  const showInlineMarkDoneButton =
    task.status === 'failed' ||
    (task.status === 'review' && isAnomalousReviewTask)

  return {
    showInlineActionBar,
    showResetButton,
    showMarkDoneIcon,
    showInlineMarkDoneButton,
  }
}