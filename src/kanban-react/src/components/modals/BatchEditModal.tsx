import { useState, useEffect, useRef, useCallback } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useToastContext, useModelSearchContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks/useApi'
import { HelpButton } from '../common/HelpButton'
import type { ThinkingLevel, TaskStatus, Task } from '@/types'

interface BatchEditModalProps {
  taskIds: string[]
  onClose: () => void
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

export function BatchEditModal({ taskIds, onClose }: BatchEditModalProps) {
  const tasks = useTasksContext()
  const toasts = useToastContext()
  const modelSearch = useModelSearchContext()
  const api = useApi()

  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState<string | null>(null)

  const planmodeRef = useRef<HTMLInputElement>(null)
  const autoApprovePlanRef = useRef<HTMLInputElement>(null)
  const reviewRef = useRef<HTMLInputElement>(null)
  const codeStyleReviewRef = useRef<HTMLInputElement>(null)
  const autoCommitRef = useRef<HTMLInputElement>(null)
  const deleteWorktreeRef = useRef<HTMLInputElement>(null)
  const skipPermissionAskingRef = useRef<HTMLInputElement>(null)

  const checkboxRefs = {
    planmode: planmodeRef,
    autoApprovePlan: autoApprovePlanRef,
    review: reviewRef,
    codeStyleReview: codeStyleReviewRef,
    autoCommit: autoCommitRef,
    deleteWorktree: deleteWorktreeRef,
    skipPermissionAsking: skipPermissionAskingRef,
  }

  const [form, setForm] = useState<FormState>({
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

  const [isLoading, setIsLoading] = useState(false)

  const getCommonValue = useCallback(<K extends keyof Task>(tasks: Task[], key: K): Task[K] | undefined => {
    if (tasks.length === 0) return undefined
    const first = tasks[0][key]
    for (let i = 1; i < tasks.length; i++) {
      if (tasks[i][key] !== first) return undefined
    }
    return first
  }, [])

  const allSame = useCallback(<K extends keyof Task>(tasks: Task[], key: K): boolean => {
    if (tasks.length <= 1) return true
    const first = tasks[0][key]
    return tasks.every(t => t[key] === first)
  }, [])

  useEffect(() => {
    const selectedTasks = tasks.tasks.filter(t => taskIds.includes(t.id))
    if (selectedTasks.length === 0) return

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
  }, [taskIds, tasks.tasks, getCommonValue, allSame])

  useEffect(() => {
    setBranchesLoading(true)
    setBranchesError(null)
    api.getBranches()
      .then((data) => {
        setBranches(data.branches || [])
      })
      .catch((err) => {
        setBranchesError(err instanceof Error ? err.message : 'Failed to load branches')
      })
      .finally(() => {
        setBranchesLoading(false)
      })
  }, [api])

  useEffect(() => {
    (Object.keys(checkboxRefs) as Array<keyof typeof checkboxRefs>).forEach(key => {
      const ref = checkboxRefs[key]
      if (ref.current) {
        const state = getCheckboxState(form[key] as FieldValue<boolean>)
        ref.current.indeterminate = state.indeterminate
      }
    })
  }, [form])

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

    if (form.status.kind === 'set') payload.status = form.status.value
    if (form.branch.kind === 'set') payload.branch = form.branch.value
    if (form.branch.kind === 'cleared') payload.branch = ''
    if (form.planModel.kind === 'set') payload.planModel = form.planModel.value
    if (form.executionModel.kind === 'set') payload.executionModel = form.executionModel.value
    if (form.thinkingLevel.kind === 'set') payload.thinkingLevel = form.thinkingLevel.value

    if (form.maxReviewRunsOverride.kind === 'set') {
      payload.maxReviewRunsOverride = form.maxReviewRunsOverride.value ?? undefined
    } else if (form.maxReviewRunsOverride.kind === 'cleared') {
      payload.maxReviewRunsOverride = undefined
    }

    if (form.planmode.kind === 'set') payload.planmode = form.planmode.value
    if (form.autoApprovePlan.kind === 'set') payload.autoApprovePlan = form.autoApprovePlan.value
    if (form.review.kind === 'set') payload.review = form.review.value
    if (form.codeStyleReview.kind === 'set') payload.codeStyleReview = form.codeStyleReview.value
    if (form.autoCommit.kind === 'set') payload.autoCommit = form.autoCommit.value
    if (form.deleteWorktree.kind === 'set') payload.deleteWorktree = form.deleteWorktree.value
    if (form.skipPermissionAsking.kind === 'set') payload.skipPermissionAsking = form.skipPermissionAsking.value

    return payload
  }

  const modifiedCount = Object.values(form).filter(isModified).length

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (modifiedCount === 0) {
      toasts.showToast('No changes to apply', 'info')
      return
    }

    setIsLoading(true)

    const updates = buildUpdatePayload()

    try {
      await Promise.all(taskIds.map(id => tasks.updateTask(id, updates)))
      toasts.showToast(`Updated ${taskIds.length} tasks`, 'success')
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to update tasks', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const inputValue = getInputValue(form.status)
  const branchValue = getInputValue(form.branch)
  const planModelValue = getInputValue(form.planModel)
  const execModelValue = getInputValue(form.executionModel)
  const thinkingValue = getInputValue(form.thinkingLevel)
  const maxReviewValue = form.maxReviewRunsOverride.kind === 'set'
    ? (form.maxReviewRunsOverride.value ?? '')
    : form.maxReviewRunsOverride.kind === 'mixed'
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
    <ModalWrapper title={`Batch Edit: ${taskIds.length} Tasks`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-dark-text-muted">
          Select the fields you want to update. Fields showing "mixed" have different values across selected tasks.
        </p>

        <div className="form-group">
          <label className="flex items-center gap-2">
            Status
            {getMixedDisplay(form.status) && (
              <span className="text-xs text-amber-400">{getMixedDisplay(form.status)}</span>
            )}
          </label>
          <select
            className="form-select"
            value={inputValue}
            onChange={(e) => handleSelectChange('status', e.target.value as TaskStatus)}
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
          <label className="flex items-center gap-2">
            Branch
            {getMixedDisplay(form.branch) && (
              <span className="text-xs text-amber-400">{getMixedDisplay(form.branch)}</span>
            )}
          </label>
          {branchesLoading ? (
            <div className="text-sm text-dark-text-muted">Loading branches...</div>
          ) : branchesError ? (
            <div className="text-sm text-red-400">{branchesError}</div>
          ) : (
            <select
              className="form-select"
              value={branchValue}
              onChange={(e) => handleSelectChange('branch', e.target.value)}
            >
              <option value="">Keep current</option>
              {branches.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          )}
        </div>

        <div className="form-group">
          <label className="flex items-center gap-2">
            Plan Model
            {getMixedDisplay(form.planModel) && (
              <span className="text-xs text-amber-400">{getMixedDisplay(form.planModel)}</span>
            )}
          </label>
          <select
            className="form-select"
            value={planModelValue}
            onChange={(e) => handleSelectChange('planModel', e.target.value)}
          >
            <option value="">Keep current</option>
            {modelSearch.getModelOptions().map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="flex items-center gap-2">
            Execution Model
            {getMixedDisplay(form.executionModel) && (
              <span className="text-xs text-amber-400">{getMixedDisplay(form.executionModel)}</span>
            )}
          </label>
          <select
            className="form-select"
            value={execModelValue}
            onChange={(e) => handleSelectChange('executionModel', e.target.value)}
          >
            <option value="">Keep current</option>
            {modelSearch.getModelOptions().map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="flex items-center gap-2">
            Thinking Level
            {getMixedDisplay(form.thinkingLevel) && (
              <span className="text-xs text-amber-400">{getMixedDisplay(form.thinkingLevel)}</span>
            )}
          </label>
          <select
            className="form-select"
            value={thinkingValue}
            onChange={(e) => handleSelectChange('thinkingLevel', e.target.value as ThinkingLevel)}
          >
            <option value="">Keep current</option>
            <option value="default">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="form-group">
          <label className="flex items-center gap-2">
            Max Reviews Override
            {getMixedDisplay(form.maxReviewRunsOverride) && (
              <span className="text-xs text-amber-400">{getMixedDisplay(form.maxReviewRunsOverride)}</span>
            )}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              className="form-input w-32"
              min="0"
              placeholder={form.maxReviewRunsOverride.kind === 'mixed' ? 'mixed' : 'Keep current'}
              value={maxReviewValue === 'mixed' ? '' : maxReviewValue}
              onChange={(e) => handleMaxReviewChange(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => handleClear('maxReviewRunsOverride')}
            >
              Clear
            </button>
            <HelpButton tooltip="Clear override (use default)" />
          </div>
          <p className="text-xs text-dark-text-muted mt-1">
            Leave empty to keep current, 0 to clear override, or set a value.
          </p>
        </div>

        <div className="border-t border-dark-border pt-4 mt-4">
          <p className="text-sm font-medium text-dark-text-secondary mb-3">Options</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {checkboxFields.map(({ key, label }) => {
              const state = getCheckboxState(form[key] as FieldValue<boolean>)
              const isMixed = (form[key] as FieldValue<boolean>).kind === 'mixed'
              return (
                <label key={key} className="flex items-center gap-2 cursor-pointer hover:bg-dark-surface p-2 rounded">
                  <input
                    ref={checkboxRefs[key as keyof typeof checkboxRefs]}
                    type="checkbox"
                    className="form-checkbox"
                    checked={state.checked}
                    onChange={() => handleCheckboxChange(key)}
                  />
                  <span className="text-sm">
                    {label}
                    {isMixed && (
                      <span className="text-xs text-amber-400 ml-1">(mixed)</span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        <div className="modal-footer">
          <div className="flex items-center gap-2">
            <span className="text-sm text-dark-text-muted">
              {modifiedCount} field{modifiedCount !== 1 ? 's' : ''} modified
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn" onClick={onClose} disabled={isLoading}>Cancel</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isLoading || modifiedCount === 0}
            >
              {isLoading ? 'Updating...' : `Update ${taskIds.length} Tasks`}
            </button>
          </div>
        </div>
      </form>
    </ModalWrapper>
  )
}
