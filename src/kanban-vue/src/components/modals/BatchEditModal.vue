<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue'
import type { Task, UpdateTaskDTO, BestOfNSlot, ThinkingLevel, ExecutionStrategy } from '@/types/api'
import type { useTasks } from '@/composables/useTasks'
import type { useModelSearch } from '@/composables/useModelSearch'
import type { useToasts } from '@/composables/useToasts'
import ModelPicker from '../common/ModelPicker.vue'

const props = defineProps<{
  taskIds: string[]
}>()

const emit = defineEmits<{
  close: []
}>()

const tasks = inject<ReturnType<typeof useTasks>>('tasks')!
const modelSearch = inject<ReturnType<typeof useModelSearch>>('modelSearch')!
const toasts = inject<ReturnType<typeof useToasts>>('toasts')!

const isLoading = ref(false)

// Get all selected tasks
const selectedTasks = computed(() => {
  return props.taskIds
    .map(id => tasks.getTaskById(id))
    .filter((t): t is Task => t !== undefined)
})

// Check if all values are the same
const isUniform = <T,>(values: T[]): boolean => {
  if (values.length === 0) return true
  const first = JSON.stringify(values[0])
  return values.every(v => JSON.stringify(v) === first)
}

// Get common value or undefined (for mixed)
const getCommonValue = <T,>(values: T[]): T | undefined => {
  if (values.length === 0 || !isUniform(values)) return undefined
  return values[0]
}

// Form state with "mixed" handling
const form = ref({
  branch: '' as string | undefined,
  branchMixed: false,
  planModel: '' as string | undefined,
  planModelMixed: false,
  executionModel: '' as string | undefined,
  executionModelMixed: false,
  planmode: undefined as boolean | undefined,
  planmodeMixed: false,
  autoApprovePlan: undefined as boolean | undefined,
  autoApprovePlanMixed: false,
  review: undefined as boolean | undefined,
  reviewMixed: false,
  autoCommit: undefined as boolean | undefined,
  autoCommitMixed: false,
  deleteWorktree: undefined as boolean | undefined,
  deleteWorktreeMixed: false,
  skipPermissionAsking: undefined as boolean | undefined,
  skipPermissionAskingMixed: false,
  thinkingLevel: '' as ThinkingLevel | undefined,
  thinkingLevelMixed: false,
  executionStrategy: '' as ExecutionStrategy | undefined,
  executionStrategyMixed: false,
  maxReviewRunsOverride: undefined as number | undefined,
  maxReviewRunsOverrideMixed: false,
  // Best-of-N config (only editable if all tasks have best_of_n strategy)
  bonWorkers: [] as BestOfNSlot[],
  bonReviewers: [] as BestOfNSlot[],
  bonFinalApplierModel: '' as string | undefined,
  bonFinalApplierSuffix: '',
  bonSelectionMode: 'pick_best' as const,
  bonMinSuccessful: 1,
  bonVerificationCmd: '',
  bonConfigEnabled: false,
  bonConfigMixed: false,
})

const bonValidationErrors = ref<string[]>([])
const availableBranches = ref<string[]>([])

// Track which fields have been explicitly modified by the user
const modifiedFields = ref<Set<string>>(new Set())

const markModified = (field: string) => {
  modifiedFields.value.add(field)
}

onMounted(async () => {
  // Load branches
  try {
    const branchData = await tasks.api.getBranches()
    availableBranches.value = branchData.branches
  } catch {
    // Use empty branches
  }

  // Initialize form with common values from selected tasks
  const taskList = selectedTasks.value
  if (taskList.length === 0) return

  // Branch
  const branches = taskList.map(t => t.branch)
  form.value.branch = getCommonValue(branches)
  form.value.branchMixed = !isUniform(branches)

  // Models
  const planModels = taskList.map(t => t.planModel || 'default')
  form.value.planModel = getCommonValue(planModels)
  form.value.planModelMixed = !isUniform(planModels)

  const execModels = taskList.map(t => t.executionModel || 'default')
  form.value.executionModel = getCommonValue(execModels)
  form.value.executionModelMixed = !isUniform(execModels)

  // Checkboxes
  const planmodes = taskList.map(t => t.planmode)
  form.value.planmode = getCommonValue(planmodes)
  form.value.planmodeMixed = !isUniform(planmodes)

  const autoApprovePlans = taskList.map(t => t.autoApprovePlan)
  form.value.autoApprovePlan = getCommonValue(autoApprovePlans)
  form.value.autoApprovePlanMixed = !isUniform(autoApprovePlans)

  const reviews = taskList.map(t => t.review)
  form.value.review = getCommonValue(reviews)
  form.value.reviewMixed = !isUniform(reviews)

  const autoCommits = taskList.map(t => t.autoCommit)
  form.value.autoCommit = getCommonValue(autoCommits)
  form.value.autoCommitMixed = !isUniform(autoCommits)

  const deleteWorktrees = taskList.map(t => t.deleteWorktree)
  form.value.deleteWorktree = getCommonValue(deleteWorktrees)
  form.value.deleteWorktreeMixed = !isUniform(deleteWorktrees)

  const skipPerms = taskList.map(t => t.skipPermissionAsking)
  form.value.skipPermissionAsking = getCommonValue(skipPerms)
  form.value.skipPermissionAskingMixed = !isUniform(skipPerms)

  // Dropdowns
  const thinkingLevels = taskList.map(t => t.thinkingLevel)
  form.value.thinkingLevel = getCommonValue(thinkingLevels)
  form.value.thinkingLevelMixed = !isUniform(thinkingLevels)

  const execStrategies = taskList.map(t => t.executionStrategy)
  form.value.executionStrategy = getCommonValue(execStrategies)
  form.value.executionStrategyMixed = !isUniform(execStrategies)

  // Max reviews
  const maxReviews = taskList.map(t => t.maxReviewRunsOverride)
  form.value.maxReviewRunsOverride = getCommonValue(maxReviews)
  form.value.maxReviewRunsOverrideMixed = !isUniform(maxReviews)

  // Best-of-N config - only enable if all tasks are best_of_n
  const allBestOfN = taskList.every(t => t.executionStrategy === 'best_of_n')
  form.value.bonConfigEnabled = allBestOfN

  if (allBestOfN) {
    // Check if all configs are the same
    const configs = taskList.map(t => JSON.stringify(t.bestOfNConfig))
    form.value.bonConfigMixed = !isUniform(configs)

    // Use first task's config as default (or mixed indicator)
    const firstConfig = taskList[0].bestOfNConfig
    if (firstConfig && !form.value.bonConfigMixed) {
      form.value.bonWorkers = firstConfig.workers.map(w => ({ ...w }))
      form.value.bonReviewers = firstConfig.reviewers.map(r => ({ ...r }))
      form.value.bonFinalApplierModel = firstConfig.finalApplier.model
      form.value.bonFinalApplierSuffix = firstConfig.finalApplier.taskSuffix || ''
      form.value.bonSelectionMode = firstConfig.selectionMode
      form.value.bonMinSuccessful = firstConfig.minSuccessfulWorkers
      form.value.bonVerificationCmd = firstConfig.verificationCommand || ''
    }
  }
})

const showBonConfig = computed(() => 
  form.value.executionStrategy === 'best_of_n' || 
  (form.value.executionStrategyMixed && form.value.bonConfigEnabled)
)

const validateBonConfig = (): string[] => {
  const errors: string[] = []
  if (form.value.bonWorkers.length === 0) {
    errors.push('Add at least one worker slot')
  }
  const totalWorkers = form.value.bonWorkers.reduce((sum, w) => sum + (w.count || 1), 0)
  if (totalWorkers > 8) {
    errors.push(`Total workers (${totalWorkers}) exceeds maximum of 8`)
  }
  if (form.value.bonMinSuccessful > totalWorkers) {
    errors.push('Minimum successful workers cannot exceed total workers')
  }
  return errors
}

const addBonWorker = () => {
  form.value.bonWorkers.push({ model: 'default', count: 1, suffix: '' })
  markModified('bestOfNConfig')
}

const removeBonWorker = (index: number) => {
  form.value.bonWorkers.splice(index, 1)
  markModified('bestOfNConfig')
}

const addBonReviewer = () => {
  form.value.bonReviewers.push({ model: 'default', count: 1, suffix: '' })
  markModified('bestOfNConfig')
}

const removeBonReviewer = (index: number) => {
  form.value.bonReviewers.splice(index, 1)
  markModified('bestOfNConfig')
}

const save = async () => {
  if (selectedTasks.value.length === 0) {
    emit('close')
    return
  }

  // Validate best-of-n if enabled and modified
  if (showBonConfig.value && modifiedFields.value.has('bestOfNConfig')) {
    const errors = validateBonConfig()
    if (errors.length > 0) {
      bonValidationErrors.value = errors
      toasts.showToast('Invalid best-of-n configuration: ' + errors.join('; '), 'error')
      return
    }
  }

  isLoading.value = true
  try {
    const updateData: UpdateTaskDTO = {}

    // Only include fields that were explicitly modified
    if (modifiedFields.value.has('branch') && form.value.branch !== undefined) {
      updateData.branch = form.value.branch
    }
    if (modifiedFields.value.has('planModel') && form.value.planModel !== undefined) {
      updateData.planModel = modelSearch.normalizeValue(form.value.planModel)
    }
    if (modifiedFields.value.has('executionModel') && form.value.executionModel !== undefined) {
      updateData.executionModel = modelSearch.normalizeValue(form.value.executionModel)
    }
    if (modifiedFields.value.has('planmode') && form.value.planmode !== undefined) {
      updateData.planmode = form.value.planmode
    }
    if (modifiedFields.value.has('autoApprovePlan') && form.value.autoApprovePlan !== undefined) {
      updateData.autoApprovePlan = form.value.autoApprovePlan
    }
    if (modifiedFields.value.has('review') && form.value.review !== undefined) {
      updateData.review = form.value.review
    }
    if (modifiedFields.value.has('autoCommit') && form.value.autoCommit !== undefined) {
      updateData.autoCommit = form.value.autoCommit
    }
    if (modifiedFields.value.has('deleteWorktree') && form.value.deleteWorktree !== undefined) {
      updateData.deleteWorktree = form.value.deleteWorktree
    }
    if (modifiedFields.value.has('skipPermissionAsking') && form.value.skipPermissionAsking !== undefined) {
      updateData.skipPermissionAsking = form.value.skipPermissionAsking
    }
    if (modifiedFields.value.has('thinkingLevel') && form.value.thinkingLevel !== undefined) {
      updateData.thinkingLevel = form.value.thinkingLevel
    }
    if (modifiedFields.value.has('executionStrategy') && form.value.executionStrategy !== undefined) {
      updateData.executionStrategy = form.value.executionStrategy
    }
    if (modifiedFields.value.has('maxReviewRunsOverride')) {
      updateData.maxReviewRunsOverride = form.value.maxReviewRunsOverride
    }

    // Best-of-N config
    if (modifiedFields.value.has('bestOfNConfig') && showBonConfig.value) {
      updateData.bestOfNConfig = {
        workers: form.value.bonWorkers.map(w => ({
          model: w.model,
          count: w.count || 1,
          taskSuffix: w.suffix || undefined,
        })),
        reviewers: form.value.bonReviewers.map(r => ({
          model: r.model,
          count: r.count || 1,
          taskSuffix: r.suffix || undefined,
        })),
        finalApplier: {
          model: modelSearch.normalizeValue(form.value.bonFinalApplierModel || 'default'),
          taskSuffix: form.value.bonFinalApplierSuffix.trim() || undefined,
        },
        selectionMode: form.value.bonSelectionMode,
        minSuccessfulWorkers: form.value.bonMinSuccessful,
        verificationCommand: form.value.bonVerificationCmd.trim() || undefined,
      }
    }

    // Update all tasks in parallel
    const results = await Promise.all(
      props.taskIds.map(id => tasks.updateTask(id, updateData))
    )

    toasts.showToast(`Updated ${results.length} tasks`, 'success')
    emit('close')
  } catch (e) {
    toasts.showToast('Update failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
  } finally {
    isLoading.value = false
  }
}

const closeOnOverlay = (e: MouseEvent) => {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}

// Helper to render mixed state indicator
const mixedIndicator = (isMixed: boolean) => isMixed ? '— ' : ''
</script>

<template>
  <div class="modal-overlay" @mousedown="closeOnOverlay">
    <div class="modal w-[min(640px,calc(100vw-40px))] max-h-[min(880px,calc(100vh-40px))]">
      <div class="modal-header">
        <h2>Edit {{ selectedCount }} Tasks</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body space-y-3">
        <div class="text-sm text-dark-text-muted mb-4">
          Only modified fields will be updated. Fields showing "—" have mixed values across selected tasks.
        </div>

        <!-- Branch -->
        <div class="form-group">
          <div class="label-row">
            <label>Branch</label>
            <span v-if="form.branchMixed" class="text-xs text-amber-400">(mixed)</span>
          </div>
          <select 
            v-model="form.branch" 
            class="form-select"
            @change="markModified('branch')"
          >
            <option value="" disabled v-if="form.branchMixed">— (mixed values)</option>
            <option v-for="branch in availableBranches" :key="branch" :value="branch">
              {{ mixedIndicator(form.branchMixed) }}{{ branch }}
            </option>
          </select>
        </div>

        <!-- Models -->
        <div class="grid grid-cols-2 gap-3">
          <div class="form-group">
            <div class="label-row">
              <label>Plan Model</label>
              <span v-if="form.planModelMixed" class="text-xs text-amber-400">(mixed)</span>
            </div>
            <select
              v-model="form.planModel"
              class="form-select"
              @change="markModified('planModel')"
            >
              <option value="" disabled v-if="form.planModelMixed">— (mixed values)</option>
              <option
                v-for="opt in modelSearch.getModelOptions(form.planModel || 'default')"
                :key="opt.value"
                :value="opt.value"
              >
                {{ mixedIndicator(form.planModelMixed) }}{{ opt.label }}
              </option>
            </select>
          </div>
          <div class="form-group">
            <div class="label-row">
              <label>Execution Model</label>
              <span v-if="form.executionModelMixed" class="text-xs text-amber-400">(mixed)</span>
            </div>
            <select
              v-model="form.executionModel"
              class="form-select"
              @change="markModified('executionModel')"
            >
              <option value="" disabled v-if="form.executionModelMixed">— (mixed values)</option>
              <option
                v-for="opt in modelSearch.getModelOptions(form.executionModel || 'default')"
                :key="opt.value"
                :value="opt.value"
              >
                {{ mixedIndicator(form.executionModelMixed) }}{{ opt.label }}
              </option>
            </select>
          </div>
        </div>

        <!-- Thinking Level -->
        <div class="form-group">
          <div class="label-row">
            <label>Thinking Level</label>
            <span v-if="form.thinkingLevelMixed" class="text-xs text-amber-400">(mixed)</span>
          </div>
          <select 
            v-model="form.thinkingLevel" 
            class="form-select"
            @change="markModified('thinkingLevel')"
          >
            <option value="" disabled v-if="form.thinkingLevelMixed">— (mixed values)</option>
            <option value="default">{{ mixedIndicator(form.thinkingLevelMixed) }}Default</option>
            <option value="low">{{ mixedIndicator(form.thinkingLevelMixed) }}Low</option>
            <option value="medium">{{ mixedIndicator(form.thinkingLevelMixed) }}Medium</option>
            <option value="high">{{ mixedIndicator(form.thinkingLevelMixed) }}High</option>
          </select>
        </div>

        <!-- Execution Strategy -->
        <div class="form-group">
          <div class="label-row">
            <label>Execution Strategy</label>
            <span v-if="form.executionStrategyMixed" class="text-xs text-amber-400">(mixed)</span>
          </div>
          <select 
            v-model="form.executionStrategy" 
            class="form-select"
            @change="markModified('executionStrategy')"
          >
            <option value="" disabled v-if="form.executionStrategyMixed">— (mixed values)</option>
            <option value="standard">{{ mixedIndicator(form.executionStrategyMixed) }}Standard</option>
            <option value="best_of_n">{{ mixedIndicator(form.executionStrategyMixed) }}Best of N</option>
          </select>
        </div>

        <!-- Best-of-N Config -->
        <div v-if="showBonConfig" class="border border-dark-surface3 rounded-lg p-3 bg-dark-bg">
          <div class="flex items-center justify-between mb-2">
            <h4 class="text-sm font-semibold">Best of N Configuration</h4>
            <span v-if="form.bonConfigMixed" class="text-xs text-amber-400">(mixed values)</span>
          </div>

          <div v-if="bonValidationErrors.length > 0" class="mb-2 space-y-1">
            <div v-for="err in bonValidationErrors" :key="err" class="text-xs text-red-400">
              {{ err }}
            </div>
          </div>

          <!-- Workers -->
          <div class="form-group">
            <label>Workers</label>
            <div class="space-y-2">
              <div
                v-for="(slot, i) in form.bonWorkers"
                :key="i"
                class="flex gap-2 items-center"
              >
                <input
                  v-model.number="slot.count"
                  type="number"
                  min="1"
                  max="4"
                  class="form-input w-16"
                  @change="markModified('bestOfNConfig')"
                />
                <select v-model="slot.model" class="form-select flex-1" @change="markModified('bestOfNConfig')">
                  <option
                    v-for="opt in modelSearch.getModelOptions(slot.model)"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </option>
                </select>
                <input
                  v-model="slot.suffix"
                  type="text"
                  placeholder="Suffix (optional)"
                  class="form-input flex-1"
                  @change="markModified('bestOfNConfig')"
                />
                <button
                  class="text-red-400 hover:text-red-300 px-2"
                  @click="removeBonWorker(i)"
                >
                  ✕
                </button>
              </div>
            </div>
            <button class="add-task-btn mt-2" @click="addBonWorker">
              + Add Worker Slot
            </button>
          </div>

          <!-- Reviewers -->
          <div class="form-group">
            <label>Reviewers</label>
            <div class="space-y-2">
              <div
                v-for="(slot, i) in form.bonReviewers"
                :key="i"
                class="flex gap-2 items-center"
              >
                <input
                  v-model.number="slot.count"
                  type="number"
                  min="1"
                  max="4"
                  class="form-input w-16"
                  @change="markModified('bestOfNConfig')"
                />
                <select v-model="slot.model" class="form-select flex-1" @change="markModified('bestOfNConfig')">
                  <option
                    v-for="opt in modelSearch.getModelOptions(slot.model)"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </option>
                </select>
                <input
                  v-model="slot.suffix"
                  type="text"
                  placeholder="Suffix (optional)"
                  class="form-input flex-1"
                  @change="markModified('bestOfNConfig')"
                />
                <button
                  class="text-red-400 hover:text-red-300 px-2"
                  @click="removeBonReviewer(i)"
                >
                  ✕
                </button>
              </div>
            </div>
            <button class="add-task-btn mt-2" @click="addBonReviewer">
              + Add Reviewer Slot
            </button>
          </div>

          <!-- Final Applier -->
          <div class="form-group">
            <label>Final Applier Model</label>
            <select
              v-model="form.bonFinalApplierModel"
              class="form-select"
              @change="markModified('bestOfNConfig')"
            >
              <option
                v-for="opt in modelSearch.getModelOptions(form.bonFinalApplierModel || 'default')"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
          </div>

          <div class="form-group">
            <label>Final Applier Suffix (optional)</label>
            <textarea
              v-model="form.bonFinalApplierSuffix"
              class="form-textarea"
              placeholder="Additional instructions for the final applier..."
              @change="markModified('bestOfNConfig')"
            />
          </div>

          <!-- Selection Mode & Min Successful -->
          <div class="grid grid-cols-2 gap-3">
            <div class="form-group">
              <label>Selection Mode</label>
              <select 
                v-model="form.bonSelectionMode" 
                class="form-select"
                @change="markModified('bestOfNConfig')"
              >
                <option value="pick_best">Pick Best</option>
                <option value="synthesize">Synthesize</option>
                <option value="pick_or_synthesize">Pick or Synthesize</option>
              </select>
            </div>
            <div class="form-group">
              <label>Min Successful Workers</label>
              <input
                v-model.number="form.bonMinSuccessful"
                type="number"
                min="1"
                max="8"
                class="form-input"
                @change="markModified('bestOfNConfig')"
              />
            </div>
          </div>

          <!-- Verification Command -->
          <div class="form-group">
            <label>Verification Command (optional)</label>
            <input
              v-model="form.bonVerificationCmd"
              type="text"
              class="form-input"
              placeholder="e.g. npm test"
              @change="markModified('bestOfNConfig')"
            />
          </div>
        </div>

        <div v-else-if="form.executionStrategy === 'best_of_n' && !form.bonConfigEnabled" class="text-sm text-amber-400">
          Best-of-N configuration can only be edited when all selected tasks use the "Best of N" strategy.
        </div>

        <!-- Max Review Override -->
        <div class="form-group">
          <div class="label-row">
            <label>Max Review Runs Override</label>
            <span v-if="form.maxReviewRunsOverrideMixed" class="text-xs text-amber-400">(mixed)</span>
          </div>
          <input
            v-model.number="form.maxReviewRunsOverride"
            type="number"
            min="1"
            class="form-input"
            :placeholder="form.maxReviewRunsOverrideMixed ? '— (mixed values)' : 'Use global default'"
            @change="markModified('maxReviewRunsOverride')"
          />
        </div>

        <!-- Checkboxes -->
        <div class="checkbox-group">
          <label class="checkbox-item">
            <input 
              v-model="form.planmode" 
              :indeterminate="form.planmode === undefined && form.planmodeMixed"
              type="checkbox"
              @change="markModified('planmode')"
            />
            <span>
              Plan Mode
              <span v-if="form.planmodeMixed" class="text-xs text-amber-400 ml-1">(mixed)</span>
            </span>
          </label>
          <label class="checkbox-item">
            <input 
              v-model="form.autoApprovePlan" 
              :indeterminate="form.autoApprovePlan === undefined && form.autoApprovePlanMixed"
              type="checkbox"
              @change="markModified('autoApprovePlan')"
            />
            <span>
              Auto-approve plan
              <span v-if="form.autoApprovePlanMixed" class="text-xs text-amber-400 ml-1">(mixed)</span>
            </span>
          </label>
          <label class="checkbox-item">
            <input 
              v-model="form.review" 
              :indeterminate="form.review === undefined && form.reviewMixed"
              type="checkbox"
              @change="markModified('review')"
            />
            <span>
              Review
              <span v-if="form.reviewMixed" class="text-xs text-amber-400 ml-1">(mixed)</span>
            </span>
          </label>
          <label class="checkbox-item">
            <input 
              v-model="form.autoCommit" 
              :indeterminate="form.autoCommit === undefined && form.autoCommitMixed"
              type="checkbox"
              @change="markModified('autoCommit')"
            />
            <span>
              Auto-commit
              <span v-if="form.autoCommitMixed" class="text-xs text-amber-400 ml-1">(mixed)</span>
            </span>
          </label>
          <label class="checkbox-item">
            <input 
              v-model="form.deleteWorktree" 
              :indeterminate="form.deleteWorktree === undefined && form.deleteWorktreeMixed"
              type="checkbox"
              @change="markModified('deleteWorktree')"
            />
            <span>
              Delete Worktree
              <span v-if="form.deleteWorktreeMixed" class="text-xs text-amber-400 ml-1">(mixed)</span>
            </span>
          </label>
          <label class="checkbox-item">
            <input 
              v-model="form.skipPermissionAsking" 
              :indeterminate="form.skipPermissionAsking === undefined && form.skipPermissionAskingMixed"
              type="checkbox"
              @change="markModified('skipPermissionAsking')"
            />
            <span>
              Skip Permission Asking
              <span v-if="form.skipPermissionAskingMixed" class="text-xs text-amber-400 ml-1">(mixed)</span>
            </span>
          </label>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button
          class="btn btn-primary"
          :disabled="isLoading || modifiedFields.size === 0"
          @click="save"
        >
          {{ isLoading ? 'Saving...' : `Update ${selectedCount} Tasks` }}
        </button>
      </div>
    </div>
  </div>
</template>
