/**
 * OptionsModal Component - Quick options modal
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, Show, For } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { HelpButton } from '@/components/common/HelpButton'
import { ModelPicker } from '@/components/common/ModelPicker'
import { ThinkingLevelSelect } from '@/components/common/ThinkingLevelSelect'
import { uiStore } from '@/stores'
import { optionsApi, referenceApi } from '@/api'
import type { Options, ThinkingLevel } from '@/types'
import { DEFAULT_CODE_STYLE_PROMPT } from '@/types'

interface OptionsModalProps {
  onClose: () => void
}

export function OptionsModal(props: OptionsModalProps) {
  const [formData, setFormData] = createSignal<Partial<Options>>({})
  const [availableBranches, setAvailableBranches] = createSignal<string[]>([])
  const [branchesError, setBranchesError] = createSignal<string | null>(null)
  const [isLoading, setIsLoading] = createSignal(true)
  const [isSaving, setIsSaving] = createSignal(false)

  createEffect(() => {
    const loadData = async () => {
      try {
        const [loadedOpts, branchData] = await Promise.all([
          optionsApi.get(),
          referenceApi.getBranches()
        ])

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
          telegramNotificationLevel: currentOpts.telegramNotificationLevel || 'all',
          telegramBotToken: currentOpts.telegramBotToken || '',
          telegramChatId: currentOpts.telegramChatId || '',
        })
        setAvailableBranches(branchData.branches || [])
      } catch (e) {
        setBranchesError(e instanceof Error ? e.message : 'Failed to load data')
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
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
      await optionsApi.save(optionsToSave)
      uiStore.showToast('Options saved successfully', 'success')
      props.onClose()
    } catch (e) {
      uiStore.showToast(e instanceof Error ? e.message : 'Failed to save options', 'error')
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading()) {
    return (
      <div class="modal-overlay" onClick={props.onClose}>
        <div class="modal w-[min(560px,calc(100vw-40px))]" onClick={(e) => e.stopPropagation()}>
          <div class="modal-header">
            <h2>Options</h2>
            <button class="icon-btn" onClick={props.onClose}>×</button>
          </div>
          <div class="modal-body p-8 text-center">
            <div class="text-dark-text-muted">Loading options...</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal w-[min(560px,calc(100vw-40px))] max-h-[calc(100vh-40px)]" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Options</h2>
          <button class="icon-btn" onClick={props.onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div class="modal-body space-y-3 max-h-[calc(100vh-180px)] overflow-y-auto">
            {/* Default Branch */}
            <div class="form-group">
              <div class="label-row">
                <label>Default Branch</label>
                <HelpButton tooltip="Default git branch for new tasks when a task-specific branch is not selected." />
              </div>
              <Show when={branchesError()}>
                <div class="text-xs text-red-400 mb-1">Error loading branches: {branchesError()}</div>
              </Show>
              <select
                class="form-select"
                value={formData().branch || ''}
                onChange={(e) => updateField('branch', e.currentTarget.value)}
                disabled={availableBranches().length === 0}
              >
                <option value="" disabled>No branches available</option>
                <For each={availableBranches()}>
                  {(branch) => <option value={branch}>{branch}</option>}
                </For>
              </select>
              <Show when={availableBranches().length === 0 && !branchesError()}>
                <div class="text-xs text-dark-text-muted mt-1">Loading branches...</div>
              </Show>
            </div>

            {/* Models with Thinking Levels */}
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-2">
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
                  onUpdate={(v) => updateField('planThinkingLevel', v as ThinkingLevel)}
                />
              </div>
              <div class="space-y-2">
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
                  onUpdate={(v) => updateField('executionThinkingLevel', v as ThinkingLevel)}
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

            {/* Parallel Tasks */}
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

            {/* Show Execution Graph */}
            <div class="form-group">
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

          <div class="modal-footer">
            <button type="button" class="btn" onClick={props.onClose}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={isSaving()}>
              {isSaving() ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
