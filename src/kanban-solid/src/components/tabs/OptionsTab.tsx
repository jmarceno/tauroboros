/**
 * OptionsTab Component - Full options configuration form
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, createMemo, batch, Show, For } from 'solid-js'
import { createQuery, useQueryClient } from '@tanstack/solid-query'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { HelpButton } from '@/components/common/HelpButton'
import { ModelPicker } from '@/components/common/ModelPicker'
import { ThinkingLevelSelect } from '@/components/common/ThinkingLevelSelect'
import { uiStore } from '@/stores'
import { optionsApi, referenceApi } from '@/api'
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
  const queryClient = useQueryClient()

  const [formData, setFormData] = createSignal<Partial<Options>>({})
  const [availableBranches, setAvailableBranches] = createSignal<string[]>([])
  const [currentBranch, setCurrentBranch] = createSignal<string | null>(null)
  const [branchesError, setBranchesError] = createSignal<string | null>(null)
  const [isLoading, setIsLoading] = createSignal(true)
  const [isSaving, setIsSaving] = createSignal(false)
  const [hasHydrated, setHasHydrated] = createSignal(false)

  // Queries
  const optionsQuery = createQuery(() => ({
    queryKey: ['options'],
    queryFn: () => optionsApi.get(),
    staleTime: 10000,
  }))

  const branchesQuery = createQuery(() => ({
    queryKey: ['branches'],
    queryFn: () => referenceApi.getBranches(),
    staleTime: 60000,
  }))

  // Reactive memos for query state (following tasksStore pattern)
  const opts = createMemo(() => optionsQuery.data)
  const branchData = createMemo(() => branchesQuery.data)
  const queryIsLoading = createMemo(() => optionsQuery.isLoading || branchesQuery.isLoading)
  const queryError = createMemo(() => optionsQuery.error?.message || branchesQuery.error?.message || null)
  const branchOptions = createMemo(() => {
    const options = new Set(availableBranches())
    const selectedBranch = formData().branch?.trim()
    if (selectedBranch) {
      options.add(selectedBranch)
    }
    return Array.from(options)
  })

  // Function to process loaded data
  const processLoadedData = (options: Options | undefined, branches: import('@/types').BranchList | undefined, error: string | null) => {
    if (error) {
      setBranchesError(error)
      setIsLoading(false)
      setHasHydrated(true)
      return
    }

    if (options !== undefined && branches !== undefined) {
      const currentOpts = options || {}
      batch(() => {
        setFormData({
          ...DEFAULT_FORM_DATA,
          branch: currentOpts.branch || branches.current || branches.branches?.[0] || '',
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
        setAvailableBranches(branches.branches || [])
        setCurrentBranch(branches.current || null)
        setIsLoading(false)
        setHasHydrated(true)
      })
    }
  }

  // Load initial data when queries complete
  createEffect(() => {
    // Access the memoized values to track reactivity
    const loading = queryIsLoading()
    const error = queryError()
    const options = opts()
    const branches = branchData()

    // Still loading - wait for next effect run
    if (loading) {
      return
    }

    if (hasHydrated()) {
      return
    }

    // Process the loaded data
    processLoadedData(options, branches, error)
  })

  const updateField = <K extends keyof Options>(key: K, value: Options[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    if (!formData().branch) {
      uiStore.showToast('Select a valid default branch', 'error')
      return
    }

    setIsSaving(true)
    try {
      const optionsToSave: Partial<Options> = {
        ...formData(),
        codeStylePrompt: formData().codeStylePrompt?.trim() ? formData().codeStylePrompt : DEFAULT_CODE_STYLE_PROMPT,
      }
      await optionsApi.update(optionsToSave)
      await queryClient.invalidateQueries({ queryKey: ['options'] })
      uiStore.showToast('Options saved successfully', 'success')
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to save options'
      uiStore.showToast(errorMessage, 'error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = async () => {
    try {
      const opts = await queryClient.fetchQuery({
        queryKey: ['options'],
        queryFn: () => optionsApi.get(),
      })
      if (opts) {
        setFormData({
          ...DEFAULT_FORM_DATA,
          branch: opts.branch || '',
          planModel: opts.planModel || '',
          executionModel: opts.executionModel || '',
          reviewModel: opts.reviewModel || '',
          repairModel: opts.repairModel || '',
          command: opts.command || '',
          commitPrompt: opts.commitPrompt || '',
          extraPrompt: opts.extraPrompt || '',
          codeStylePrompt: opts.codeStylePrompt?.trim() ? opts.codeStylePrompt : DEFAULT_CODE_STYLE_PROMPT,
          parallelTasks: opts.parallelTasks ?? 1,
          maxReviews: opts.maxReviews ?? 3,
          maxJsonParseRetries: opts.maxJsonParseRetries ?? 5,
          showExecutionGraph: opts.showExecutionGraph ?? false,
          autoDeleteNormalSessions: opts.autoDeleteNormalSessions ?? false,
          autoDeleteReviewSessions: opts.autoDeleteReviewSessions ?? false,
          thinkingLevel: isValidThinkingLevel(opts.thinkingLevel || '') ? opts.thinkingLevel : 'default',
          planThinkingLevel: isValidThinkingLevel(opts.planThinkingLevel || '') ? opts.planThinkingLevel : 'default',
          executionThinkingLevel: isValidThinkingLevel(opts.executionThinkingLevel || '') ? opts.executionThinkingLevel : 'default',
          reviewThinkingLevel: isValidThinkingLevel(opts.reviewThinkingLevel || '') ? opts.reviewThinkingLevel : 'default',
          repairThinkingLevel: isValidThinkingLevel(opts.repairThinkingLevel || '') ? opts.repairThinkingLevel : 'default',
          telegramNotificationLevel: isValidTelegramNotificationLevel(opts.telegramNotificationLevel || '') ? opts.telegramNotificationLevel : 'all',
          telegramBotToken: opts.telegramBotToken || '',
          telegramChatId: opts.telegramChatId || '',
        })
        uiStore.showToast('Options reset to saved values', 'info')
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to reset options'
      uiStore.showToast(errorMessage, 'error')
    }
  }

  return (
    <Show when={!queryIsLoading()} fallback={
      <div class="flex-1 flex items-center justify-center p-8">
        <div class="text-dark-text-muted">Loading options...</div>
      </div>
    }>
    <div class="flex-1 overflow-y-auto p-6">
      <form onSubmit={handleSubmit} class="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div class="flex items-center justify-between pb-4 border-b border-dark-surface3">
          <h2 class="text-xl font-semibold text-dark-text flex items-center gap-2">
            <svg class="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Options Configuration
          </h2>
          <div class="flex gap-2">
            <button type="button" class="btn" onClick={handleReset} disabled={isSaving()}>
              Reset
            </button>
            <button type="submit" class="btn btn-primary" disabled={isSaving()}>
              {isSaving() ? 'Saving...' : 'Save Options'}
            </button>
          </div>
        </div>

        {/* Default Branch */}
        <div class="form-group">
          <div class="label-row">
            <label>Default Branch</label>
            <HelpButton tooltip="Default git branch for new tasks when a task-specific branch is not selected." />
          </div>
          {queryError() && (
            <div class="text-xs text-red-400 mb-1">Error loading data: {queryError()}</div>
          )}
          <select
            class="form-select"
            value={formData().branch || ''}
            onChange={(e) => updateField('branch', e.currentTarget.value)}
            disabled={branchOptions().length === 0}
          >
            <option value="" disabled>No branches available</option>
            <For each={branchOptions()}>
              {(branch) => <option value={branch}>{branch}</option>}
            </For>
          </select>
          {branchOptions().length === 0 && !queryError() && (
            <div class="text-xs text-dark-text-muted mt-1">Loading branches...</div>
          )}
        </div>

        {/* Models with Thinking Levels */}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="space-y-3">
            <ModelPicker
              modelValue={formData().planModel || ''}
              label="Plan Model (global)"
              help="Default planning model for new tasks. Individual tasks can override this value."
              onUpdate={(v) => updateField('planModel', v)}
            />
            <ThinkingLevelSelect
              modelValue={formData().planThinkingLevel || 'default'}
              label="Plan Thinking"
              help="Default thinking level for planning phase."
              onUpdate={(v) => {
                if (isValidThinkingLevel(v)) {
                  updateField('planThinkingLevel', v)
                }
              }}
            />
          </div>
          <div class="space-y-3">
            <ModelPicker
              modelValue={formData().executionModel || ''}
              label="Execution Model (global)"
              help="Default execution model for new tasks. Individual tasks can override this value."
              onUpdate={(v) => updateField('executionModel', v)}
            />
            <ThinkingLevelSelect
              modelValue={formData().executionThinkingLevel || 'default'}
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

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="space-y-3">
            <ModelPicker
              modelValue={formData().reviewModel || ''}
              label="Review Model"
              help="Model used by the workflow-review agent. This is stored in the database and used for all review operations."
              onUpdate={(v) => updateField('reviewModel', v)}
            />
            <ThinkingLevelSelect
              modelValue={formData().reviewThinkingLevel || 'default'}
              label="Review Thinking"
              help="Default thinking level for review phase."
              onUpdate={(v) => {
                if (isValidThinkingLevel(v)) {
                  updateField('reviewThinkingLevel', v)
                }
              }}
            />
          </div>
          <div class="space-y-3">
            <ModelPicker
              modelValue={formData().repairModel || ''}
              label="Repair Model"
              help="Model used by the workflow-repair agent for state repair analysis."
              onUpdate={(v) => updateField('repairModel', v)}
            />
            <ThinkingLevelSelect
              modelValue={formData().repairThinkingLevel || 'default'}
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
        <div class="form-group">
          <div class="label-row">
            <label>Pre-execution Command</label>
            <HelpButton tooltip="Command to run before task execution begins, such as installing dependencies or preparing the workspace." />
          </div>
          <input
            type="text"
            class="form-input"
            placeholder="e.g. npm install"
            value={formData().command || ''}
            onChange={(e) => updateField('command', e.currentTarget.value)}
          />
        </div>

        {/* Parallel Tasks & Max Reviews */}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="form-group">
            <div class="label-row">
              <label>Parallel Tasks</label>
              <HelpButton tooltip="Maximum number of tasks the workflow should execute at the same time." />
            </div>
            <input
              type="number"
              class="form-input"
              min={1}
              max={10}
              value={formData().parallelTasks ?? 1}
              onChange={(e) => updateField('parallelTasks', parseInt(e.currentTarget.value) || 1)}
            />
          </div>

          <div class="form-group">
            <div class="label-row">
              <label>Maximum Review Runs</label>
              <HelpButton tooltip="Maximum number of review cycles for a task before it gets stuck. Can be overridden per-task." />
            </div>
            <input
              type="number"
              class="form-input"
              min={1}
              max={10}
              value={formData().maxReviews ?? 3}
              onChange={(e) => updateField('maxReviews', parseInt(e.currentTarget.value) || 3)}
            />
          </div>

          <div class="form-group">
            <div class="label-row">
              <label>Max JSON Parse Retries</label>
              <HelpButton tooltip="Maximum consecutive retries when a review response fails JSON parsing before marking task as stuck. Resets when a valid JSON response is received." />
            </div>
            <input
              type="number"
              class="form-input"
              min={1}
              max={20}
              value={formData().maxJsonParseRetries ?? 5}
              onChange={(e) => updateField('maxJsonParseRetries', parseInt(e.currentTarget.value) || 5)}
            />
          </div>
        </div>

        {/* Session Cleanup & Execution Graph */}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="form-group border border-dark-surface3 rounded-lg p-4">
            <div class="label-row">
              <label>Session Cleanup (global)</label>
              <HelpButton tooltip="Automatically delete TaurOboros sessions after task/review runs finish. Enable only if you do not need session history for debugging." />
            </div>
            <div class="checkbox-group space-y-2">
              <label class="checkbox-item">
                <input
                  type="checkbox"
                  checked={formData().autoDeleteNormalSessions ?? false}
                  onChange={(e) => updateField('autoDeleteNormalSessions', e.currentTarget.checked)}
                />
                <span>Auto-delete normal sessions</span>
              </label>
              <label class="checkbox-item">
                <input
                  type="checkbox"
                  checked={formData().autoDeleteReviewSessions ?? false}
                  onChange={(e) => updateField('autoDeleteReviewSessions', e.currentTarget.checked)}
                />
                <span>Auto-delete review sessions</span>
              </label>
            </div>
          </div>

          <div class="form-group border border-dark-surface3 rounded-lg p-4">
            <label class="checkbox-item">
              <input
                type="checkbox"
                checked={formData().showExecutionGraph ?? false}
                onChange={(e) => updateField('showExecutionGraph', e.currentTarget.checked)}
              />
              <span>Show execution graph before starting workflow</span>
            </label>
          </div>
        </div>

        {/* Prompts */}
        <div class="space-y-4">
          <div class="form-group">
            <div class="label-row">
              <label>Commit Prompt <span class="text-dark-text-muted font-normal">({`{{base_ref}}`} will be replaced at runtime)</span></label>
              <HelpButton tooltip="Instructions used when the workflow asks the agent to prepare a git commit. Use {{base_ref}} anywhere you want the current base branch inserted automatically." />
            </div>
            <textarea
              class="form-textarea font-mono text-xs min-h-[120px]"
              placeholder="Instructions for committing changes..."
              value={formData().commitPrompt || ''}
              onChange={(e) => updateField('commitPrompt', e.currentTarget.value)}
            />
          </div>

          <div class="form-group">
            <div class="label-row">
              <label>Code Style Prompt</label>
              <HelpButton tooltip="Instructions for code style enforcement. The agent will review code and apply fixes to comply with these rules. Uses the Review Model. If left empty, the default prompt will be used." />
            </div>
            <textarea
              class="form-textarea font-mono text-xs min-h-[100px]"
              placeholder="Code style rules..."
              value={formData().codeStylePrompt || ''}
              onChange={(e) => updateField('codeStylePrompt', e.currentTarget.value)}
            />
          </div>

          <div class="form-group">
            <div class="label-row">
              <label>Extra Prompt <span class="text-dark-text-muted font-normal">(added to every prompt)</span></label>
              <HelpButton tooltip="Additional instructions that will be appended to every task prompt sent to the agent." />
            </div>
            <textarea
              class="form-textarea font-mono text-xs min-h-[80px]"
              placeholder="Additional context or instructions for all tasks..."
              value={formData().extraPrompt || ''}
              onChange={(e) => updateField('extraPrompt', e.currentTarget.value)}
            />
          </div>
        </div>

        {/* Telegram Notifications */}
        <div class="form-group border border-dark-surface3 rounded-lg p-4">
          <div class="label-row">
            <label>Telegram Notifications</label>
            <HelpButton tooltip="Configure when to receive Telegram notifications about task and workflow status changes. Leave bot token and chat ID empty to disable notifications." />
          </div>
          <div class="mb-3">
            <label class="text-xs text-dark-text-muted mb-1 block">Notification Level</label>
            <select
              class="form-select"
              value={formData().telegramNotificationLevel || 'all'}
              onChange={(e) => {
                const value = e.currentTarget.value
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
            <p class="text-xs text-dark-text-muted mt-1">
              {formData().telegramNotificationLevel === 'all' && 'Receive notifications for every task status change.'}
              {formData().telegramNotificationLevel === 'failures' && 'Only receive notifications when a task fails or gets stuck.'}
              {formData().telegramNotificationLevel === 'done_and_failures' && 'Receive notifications when tasks complete, fail, or get stuck.'}
              {formData().telegramNotificationLevel === 'workflow_done_and_failures' && 'Receive a workflow summary when complete, plus notifications for failures.'}
            </p>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-dark-text-muted mb-1 block">Bot Token</label>
              <input
                type="password"
                class="form-input"
                placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxYZ"
                value={formData().telegramBotToken || ''}
                onChange={(e) => updateField('telegramBotToken', e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="text-xs text-dark-text-muted mb-1 block">Chat ID</label>
              <input
                type="text"
                class="form-input"
                placeholder="-1001234567890 or @channel_name"
                value={formData().telegramChatId || ''}
                onChange={(e) => updateField('telegramChatId', e.currentTarget.value)}
              />
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div class="flex justify-end gap-3 pt-4 border-t border-dark-surface3">
          <button type="button" class="btn" onClick={handleReset} disabled={isSaving()}>
            Reset
          </button>
          <button type="submit" class="btn btn-primary" disabled={isSaving()}>
            {isSaving() ? 'Saving...' : 'Save Options'}
          </button>
        </div>
      </form>
    </div>
    </Show>
  )
}
