import { useState, useEffect, useCallback, useRef } from 'react'
import { useOptionsContext, useToastContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks'
import { ModelPicker } from '@/components/common/ModelPicker'
import { ThinkingLevelSelect } from '@/components/common/ThinkingLevelSelect'
import { HelpButton } from '@/components/common/HelpButton'
import type { Options, ThinkingLevel, TelegramNotificationLevel } from '@/types'
import { DEFAULT_CODE_STYLE_PROMPT } from '@/types'

const DEFAULT_FORM_DATA: Partial<Options> = {
  branch: '',
  planModel: '',
  executionModel: '',
  reviewModel: '',
  repairModel: '',
  command: '',
  commitPrompt: '',
  extraPrompt: '',
  codeStylePrompt: DEFAULT_CODE_STYLE_PROMPT,
  parallelTasks: 1,
  maxReviews: 3,
  maxJsonParseRetries: 5,
  showExecutionGraph: false,
  autoDeleteNormalSessions: false,
  autoDeleteReviewSessions: false,
  thinkingLevel: 'default',
  planThinkingLevel: 'default',
  executionThinkingLevel: 'default',
  reviewThinkingLevel: 'default',
  repairThinkingLevel: 'default',
  telegramNotificationLevel: 'all',
  telegramBotToken: '',
  telegramChatId: '',
}

function isValidThinkingLevel(value: string): value is ThinkingLevel {
  return ['default', 'low', 'medium', 'high'].includes(value)
}

function isValidTelegramNotificationLevel(value: string): value is TelegramNotificationLevel {
  return ['all', 'failures', 'done_and_failures', 'workflow_done_and_failures'].includes(value)
}

export function OptionsTab() {
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

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true

    let cancelled = false
    const loadData = async () => {
      try {
        const [loadedOpts, branchData] = await Promise.all([
          loadOptions(),
          getBranches()
        ])
        if (cancelled) return

        const currentOpts = loadedOpts || {}
        setFormData({
          ...DEFAULT_FORM_DATA,
          branch: currentOpts.branch || branchData.current || branchData.branches?.[0] || '',
          planModel: currentOpts.planModel || '',
          executionModel: currentOpts.executionModel || '',
          reviewModel: currentOpts.reviewModel || '',
          repairModel: currentOpts.repairModel || '',
          command: currentOpts.command || '',
          commitPrompt: currentOpts.commitPrompt || '',
          extraPrompt: currentOpts.extraPrompt || '',
          codeStylePrompt: currentOpts.codeStylePrompt?.trim() ? currentOpts.codeStylePrompt : DEFAULT_CODE_STYLE_PROMPT,
          parallelTasks: currentOpts.parallelTasks ?? 1,
          maxReviews: currentOpts.maxReviews ?? 3,
          maxJsonParseRetries: currentOpts.maxJsonParseRetries ?? 5,
          showExecutionGraph: currentOpts.showExecutionGraph ?? false,
          autoDeleteNormalSessions: currentOpts.autoDeleteNormalSessions ?? false,
          autoDeleteReviewSessions: currentOpts.autoDeleteReviewSessions ?? false,
          thinkingLevel: isValidThinkingLevel(currentOpts.thinkingLevel || '') ? currentOpts.thinkingLevel : 'default',
          planThinkingLevel: isValidThinkingLevel(currentOpts.planThinkingLevel || '') ? currentOpts.planThinkingLevel : 'default',
          executionThinkingLevel: isValidThinkingLevel(currentOpts.executionThinkingLevel || '') ? currentOpts.executionThinkingLevel : 'default',
          reviewThinkingLevel: isValidThinkingLevel(currentOpts.reviewThinkingLevel || '') ? currentOpts.reviewThinkingLevel : 'default',
          repairThinkingLevel: isValidThinkingLevel(currentOpts.repairThinkingLevel || '') ? currentOpts.repairThinkingLevel : 'default',
          telegramNotificationLevel: isValidTelegramNotificationLevel(currentOpts.telegramNotificationLevel || '') ? currentOpts.telegramNotificationLevel : 'all',
          telegramBotToken: currentOpts.telegramBotToken || '',
          telegramChatId: currentOpts.telegramChatId || '',
        })
        setAvailableBranches(branchData.branches || [])
        setCurrentBranch(branchData.current || null)
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to load data'
        if (!cancelled) setBranchesError(errorMessage)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [loadOptions, getBranches])

  const updateField = useCallback(<K extends keyof Options>(key: K, value: Options[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }, [setFormData])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.branch) {
      toasts.showToast('Select a valid default branch', 'error')
      return
    }

    setIsSaving(true)
    try {
      if (!formData.branch) {
        throw new Error('Branch is required to save options')
      }
      const optionsToSave: Partial<Options> = {
        ...formData,
        codeStylePrompt: formData.codeStylePrompt?.trim() ? formData.codeStylePrompt : DEFAULT_CODE_STYLE_PROMPT,
      }
      await optionsHook.saveOptions(optionsToSave)
      toasts.showToast('Options saved successfully', 'success')
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to save options'
      toasts.showToast(errorMessage, 'error')
      throw new Error(`Options save failed: ${errorMessage}`)
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = useCallback(async () => {
    try {
      const loadedOpts = await loadOptions()
      if (loadedOpts) {
        setFormData({
          ...DEFAULT_FORM_DATA,
          branch: loadedOpts.branch || '',
          planModel: loadedOpts.planModel || '',
          executionModel: loadedOpts.executionModel || '',
          reviewModel: loadedOpts.reviewModel || '',
          repairModel: loadedOpts.repairModel || '',
          command: loadedOpts.command || '',
          commitPrompt: loadedOpts.commitPrompt || '',
          extraPrompt: loadedOpts.extraPrompt || '',
          codeStylePrompt: loadedOpts.codeStylePrompt?.trim() ? loadedOpts.codeStylePrompt : DEFAULT_CODE_STYLE_PROMPT,
          parallelTasks: loadedOpts.parallelTasks ?? 1,
          maxReviews: loadedOpts.maxReviews ?? 3,
          maxJsonParseRetries: loadedOpts.maxJsonParseRetries ?? 5,
          showExecutionGraph: loadedOpts.showExecutionGraph ?? false,
          autoDeleteNormalSessions: loadedOpts.autoDeleteNormalSessions ?? false,
          autoDeleteReviewSessions: loadedOpts.autoDeleteReviewSessions ?? false,
          thinkingLevel: isValidThinkingLevel(loadedOpts.thinkingLevel || '') ? loadedOpts.thinkingLevel : 'default',
          planThinkingLevel: isValidThinkingLevel(loadedOpts.planThinkingLevel || '') ? loadedOpts.planThinkingLevel : 'default',
          executionThinkingLevel: isValidThinkingLevel(loadedOpts.executionThinkingLevel || '') ? loadedOpts.executionThinkingLevel : 'default',
          reviewThinkingLevel: isValidThinkingLevel(loadedOpts.reviewThinkingLevel || '') ? loadedOpts.reviewThinkingLevel : 'default',
          repairThinkingLevel: isValidThinkingLevel(loadedOpts.repairThinkingLevel || '') ? loadedOpts.repairThinkingLevel : 'default',
          telegramNotificationLevel: isValidTelegramNotificationLevel(loadedOpts.telegramNotificationLevel || '') ? loadedOpts.telegramNotificationLevel : 'all',
          telegramBotToken: loadedOpts.telegramBotToken || '',
          telegramChatId: loadedOpts.telegramChatId || '',
        })
        toasts.showToast('Options reset to saved values', 'info')
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to reset options'
      toasts.showToast(errorMessage, 'error')
      throw new Error(`Options reset failed: ${errorMessage}`)
    }
  }, [loadOptions, toasts])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-dark-text-muted">Loading options...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <form onSubmit={handleSubmit} className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-dark-surface3">
          <h2 className="text-xl font-semibold text-dark-text flex items-center gap-2">
            <svg className="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Options Configuration
          </h2>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={handleReset} disabled={isSaving}>
              Reset
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Options'}
            </button>
          </div>
        </div>

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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
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
              onUpdate={(v) => {
                if (isValidThinkingLevel(v)) {
                  updateField('planThinkingLevel', v)
                }
              }}
            />
          </div>
          <div className="space-y-3">
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
              onUpdate={(v) => {
                if (isValidThinkingLevel(v)) {
                  updateField('executionThinkingLevel', v)
                }
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
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
              onUpdate={(v) => {
                if (isValidThinkingLevel(v)) {
                  updateField('reviewThinkingLevel', v)
                }
              }}
            />
          </div>
          <div className="space-y-3">
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
              onUpdate={(v) => {
                if (isValidThinkingLevel(v)) {
                  updateField('repairThinkingLevel', v)
                }
              }}
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

        {/* Parallel Tasks & Max Reviews */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

          <div className="form-group">
            <div className="label-row">
              <label>Max JSON Parse Retries</label>
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
        </div>

        {/* Session Cleanup & Execution Graph */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="form-group border border-dark-surface3 rounded-lg p-4">
            <div className="label-row">
              <label>Session Cleanup (global)</label>
              <HelpButton tooltip="Automatically delete TaurOboros sessions after task/review runs finish. Enable only if you do not need session history for debugging." />
            </div>
            <div className="checkbox-group space-y-2">
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

          <div className="form-group border border-dark-surface3 rounded-lg p-4">
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={formData.showExecutionGraph ?? false}
                onChange={(e) => updateField('showExecutionGraph', e.target.checked)}
              />
              <span>Show execution graph before starting workflow</span>
            </label>
          </div>
        </div>

        {/* Prompts */}
        <div className="space-y-4">
          <div className="form-group">
            <div className="label-row">
              <label>Commit Prompt <span className="text-dark-text-muted font-normal">({`{{`}base_ref{`}}`} will be replaced at runtime)</span></label>
              <HelpButton tooltip="Instructions used when the workflow asks the agent to prepare a git commit. Use {{base_ref}} anywhere you want the current base branch inserted automatically." />
            </div>
            <textarea
              className="form-textarea font-mono text-xs min-h-[120px]"
              placeholder="Instructions for committing changes..."
              value={formData.commitPrompt || ''}
              onChange={(e) => updateField('commitPrompt', e.target.value)}
            />
          </div>

          <div className="form-group">
            <div className="label-row">
              <label>Code Style Prompt</label>
              <HelpButton tooltip="Instructions for code style enforcement. The agent will review code and apply fixes to comply with these rules. Uses the Review Model. If left empty, the default prompt will be used." />
            </div>
            <textarea
              className="form-textarea font-mono text-xs min-h-[100px]"
              placeholder="Code style rules..."
              value={formData.codeStylePrompt || ''}
              onChange={(e) => updateField('codeStylePrompt', e.target.value)}
            />
          </div>

          <div className="form-group">
            <div className="label-row">
              <label>Extra Prompt <span className="text-dark-text-muted font-normal">(added to every prompt)</span></label>
              <HelpButton tooltip="Additional instructions that will be appended to every task prompt sent to the agent." />
            </div>
            <textarea
              className="form-textarea font-mono text-xs min-h-[80px]"
              placeholder="Additional context or instructions for all tasks..."
              value={formData.extraPrompt || ''}
              onChange={(e) => updateField('extraPrompt', e.target.value)}
            />
          </div>
        </div>

        {/* Telegram Notifications */}
        <div className="form-group border border-dark-surface3 rounded-lg p-4">
          <div className="label-row">
            <label>Telegram Notifications</label>
            <HelpButton tooltip="Configure when to receive Telegram notifications about task and workflow status changes. Leave bot token and chat ID empty to disable notifications." />
          </div>
          <div className="mb-3">
            <label className="text-xs text-dark-text-muted mb-1 block">Notification Level</label>
            <select
              className="form-select"
              value={formData.telegramNotificationLevel || 'all'}
              onChange={(e) => {
                const value = e.target.value
                if (isValidTelegramNotificationLevel(value)) {
                  updateField('telegramNotificationLevel', value)
                }
              }}
            >
              <option value="all">Every state change</option>
              <option value="failures">Only failures</option>
              <option value="done_and_failures">Only when tasks done and failures</option>
              <option value="workflow_done_and_failures">Only on workflow done and failures</option>
            </select>
            <p className="text-xs text-dark-text-muted mt-1">
              {formData.telegramNotificationLevel === 'all' && 'Receive notifications for every task status change.'}
              {formData.telegramNotificationLevel === 'failures' && 'Only receive notifications when a task fails or gets stuck.'}
              {formData.telegramNotificationLevel === 'done_and_failures' && 'Receive notifications when tasks complete, fail, or get stuck.'}
              {formData.telegramNotificationLevel === 'workflow_done_and_failures' && 'Receive a workflow summary when complete, plus notifications for failures.'}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

        {/* Footer Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t border-dark-surface3">
          <button type="button" className="btn" onClick={handleReset} disabled={isSaving}>
            Reset
          </button>
          <button type="submit" className="btn btn-primary" disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save Options'}
          </button>
        </div>
      </form>
    </div>
  )
}
