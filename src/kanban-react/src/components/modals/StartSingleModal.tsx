import { useState } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useToastContext } from '@/contexts/AppContext'

interface StartSingleModalProps {
  taskId: string
  onClose: () => void
}

export function StartSingleModal({ taskId, onClose }: StartSingleModalProps) {
  const tasks = useTasksContext()
  const toasts = useToastContext()
  const [isLoading, setIsLoading] = useState(false)

  const task = tasks.getTaskById(taskId)

  const handleStart = async () => {
    setIsLoading(true)
    try {
      await tasks.startSingleTask(taskId)
      toasts.showToast('Task started', 'success')
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to start task', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper title={`Start Task: ${task?.name || taskId}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-dark-text-secondary">
          Start this task immediately? This will bypass the normal workflow execution queue.
        </p>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={isLoading}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleStart}
            disabled={isLoading}
          >
            {isLoading ? 'Starting...' : 'Start Task'}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}
