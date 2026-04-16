import { useState } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useToastContext } from '@/contexts/AppContext'

interface ApproveModalProps {
  taskId: string
  onClose: () => void
}

export function ApproveModal({ taskId, onClose }: ApproveModalProps) {
  const tasks = useTasksContext()
  const toasts = useToastContext()
  const [message, setMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const task = tasks.getTaskById(taskId)

  const handleApprove = async () => {
    setIsLoading(true)
    try {
      await tasks.approvePlan(taskId, message)
      toasts.showToast('Plan approved', 'success')
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to approve plan', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper title={`Approve Plan: ${task?.name || taskId}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="form-group">
          <label>Approval Message (optional)</label>
          <textarea
            className="form-textarea"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="Enter any feedback or approval message..."
          />
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={isLoading}>Cancel</button>
          <button 
            type="button" 
            className="btn btn-primary" 
            onClick={handleApprove}
            disabled={isLoading}
          >
            {isLoading ? 'Approving...' : 'Approve Plan'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}
