/**
 * CleanRunModal Component - Confirmation dialog for cleaning a workflow run
 */

import { Show } from 'solid-js'
import type { WorkflowRun } from '@/types'
import { ModalWrapper } from '../common/ModalWrapper'

interface CleanRunModalProps {
  run: WorkflowRun
  isOpen: boolean
  isLoading: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function CleanRunModal(props: CleanRunModalProps) {
  const taskCount = () => props.run?.taskOrder?.length ?? 0

  return (
    <Show when={props.isOpen}>
      <ModalWrapper onClose={props.onCancel}>
        <div class="w-full max-w-md p-6 bg-dark-surface rounded-lg border border-dark-border">
          <h2 class="text-lg font-semibold text-dark-text mb-4">
            Clean Workflow Run
          </h2>

          <div class="space-y-4">
            <p class="text-dark-text-secondary">
              This will reset all <span class="font-semibold text-accent-warning">{taskCount()}</span> tasks in this run to their initial state.
            </p>

            <ul class="text-sm text-dark-text-secondary space-y-1 list-disc list-inside">
              <li>Task execution state will be cleared</li>
              <li>All sessions and logs will be deleted</li>
              <li>Self-healing reports will be removed</li>
              <li>Tasks will return to "backlog" status</li>
            </ul>

            <p class="text-xs text-dark-text-muted italic">
              Task definitions and prompts will be preserved.
            </p>

            <div class="flex gap-3 pt-4">
              <button
                type="button"
                class="flex-1 px-4 py-2 bg-dark-bg border border-dark-border rounded text-dark-text-secondary hover:bg-dark-border/50 transition-colors"
                onClick={props.onCancel}
                disabled={props.isLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                class="flex-1 px-4 py-2 bg-accent-danger/20 border border-accent-danger/50 rounded text-accent-danger hover:bg-accent-danger/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={props.onConfirm}
                disabled={props.isLoading}
              >
                {props.isLoading ? 'Cleaning...' : 'Clean Run'}
              </button>
            </div>
          </div>
        </div>
      </ModalWrapper>
    </Show>
  )
}
