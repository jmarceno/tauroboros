/**
 * BatchEditModal Component - Batch task editing
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, For, Show } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { HelpButton } from '@/components/common/HelpButton'
import { uiStore, createTasksStore } from '@/stores'
import { createModelSearchStore } from '@/stores'
import { optionsApi, referenceApi } from '@/api'
import type { ThinkingLevel, TaskStatus, Task } from '@/types'

interface BatchEditModalProps {
  taskIds: string[]
  onClose: () => void
  onConfirm?: (updates: Partial<import('@/types').Task>) => Promise<void>
}

type FieldValue<T> =
  | { kind: 'unchanged' }
  | { kind: 'mixed' }
  | { kind: 'set'; value: T }
  | { kind: 'cleared' }

interface FormState {
  status: FieldValue<TaskStatus>
  branch: FieldValue<string>
  planModel: FieldValue<string>
  executionModel: FieldValue<string>
  thinkingLevel: FieldValue<ThinkingLevel>
  maxReviewRunsOverride: FieldValue<number | null>
  planmode: FieldValue<boolean>
  autoApprovePlan: FieldValue<boolean>
  review: FieldValue<boolean>
  codeStyleReview: FieldValue<boolean>
  autoCommit: FieldValue<boolean>
  deleteWorktree: FieldValue<boolean>
  skipPermissionAsking: FieldValue<boolean>
}

const UNCHANGED = <T,>(): FieldValue<T> => ({ kind: 'unchanged' })
const MIXED = <T,>(): FieldValue<T> => ({ kind: 'mixed' })
const SET = <T,>(value: T): FieldValue<T> => ({ kind: 'set', value })
const CLEARED = <T,>(): FieldValue<T> => ({ kind: 'cleared' })

const isModified = <T,>(fv: FieldValue<T>): boolean => fv.kind !== 'unchanged'

const getInputValue = <T,>(fv: FieldValue<T>): T | '' | 'mixed' => {
  if (fv.kind === 'set') return fv.value
  if (fv.kind === 'mixed') return 'mixed' as unknown as T
  return '' as T
}

const getCheckboxState = (fv: FieldValue<boolean>): { checked: boolean; indeterminate: boolean } => {
  if (fv.kind === 'set') return { checked: fv.value, indeterminate: false }
  if (fv.kind === 'mixed') return { checked: false, indeterminate: true }
  return { checked: false, indeterminate: false }
}

const getMixedDisplay = (fv: FieldValue<unknown>): string => {
  return fv.kind === 'mixed' ? ' (mixed)' : ''
}

export function BatchEditModal(props: BatchEditModalProps) {
  const tasksStore = createTasksStore()
  const modelSearch = createModelSearchStore()

  const [branches, setBranches] = createSignal<string[]>([])
  const [branchesLoading, setBranchesLoading] = createSignal(false)
  const [branchesError, setBranchesError] = createSignal<string | null>(null)

  const [form, setForm] = createSignal<FormState>({
    status: UNCHANGED(),
    branch: UNCHANGED(),
    planModel: UNCHANGED(),
    executionModel: UNCHANGED(),
    thinkingLevel: UNCHANGED(),
    maxReviewRunsOverride: UNCHANGED(),
    planmode: UNCHANGED(),
    autoApprovePlan: UNCHANGED(),
    review: UNCHANGED(),
    codeStyleReview: UNCHANGED(),
    autoCommit: UNCHANGED(),
    deleteWorktree: UNCHANGED(),
    skipPermissionAsking: UNCHANGED(),
  })

  const [isLoading, setIsLoading] = createSignal(false)

  // Compute initial form state from selected tasks
  createEffect(() => {
    const selectedTasks = tasksStore.tasks().filter(t => props.taskIds.includes(t.id))
    if (selectedTasks.length === 0) return

    const getCommonValue = <K extends keyof Task>(selected: Task[], key: K): Task[K] | undefined => {
      if (selected.length === 0) return undefined
      const first = selected[0][key]
      for (let i = 1; i < selected.length; i++) {
        if (selected[i][key] !== first) return undefined
      }
      return first
    }

    const allSame = <K extends keyof Task>(selected: Task[], key: K): boolean => {
      if (selected.length <= 1) return true
      const first = selected[0][key]
      return selected.every(t => t[key] === first)
    }

    const newForm: FormState = {
      status: UNCHANGED(),
      branch: UNCHANGED(),
      planModel: UNCHANGED(),
      executionModel: UNCHANGED(),
      thinkingLevel: UNCHANGED(),
      maxReviewRunsOverride: UNCHANGED(),
      planmode: UNCHANGED(),
      autoApprovePlan: UNCHANGED(),
      review: UNCHANGED(),
      codeStyleReview: UNCHANGED(),
      autoCommit: UNCHANGED(),
      deleteWorktree: UNCHANGED(),
      skipPermissionAsking: UNCHANGED(),
    }

    const statusVal = getCommonValue(selectedTasks, 'status')
    newForm.status = statusVal !== undefined ? SET(statusVal) : MIXED()

    const branchVal = getCommonValue(selectedTasks, 'branch')
    newForm.branch = branchVal !== undefined ? SET(branchVal) : MIXED()

    const planModelVal = getCommonValue(selectedTasks, 'planModel')
    newForm.planModel = planModelVal !== undefined ? SET(planModelVal) : MIXED()

    const execModelVal = getCommonValue(selectedTasks, 'executionModel')
    newForm.executionModel = execModelVal !== undefined ? SET(execModelVal) : MIXED()

    const thinkVal = getCommonValue(selectedTasks, 'thinkingLevel')
    newForm.thinkingLevel = thinkVal !== undefined ? SET(thinkVal) : MIXED()

    if (allSame(selectedTasks, 'maxReviewRunsOverride')) {
      const maxRevVal = selectedTasks[0].maxReviewRunsOverride
      newForm.maxReviewRunsOverride = maxRevVal !== undefined ? SET(maxRevVal) : SET(null)
    } else {
      newForm.maxReviewRunsOverride = MIXED()
    }

    if (allSame(selectedTasks, 'planmode')) {
      newForm.planmode = SET(selectedTasks[0].planmode)
    } else {
      newForm.planmode = MIXED()
    }

    if (allSame(selectedTasks, 'autoApprovePlan')) {
      newForm.autoApprovePlan = SET(selectedTasks[0].autoApprovePlan)
    } else {
      newForm.autoApprovePlan = MIXED()
    }

    if (allSame(selectedTasks, 'review')) {
      newForm.review = SET(selectedTasks[0].review)
    } else {
      newForm.review = MIXED()
    }

    if (allSame(selectedTasks, 'codeStyleReview')) {
      newForm.codeStyleReview = SET(selectedTasks[0].codeStyleReview)
    } else {
      newForm.codeStyleReview = MIXED()
    }

    if (allSame(selectedTasks, 'autoCommit')) {
      newForm.autoCommit = SET(selectedTasks[0].autoCommit)
    } else {
      newForm.autoCommit = MIXED()
    }

    if (allSame(selectedTasks, 'deleteWorktree')) {
      newForm.deleteWorktree = SET(selectedTasks[0].deleteWorktree)
    } else {
      newForm.deleteWorktree = MIXED()
    }

    if (allSame(selectedTasks, 'skipPermissionAsking')) {
      newForm.skipPermissionAsking = SET(selectedTasks[0].skipPermissionAsking)
    } else {
      newForm.skipPermissionAsking = MIXED()
    }

    setForm(newForm)
  })

  // Load branches
  createEffect(() => {
    setBranchesLoading(true)
    setBranchesError(null)
    referenceApi.getBranches()
      .then((data) => {
        setBranches(data.branches || [])
      })
      .catch((err) => {
        setBranchesError(err instanceof Error ? err.message : 'Failed to load branches')
      })
      .finally(() => {
        setBranchesLoading(false)
      })
  })

  const handleSelectChange = <K extends keyof FormState>(
    key: K,
    value: FormState[K] extends FieldValue<infer T> ? T : never
  ) => {
    setForm(prev => ({ ...prev, [key]: SET(value) }))
  }

  const handleClear = (key: keyof FormState) => {
    setForm(prev => ({ ...prev, [key]: CLEARED() }))
  }

  const handleCheckboxChange = (key: keyof FormState) => {
    setForm(prev => {
      const current = prev[key] as FieldValue<boolean>
      if (current.kind === 'set') {
        return { ...prev, [key]: SET(!current.value) }
      }
      return { ...prev, [key]: SET(true) }
    })
  }

  const handleMaxReviewChange = (value: string) => {
    if (value === '') {
      setForm(prev => ({ ...prev, maxReviewRunsOverride: CLEARED() }))
    } else {
      const num = parseInt(value, 10)
      if (!isNaN(num) && num >= 0) {
        setForm(prev => ({ ...prev, maxReviewRunsOverride: SET(num) }))
      }
    }
  }

  const buildUpdatePayload = () => {
    const payload: Partial<Task> = {}
    const f = form()

    if (f.status.kind === 'set') payload.status = f.status.value
    if (f.branch.kind === 'set') payload.branch = f.branch.value
    if (f.branch.kind === 'cleared') payload.branch = ''
    if (f.planModel.kind === 'set') payload.planModel = f.planModel.value
    if (f.executionModel.kind === 'set') payload.executionModel = f.executionModel.value
    if (f.thinkingLevel.kind === 'set') payload.thinkingLevel = f.thinkingLevel.value

    if (f.maxReviewRunsOverride.kind === 'set') {
      payload.maxReviewRunsOverride = f.maxReviewRunsOverride.value ?? undefined
    } else if (f.maxReviewRunsOverride.kind === 'cleared') {
      payload.maxReviewRunsOverride = undefined
    }

    if (f.planmode.kind === 'set') payload.planmode = f.planmode.value
    if (f.autoApprovePlan.kind === 'set') payload.autoApprovePlan = f.autoApprovePlan.value
    if (f.review.kind === 'set') payload.review = f.review.value
    if (f.codeStyleReview.kind === 'set') payload.codeStyleReview = f.codeStyleReview.value
    if (f.autoCommit.kind === 'set') payload.autoCommit = f.autoCommit.value
    if (f.deleteWorktree.kind === 'set') payload.deleteWorktree = f.deleteWorktree.value
    if (f.skipPermissionAsking.kind === 'set') payload.skipPermissionAsking = f.skipPermissionAsking.value

    return payload
  }

  const modifiedCount = () => Object.values(form()).filter(isModified).length

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    if (modifiedCount() === 0) {
      uiStore.showToast('No changes to apply', 'info')
      return
    }

    setIsLoading(true)

    const updates = buildUpdatePayload()

    try {
      if (props.onConfirm) {
        await props.onConfirm(updates)
      } else {
        await Promise.all(props.taskIds.map(id => tasksStore.updateTask(id, updates)))
        uiStore.showToast(`Updated ${props.taskIds.length} tasks`, 'success')
      }
      props.onClose()
    } catch (e) {
      uiStore.showToast(e instanceof Error ? e.message : 'Failed to update tasks', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const inputValue = () => getInputValue(form().status)
  const branchValue = () => getInputValue(form().branch)
  const planModelValue = () => getInputValue(form().planModel)
  const execModelValue = () => getInputValue(form().executionModel)
  const thinkingValue = () => getInputValue(form().thinkingLevel)
  const maxReviewValue = () => form().maxReviewRunsOverride.kind === 'set'
    ? (form().maxReviewRunsOverride.value ?? '')
    : form().maxReviewRunsOverride.kind === 'mixed'
      ? 'mixed'
      : ''

  const checkboxFields: { key: keyof FormState; label: string }[] = [
    { key: 'planmode', label: 'Plan Mode' },
    { key: 'autoApprovePlan', label: 'Auto-approve Plan' },
    { key: 'review', label: 'Review' },
    { key: 'codeStyleReview', label: 'Code Style Review' },
    { key: 'autoCommit', label: 'Auto-commit' },
    { key: 'deleteWorktree', label: 'Delete Worktree' },
    { key: 'skipPermissionAsking', label: 'Skip Permission Asking' },
  ]

  return (
    <ModalWrapper title={`Batch Edit: ${props.taskIds.length} Tasks`} onClose={props.onClose}>
      <form onSubmit={handleSubmit} class="space-y-4">
        <p class="text-sm text-dark-text-muted">
          Select the fields you want to update. Fields showing "mixed" have different values across selected tasks.
        </p>

        <div class="form-group">
          <label class="flex items-center gap-2">
            Status
            <Show when={getMixedDisplay(form().status)}>
              <span class="text-xs text-amber-400">{getMixedDisplay(form().status)}</span>
            </Show>
          </label>
          <select
            class="form-select"
            value={inputValue()}
            onChange={(e) => handleSelectChange('status', e.currentTarget.value as TaskStatus)}
          >
            <option value="">Keep current</option>
            <option value="template">Template</option>
            <option value="backlog">Backlog</option>
            <option value="executing">Executing</option>
            <option value="review">Review</option>
            <option value="done">Done</option>
          </select>
        </div>

        <div class="form-group">
          <label class="flex items-center gap-2">
            Branch
            <Show when={getMixedDisplay(form().branch)}>
              <span class="text-xs text-amber-400">{getMixedDisplay(form().branch)}</span>
            </Show>
          </label>
          <Show when={branchesLoading()} fallback={
            <Show when={branchesError()} fallback={
              <select
                class="form-select"
                value={branchValue()}
                onChange={(e) => handleSelectChange('branch', e.currentTarget.value)}
              >
                <option value="">Keep current</option>
                <For each={branches()}>
                  {(b) => <option value={b}>{b}</option>}
                </For>
              </select>
            }>
              <div class="text-sm text-red-400">{branchesError()}</div>
            </Show>
          }>
            <div class="text-sm text-dark-text-muted">Loading branches...</div>
          </Show>
        </div>

        <div class="form-group">
          <label class="flex items-center gap-2">
            Plan Model
            <Show when={getMixedDisplay(form().planModel)}>
              <span class="text-xs text-amber-400">{getMixedDisplay(form().planModel)}</span>
            </Show>
          </label>
          <input
            type="text"
            class="form-input"
            value={planModelValue()}
            onChange={(e) => handleSelectChange('planModel', e.currentTarget.value)}
            placeholder="Keep current"
          />
        </div>

        <div class="form-group">
          <label class="flex items-center gap-2">
            Execution Model
            <Show when={getMixedDisplay(form().executionModel)}>
              <span class="text-xs text-amber-400">{getMixedDisplay(form().executionModel)}</span>
            </Show>
          </label>
          <input
            type="text"
            class="form-input"
            value={execModelValue()}
            onChange={(e) => handleSelectChange('executionModel', e.currentTarget.value)}
            placeholder="Keep current"
          />
        </div>

        <div class="form-group">
          <label class="flex items-center gap-2">
            Thinking Level
            <Show when={getMixedDisplay(form().thinkingLevel)}>
              <span class="text-xs text-amber-400">{getMixedDisplay(form().thinkingLevel)}</span>
            </Show>
          </label>
          <select
            class="form-select"
            value={thinkingValue()}
            onChange={(e) => handleSelectChange('thinkingLevel', e.currentTarget.value as ThinkingLevel)}
          >
            <option value="">Keep current</option>
            <option value="default">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div class="form-group">
          <label class="flex items-center gap-2">
            Max Reviews Override
            <Show when={getMixedDisplay(form().maxReviewRunsOverride)}>
              <span class="text-xs text-amber-400">{getMixedDisplay(form().maxReviewRunsOverride)}</span>
            </Show>
          </label>
          <div class="flex items-center gap-2">
            <input
              type="number"
              class="form-input w-32"
              min="0"
              placeholder={form().maxReviewRunsOverride.kind === 'mixed' ? 'mixed' : 'Keep current'}
              value={maxReviewValue() === 'mixed' ? '' : maxReviewValue()}
              onChange={(e) => handleMaxReviewChange(e.currentTarget.value)}
            />
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => handleClear('maxReviewRunsOverride')}
            >
              Clear
            </button>
            <HelpButton tooltip="Clear override (use default)" />
          </div>
          <p class="text-xs text-dark-text-muted mt-1">
            Leave empty to keep current, 0 to clear override, or set a value.
          </p>
        </div>

        <div class="border-t border-dark-border pt-4 mt-4">
          <p class="text-sm font-medium text-dark-text-secondary mb-3">Options</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <For each={checkboxFields}>
              {({ key, label }) => {
                const state = () => getCheckboxState(form()[key] as FieldValue<boolean>)
                const isMixed = () => (form()[key] as FieldValue<boolean>).kind === 'mixed'
                return (
                  <label class="flex items-center gap-2 cursor-pointer hover:bg-dark-surface p-2 rounded">
                    <input
                      type="checkbox"
                      class="form-checkbox"
                      checked={state().checked}
                      onChange={() => handleCheckboxChange(key)}
                    />
                    <span class="text-sm">
                      {label}
                      <Show when={isMixed()}>
                        <span class="text-xs text-amber-400 ml-1">(mixed)</span>
                      </Show>
                    </span>
                  </label>
                )
              }}
            </For>
          </div>
        </div>

        <div class="modal-footer">
          <div class="flex items-center gap-2">
            <span class="text-sm text-dark-text-muted">
              {modifiedCount()} field{modifiedCount() !== 1 ? 's' : ''} modified
            </span>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" class="btn" onClick={props.onClose} disabled={isLoading()}>Cancel</button>
            <button
              type="submit"
              class="btn btn-primary"
              disabled={isLoading() || modifiedCount() === 0}
            >
              {isLoading() ? 'Updating...' : `Update ${props.taskIds.length} Tasks`}
            </button>
          </div>
        </div>
      </form>
    </ModalWrapper>
  )
}
