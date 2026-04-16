import { useState, useEffect } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { ModelPicker } from '../common/ModelPicker'
import { ThinkingLevelSelect } from '../common/ThinkingLevelSelect'
import { MarkdownEditor } from '../common/MarkdownEditor'
import { useTasksContext, useOptionsContext, useModelSearchContext, useToastContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks'
import type { Task, TaskStatus, ThinkingLevel, ExecutionStrategy, BestOfNSlot } from '@/types'

interface TaskModalProps {
  mode: 'create' | 'edit' | 'deploy' | 'view'
  taskId?: string
  createStatus?: 'template' | 'backlog'
  seedTaskId?: string
  onClose: () => void
}

export function TaskModal({ mode, taskId, createStatus = 'backlog', seedTaskId, onClose }: TaskModalProps) {
  const tasks = useTasksContext()
  const optionsContext = useOptionsContext()
  const modelSearch = useModelSearchContext()
  const toasts = useToastContext()
  const api = useApi()
  const getBranches = api.getBranches
  const getContainerImages = api.getContainerImages

  const existingTask = taskId ? tasks.getTaskById(taskId) : null
  const seedTask = seedTaskId ? tasks.getTaskById(seedTaskId) : null

  const [name, setName] = useState(existingTask?.name || seedTask?.name || '')
  const [prompt, setPrompt] = useState(existingTask?.prompt || seedTask?.prompt || '')
  const [branch, setBranch] = useState('')
  const [planModel, setPlanModel] = useState(existingTask?.planModel || optionsContext.options?.planModel || '')
  const [executionModel, setExecutionModel] = useState(existingTask?.executionModel || optionsContext.options?.executionModel || '')
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(existingTask?.thinkingLevel || optionsContext.options?.thinkingLevel || 'default')
  const [planThinkingLevel, setPlanThinkingLevel] = useState<ThinkingLevel>(existingTask?.planThinkingLevel || optionsContext.options?.planThinkingLevel || 'default')
  const [executionThinkingLevel, setExecutionThinkingLevel] = useState<ThinkingLevel>(existingTask?.executionThinkingLevel || optionsContext.options?.executionThinkingLevel || 'default')
  const [planmode, setPlanmode] = useState(existingTask?.planmode ?? false)
  const [autoApprovePlan, setAutoApprovePlan] = useState(existingTask?.autoApprovePlan ?? false)
  const [review, setReview] = useState(existingTask?.review ?? true)
  const [autoCommit, setAutoCommit] = useState(existingTask?.autoCommit ?? true)
  const [deleteWorktree, setDeleteWorktree] = useState(existingTask?.deleteWorktree ?? true)
  const [skipPermissionAsking, setSkipPermissionAsking] = useState(existingTask?.skipPermissionAsking ?? true)
  const [requirements, setRequirements] = useState<string[]>(existingTask?.requirements || seedTask?.requirements || [])
  const [executionStrategy, setExecutionStrategy] = useState<ExecutionStrategy>(existingTask?.executionStrategy || 'standard')
  const [containerImage, setContainerImage] = useState(existingTask?.containerImage || '')
  const [availableBranches, setAvailableBranches] = useState<string[]>([])
  const [availableImages, setAvailableImages] = useState<Array<{ tag: string }>>([])
  const [isLoading, setIsLoading] = useState(true)
  const [bonWorkers, setBonWorkers] = useState<BestOfNSlot[]>([])
  const [bonReviewers, setBonReviewers] = useState<BestOfNSlot[]>([])
  const [bonFinalApplierModel, setBonFinalApplierModel] = useState('')
  const [bonFinalApplierSuffix, setBonFinalApplierSuffix] = useState('')
  const [bonSelectionMode, setBonSelectionMode] = useState<'pick_best' | 'synthesize' | 'pick_or_synthesize'>('pick_best')
  const [bonMinSuccessful, setBonMinSuccessful] = useState(1)
  const [bonVerificationCmd, setBonVerificationCmd] = useState('')

  const isViewOnly = mode === 'view'
  const isDeploy = mode === 'deploy'
  const isCreate = mode === 'create'
  const isEdit = mode === 'edit'

  const showBonConfig = executionStrategy === 'best_of_n'

  useEffect(() => {
    let cancelled = false
    const loadData = async () => {
      setIsLoading(true)
      try {
        const [branchData, imageData] = await Promise.all([
          getBranches(),
          getContainerImages()
        ])
        if (cancelled) return

        setAvailableBranches(branchData.branches || [])
        setAvailableImages(imageData.images || [])

        if (existingTask?.branch) {
          setBranch(existingTask.branch)
        } else if (seedTask?.branch) {
          setBranch(seedTask.branch)
        } else if (branchData.current) {
          setBranch(branchData.current)
        } else if (branchData.branches?.[0]) {
          setBranch(branchData.branches[0])
        }

        if (existingTask?.containerImage) {
          setContainerImage(existingTask.containerImage)
        } else if (optionsContext.options?.container?.image) {
          setContainerImage(optionsContext.options.container.image)
        }

        if (existingTask?.executionStrategy === 'best_of_n' && existingTask.bestOfNConfig) {
          setBonWorkers(existingTask.bestOfNConfig.workers.map(w => ({ ...w })))
          setBonReviewers(existingTask.bestOfNConfig.reviewers.map(r => ({ ...r })))
          setBonFinalApplierModel(existingTask.bestOfNConfig.finalApplier.model)
          setBonFinalApplierSuffix(existingTask.bestOfNConfig.finalApplier.taskSuffix || '')
          setBonSelectionMode(existingTask.bestOfNConfig.selectionMode)
          setBonMinSuccessful(existingTask.bestOfNConfig.minSuccessfulWorkers)
          setBonVerificationCmd(existingTask.bestOfNConfig.verificationCommand || '')
        }
      } catch (e) {
        console.error('Failed to load data:', e)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [getBranches, getContainerImages, existingTask, seedTask, optionsContext.options])

  const availableRequirements = tasks.tasks.filter(t =>
    isViewOnly ? t.id !== taskId : t.status === 'backlog' && t.id !== taskId
  )

  const addBonWorker = () => {
    setBonWorkers([...bonWorkers, { model: '', count: 1, suffix: '' }])
  }

  const removeBonWorker = (index: number) => {
    setBonWorkers(bonWorkers.filter((_, i) => i !== index))
  }

  const updateBonWorker = (index: number, field: 'model' | 'count' | 'suffix', value: string | number) => {
    setBonWorkers(bonWorkers.map((w, i) => i === index ? { ...w, [field]: value } : w))
  }

  const addBonReviewer = () => {
    setBonReviewers([...bonReviewers, { model: '', count: 1, suffix: '' }])
  }

  const removeBonReviewer = (index: number) => {
    setBonReviewers(bonReviewers.filter((_, i) => i !== index))
  }

  const updateBonReviewer = (index: number, field: 'model' | 'count' | 'suffix', value: string | number) => {
    setBonReviewers(bonReviewers.map((r, i) => i === index ? { ...r, [field]: value } : r))
  }

  const toggleRequirement = (taskId: string) => {
    setRequirements(prev =>
      prev.includes(taskId) ? prev.filter(id => id !== taskId) : [...prev, taskId]
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!name.trim() || !prompt.trim()) {
      toasts.showToast('Name and prompt are required', 'error')
      return
    }

    if (!branch) {
      toasts.showToast('Select a valid branch', 'error')
      return
    }

    if (executionStrategy === 'best_of_n') {
      if (bonWorkers.length === 0) {
        toasts.showToast('Add at least one worker slot for Best of N', 'error')
        return
      }
      const totalWorkers = bonWorkers.reduce((sum, w) => sum + (w.count || 1), 0)
      if (totalWorkers > 8) {
        toasts.showToast(`Total workers (${totalWorkers}) exceeds maximum of 8`, 'error')
        return
      }
      if (bonMinSuccessful > totalWorkers) {
        toasts.showToast('Minimum successful workers cannot exceed total workers', 'error')
        return
      }
    }

    try {
      const taskData: Record<string, unknown> = {
        name: name.trim(),
        prompt: prompt.trim(),
        branch,
        planModel: modelSearch.normalizeValue(planModel),
        executionModel: modelSearch.normalizeValue(executionModel),
        planmode,
        autoApprovePlan,
        review,
        autoCommit,
        deleteWorktree,
        skipPermissionAsking,
        requirements,
        thinkingLevel,
        planThinkingLevel,
        executionThinkingLevel,
        executionStrategy,
        containerImage: containerImage || undefined,
      }

      if (executionStrategy === 'best_of_n') {
        taskData.bestOfNConfig = {
          workers: bonWorkers.map(w => ({
            model: w.model,
            count: w.count || 1,
            taskSuffix: w.suffix || undefined,
          })),
          reviewers: bonReviewers.map(r => ({
            model: r.model,
            count: r.count || 1,
            taskSuffix: r.suffix || undefined,
          })),
          finalApplier: {
            model: modelSearch.normalizeValue(bonFinalApplierModel),
            taskSuffix: bonFinalApplierSuffix.trim() || undefined,
          },
          selectionMode: bonSelectionMode,
          minSuccessfulWorkers: bonMinSuccessful,
          verificationCommand: bonVerificationCmd.trim() || undefined,
        }
      }

      if (isEdit && taskId) {
        await tasks.updateTask(taskId, taskData)
        toasts.showToast('Task updated', 'success')
      } else if (isDeploy && seedTaskId) {
        await tasks.createTask({ ...taskData, status: 'backlog' })
        toasts.showToast('Template deployed', 'success')
      } else {
        await tasks.createTask({ ...taskData, status: createStatus })
        toasts.showToast('Task created', 'success')
      }
      onClose()
    } catch (e) {
      toasts.showToast(e instanceof Error ? e.message : 'Failed to save task', 'error')
    }
  }

  const getTitle = () => {
    if (isViewOnly) return 'View Task'
    if (isDeploy) return 'Deploy Template'
    if (isEdit) return createStatus === 'template' ? 'Edit Template' : 'Edit Task'
    return createStatus === 'template' ? 'Add Template' : 'Add Task'
  }

  const getSaveButtonText = () => {
    if (isDeploy) return 'Send to Backlog'
    if (isCreate && createStatus === 'template') return 'Save Template'
    return 'Save'
  }

  if (isLoading) {
    return (
      <ModalWrapper title={getTitle()} onClose={onClose} size="lg">
        <div className="p-8 text-center">
          <div className="text-dark-text-muted">Loading...</div>
        </div>
      </ModalWrapper>
    )
  }

  return (
    <ModalWrapper title={getTitle()} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div className="form-group">
          <div className="label-row">
            <label>Name</label>
            <span className="help-btn" title="Short task title shown on the card.">?</span>
          </div>
          <input
            type="text"
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Task name"
            disabled={isViewOnly}
            required
          />
        </div>

        {/* Prompt */}
        <div className="form-group">
          <div className="label-row">
            <label>Prompt</label>
            <span className="help-btn" title="The main instructions for the agent.">?</span>
          </div>
          <MarkdownEditor
            modelValue={prompt}
            onUpdate={setPrompt}
            placeholder="What should this task do?"
            disabled={isViewOnly}
          />
        </div>

        {/* Models with Thinking Levels */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <ModelPicker
              modelValue={planModel}
              label="Plan Model"
              help="Model used for planning steps before implementation."
              disabled={isViewOnly}
              onUpdate={setPlanModel}
            />
            <ThinkingLevelSelect
              modelValue={planThinkingLevel}
              label="Plan Thinking"
              help="Thinking level for planning phase."
              disabled={isViewOnly}
              onUpdate={(v) => setPlanThinkingLevel(v as ThinkingLevel)}
            />
          </div>
          <div className="space-y-2">
            <ModelPicker
              modelValue={executionModel}
              label="Execution Model"
              help="Model used for the actual implementation work."
              disabled={isViewOnly}
              onUpdate={setExecutionModel}
            />
            <ThinkingLevelSelect
              modelValue={executionThinkingLevel}
              label="Execution Thinking"
              help="Thinking level for execution phase."
              disabled={isViewOnly}
              onUpdate={(v) => setExecutionThinkingLevel(v as ThinkingLevel)}
            />
          </div>
        </div>

        {/* Execution Strategy */}
        <div className="form-group">
          <div className="label-row">
            <label>Execution Strategy</label>
            <span className="help-btn" title="Standard runs a single execution. Best of N runs multiple candidates in parallel and picks or synthesizes the best result.">?</span>
          </div>
          <select
            className="form-select"
            value={executionStrategy}
            onChange={(e) => setExecutionStrategy(e.target.value as ExecutionStrategy)}
            disabled={isViewOnly}
          >
            <option value="standard">Standard</option>
            <option value="best_of_n">Best of N</option>
          </select>
        </div>

        {/* Container Image */}
        <div className="form-group">
          <div className="label-row">
            <label>Container Image</label>
            <span className="help-btn" title="Select the container image for this task. Uses system default if not specified.">?</span>
          </div>
          <select
            className="form-select"
            value={containerImage}
            onChange={(e) => setContainerImage(e.target.value)}
            disabled={isViewOnly}
          >
            <option value="">System Default</option>
            {availableImages.map(img => (
              <option key={img.tag} value={img.tag}>{img.tag}</option>
            ))}
          </select>
          {availableImages.length > 0 && (
            <div className="text-xs text-dark-text-muted mt-1">Build custom images in the Image Builder</div>
          )}
        </div>

        {/* Best-of-N Config */}
        {showBonConfig && (
          <div className="border border-dark-surface3 rounded-lg p-3 bg-dark-bg">
            <h4 className="text-sm font-semibold mb-2">Best of N Configuration</h4>

            {/* Workers */}
            <div className="form-group">
              <label>Workers</label>
              <div className="space-y-2">
                {bonWorkers.map((slot, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      type="number"
                      min={1}
                      max={4}
                      className="form-input w-16"
                      value={slot.count || 1}
                      onChange={(e) => updateBonWorker(i, 'count', parseInt(e.target.value) || 1)}
                      disabled={isViewOnly}
                    />
                    <select
                      className="form-select flex-1"
                      value={slot.model}
                      onChange={(e) => updateBonWorker(i, 'model', e.target.value)}
                      disabled={isViewOnly}
                    >
                      <option value="">Select model...</option>
                      {modelSearch.getModelOptions(slot.model).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Suffix (optional)"
                      className="form-input flex-1"
                      value={slot.suffix || ''}
                      onChange={(e) => updateBonWorker(i, 'suffix', e.target.value)}
                      disabled={isViewOnly}
                    />
                    {!isViewOnly && (
                      <button
                        type="button"
                        className="text-red-400 hover:text-red-300 px-2"
                        onClick={() => removeBonWorker(i)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!isViewOnly && (
                <button type="button" className="add-task-btn mt-2" onClick={addBonWorker}>
                  + Add Worker Slot
                </button>
              )}
            </div>

            {/* Reviewers */}
            <div className="form-group">
              <label>Reviewers</label>
              <div className="space-y-2">
                {bonReviewers.map((slot, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      type="number"
                      min={1}
                      max={4}
                      className="form-input w-16"
                      value={slot.count || 1}
                      onChange={(e) => updateBonReviewer(i, 'count', parseInt(e.target.value) || 1)}
                      disabled={isViewOnly}
                    />
                    <select
                      className="form-select flex-1"
                      value={slot.model}
                      onChange={(e) => updateBonReviewer(i, 'model', e.target.value)}
                      disabled={isViewOnly}
                    >
                      <option value="">Select model...</option>
                      {modelSearch.getModelOptions(slot.model).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Suffix (optional)"
                      className="form-input flex-1"
                      value={slot.suffix || ''}
                      onChange={(e) => updateBonReviewer(i, 'suffix', e.target.value)}
                      disabled={isViewOnly}
                    />
                    {!isViewOnly && (
                      <button
                        type="button"
                        className="text-red-400 hover:text-red-300 px-2"
                        onClick={() => removeBonReviewer(i)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!isViewOnly && (
                <button type="button" className="add-task-btn mt-2" onClick={addBonReviewer}>
                  + Add Reviewer Slot
                </button>
              )}
            </div>

            {/* Final Applier */}
            <ModelPicker
              modelValue={bonFinalApplierModel}
              label="Final Applier Model"
              disabled={isViewOnly}
              onUpdate={setBonFinalApplierModel}
            />

            <div className="form-group">
              <label>Final Applier Suffix (optional)</label>
              <textarea
                className="form-textarea"
                placeholder="Additional instructions for the final applier..."
                value={bonFinalApplierSuffix}
                onChange={(e) => setBonFinalApplierSuffix(e.target.value)}
                disabled={isViewOnly}
              />
            </div>

            {/* Selection Mode & Min Successful */}
            <div className="grid grid-cols-2 gap-3">
              <div className="form-group">
                <label>Selection Mode</label>
                <select
                  className="form-select"
                  value={bonSelectionMode}
                  onChange={(e) => setBonSelectionMode(e.target.value as typeof bonSelectionMode)}
                  disabled={isViewOnly}
                >
                  <option value="pick_best">Pick Best</option>
                  <option value="synthesize">Synthesize</option>
                  <option value="pick_or_synthesize">Pick or Synthesize</option>
                </select>
              </div>
              <div className="form-group">
                <label>Min Successful Workers</label>
                <input
                  type="number"
                  min={1}
                  max={8}
                  className="form-input"
                  value={bonMinSuccessful}
                  onChange={(e) => setBonMinSuccessful(parseInt(e.target.value) || 1)}
                  disabled={isViewOnly}
                />
              </div>
            </div>

            {/* Verification Command */}
            <div className="form-group">
              <label>Verification Command (optional)</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. npm test"
                value={bonVerificationCmd}
                onChange={(e) => setBonVerificationCmd(e.target.value)}
                disabled={isViewOnly}
              />
            </div>
          </div>
        )}

        {/* Branch */}
        <div className="form-group">
          <div className="label-row">
            <label>Branch</label>
            <span className="help-btn" title="Git branch the task should run against.">?</span>
          </div>
          <select
            className="form-select"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={isViewOnly}
          >
            {availableBranches.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        {/* Checkboxes */}
        {!isViewOnly && (
          <div className="checkbox-group">
            <label className="checkbox-item">
              <input type="checkbox" checked={planmode} onChange={(e) => setPlanmode(e.target.checked)} />
              <span>Plan Mode</span>
            </label>
            <label className="checkbox-item">
              <input type="checkbox" checked={autoApprovePlan} onChange={(e) => setAutoApprovePlan(e.target.checked)} />
              <span>Auto-approve plan</span>
            </label>
            <label className="checkbox-item">
              <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
              <span>Review</span>
            </label>
            <label className="checkbox-item">
              <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} />
              <span>Auto-commit</span>
            </label>
            <label className="checkbox-item">
              <input type="checkbox" checked={deleteWorktree} onChange={(e) => setDeleteWorktree(e.target.checked)} />
              <span>Delete Worktree</span>
            </label>
            <label className="checkbox-item">
              <input type="checkbox" checked={skipPermissionAsking} onChange={(e) => setSkipPermissionAsking(e.target.checked)} />
              <span>Skip Permission Asking</span>
            </label>
          </div>
        )}

        {/* Requirements */}
        <div className="form-group">
          <div className="label-row">
            <label>Requirements (dependencies)</label>
            <span className="help-btn" title="Tasks that must be completed before this one should run.">?</span>
          </div>
          <div className="border border-dark-surface3 rounded-lg p-1.5 max-h-36 overflow-y-auto">
            {availableRequirements.map(t => (
              <label
                key={t.id}
                className="checkbox-item p-1 rounded hover:bg-dark-surface2"
              >
                <input
                  type="checkbox"
                  checked={requirements.includes(t.id)}
                  onChange={() => toggleRequirement(t.id)}
                  disabled={isViewOnly}
                />
                <span className="text-sm">{t.name} (#{t.idx + 1})</span>
              </label>
            ))}
            {availableRequirements.length === 0 && (
              <div className="text-xs text-dark-text-muted p-1">No other tasks</div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {!isViewOnly && (
            <button type="submit" className="btn btn-primary">
              {getSaveButtonText()}
            </button>
          )}
        </div>
      </form>
    </ModalWrapper>
  )
}