/**
 * TaskModal Component - Create/edit/deploy task modal
 * Ported from React to SolidJS
 */

import { createSignal, createMemo, createEffect, onMount, Show, For, Suspense, lazy } from 'solid-js'
import type { AutoDeployCondition, TaskStatus, CreateTaskDTO, ThinkingLevel, ExecutionStrategy, BestOfNSlot } from '@/types'
import { ModalWrapper } from '../common/ModalWrapper'
import { ModelPicker } from '../common/ModelPicker'
import { ThinkingLevelSelect } from '../common/ThinkingLevelSelect'
import { HelpButton } from '../common/HelpButton'
import { createTasksStore, createOptionsStore, createModelSearchStore, uiStore } from '@/stores'
import { referenceApi, containersApi, optionsApi } from '@/api'

const MarkdownEditor = lazy(async () => {
  const mod = await import('../common/MarkdownEditor')
  return { default: mod.MarkdownEditor }
})

export type TaskModalMode = 'create' | 'edit' | 'deploy' | 'view'

interface TaskModalProps {
  mode: TaskModalMode
  taskId?: string
  createStatus?: TaskStatus
  seedTaskId?: string
  onClose: () => void
}

export function TaskModal(props: TaskModalProps) {
  // Initialize stores
  const tasksStore = createTasksStore()
  const optionsStore = createOptionsStore()
  const modelSearch = createModelSearchStore()

  const existingTask = createMemo(() => props.taskId ? tasksStore.getTaskById(props.taskId) ?? null : null)
  const seedTask = createMemo(() => props.seedTaskId ? tasksStore.getTaskById(props.seedTaskId) ?? null : null)
  const sourceTask = createMemo(() => existingTask() ?? seedTask())
  const [initializedFormKey, setInitializedFormKey] = createSignal<string | null>(null)

  // Form state
  const [name, setName] = createSignal('')
  const [prompt, setPrompt] = createSignal('')
  const [branch, setBranch] = createSignal('')
  const [planModel, setPlanModel] = createSignal('')
  const [executionModel, setExecutionModel] = createSignal('')
  const [planThinkingLevel, setPlanThinkingLevel] = createSignal<ThinkingLevel>('default')
  const [executionThinkingLevel, setExecutionThinkingLevel] = createSignal<ThinkingLevel>('default')
  const [planmode, setPlanmode] = createSignal(false)
  const [autoApprovePlan, setAutoApprovePlan] = createSignal(false)
  const [review, setReview] = createSignal(true)
  const [codeStyleReview, setCodeStyleReview] = createSignal(false)
  const [autoCommit, setAutoCommit] = createSignal(true)
  const [autoDeploy, setAutoDeploy] = createSignal(false)
  const [autoDeployCondition, setAutoDeployCondition] = createSignal<AutoDeployCondition>('before_workflow_start')
  const [deleteWorktree, setDeleteWorktree] = createSignal(true)
  const [skipPermissionAsking, setSkipPermissionAsking] = createSignal(true)
  const [requirements, setRequirements] = createSignal<string[]>([])
  const [executionStrategy, setExecutionStrategy] = createSignal<ExecutionStrategy>('standard')
  const [containerImage, setContainerImage] = createSignal('')
  const [availableBranches, setAvailableBranches] = createSignal<string[]>([])
  const [availableImages, setAvailableImages] = createSignal<Array<{ tag: string }>>([])
  const [isLoading, setIsLoading] = createSignal(true)
  
  // Best-of-N state
  const [bonWorkers, setBonWorkers] = createSignal<BestOfNSlot[]>([])
  const [bonReviewers, setBonReviewers] = createSignal<BestOfNSlot[]>([])
  const [bonFinalApplierModel, setBonFinalApplierModel] = createSignal('')
  const [bonFinalApplierSuffix, setBonFinalApplierSuffix] = createSignal('')
  const [bonSelectionMode, setBonSelectionMode] = createSignal<'pick_best' | 'synthesize' | 'pick_or_synthesize'>('pick_best')
  const [bonMinSuccessful, setBonMinSuccessful] = createSignal(1)
  const [bonVerificationCmd, setBonVerificationCmd] = createSignal('')

  // Computed values
  const isViewOnly = () => props.mode === 'view'
  const isDeploy = () => props.mode === 'deploy'
  const isCreate = () => props.mode === 'create'
  const isEdit = () => props.mode === 'edit'
  const showBonConfig = () => executionStrategy() === 'best_of_n'
  const allowsAutoDeploy = createMemo(() => {
    if (isEdit()) {
      return sourceTask()?.status === 'template'
    }
    return isCreate() && props.createStatus === 'template'
  })
  const isAwaitingSourceTask = createMemo(() => {
    if (isEdit() && props.taskId) return !existingTask()
    if (isDeploy() && props.seedTaskId) return !seedTask()
    return false
  })
  const branchOptions = createMemo(() => {
    const options = new Set(availableBranches())
    const selectedBranch = branch().trim()
    if (selectedBranch) {
      options.add(selectedBranch)
    }
    return Array.from(options)
  })

  const resetBestOfNForm = () => {
    setBonWorkers([])
    setBonReviewers([])
    setBonFinalApplierModel('')
    setBonFinalApplierSuffix('')
    setBonSelectionMode('pick_best')
    setBonMinSuccessful(1)
    setBonVerificationCmd('')
  }

  const initializeFormFromTask = () => {
    const currentTask = sourceTask()
    const currentOptions = optionsStore.options()

    setName(currentTask?.name ?? '')
    setPrompt(currentTask?.prompt ?? '')
    setBranch(currentTask?.branch ?? currentOptions?.branch?.trim() ?? '')
    setPlanModel(currentTask?.planModel ?? currentOptions?.planModel ?? '')
    setExecutionModel(currentTask?.executionModel ?? currentOptions?.executionModel ?? '')
    setPlanThinkingLevel(currentTask?.planThinkingLevel ?? currentOptions?.planThinkingLevel ?? 'default')
    setExecutionThinkingLevel(currentTask?.executionThinkingLevel ?? currentOptions?.executionThinkingLevel ?? 'default')
    setPlanmode(currentTask?.planmode ?? false)
    setAutoApprovePlan(currentTask?.autoApprovePlan ?? false)
    setReview(currentTask?.review ?? true)
    setCodeStyleReview(currentTask?.codeStyleReview ?? false)
    setAutoCommit(currentTask?.autoCommit ?? true)
    setAutoDeploy(currentTask?.autoDeploy ?? false)
    setAutoDeployCondition(currentTask?.autoDeployCondition ?? 'before_workflow_start')
    setDeleteWorktree(currentTask?.deleteWorktree ?? true)
    setSkipPermissionAsking(currentTask?.skipPermissionAsking ?? true)
    setRequirements(currentTask?.requirements ? [...currentTask.requirements] : [])
    setExecutionStrategy(currentTask?.executionStrategy ?? 'standard')
    setContainerImage(currentTask?.containerImage ?? '')

    if (currentTask?.executionStrategy === 'best_of_n' && currentTask.bestOfNConfig) {
      const config = currentTask.bestOfNConfig
      setBonWorkers(config.workers.map(w => ({ ...w })))
      setBonReviewers(config.reviewers.map(r => ({ ...r })))
      setBonFinalApplierModel(config.finalApplier.model)
      setBonFinalApplierSuffix(config.finalApplier.taskSuffix || '')
      setBonSelectionMode(config.selectionMode)
      setBonMinSuccessful(config.minSuccessfulWorkers)
      setBonVerificationCmd(config.verificationCommand || '')
      return
    }

    resetBestOfNForm()
  }

  createEffect(() => {
    const formKey = `${props.mode}:${props.taskId ?? ''}:${props.seedTaskId ?? ''}`
    if (initializedFormKey() === formKey) return
    if (isAwaitingSourceTask()) return

    initializeFormFromTask()
    setInitializedFormKey(formKey)
  })

  createEffect(() => {
    if (!isAwaitingSourceTask()) return
    if (tasksStore.isLoading()) return

    const errorMessage = tasksStore.error()
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    uiStore.showToast('Task data could not be loaded', 'error')
    props.onClose()
  })

  // Load data on mount
  onMount(async () => {
    setIsLoading(true)
    try {
      const [branchData, imageData, latestOptions] = await Promise.all([
        referenceApi.getBranches(),
        containersApi.getImages(),
        optionsApi.get(),
      ])

      setAvailableBranches(branchData.branches || [])
      setAvailableImages(imageData.images || [])

      setBranch(currentBranch => {
        if (currentBranch.trim()) return currentBranch
        if (latestOptions.branch?.trim()) return latestOptions.branch.trim()
        if (branchData.current) return branchData.current
        if (branchData.branches?.[0]) return branchData.branches[0]
        return currentBranch
      })

      setPlanModel(currentPlanModel => currentPlanModel || latestOptions.planModel || '')
      setExecutionModel(currentExecutionModel => currentExecutionModel || latestOptions.executionModel || '')
      setPlanThinkingLevel(currentLevel => currentLevel === 'default' ? latestOptions.planThinkingLevel || 'default' : currentLevel)
      setExecutionThinkingLevel(currentLevel => currentLevel === 'default' ? latestOptions.executionThinkingLevel || 'default' : currentLevel)
    } catch (e) {
      console.error('Failed to load data:', e)
      uiStore.showToast('Failed to load form data', 'error')
    } finally {
      setIsLoading(false)
    }
  })

  const availableRequirements = createMemo(() => {
    const currentTaskId = sourceTask()?.id ?? props.taskId
    return tasksStore.tasks().filter(t => {
      if (isViewOnly()) return t.id !== currentTaskId
      if (t.id === currentTaskId) return false
      if (t.status === 'backlog') return true
      if (t.status === 'done' && requirements().includes(t.id)) return true
      return false
    })
  })

  // Best-of-N handlers
  const addBonWorker = () => {
    setBonWorkers([...bonWorkers(), { model: '', count: 1, taskSuffix: '' }])
  }

  const removeBonWorker = (index: number) => {
    setBonWorkers(bonWorkers().filter((_, i) => i !== index))
  }

  const updateBonWorker = (index: number, field: 'model' | 'count' | 'taskSuffix', value: string | number) => {
    setBonWorkers(bonWorkers().map((w, i) => i === index ? { ...w, [field]: value } : w))
  }

  const addBonReviewer = () => {
    setBonReviewers([...bonReviewers(), { model: '', count: 1, taskSuffix: '' }])
  }

  const removeBonReviewer = (index: number) => {
    setBonReviewers(bonReviewers().filter((_, i) => i !== index))
  }

  const updateBonReviewer = (index: number, field: 'model' | 'count' | 'taskSuffix', value: string | number) => {
    setBonReviewers(bonReviewers().map((r, i) => i === index ? { ...r, [field]: value } : r))
  }

  const toggleRequirement = (taskId: string) => {
    setRequirements(prev =>
      prev.includes(taskId) ? prev.filter(id => id !== taskId) : [...prev, taskId]
    )
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()

    if (!name().trim() || !prompt().trim()) {
      uiStore.showToast('Name and prompt are required', 'error')
      return
    }

    if (!branch()) {
      uiStore.showToast('Select a valid branch', 'error')
      return
    }

    if (allowsAutoDeploy() && autoDeploy() && !autoDeployCondition()) {
      uiStore.showToast('Select an auto-deploy condition', 'error')
      return
    }

    if (executionStrategy() === 'best_of_n') {
      if (bonWorkers().length === 0) {
        uiStore.showToast('Add at least one worker slot for Best of N', 'error')
        return
      }
      const totalWorkers = bonWorkers().reduce((sum, w) => sum + (w.count || 1), 0)
      if (totalWorkers > 8) {
        uiStore.showToast(`Total workers (${totalWorkers}) exceeds maximum of 8`, 'error')
        return
      }
      if (bonMinSuccessful() > totalWorkers) {
        uiStore.showToast('Minimum successful workers cannot exceed total workers', 'error')
        return
      }
    }

    try {
      const taskData: Record<string, unknown> = {
        name: name().trim(),
        prompt: prompt().trim(),
        branch: branch(),
        planModel: modelSearch.normalizeValue(planModel()),
        executionModel: modelSearch.normalizeValue(executionModel()),
        planmode: planmode(),
        autoApprovePlan: autoApprovePlan(),
        review: review(),
        codeStyleReview: codeStyleReview(),
        autoCommit: autoCommit(),
        autoDeploy: allowsAutoDeploy() ? autoDeploy() : false,
        autoDeployCondition: allowsAutoDeploy() && autoDeploy() ? autoDeployCondition() : null,
        deleteWorktree: deleteWorktree(),
        skipPermissionAsking: skipPermissionAsking(),
        requirements: requirements(),
        planThinkingLevel: planThinkingLevel(),
        executionThinkingLevel: executionThinkingLevel(),
        executionStrategy: executionStrategy(),
        containerImage: containerImage() || undefined,
      }

      if (executionStrategy() === 'best_of_n') {
        taskData.bestOfNConfig = {
          workers: bonWorkers().map(w => ({
            model: w.model,
            count: w.count || 1,
            taskSuffix: w.taskSuffix || undefined,
          })),
          reviewers: bonReviewers().map(r => ({
            model: r.model,
            count: r.count || 1,
            taskSuffix: r.taskSuffix || undefined,
          })),
          finalApplier: {
            model: modelSearch.normalizeValue(bonFinalApplierModel()),
            taskSuffix: bonFinalApplierSuffix().trim() || undefined,
          },
          selectionMode: bonSelectionMode(),
          minSuccessfulWorkers: bonMinSuccessful(),
          verificationCommand: bonVerificationCmd().trim() || undefined,
        }
      }

      if (isEdit() && props.taskId) {
        await tasksStore.updateTask(props.taskId, taskData)
        uiStore.showToast('Task updated', 'success')
      } else if (isDeploy() && props.seedTaskId) {
        await tasksStore.createTask({ ...taskData, status: 'backlog' } as CreateTaskDTO)
        uiStore.showToast('Template deployed', 'success')
      } else {
        await tasksStore.createTask({ ...taskData, status: props.createStatus || 'backlog' } as CreateTaskDTO)
        uiStore.showToast('Task created', 'success')
      }
      props.onClose()
    } catch (e) {
      uiStore.showToast(e instanceof Error ? e.message : 'Failed to save task', 'error')
    }
  }

  const getTitle = () => {
    if (isViewOnly()) return 'View Task'
    if (isDeploy()) return 'Deploy Template'
    if (isEdit()) return props.createStatus === 'template' ? 'Edit Template' : 'Edit Task'
    return props.createStatus === 'template' ? 'Add Template' : 'Add Task'
  }

  const getSaveButtonText = () => {
    if (isDeploy()) return 'Send to Backlog'
    if (isCreate() && props.createStatus === 'template') return 'Save Template'
    return 'Save'
  }

  return (
    <ModalWrapper title={getTitle()} onClose={props.onClose} size="lg">
      <Show when={isLoading()}>
        <div class="p-8 text-center">
          <div class="text-dark-text-muted">Loading...</div>
        </div>
      </Show>

      <Show when={!isLoading() && !isAwaitingSourceTask()}>
        <form onSubmit={handleSubmit} class="space-y-4">
          {/* Name */}
          <div class="form-group">
            <div class="label-row">
              <label>Name</label>
              <HelpButton tooltip="Short task title shown on the card." />
            </div>
            <input
              type="text"
              class="form-input"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder="Task name"
              disabled={isViewOnly()}
              required
            />
          </div>

          {/* Prompt */}
          <div class="form-group">
            <div class="label-row">
              <label>Prompt</label>
              <HelpButton tooltip="The main instructions for the agent." />
            </div>
            <Suspense fallback={<div class="form-input min-h-[80px] flex items-center text-dark-text-muted">Loading editor...</div>}>
              <MarkdownEditor
                modelValue={prompt()}
                onUpdate={setPrompt}
                placeholder="What should this task do?"
                disabled={isViewOnly()}
              />
            </Suspense>
          </div>

          {/* Models with Thinking Levels */}
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <ModelPicker
                modelValue={planModel()}
                label="Plan Model"
                help="Model used for planning steps before implementation."
                disabled={isViewOnly()}
                onUpdate={setPlanModel}
              />
              <ThinkingLevelSelect
                modelValue={planThinkingLevel()}
                label="Plan Thinking"
                help="Thinking level for planning phase."
                disabled={isViewOnly()}
                onUpdate={(v) => setPlanThinkingLevel(v as ThinkingLevel)}
              />
            </div>
            <div class="space-y-2">
              <ModelPicker
                modelValue={executionModel()}
                label="Execution Model"
                help="Model used for the actual implementation work."
                disabled={isViewOnly()}
                onUpdate={setExecutionModel}
              />
              <ThinkingLevelSelect
                modelValue={executionThinkingLevel()}
                label="Execution Thinking"
                help="Thinking level for execution phase."
                disabled={isViewOnly()}
                onUpdate={(v) => setExecutionThinkingLevel(v as ThinkingLevel)}
              />
            </div>
          </div>

          {/* Execution Strategy */}
          <div class="form-group">
            <div class="label-row">
              <label>Execution Strategy</label>
              <HelpButton tooltip="Standard runs a single execution. Best of N runs multiple candidates in parallel and picks or synthesizes the best result." />
            </div>
            <select
              class="form-select"
              value={executionStrategy()}
              onChange={(e) => setExecutionStrategy(e.currentTarget.value as ExecutionStrategy)}
              disabled={isViewOnly()}
            >
              <option value="standard">Standard</option>
              <option value="best_of_n">Best of N</option>
            </select>
          </div>

          {/* Container Image */}
          <div class="form-group">
            <div class="label-row">
              <label>Container Image</label>
              <HelpButton tooltip="Select the container image for this task. Uses system default if not specified." />
            </div>
            <select
              class="form-select"
              value={containerImage()}
              onChange={(e) => setContainerImage(e.currentTarget.value)}
              disabled={isViewOnly()}
            >
              <option value="">System Default</option>
              <For each={availableImages()}>
                {(img) => <option value={img.tag}>{img.tag}</option>}
              </For>
            </select>
            <Show when={availableImages().length > 0}>
              <div class="text-xs text-dark-text-muted mt-1">Build custom images in the Image Builder</div>
            </Show>
          </div>

          {/* Best-of-N Config */}
          <Show when={showBonConfig()}>
            <div class="border border-dark-surface3 rounded-lg p-3 bg-dark-bg">
              <h4 class="text-sm font-semibold mb-2">Best of N Configuration</h4>

              {/* Workers */}
              <div class="form-group">
                <label>Workers</label>
                <div class="space-y-2">
                  <For each={bonWorkers()}>
                    {(slot, i) => (
                      <div class="flex gap-2 items-center">
                        <input
                          type="number"
                          min={1}
                          max={4}
                          class="form-input w-16"
                          value={slot.count || 1}
                          onChange={(e) => updateBonWorker(i(), 'count', parseInt(e.currentTarget.value) || 1)}
                          disabled={isViewOnly()}
                        />
                        <select
                          class="form-select flex-1"
                          value={slot.model}
                          onChange={(e) => updateBonWorker(i(), 'model', e.currentTarget.value)}
                          disabled={isViewOnly()}
                        >
                          <option value="">Select model...</option>
                          <For each={modelSearch.getModelOptions(slot.model)}>
                            {(opt) => <option value={opt.value}>{opt.label}</option>}
                          </For>
                        </select>
                        <input
                          type="text"
                          placeholder="Suffix (optional)"
                          class="form-input flex-1"
                          value={slot.taskSuffix || ''}
                          onChange={(e) => updateBonWorker(i(), 'taskSuffix', e.currentTarget.value)}
                          disabled={isViewOnly()}
                        />
                        <Show when={!isViewOnly()}>
                          <button
                            type="button"
                            class="text-red-400 hover:text-red-300 px-2"
                            onClick={() => removeBonWorker(i())}
                          >
                            ✕
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={!isViewOnly()}>
                  <button type="button" class="add-task-btn mt-2" onClick={addBonWorker}>
                    + Add Worker Slot
                  </button>
                </Show>
              </div>

              {/* Reviewers */}
              <div class="form-group">
                <label>Reviewers</label>
                <div class="space-y-2">
                  <For each={bonReviewers()}>
                    {(slot, i) => (
                      <div class="flex gap-2 items-center">
                        <input
                          type="number"
                          min={1}
                          max={4}
                          class="form-input w-16"
                          value={slot.count || 1}
                          onChange={(e) => updateBonReviewer(i(), 'count', parseInt(e.currentTarget.value) || 1)}
                          disabled={isViewOnly()}
                        />
                        <select
                          class="form-select flex-1"
                          value={slot.model}
                          onChange={(e) => updateBonReviewer(i(), 'model', e.currentTarget.value)}
                          disabled={isViewOnly()}
                        >
                          <option value="">Select model...</option>
                          <For each={modelSearch.getModelOptions(slot.model)}>
                            {(opt) => <option value={opt.value}>{opt.label}</option>}
                          </For>
                        </select>
                        <input
                          type="text"
                          placeholder="Suffix (optional)"
                          class="form-input flex-1"
                          value={slot.taskSuffix || ''}
                          onChange={(e) => updateBonReviewer(i(), 'taskSuffix', e.currentTarget.value)}
                          disabled={isViewOnly()}
                        />
                        <Show when={!isViewOnly()}>
                          <button
                            type="button"
                            class="text-red-400 hover:text-red-300 px-2"
                            onClick={() => removeBonReviewer(i())}
                          >
                            ✕
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={!isViewOnly()}>
                  <button type="button" class="add-task-btn mt-2" onClick={addBonReviewer}>
                    + Add Reviewer Slot
                  </button>
                </Show>
              </div>

              {/* Final Applier */}
              <ModelPicker
                modelValue={bonFinalApplierModel()}
                label="Final Applier Model"
                disabled={isViewOnly()}
                onUpdate={setBonFinalApplierModel}
              />

              <div class="form-group">
                <label>Final Applier Suffix (optional)</label>
                <textarea
                  class="form-textarea"
                  placeholder="Additional instructions for the final applier..."
                  value={bonFinalApplierSuffix()}
                  onChange={(e) => setBonFinalApplierSuffix(e.currentTarget.value)}
                  disabled={isViewOnly()}
                />
              </div>

              {/* Selection Mode & Min Successful */}
              <div class="grid grid-cols-2 gap-3">
                <div class="form-group">
                  <label>Selection Mode</label>
                  <select
                    class="form-select"
                    value={bonSelectionMode()}
                    onChange={(e) => setBonSelectionMode(e.currentTarget.value as 'pick_best' | 'synthesize' | 'pick_or_synthesize')}
                    disabled={isViewOnly()}
                  >
                    <option value="pick_best">Pick Best</option>
                    <option value="synthesize">Synthesize</option>
                    <option value="pick_or_synthesize">Pick or Synthesize</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Min Successful Workers</label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    class="form-input"
                    value={bonMinSuccessful()}
                    onChange={(e) => setBonMinSuccessful(parseInt(e.currentTarget.value) || 1)}
                    disabled={isViewOnly()}
                  />
                </div>
              </div>

              {/* Verification Command */}
              <div class="form-group">
                <label>Verification Command (optional)</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="e.g. npm test"
                  value={bonVerificationCmd()}
                  onChange={(e) => setBonVerificationCmd(e.currentTarget.value)}
                  disabled={isViewOnly()}
                />
              </div>
            </div>
          </Show>

          {/* Branch */}
          <div class="form-group">
            <div class="label-row">
              <label>Branch</label>
              <HelpButton tooltip="Git branch the task should run against." />
            </div>
            <select
              class="form-select"
              value={branch()}
              onChange={(e: Event & { currentTarget: HTMLSelectElement }) => setBranch(e.currentTarget.value)}
              disabled={isViewOnly()}
            >
              <For each={branchOptions()}>
                {(b) => <option value={b}>{b}</option>}
              </For>
            </select>
          </div>

          {/* Checkboxes */}
          <Show when={!isViewOnly()}>
            <div class="checkbox-group">
              <label class="checkbox-item">
                <input 
                  type="checkbox" 
                  checked={planmode()} 
                  onChange={(e) => setPlanmode(e.currentTarget.checked)} 
                />
                <span>Plan Mode</span>
              </label>
              <label class="checkbox-item">
                <input 
                  type="checkbox" 
                  checked={autoApprovePlan()} 
                  onChange={(e) => setAutoApprovePlan(e.currentTarget.checked)} 
                />
                <span>Auto-approve plan</span>
              </label>
              <label class="checkbox-item">
                <input 
                  type="checkbox" 
                  checked={review()} 
                  onChange={(e) => setReview(e.currentTarget.checked)} 
                />
                <span>Review</span>
              </label>
              <label class="checkbox-item">
                <input
                  type="checkbox"
                  checked={codeStyleReview()}
                  onChange={(e) => setCodeStyleReview(e.currentTarget.checked)}
                  disabled={!review()}
                />
                <span class={!review() ? 'opacity-50' : ''}>Code Style Review (after review)</span>
              </label>
              <label class="checkbox-item">
                <input 
                  type="checkbox" 
                  checked={autoCommit()} 
                  onChange={(e) => setAutoCommit(e.currentTarget.checked)} 
                />
                <span>Auto-commit</span>
              </label>
              <Show when={allowsAutoDeploy()}>
                <label class="checkbox-item">
                  <input
                    type="checkbox"
                    checked={autoDeploy()}
                    onChange={(e) => setAutoDeploy(e.currentTarget.checked)}
                  />
                  <span>Auto Deploy</span>
                </label>
              </Show>
              <label class="checkbox-item">
                <input 
                  type="checkbox" 
                  checked={deleteWorktree()} 
                  onChange={(e) => setDeleteWorktree(e.currentTarget.checked)} 
                />
                <span>Delete Worktree</span>
              </label>
              <label class="checkbox-item">
                <input 
                  type="checkbox" 
                  checked={skipPermissionAsking()} 
                  onChange={(e) => setSkipPermissionAsking(e.currentTarget.checked)} 
                />
                <span>Skip Permission Asking</span>
              </label>
            </div>
            <Show when={allowsAutoDeploy() && autoDeploy()}>
              <div class="form-group mt-2">
                <label>Auto Deploy Condition</label>
                <select
                  class="form-select"
                  value={autoDeployCondition()}
                  onChange={(e) => setAutoDeployCondition(e.currentTarget.value as AutoDeployCondition)}
                >
                  <option value="before_workflow_start">Before workflow start</option>
                  <option value="after_workflow_end">After workflow end</option>
                  <option value="workflow_done">Workflow done</option>
                  <option value="workflow_failed">Workflow failed</option>
                </select>
              </div>
            </Show>
          </Show>

          {/* Requirements */}
          <div class="form-group">
            <div class="label-row">
              <label>Requirements (dependencies)</label>
              <HelpButton tooltip="Tasks that must be completed before this one should run." />
            </div>
            <div class="border border-dark-surface3 rounded-lg p-1.5 max-h-36 overflow-y-auto">
              <For each={availableRequirements()}>
                {(t) => (
                  <label
                    class="checkbox-item p-1 rounded hover:bg-dark-surface2"
                  >
                    <input
                      type="checkbox"
                      checked={requirements().includes(t.id)}
                      onChange={() => toggleRequirement(t.id)}
                      disabled={isViewOnly()}
                    />
                    <span class="text-sm">{t.name} (#{t.idx + 1})</span>
                  </label>
                )}
              </For>
              <Show when={availableRequirements().length === 0}>
                <div class="text-xs text-dark-text-muted p-1">No other tasks</div>
              </Show>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn" onClick={props.onClose}>Cancel</button>
            <Show when={!isViewOnly()}>
              <button type="submit" class="btn btn-primary">
                {getSaveButtonText()}
              </button>
            </Show>
          </div>
        </form>
      </Show>

      <Show when={!isLoading() && isAwaitingSourceTask()}>
        <div class="p-8 text-center">
          <div class="text-dark-text-muted">Loading task...</div>
        </div>
      </Show>
    </ModalWrapper>
  )
}
