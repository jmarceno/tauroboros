import { useState } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useOptionsContext, useToastContext, useModelSearchContext } from '@/contexts/AppContext'
import type { ThinkingLevel, TaskStatus } from '@/types'

interface BatchEditModalProps {
  taskIds: string[]
  onClose: () => void
}

export function BatchEditModal({ taskIds, onClose }: BatchEditModalProps) {
  const tasks = useTasksContext()
  const options = useOptionsContext()
  const toasts = useToastContext()
  const modelSearch = useModelSearchContext()

  const [planModel, setPlanModel] = useState('')
  const [executionModel, setExecutionModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('' as ThinkingLevel)
  const [status, setStatus] = useState<TaskStatus>('' as TaskStatus)
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const updates: Partial<{ planModel: string; executionModel: string; thinkingLevel: ThinkingLevel; status: TaskStatus }> = {}
      if (planModel) updates.planModel = planModel
      if (executionModel) updates.executionModel = executionModel
      if (thinkingLevel) updates.thinkingLevel = thinkingLevel
      if (status) updates.status = status

      await Promise.all(taskIds.map(id => tasks.updateTask(id, updates)))
      toasts.showToast(`Updated ${taskIds.length} tasks`, 'success')
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to update tasks', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper title={`Batch Edit: ${taskIds.length} Tasks`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-dark-text-muted">
          Select the fields you want to update. Leave blank to keep current values.
        </p>

        <div className="form-group">
          <label>Status</label>
          <select
            className="form-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
          >
            <option value="">Keep current</option>
            <option value="template">Template</option>
            <option value="backlog">Backlog</option>
            <option value="executing">Executing</option>
            <option value="review">Review</option>
            <option value="done">Done</option>
          </select>
        </div>

        <div className="form-group">
          <label>Plan Model</label>
          <select
            className="form-select"
            value={planModel}
            onChange={(e) => setPlanModel(e.target.value)}
          >
            <option value="">Keep current</option>
            {modelSearch.getModelOptions().map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Execution Model</label>
          <select
            className="form-select"
            value={executionModel}
            onChange={(e) => setExecutionModel(e.target.value)}
          >
            <option value="">Keep current</option>
            {modelSearch.getModelOptions().map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Thinking Level</label>
          <select
            className="form-select"
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
          >
            <option value="">Keep current</option>
            <option value="default">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={isLoading}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={isLoading}>
            {isLoading ? 'Updating...' : `Update ${taskIds.length} Tasks`}
          </button>
        </div>
      </form>
    </ModalWrapper>
  )
}
