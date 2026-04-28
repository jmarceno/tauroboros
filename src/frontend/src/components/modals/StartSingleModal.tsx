/**
 * StartSingleModal Component - Single task start dialog
 * Ported from React to SolidJS
 */

import { createSignal, Show } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { uiStore } from '@/stores'
import type { Task } from '@/types'

interface StartSingleModalProps {
  task?: Task
  onClose: () => void
  onConfirm: (taskId: string) => Promise<void>
}

export function StartSingleModal(props: StartSingleModalProps) {
  const [isLoading, setIsLoading] = createSignal(false)

  const taskId = () => props.task?.id

  const handleStart = async () => {
    const id = taskId()
    if (!id) return
    
    setIsLoading(true)
    try {
      await props.onConfirm(id)
      uiStore.showToast('Task started', 'success')
    } catch (e) {
      uiStore.showToast(e instanceof Error ? e.message : 'Failed to start task', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper title={`Start Task: ${props.task?.name || taskId() || 'Unknown'}`} onClose={props.onClose}>
      <div class="space-y-4">
        <p class="text-dark-text-secondary">
          Start this task immediately? This will bypass the normal workflow execution queue.
        </p>

        <div class="modal-footer">
          <button type="button" class="btn" onClick={props.onClose} disabled={isLoading()}>Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            onClick={handleStart}
            disabled={isLoading()}
          >
            {isLoading() ? 'Starting...' : 'Start Task'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}
