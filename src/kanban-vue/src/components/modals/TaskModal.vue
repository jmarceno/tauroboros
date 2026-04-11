<script setup lang="ts">
import { ref, computed, inject, watch, onMounted } from 'vue'
import type { Task, CreateTaskDTO, BestOfNSlot, BestOfNConfig } from '@/types/api'
import type { useTasks } from '@/composables/useTasks'
import type { useModelSearch } from '@/composables/useModelSearch'
import type { useToasts } from '@/composables/useToasts'
import type { useOptions } from '@/composables/useOptions'
import ModelPicker from '../common/ModelPicker.vue'

const props = defineProps<{
  mode: 'create' | 'edit' | 'view' | 'deploy'
  taskId?: string
  createStatus: 'template' | 'backlog'
  seedTaskId?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const tasks = inject<ReturnType<typeof useTasks>>('tasks')!
const modelSearch = inject<ReturnType<typeof useModelSearch>>('modelSearch')!
const toasts = inject<ReturnType<typeof useToasts>>('toasts')!
const options = inject<ReturnType<typeof useOptions>>('options')!

// Form state
const form = ref({
  name: '',
  prompt: '',
  branch: '',
  planModel: 'default',
  executionModel: 'default',
  planmode: false,
  autoApprovePlan: false,
  review: true,
  autoCommit: true,
  deleteWorktree: true,
  skipPermissionAsking: true,
  requirements: [] as string[],
  thinkingLevel: 'default' as const,
  executionStrategy: 'standard' as const,
  bonWorkers: [] as BestOfNSlot[],
  bonReviewers: [] as BestOfNSlot[],
  bonFinalApplierModel: 'default',
  bonFinalApplierSuffix: '',
  bonSelectionMode: 'pick_best' as const,
  bonMinSuccessful: 1,
  bonVerificationCmd: '',
})

const bonValidationErrors = ref<string[]>([])
const isLoading = ref(false)

// Computed
const isViewOnly = computed(() => props.mode === 'view')
const isDeploy = computed(() => props.mode === 'deploy')
const title = computed(() => {
  if (isViewOnly.value) return 'View Task'
  if (isDeploy.value) return 'Deploy Template'
  if (props.mode === 'edit') return props.createStatus === 'template' ? 'Edit Template' : 'Edit Task'
  return props.createStatus === 'template' ? 'Add Template' : 'Add Task'
})

const saveButtonText = computed(() => {
  if (isDeploy.value) return 'Send to Backlog'
  if (props.mode === 'create' && props.createStatus === 'template') return 'Save Template'
  return 'Save'
})

const availableBranches = ref<string[]>([])
const currentBranch = ref<string | null>(null)

// Get branches on mount
onMounted(async () => {
  try {
    const branchData = await tasks.api.getBranches()
    availableBranches.value = branchData.branches
    currentBranch.value = branchData.current
  } catch {
    // Use default empty branches
  }

  if (props.taskId) {
    // Edit/view existing task
    const task = tasks.getTaskById(props.taskId)
    if (task) {
      populateFormFromTask(task)
    }
  } else if (props.seedTaskId) {
    // Deploy from template
    const seedTask = tasks.getTaskById(props.seedTaskId)
    if (seedTask) {
      populateFormFromTask(seedTask)
    }
  } else {
    // New task - set defaults
    form.value.branch = currentBranch.value || availableBranches.value[0] || ''
    form.value.planModel = options.options.planModel || 'default'
    form.value.executionModel = options.options.executionModel || 'default'
  }
})

const populateFormFromTask = (task: Task) => {
  form.value.name = task.name
  form.value.prompt = task.prompt
  form.value.branch = task.branch || currentBranch.value || availableBranches.value[0] || ''
  form.value.planModel = task.planModel || 'default'
  form.value.executionModel = task.executionModel || 'default'
  form.value.planmode = task.planmode
  form.value.autoApprovePlan = task.autoApprovePlan
  form.value.review = task.review
  form.value.autoCommit = task.autoCommit
  form.value.deleteWorktree = task.deleteWorktree !== false
  form.value.skipPermissionAsking = task.skipPermissionAsking
  form.value.requirements = [...task.requirements]
  form.value.thinkingLevel = task.thinkingLevel
  form.value.executionStrategy = task.executionStrategy

  if (task.executionStrategy === 'best_of_n' && task.bestOfNConfig) {
    form.value.bonWorkers = task.bestOfNConfig.workers.map(w => ({ ...w }))
    form.value.bonReviewers = task.bestOfNConfig.reviewers.map(r => ({ ...r }))
    form.value.bonFinalApplierModel = task.bestOfNConfig.finalApplier.model
    form.value.bonFinalApplierSuffix = task.bestOfNConfig.finalApplier.taskSuffix || ''
    form.value.bonSelectionMode = task.bestOfNConfig.selectionMode
    form.value.bonMinSuccessful = task.bestOfNConfig.minSuccessfulWorkers
    form.value.bonVerificationCmd = task.bestOfNConfig.verificationCommand || ''
  }
}

const getFallbackBranch = () => {
  if (availableBranches.value.includes(options.options.branch)) return options.options.branch
  if (currentBranch.value && availableBranches.value.includes(currentBranch.value)) return currentBranch.value
  return availableBranches.value[0] || ''
}

const availableRequirements = computed(() => {
  if (isViewOnly.value) {
    return tasks.tasks.value.filter(t => t.id !== props.taskId)
  }
  return tasks.tasks.value.filter(t => t.status === 'backlog' && t.id !== props.taskId)
})

const showBonConfig = computed(() => form.value.executionStrategy === 'best_of_n')

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
}

const removeBonWorker = (index: number) => {
  form.value.bonWorkers.splice(index, 1)
}

const addBonReviewer = () => {
  form.value.bonReviewers.push({ model: 'default', count: 1, suffix: '' })
}

const removeBonReviewer = (index: number) => {
  form.value.bonReviewers.splice(index, 1)
}

const save = async () => {
  if (!form.value.name.trim() || !form.value.prompt.trim()) {
    toasts.showToast('Name and prompt are required', 'error')
    return
  }
  if (!form.value.branch) {
    toasts.showToast('Select a valid branch', 'error')
    return
  }

  if (form.value.executionStrategy === 'best_of_n') {
    const errors = validateBonConfig()
    if (errors.length > 0) {
      bonValidationErrors.value = errors
      toasts.showToast('Invalid best-of-n configuration: ' + errors.join('; '), 'error')
      return
    }
  }

  isLoading.value = true
  try {
    const data: CreateTaskDTO = {
      name: form.value.name.trim(),
      prompt: form.value.prompt.trim(),
      branch: form.value.branch,
      planModel: modelSearch.normalizeValue(form.value.planModel),
      executionModel: modelSearch.normalizeValue(form.value.executionModel),
      planmode: form.value.planmode,
      autoApprovePlan: form.value.autoApprovePlan,
      review: form.value.review,
      autoCommit: form.value.autoCommit,
      deleteWorktree: form.value.deleteWorktree,
      skipPermissionAsking: form.value.skipPermissionAsking,
      requirements: form.value.requirements,
      thinkingLevel: form.value.thinkingLevel,
      executionStrategy: form.value.executionStrategy,
    }

    if (form.value.executionStrategy === 'best_of_n') {
      data.bestOfNConfig = {
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
          model: modelSearch.normalizeValue(form.value.bonFinalApplierModel),
          taskSuffix: form.value.bonFinalApplierSuffix.trim() || undefined,
        },
        selectionMode: form.value.bonSelectionMode,
        minSuccessfulWorkers: form.value.bonMinSuccessful,
        verificationCommand: form.value.bonVerificationCmd.trim() || undefined,
      }
    }

    if (props.taskId && props.mode === 'edit') {
      await tasks.updateTask(props.taskId, data)
    } else {
      await tasks.createTask({ ...data, status: props.createStatus })
      if (isDeploy.value) {
        toasts.showToast('Task sent to Backlog', 'success')
      }
    }

    emit('close')
  } catch (e) {
    toasts.showToast('Save failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
  } finally {
    isLoading.value = false
  }
}

const closeOnOverlay = (e: MouseEvent) => {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}
</script>

<template>
  <div class="modal-overlay" @mousedown="closeOnOverlay">
    <div class="modal w-[min(640px,calc(100vw-40px))] max-h-[min(880px,calc(100vh-40px))]">
      <div class="modal-header">
        <h2>{{ title }}</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body space-y-3">
        <!-- Name -->
        <div class="form-group">
          <div class="label-row">
            <label>Name</label>
            <span class="help-btn" title="Short task title shown on the card. Make it specific enough to identify the work at a glance.">?</span>
          </div>
          <input
            v-model="form.name"
            type="text"
            class="form-input"
            placeholder="Task name"
            :disabled="isViewOnly"
          />
        </div>

        <!-- Prompt -->
        <div class="form-group">
          <div class="label-row">
            <label>Prompt</label>
            <span class="help-btn" title="The main instructions for the agent. Describe the change, bug, or outcome you want it to produce.">?</span>
          </div>
          <textarea
            v-model="form.prompt"
            class="form-textarea"
            placeholder="What should this task do?"
            :disabled="isViewOnly"
          />
        </div>

        <!-- Models -->
        <div class="grid grid-cols-2 gap-3">
          <ModelPicker
            v-model="form.planModel"
            label="Plan Model"
            help="Model used for planning steps before implementation. Use this when you want a specific model to reason about the approach first."
            :disabled="isViewOnly"
          />
          <ModelPicker
            v-model="form.executionModel"
            label="Execution Model"
            help="Model used for the actual implementation work. Set this when execution should run on a different model than planning."
            :disabled="isViewOnly"
          />
        </div>

        <!-- Thinking Level -->
        <div class="form-group">
          <div class="label-row">
            <label>Thinking Level</label>
            <span class="help-btn" title="Controls how much reasoning effort the agent should spend. Higher levels can improve harder tasks but usually take longer.">?</span>
          </div>
          <select v-model="form.thinkingLevel" class="form-select" :disabled="isViewOnly">
            <option value="default">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <!-- Execution Strategy -->
        <div class="form-group">
          <div class="label-row">
            <label>Execution Strategy</label>
            <span class="help-btn" title="Standard runs a single execution. Best of N runs multiple candidates in parallel and picks or synthesizes the best result.">?</span>
          </div>
          <select v-model="form.executionStrategy" class="form-select" :disabled="isViewOnly">
            <option value="standard">Standard</option>
            <option value="best_of_n">Best of N</option>
          </select>
        </div>

        <!-- Best-of-N Config -->
        <div v-if="showBonConfig" class="border border-dark-surface3 rounded-lg p-3 bg-dark-bg">
          <h4 class="text-sm font-semibold mb-2">Best of N Configuration</h4>

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
                  :disabled="isViewOnly"
                />
                <select v-model="slot.model" class="form-select flex-1" :disabled="isViewOnly">
                  <option
                    v-for="opt in modelSearch.getModelOptions(slot.model)"
                    :key="opt.value"
                    :value="opt.value"
                    :selected="opt.selected"
                  >
                    {{ opt.label }}
                  </option>
                </select>
                <input
                  v-model="slot.suffix"
                  type="text"
                  placeholder="Suffix (optional)"
                  class="form-input flex-1"
                  :disabled="isViewOnly"
                />
                <button
                  v-if="!isViewOnly"
                  class="text-red-400 hover:text-red-300 px-2"
                  @click="removeBonWorker(i)"
                >
                  ✕
                </button>
              </div>
            </div>
            <button
              v-if="!isViewOnly"
              class="add-task-btn mt-2"
              @click="addBonWorker"
            >
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
                  :disabled="isViewOnly"
                />
                <select v-model="slot.model" class="form-select flex-1" :disabled="isViewOnly">
                  <option
                    v-for="opt in modelSearch.getModelOptions(slot.model)"
                    :key="opt.value"
                    :value="opt.value"
                    :selected="opt.selected"
                  >
                    {{ opt.label }}
                  </option>
                </select>
                <input
                  v-model="slot.suffix"
                  type="text"
                  placeholder="Suffix (optional)"
                  class="form-input flex-1"
                  :disabled="isViewOnly"
                />
                <button
                  v-if="!isViewOnly"
                  class="text-red-400 hover:text-red-300 px-2"
                  @click="removeBonReviewer(i)"
                >
                  ✕
                </button>
              </div>
            </div>
            <button
              v-if="!isViewOnly"
              class="add-task-btn mt-2"
              @click="addBonReviewer"
            >
              + Add Reviewer Slot
            </button>
          </div>

          <!-- Final Applier -->
          <ModelPicker
            v-model="form.bonFinalApplierModel"
            label="Final Applier Model"
            :disabled="isViewOnly"
          />

          <div class="form-group">
            <label>Final Applier Suffix (optional)</label>
            <textarea
              v-model="form.bonFinalApplierSuffix"
              class="form-textarea"
              placeholder="Additional instructions for the final applier..."
              :disabled="isViewOnly"
            />
          </div>

          <!-- Selection Mode & Min Successful -->
          <div class="grid grid-cols-2 gap-3">
            <div class="form-group">
              <label>Selection Mode</label>
              <select v-model="form.bonSelectionMode" class="form-select" :disabled="isViewOnly">
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
                :disabled="isViewOnly"
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
              :disabled="isViewOnly"
            />
          </div>
        </div>

        <!-- Branch -->
        <div class="form-group">
          <div class="label-row">
            <label>Branch</label>
            <span class="help-btn" title="Git branch the task should run against. Pick the branch where changes should be created or reviewed.">?</span>
          </div>
          <select v-model="form.branch" class="form-select" :disabled="isViewOnly">
            <option v-for="branch in availableBranches" :key="branch" :value="branch">
              {{ branch }}
            </option>
          </select>
        </div>

        <!-- Checkboxes -->
        <div class="checkbox-group" v-if="!isViewOnly">
          <label class="checkbox-item">
            <input v-model="form.planmode" type="checkbox" />
            <span>Plan Mode</span>
          </label>
          <label class="checkbox-item">
            <input v-model="form.autoApprovePlan" type="checkbox" />
            <span>Auto-approve plan</span>
          </label>
          <label class="checkbox-item">
            <input v-model="form.review" type="checkbox" />
            <span>Review</span>
          </label>
          <label class="checkbox-item">
            <input v-model="form.autoCommit" type="checkbox" />
            <span>Auto-commit</span>
          </label>
          <label class="checkbox-item">
            <input v-model="form.deleteWorktree" type="checkbox" />
            <span>Delete Worktree</span>
          </label>
          <label class="checkbox-item">
            <input v-model="form.skipPermissionAsking" type="checkbox" />
            <span>Skip Permission Asking</span>
          </label>
        </div>

        <!-- Requirements -->
        <div class="form-group">
          <div class="label-row">
            <label>Requirements (dependencies)</label>
            <span class="help-btn" title="Tasks that must be completed before this one should run. Use dependencies to enforce execution order.">?</span>
          </div>
          <div class="border border-dark-surface3 rounded-lg p-1.5 max-h-36 overflow-y-auto">
            <label
              v-for="t in availableRequirements"
              :key="t.id"
              class="flex items-center gap-1.5 p-1 rounded cursor-pointer hover:bg-dark-surface2"
            >
              <input
                v-model="form.requirements"
                type="checkbox"
                :value="t.id"
                :disabled="isViewOnly"
              />
              <span class="text-sm">{{ t.name }} (#{{ t.idx + 1 }})</span>
            </label>
            <div v-if="availableRequirements.length === 0" class="text-xs text-dark-text-muted p-1">
              No other tasks
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button
          v-if="!isViewOnly"
          class="btn btn-primary"
          :disabled="isLoading"
          @click="save"
        >
          {{ isLoading ? 'Saving...' : saveButtonText }}
        </button>
      </div>
    </div>
  </div>
</template>
