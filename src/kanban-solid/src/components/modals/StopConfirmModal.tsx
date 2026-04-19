/**
 * StopConfirmModal Component - Stop confirmation dialog
 * Ported from React to SolidJS
 */

import { Show } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'

interface StopConfirmModalProps {
  isOpen: boolean
  runName?: string
  isStopping: boolean
  onClose: () => void
  onConfirmGraceful: () => void
  onConfirmDestructive: () => void
}

export function StopConfirmModal(props: StopConfirmModalProps) {
  if (!props.isOpen) return null

  return (
    <ModalWrapper title={props.isStopping ? 'Stopping Workflow...' : 'Stop Workflow'} onClose={props.onClose} size="sm">
      <div class="space-y-4">
        <Show when={props.runName}>
          <p class="text-dark-text-secondary">
            Run: <span class="text-dark-text font-medium">{props.runName}</span>
          </p>
        </Show>

        <Show
          when={props.isStopping}
          fallback={
            <>
              <p class="text-dark-text">How would you like to stop the workflow?</p>

              <div class="grid grid-cols-2 gap-4">
                <button
                  type="button"
                  class="btn"
                  onClick={props.onConfirmGraceful}
                >
                  <div class="text-sm font-medium">PAUSE</div>
                  <div class="text-xs text-dark-text-muted">Graceful stop</div>
                  <div class="text-xs text-dark-text-muted">Preserves state</div>
                </button>

                <button
                  type="button"
                  class="btn btn-danger"
                  onClick={props.onConfirmDestructive}
                >
                  <div class="text-sm font-medium">STOP</div>
                  <div class="text-xs">Kills containers</div>
                  <div class="text-xs">Data loss risk</div>
                </button>
              </div>
            </>
          }
        >
          <div class="text-center py-4">
            <div class="animate-spin w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full mx-auto mb-2" />
            <p class="text-dark-text">Stopping workflow...</p>
          </div>
        </Show>

        <Show when={!props.isStopping}>
          <p class="text-xs text-dark-text-muted text-center">
            Both options will gracefully stop the workflow and preserve work. Choose STOP for emergency only.
          </p>
        </Show>
      </div>
    </ModalWrapper>
  )
}
