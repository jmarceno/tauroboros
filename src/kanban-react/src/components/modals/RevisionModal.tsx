import { useState } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useToastContext } from '@/contexts/AppContext'

interface RevisionModalProps {
  taskId: string
  onClose: () => void
}

export function RevisionModal({ taskId, onClose }: RevisionModalProps) {
  const tasks = useTasksContext()
  const toasts = useToastContext()
  const [feedback, setFeedback] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const task = tasks.getTaskById(taskId)

  const handleRequestRevision = async () => {
    if (!feedback.trim()) {
      toasts.showToast('Please provide feedback for the revision', 'error')
      return
    }

    setIsLoading(true)
    try {
      await tasks.requestPlanRevision(taskId, feedback)
      toasts.showToast('Revision requested', 'success')
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to request revision', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper title={`Request Revision: ${task?.name || taskId}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="form-group">
          <label>Revision Feedback</label>
          <textarea
            className="form-textarea"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={6}
            placeholder="Describe what needs to be revised in the plan..."
            required
          />
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={isLoading}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleRequestRevision}
            disabled={isLoading}
          >
            {isLoading ? 'Requesting...' : 'Request Revision'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}
