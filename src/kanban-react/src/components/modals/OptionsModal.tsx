import { useState, useEffect } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useOptionsContext, useToastContext, useModelSearchContext } from '@/contexts/AppContext'
import type { Options, ThinkingLevel } from '@/types'

interface OptionsModalProps {
  onClose: () => void
}

export function OptionsModal({ onClose }: OptionsModalProps) {
  const optionsCtx = useOptionsContext()
  const toasts = useToastContext()
  const modelSearch = useModelSearchContext()

  const [formData, setFormData] = useState<Partial<Options>>(optionsCtx.options || {})

  useEffect(() => {
    if (optionsCtx.options) {
      setFormData(optionsCtx.options)
    }
  }, [optionsCtx.options])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await optionsCtx.saveOptions(formData)
      toasts.showToast('Options saved', 'success')
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to save options', 'error')
    }
  }

  return (
    <ModalWrapper title="Options" onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="form-group">
            <label>Default Branch</label>
            <input
              type="text"
              className="form-input"
              value={formData.branch || ''}
              onChange={(e) => setFormData({ ...formData, branch: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Parallel Tasks</label>
            <input
              type="number"
              className="form-input"
              value={formData.parallelTasks || 1}
              onChange={(e) => setFormData({ ...formData, parallelTasks: parseInt(e.target.value) })}
              min={1}
              max={10}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="form-group">
            <label>Default Plan Model</label>
            <select
              className="form-select"
              value={formData.planModel || 'default'}
              onChange={(e) => setFormData({ ...formData, planModel: e.target.value })}
            >
              {modelSearch.getModelOptions(formData.planModel).map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Default Execution Model</label>
            <select
              className="form-select"
              value={formData.executionModel || 'default'}
              onChange={(e) => setFormData({ ...formData, executionModel: e.target.value })}
            >
              {modelSearch.getModelOptions(formData.executionModel).map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="form-group">
            <label>Default Thinking Level</label>
            <select
              className="form-select"
              value={formData.thinkingLevel || 'default'}
              onChange={(e) => setFormData({ ...formData, thinkingLevel: e.target.value as ThinkingLevel })}
            >
              <option value="default">Default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div className="form-group">
            <label>Max Reviews</label>
            <input
              type="number"
              className="form-input"
              value={formData.maxReviews || 3}
              onChange={(e) => setFormData({ ...formData, maxReviews: parseInt(e.target.value) })}
              min={0}
              max={10}
            />
          </div>
        </div>

        <div className="checkbox-group">
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={formData.showExecutionGraph || false}
              onChange={(e) => setFormData({ ...formData, showExecutionGraph: e.target.checked })}
            />
            <span>Show Execution Graph Preview</span>
          </label>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={formData.container?.enabled || false}
              onChange={(e) => setFormData({ ...formData, container: { ...formData.container, enabled: e.target.checked } })}
            />
            <span>Enable Container Mode</span>
          </label>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save Options</button>
        </div>
      </form>
    </ModalWrapper>
  )
}
