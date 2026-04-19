/**
 * RevisionModal Component - Task revision dialog
 * Ported from React to SolidJS
 */

import { createSignal, Show } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { uiStore } from '@/stores'
import type { Task } from '@/types'

interface RevisionModalProps {
  task?: Task
  onClose: () => void
  onSubmit: (taskId: string, revisionNotes: string) => Promise<void>
}

export function RevisionModal(props: RevisionModalProps) {
  const [feedback, setFeedback] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)

  const taskId = () => props.task?.id

  const handleRequestRevision = async () => {
    const id = taskId()
    if (!id) return

    if (!feedback().trim()) {
      uiStore.showToast('Please provide feedback for the revision', 'error')
      return
    }

    setIsLoading(true)
    try {
      await props.onSubmit(id, feedback())
      uiStore.showToast('Revision requested', 'success')
      props.onClose()
    } catch (e) {
      uiStore.showToast(e instanceof Error ? e.message : 'Failed to request revision', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper title={`Request Revision: ${props.task?.name || taskId() || 'Unknown'}`} onClose={props.onClose}>
      <div class="space-y-4">
        <div class="form-group">
          <label>Revision Feedback</label>
          <textarea
            class="form-textarea"
            value={feedback()}
            onChange={(e) => setFeedback(e.currentTarget.value)}
            rows={6}
            placeholder="Describe what needs to be revised in the plan..."
            required
          />
        </div>

        <div class="modal-footer">
          <button type="button" class="btn" onClick={props.onClose} disabled={isLoading()}>Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            onClick={handleRequestRevision}
            disabled={isLoading()}
          >
            {isLoading() ? 'Requesting...' : 'Request Revision'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}
