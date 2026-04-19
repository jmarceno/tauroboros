/**
 * ApproveModal Component - Task approval dialog
 * Ported from React to SolidJS with full feature parity
 */

import { createSignal } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { createTasksStore, uiStore } from '@/stores'

interface ApproveModalProps {
  taskId: string
  onClose: () => void
}

export function ApproveModal(props: ApproveModalProps) {
  const tasks = createTasksStore()
  const [message, setMessage] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)

  const task = () => tasks.getTaskById(props.taskId)

  const handleApprove = async () => {
    setIsLoading(true)
    try {
      await tasks.approvePlan(props.taskId, message())
      uiStore.showToast('Plan approved', 'success')
      props.onClose()
    } catch (e) {
      uiStore.showToast(e instanceof Error ? e.message : 'Failed to approve plan', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper title={`Approve Plan: ${task()?.name || props.taskId}`} onClose={props.onClose}>
      <div class="space-y-4">
        <div class="form-group">
          <label>Approval Message (optional)</label>
          <textarea
            class="form-textarea"
            value={message()}
            onChange={(e) => setMessage(e.currentTarget.value)}
            rows={4}
            placeholder="Enter any feedback or approval message..."
          />
        </div>

        <div class="modal-footer">
          <button type="button" class="btn" onClick={props.onClose} disabled={isLoading()}>Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            onClick={handleApprove}
            disabled={isLoading()}
          >
            {isLoading() ? 'Approving...' : 'Approve Plan'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}
