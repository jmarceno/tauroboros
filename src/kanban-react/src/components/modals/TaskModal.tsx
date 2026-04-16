import { useState } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useOptionsContext, useModelSearchContext, useToastContext } from '@/contexts/AppContext'
import type { TaskStatus, ThinkingLevel, ExecutionStrategy, BestOfNConfig } from '@/types'

interface TaskModalProps {
  mode: 'create' | 'edit' | 'deploy'
  taskId?: string
  createStatus?: 'template' | 'backlog'
  seedTaskId?: string
  onClose: () => void
}

export function TaskModal({ mode, taskId, createStatus = 'backlog', seedTaskId, onClose }: TaskModalProps) {
  const tasks = useTasksContext()
  const options = useOptionsContext()
  const modelSearch = useModelSearchContext()
  const toasts = useToastContext()

  const existingTask = taskId ? tasks.getTaskById(taskId) : null
  const seedTask = seedTaskId ? tasks.getTaskById(seedTaskId) : null

  const [name, setName] = useState(existingTask?.name || seedTask?.name || '')
  const [prompt, setPrompt] = useState(existingTask?.prompt || seedTask?.prompt || '')
  const [status, setStatus] = useState<TaskStatus>(existingTask?.status || createStatus || 'backlog')
  const [planModel, setPlanModel] = useState(existingTask?.planModel || options.options?.planModel || 'default')
  const [executionModel, setExecutionModel] = useState(existingTask?.executionModel || options.options?.executionModel || 'default')
  const [branch, setBranch] = useState(existingTask?.branch || options.options?.branch || 'main')
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(existingTask?.thinkingLevel || options.options?.thinkingLevel || 'default')
  const [planThinkingLevel, setPlanThinkingLevel] = useState<ThinkingLevel>(existingTask?.planThinkingLevel || options.options?.planThinkingLevel || 'default')
  const [executionThinkingLevel, setExecutionThinkingLevel] = useState<ThinkingLevel>(existingTask?.executionThinkingLevel || options.options?.executionThinkingLevel || 'default')
  const [planmode, setPlanmode] = useState(existingTask?.planmode ?? options.options?.planModel !== undefined ?? false)
  const [autoApprovePlan, setAutoApprovePlan] = useState(existingTask?.autoApprovePlan ?? false)
  const [review, setReview] = useState(existingTask?.review ?? true)
  const [autoCommit, setAutoCommit] = useState(existingTask?.autoCommit ?? true)
  const [deleteWorktree, setDeleteWorktree] = useState(existingTask?.deleteWorktree ?? false)
  const [skipPermissionAsking, setSkipPermissionAsking] = useState(existingTask?.skipPermissionAsking ?? false)
  const [requirements, setRequirements] = useState<string[]>(existingTask?.requirements || seedTask?.requirements || [])
  const [executionStrategy, setExecutionStrategy] = useState<ExecutionStrategy>(existingTask?.executionStrategy || 'standard')
  const [bestOfNConfig, setBestOfNConfig] = useState<BestOfNConfig | undefined>(existingTask?.bestOfNConfig)
  const [containerImage, setContainerImage] = useState(existingTask?.containerImage || options.options?.container?.image || '')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    try {
      if (mode === 'edit' && taskId) {
        await tasks.updateTask(taskId, {
          name,
          prompt,
          status,
          planModel,
          executionModel,
          branch,
          thinkingLevel,
          planThinkingLevel,
          executionThinkingLevel,
          planmode,
          autoApprovePlan,
          review,
          autoCommit,
          deleteWorktree,
          skipPermissionAsking,
          requirements,
          executionStrategy,
          bestOfNConfig,
          containerImage,
        })
        toasts.showToast('Task updated', 'success')
      } else if (mode === 'deploy' && seedTaskId) {
        await tasks.createTask({
          name,
          prompt,
          status: 'backlog',
          planModel,
          executionModel,
          branch,
          thinkingLevel,
          planThinkingLevel,
          executionThinkingLevel,
          planmode,
          autoApprovePlan,
          review,
          autoCommit,
          deleteWorktree,
          skipPermissionAsking,
          requirements,
          executionStrategy,
          bestOfNConfig,
          containerImage,
        })
        toasts.showToast('Template deployed', 'success')
      } else {
        await tasks.createTask({
          name,
          prompt,
          status,
          planModel,
          executionModel,
          branch,
          thinkingLevel,
          planThinkingLevel,
          executionThinkingLevel,
          planmode,
          autoApprovePlan,
          review,
          autoCommit,
          deleteWorktree,
          skipPermissionAsking,
          requirements,
          executionStrategy,
          bestOfNConfig,
          containerImage,
        })
        toasts.showToast('Task created', 'success')
      }
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to save task', 'error')
    }
  }

  return (
    <ModalWrapper 
      title={mode === 'edit' ? 'Edit Task' : mode === 'deploy' ? 'Deploy Template' : 'Create Task'} 
      onClose={onClose}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="form-group">
          <label>Name</label>
          <input
            type="text"
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label>Prompt</label>
          <textarea
            className="form-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="form-group">
            <label>Status</label>
            <select
              className="form-select"
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
            >
              <option value="template">Template</option>
              <option value="backlog">Backlog</option>
              <option value="executing">Executing</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
            </select>
          </div>

          <div className="form-group">
            <label>Branch</label>
            <input
              type="text"
              className="form-input"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="form-group">
            <label>Plan Model</label>
            <select
              className="form-select"
              value={planModel}
              onChange={(e) => setPlanModel(e.target.value)}
            >
              {modelSearch.getModelOptions(planModel).map(opt => (
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
              {modelSearch.getModelOptions(executionModel).map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="form-group">
            <label>Thinking Level</label>
            <select
              className="form-select"
              value={thinkingLevel}
              onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            >
              <option value="default">Default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>

          <div className="form-group">
            <label>Container Image</label>
            <input
              type="text"
              className="form-input"
              value={containerImage}
              onChange={(e) => setContainerImage(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="checkbox-group">
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={planmode}
              onChange={(e) => setPlanmode(e.target.checked)}
            />
            <span>Plan Mode</span>
          </label>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={autoApprovePlan}
              onChange={(e) => setAutoApprovePlan(e.target.checked)}
            />
            <span>Auto-approve Plan</span>
          </label>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={review}
              onChange={(e) => setReview(e.target.checked)}
            />
            <span>Enable Review</span>
          </label>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={autoCommit}
              onChange={(e) => setAutoCommit(e.target.checked)}
            />
            <span>Auto Commit</span>
          </label>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={deleteWorktree}
              onChange={(e) => setDeleteWorktree(e.target.checked)}
            />
            <span>Delete Worktree</span>
          </label>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">
            {mode === 'edit' ? 'Update' : mode === 'deploy' ? 'Deploy' : 'Create'}
          </button>
        </div>
      </form>
    </ModalWrapper>
  )
}
