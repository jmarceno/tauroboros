import { useState, useEffect, useCallback } from 'react'
import { useOptionsContext, useToastContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks'
import { ModelPicker } from '../common/ModelPicker'
import { ThinkingLevelSelect } from '../common/ThinkingLevelSelect'
import { HelpButton } from '../common/HelpButton'
import type { Options, ThinkingLevel } from '@/types'
import { DEFAULT_CODE_STYLE_PROMPT } from '@/types'

interface OptionsModalProps {
  onClose: () => void
}

export function OptionsModal({ onClose }: OptionsModalProps) {
  const api = useApi()
  const optionsHook = useOptionsContext()
  const toasts = useToastContext()
  const getBranches = api.getBranches
  const loadOptions = optionsHook.loadOptions

  const [formData, setFormData] = useState<Partial<Options>>({})
  const [availableBranches, setAvailableBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [branchesError, setBranchesError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    const loadData = async () => {
      try {
        const loadedOpts = await loadOptions()
        if (cancelled) return

        const branchData = await getBranches()
        if (cancelled) return

        const currentOpts = loadedOpts || {}
        setFormData({
          branch: currentOpts.branch || branchData.current || branchData.branches?.[0] || '',
          planModel: currentOpts.planModel || '',
          executionModel: currentOpts.executionModel || '',
          reviewModel: currentOpts.reviewModel || '',
          repairModel: currentOpts.repairModel || '',
          command: currentOpts.command || '',
          commitPrompt: currentOpts.commitPrompt || '',
          extraPrompt: currentOpts.extraPrompt || '',
          codeStylePrompt: currentOpts.codeStylePrompt || DEFAULT_CODE_STYLE_PROMPT,
          parallelTasks: currentOpts.parallelTasks ?? 1,
          maxReviews: currentOpts.maxReviews ?? 3,
          maxJsonParseRetries: currentOpts.maxJsonParseRetries ?? 5,
          showExecutionGraph: currentOpts.showExecutionGraph ?? false,
          autoDeleteNormalSessions: currentOpts.autoDeleteNormalSessions ?? false,
          autoDeleteReviewSessions: currentOpts.autoDeleteReviewSessions ?? false,
          thinkingLevel: currentOpts.thinkingLevel || 'default',
          planThinkingLevel: currentOpts.planThinkingLevel || 'default',
          executionThinkingLevel: currentOpts.executionThinkingLevel || 'default',
          reviewThinkingLevel: currentOpts.reviewThinkingLevel || 'default',
          repairThinkingLevel: currentOpts.repairThinkingLevel || 'default',
          telegramNotificationsEnabled: currentOpts.telegramNotificationsEnabled ?? false,
          telegramBotToken: currentOpts.telegramBotToken || '',
          telegramChatId: currentOpts.telegramChatId || '',
        })
        setAvailableBranches(branchData.branches || [])
        setCurrentBranch(branchData.current || null)
      } catch (e) {
        console.error('Failed to load options:', e)
        if (!cancelled) setBranchesError(e instanceof Error ? e.message : 'Failed to load data')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run once on mount - loadOptions and getBranches are stable

  const updateField = useCallback(<K extends keyof Options>(key: K, value: Options[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.branch) {
      toasts.showToast('Select a valid default branch', 'error')
      return
    }

    setIsSaving(true)
    try {
      // Normalize empty code style prompt to default - avoid silent fallbacks
      const optionsToSave: Partial<Options> = {
        ...formData,
        codeStylePrompt: formData.codeStylePrompt?.trim() ? formData.codeStylePrompt : DEFAULT_CODE_STYLE_PROMPT,
      }
      await optionsHook.saveOptions(optionsToSave)
      toasts.showToast('Options saved successfully', 'success')
      onClose()
    } catch (e) {
      console.error('Save failed:', e)
      toasts.showToast(e instanceof Error ? e.message : 'Failed to save options', 'error')
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal w-[min(560px,calc(100vw-40px))]" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Options</h2>
            <button className="icon-btn" onClick={onClose}>×</button>
          </div>
          <div className="modal-body p-8 text-center">
            <div className="text-dark-text-muted">Loading options...</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal w-[min(560px,calc(100vw-40px))]" style={{ maxHeight: 'calc(100vh - 40px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Options</h2>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body space-y-3" style={{ maxHeight: 'calc(100vh - 180px)', overflowY: 'auto' }}>
            {/* Default Branch */}
            <div className="form-group">
              <div className="label-row">
                <label>Default Branch</label>
                <HelpButton tooltip="Default git branch for new tasks when a task-specific branch is not selected." />
              </div>
              {branchesError && (
                <div className="text-xs text-red-400 mb-1">Error loading branches: {branchesError}</div>
              )}
              <select
                className="form-select"
                value={formData.branch || ''}
                onChange={(e) => updateField('branch', e.target.value)}
                disabled={availableBranches.length === 0}
              >
                <option value="" disabled>No branches available</option>
                {availableBranches.map(branch => (
                  <option key={branch} value={branch}>{branch}</option>
                ))}
              </select>
              {availableBranches.length === 0 && !branchesError && (
                <div className="text-xs text-dark-text-muted mt-1">Loading branches...</div>
              )}
            </div>

            {/* Models with Thinking Levels */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <ModelPicker
                  modelValue={formData.planModel || ''}
                  label="Plan Model (global)"
                  help="Default planning model for new tasks. Individual tasks can override this value."
                  onUpdate={(v) => updateField('planModel', v)}
                />
                <ThinkingLevelSelect
                  modelValue={formData.planThinkingLevel || 'default'}
                  label="Plan Thinking"
                  help="Default thinking level for planning phase."
                  onUpdate={(v) => updateField('planThinkingLevel', v as ThinkingLevel)}
                />
              </div>
              <div className="space-y-2">
                <ModelPicker
                  modelValue={formData.executionModel || ''}
                  label="Execution Model (global)"
                  help="Default execution model for new tasks. Individual tasks can override this value."
                  onUpdate={(v) => updateField('executionModel', v)}
                />
                <ThinkingLevelSelect
                  modelValue={formData.executionThinkingLevel || 'default'}
                  label="Execution Thinking"
                  help="Default thinking level for execution phase."
                  onUpdate={(v) => updateField('executionThinkingLevel', v as ThinkingLevel)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <ModelPicker
                  modelValue={formData.reviewModel || ''}
                  label="Review Model"
                  help="Model used by the workflow-review agent. This is stored in the database and used for all review operations."
                  onUpdate={(v) => updateField('reviewModel', v)}
                />
                <ThinkingLevelSelect
                  modelValue={formData.reviewThinkingLevel || 'default'}
                  label="Review Thinking"
                  help="Default thinking level for review phase."
                  onUpdate={(v) => updateField('reviewThinkingLevel', v as ThinkingLevel)}
                />
              </div>
              <div className="space-y-2">
                <ModelPicker
                  modelValue={formData.repairModel || ''}
                  label="Repair Model"
                  help="Model used by the workflow-repair agent for state repair analysis."
                  onUpdate={(v) => updateField('repairModel', v)}
                />
                <ThinkingLevelSelect
                  modelValue={formData.repairThinkingLevel || 'default'}
                  label="Repair Thinking"
                  help="Default thinking level for repair operations."
                  onUpdate={(v) => updateField('repairThinkingLevel', v as ThinkingLevel)}
                />
              </div>
            </div>

            {/* Pre-execution Command */}
            <div className="form-group">
              <div className="label-row">
                <label>Pre-execution Command</label>
                <HelpButton tooltip="Command to run before task execution begins, such as installing dependencies or preparing the workspace." />
              </div>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. npm install"
                value={formData.command || ''}
                onChange={(e) => updateField('command', e.target.value)}
              />
            </div>

            {/* Parallel Tasks */}
            <div className="form-group">
              <div className="label-row">
                <label>Parallel Tasks</label>
                <HelpButton tooltip="Maximum number of tasks the workflow should execute at the same time." />
              </div>
              <input
                type="number"
                className="form-input"
                min={1}
                max={10}
                value={formData.parallelTasks ?? 1}
                onChange={(e) => updateField('parallelTasks', parseInt(e.target.value) || 1)}
              />
            </div>

            {/* Max Reviews */}
            <div className="form-group">
              <div className="label-row">
                <label>Maximum Review Runs</label>
                <HelpButton tooltip="Maximum number of review cycles for a task before it gets stuck. Can be overridden per-task." />
              </div>
              <input
                type="number"
                className="form-input"
                min={1}
                max={10}
                value={formData.maxReviews ?? 3}
                onChange={(e) => updateField('maxReviews', parseInt(e.target.value) || 3)}
              />
            </div>

            {/* Max JSON Parse Retries */}
            <div className="form-group">
              <div className="label-row">
                <label>Maximum JSON Parse Retries</label>
                <HelpButton tooltip="Maximum consecutive retries when a review response fails JSON parsing before marking task as stuck. Resets when a valid JSON response is received." />
              </div>
              <input
                type="number"
                className="form-input"
                min={1}
                max={20}
                value={formData.maxJsonParseRetries ?? 5}
                onChange={(e) => updateField('maxJsonParseRetries', parseInt(e.target.value) || 5)}
              />
            </div>

            {/* Session Cleanup */}
            <div className="form-group">
              <div className="label-row">
                <label>Session Cleanup (global)</label>
                <HelpButton tooltip="Automatically delete TaurOboros sessions after task/review runs finish. Enable only if you do not need session history for debugging." />
              </div>
              <div className="checkbox-group">
                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={formData.autoDeleteNormalSessions ?? false}
                    onChange={(e) => updateField('autoDeleteNormalSessions', e.target.checked)}
                  />
                  <span>Auto-delete normal sessions</span>
                </label>
                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={formData.autoDeleteReviewSessions ?? false}
                    onChange={(e) => updateField('autoDeleteReviewSessions', e.target.checked)}
                  />
                  <span>Auto-delete review sessions</span>
                </label>
              </div>
            </div>

            {/* Show Execution Graph */}
            <div className="form-group">
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={formData.showExecutionGraph ?? false}
                  onChange={(e) => updateField('showExecutionGraph', e.target.checked)}
                />
                <span>Show execution graph before starting workflow</span>
              </label>
            </div>

            {/* Commit Prompt */}
            <div className="form-group">
              <div className="label-row">
                <label>Commit Prompt <span className="text-dark-text-muted font-normal">({`{{`}base_ref{`}}`} will be replaced at runtime)</span></label>
                <HelpButton tooltip="Instructions used when the workflow asks the agent to prepare a git commit. Use {{base_ref}} anywhere you want the current base branch inserted automatically." />
              </div>
              <textarea
                className="form-textarea font-mono text-xs"
                style={{ minHeight: '180px' }}
                placeholder="Instructions for committing changes..."
                value={formData.commitPrompt || ''}
                onChange={(e) => updateField('commitPrompt', e.target.value)}
              />
            </div>

            {/* Code Style Prompt */}
            <div className="form-group">
              <div className="label-row">
                <label>Code Style Prompt</label>
                <HelpButton tooltip="Instructions for code style enforcement. The agent will review code and apply fixes to comply with these rules. Uses the Review Model. If left empty, the default prompt will be used." />
              </div>
              <textarea
                className="form-textarea font-mono text-xs"
                style={{ minHeight: '120px' }}
                placeholder="Code style rules..."
                value={formData.codeStylePrompt || ''}
                onChange={(e) => updateField('codeStylePrompt', e.target.value)}
              />
            </div>

            {/* Extra Prompt */}
            <div className="form-group">
              <div className="label-row">
                <label>Extra Prompt <span className="text-dark-text-muted font-normal">(added to every prompt)</span></label>
                <HelpButton tooltip="Additional instructions that will be appended to every task prompt sent to the agent." />
              </div>
              <textarea
                className="form-textarea font-mono text-xs"
                style={{ minHeight: '100px' }}
                placeholder="Additional context or instructions for all tasks..."
                value={formData.extraPrompt || ''}
                onChange={(e) => updateField('extraPrompt', e.target.value)}
              />
            </div>

            {/* Telegram Notifications */}
            <div className="form-group border border-dark-surface3 rounded-lg p-3">
              <div className="label-row">
                <label>Telegram Notifications</label>
                <HelpButton tooltip="Send a Telegram message when a task changes state. Leave both fields empty to disable notifications." />
              </div>
              <label className="checkbox-item mb-2">
                <input
                  type="checkbox"
                  checked={formData.telegramNotificationsEnabled ?? false}
                  onChange={(e) => updateField('telegramNotificationsEnabled', e.target.checked)}
                />
                <span>Enable Telegram notifications</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-dark-text-muted mb-1 block">Bot Token</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxYZ"
                    value={formData.telegramBotToken || ''}
                    onChange={(e) => updateField('telegramBotToken', e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-dark-text-muted mb-1 block">Chat ID</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="-1001234567890 or @channel_name"
                    value={formData.telegramChatId || ''}
                    onChange={(e) => updateField('telegramChatId', e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
