<script setup lang="ts">
import { ref, inject, computed, onMounted, watch } from 'vue'
import type { Options } from '@/types/api'
import type { useOptions } from '@/composables/useOptions'
import type { useModelSearch } from '@/composables/useModelSearch'
import type { useToasts } from '@/composables/useToasts'
import ModelPicker from '../common/ModelPicker.vue'
import ThinkingLevelSelect from '../common/ThinkingLevelSelect.vue'

const emit = defineEmits<{
  close: []
}>()

const options = inject<ReturnType<typeof useOptions>>('options')!
const modelSearch = inject<ReturnType<typeof useModelSearch>>('modelSearch')!
const toasts = inject<ReturnType<typeof useToasts>>('toasts')!

const isSaving = ref(false)
const formKey = ref(0) // Used to force re-render of child components
const availableBranches = ref<string[]>([])
const currentBranch = ref<string | null>(null)
const branchesError = ref<string | null>(null)

// Form will be populated from backend data only after loading
const form = ref<Options | null>(null)

// Computed property to safely access form values
const safeForm = computed<Options>(() => {
  return form.value ?? {
    branch: '',
    planModel: '',
    executionModel: '',
    reviewModel: '',
    repairModel: '',
    command: '',
    commitPrompt: '',
    extraPrompt: '',
    parallelTasks: 1,
    maxReviews: 1,
    autoDeleteNormalSessions: false,
    autoDeleteReviewSessions: false,
    thinkingLevel: 'default',
    planThinkingLevel: 'default',
    executionThinkingLevel: 'default',
    reviewThinkingLevel: 'default',
    repairThinkingLevel: 'default',
    telegramNotificationsEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    showExecutionGraph: false,
    codeStylePrompt: '',
  }
})

// Check if options are loaded
const hasLoadedOptions = computed(() => form.value !== null)

onMounted(async () => {
  console.log('[OptionsModal] onMounted')
  
  // Load options first
  if (!options.options.value) {
    console.log('[OptionsModal] Loading options...')
    await options.loadOptions()
  }
  
  // Copy options to local form
  if (options.options.value) {
    console.log('[OptionsModal] Copying options to form:', options.options.value)
    form.value = { ...options.options.value }
    formKey.value++ // Force child components to re-render
  } else {
    console.error('[OptionsModal] Options still null after loading')
  }
  
  // Load branches
  try {
    branchesError.value = null
    const branchData = await options.api.getBranches()
    availableBranches.value = branchData.branches || []
    currentBranch.value = branchData.current
    
    // If we have branches but no selected branch, select the current one
    if (availableBranches.value.length > 0 && !safeForm.value.branch) {
      if (form.value) {
        form.value.branch = currentBranch.value || availableBranches.value[0]
      }
    }
  } catch (err) {
    branchesError.value = err instanceof Error ? err.message : 'Failed to load branches'
    console.error('[OptionsModal] Failed to load branches:', err)
  }
})

const save = async () => {
  if (!safeForm.value.branch) {
    toasts.showToast('Select a valid default branch', 'error')
    return
  }

  isSaving.value = true
  try {
    const dataToSave = {
      branch: safeForm.value.branch,
      // In Options modal, save empty strings as-is (don't convert to "default")
      planModel: safeForm.value.planModel || '',
      executionModel: safeForm.value.executionModel || '',
      reviewModel: safeForm.value.reviewModel || '',
      repairModel: safeForm.value.repairModel || '',
      command: safeForm.value.command,
      commitPrompt: safeForm.value.commitPrompt,
      extraPrompt: safeForm.value.extraPrompt,
      codeStylePrompt: safeForm.value.codeStylePrompt,
      parallelTasks: safeForm.value.parallelTasks,
      maxReviews: safeForm.value.maxReviews,
      autoDeleteNormalSessions: safeForm.value.autoDeleteNormalSessions,
      autoDeleteReviewSessions: safeForm.value.autoDeleteReviewSessions,
      thinkingLevel: safeForm.value.thinkingLevel,
      planThinkingLevel: safeForm.value.planThinkingLevel,
      executionThinkingLevel: safeForm.value.executionThinkingLevel,
      reviewThinkingLevel: safeForm.value.reviewThinkingLevel,
      repairThinkingLevel: safeForm.value.repairThinkingLevel,
      telegramNotificationsEnabled: safeForm.value.telegramNotificationsEnabled,
      telegramBotToken: safeForm.value.telegramBotToken,
      telegramChatId: safeForm.value.telegramChatId,
      showExecutionGraph: safeForm.value.showExecutionGraph,
    }
    console.log('[OptionsModal] Saving options:', dataToSave)
    await options.saveOptions(dataToSave)
    emit('close')
  } catch (e) {
    console.error('[OptionsModal] Save failed:', e)
    toasts.showToast('Options save failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
  } finally {
    isSaving.value = false
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
    <div class="modal w-[min(560px,calc(100vw-40px))]" style="max-height: calc(100vh - 40px);">
      <div class="modal-header">
        <h2>Options</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <!-- Loading State - Show until we have loaded real data from backend -->
      <div v-if="!hasLoadedOptions" class="modal-body p-8 text-center">
        <div class="text-dark-text-muted">Loading options...</div>
      </div>

      <template v-else>
        <div class="modal-body space-y-3 overflow-y-auto" style="max-height: calc(100vh - 180px);">
          <!-- Default Branch -->
          <div class="form-group">
            <div class="label-row">
              <label>Default Branch</label>
              <span class="help-btn" title="Default git branch for new tasks when a task-specific branch is not selected.">?</span>
            </div>
            <div v-if="branchesError" class="text-xs text-red-400 mb-1">
              Error loading branches: {{ branchesError }}
            </div>
            <select v-model="form!.branch" class="form-select" :disabled="availableBranches.length === 0">
              <option value="" disabled v-if="availableBranches.length === 0">No branches available</option>
              <option v-for="branch in availableBranches" :key="branch" :value="branch">
                {{ branch }}
              </option>
            </select>
            <div v-if="availableBranches.length === 0 && !branchesError" class="text-xs text-dark-text-muted mt-1">
              Loading branches...
            </div>
          </div>

          <!-- Models with Thinking Levels -->
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <ModelPicker
                :key="'plan-' + formKey"
                v-model="form!.planModel"
                label="Plan Model (global)"
                help="Default planning model for new tasks. Individual tasks can override this value."
              />
              <ThinkingLevelSelect
                v-model="form!.planThinkingLevel"
                label="Plan Thinking"
                help="Default thinking level for planning phase."
              />
            </div>
            <div class="space-y-2">
              <ModelPicker
                :key="'exec-' + formKey"
                v-model="form!.executionModel"
                label="Execution Model (global)"
                help="Default execution model for new tasks. Individual tasks can override this value."
              />
              <ThinkingLevelSelect
                v-model="form!.executionThinkingLevel"
                label="Execution Thinking"
                help="Default thinking level for execution phase."
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <ModelPicker
                :key="'review-' + formKey"
                v-model="form!.reviewModel"
                label="Review Model"
                help="Model used by the workflow-review agent. This is stored in the database and used for all review operations."
              />
              <ThinkingLevelSelect
                v-model="form!.reviewThinkingLevel"
                label="Review Thinking"
                help="Default thinking level for review phase."
              />
            </div>
            <div class="space-y-2">
              <ModelPicker
                :key="'repair-' + formKey"
                v-model="form!.repairModel"
                label="Repair Model"
                help="Model used by the workflow-repair agent for state repair analysis."
              />
              <ThinkingLevelSelect
                v-model="form!.repairThinkingLevel"
                label="Repair Thinking"
                help="Default thinking level for repair operations."
              />
            </div>
          </div>

          <!-- Pre-execution Command -->
          <div class="form-group">
            <div class="label-row">
              <label>Pre-execution Command</label>
              <span class="help-btn" title="Command to run before task execution begins, such as installing dependencies or preparing the workspace.">?</span>
            </div>
            <input v-model="form!.command" type="text" class="form-input" placeholder="e.g. npm install" />
          </div>

          <!-- Parallel Tasks -->
          <div class="form-group">
            <div class="label-row">
              <label>Parallel Tasks</label>
              <span class="help-btn" title="Maximum number of tasks the workflow should execute at the same time.">?</span>
            </div>
            <input v-model.number="form!.parallelTasks" type="number" min="1" max="10" class="form-input" />
          </div>

          <!-- Max Reviews -->
          <div class="form-group">
            <div class="label-row">
              <label>Maximum Review Runs</label>
              <span class="help-btn" title="Maximum number of review cycles for a task before it gets stuck. Can be overridden per-task.">?</span>
            </div>
            <input v-model.number="form!.maxReviews" type="number" min="1" max="10" class="form-input" />
          </div>

          <!-- Max JSON Parse Retries -->
          <div class="form-group">
            <div class="label-row">
              <label>Maximum JSON Parse Retries</label>
              <span class="help-btn" title="Maximum consecutive retries when a review response fails JSON parsing before marking task as stuck. Resets when a valid JSON response is received.">?</span>
            </div>
            <input v-model.number="form!.maxJsonParseRetries" type="number" min="1" max="20" class="form-input" />
          </div>

          <!-- Session Cleanup -->
          <div class="form-group">
            <div class="label-row">
              <label> Session Cleanup (global)</label>
              <span class="help-btn" title="Automatically delete TaurOboros sessions after task/review runs finish. Enable only if you do not need session history for debugging.">?</span>
            </div>
            <div class="checkbox-group">
              <label class="checkbox-item">
                <input v-model="form!.autoDeleteNormalSessions" type="checkbox" />
                <span> Auto-delete normal sessions</span>
              </label>
              <label class="checkbox-item">
                <input v-model="form!.autoDeleteReviewSessions" type="checkbox" />
                <span> Auto-delete review sessions</span>
              </label>
            </div>
          </div>

          <!-- Show Execution Graph -->
          <div class="form-group">
            <label class="checkbox-item">
              <input v-model="form!.showExecutionGraph" type="checkbox" />
              <span>Show execution graph before starting workflow</span>
            </label>
          </div>

          <!-- Commit Prompt -->
          <div class="form-group">
            <div class="label-row">
              <label>Commit Prompt <span class="text-dark-text-muted font-normal">({{ '{' + '{base_ref}' + '}' }} will be replaced at runtime)</span></label>
              <span class="help-btn" title="Instructions used when the workflow asks the agent to prepare a git commit. Use {{base_ref}} anywhere you want the current base branch inserted automatically.">?</span>
            </div>
            <textarea
              v-model="form!.commitPrompt"
              class="form-textarea font-mono text-xs"
              style="min-height: 180px;"
              placeholder="Instructions for committing changes..."
            />
          </div>

          <!-- Extra Prompt -->
          <div class="form-group">
            <div class="label-row">
              <label>Extra Prompt <span class="text-dark-text-muted font-normal">(added to every prompt)</span></label>
              <span class="help-btn" title="Additional instructions that will be appended to every task prompt sent to the agent.">?</span>
            </div>
            <textarea
              v-model="form!.extraPrompt"
              class="form-textarea font-mono text-xs"
              style="min-height: 100px;"
              placeholder="Additional context or instructions for all tasks..."
            />
          </div>

          <!-- Code Style Prompt -->
          <div class="form-group">
            <div class="label-row">
              <label>Code Style Prompt <span class="text-dark-text-muted font-normal">(used during code style enforcement)</span></label>
              <span class="help-btn" title="Instructions used during the code style phase to review and apply fixes to code. Uses the Review Model and Review Thinking Level.">?</span>
            </div>
            <textarea
              v-model="form!.codeStylePrompt"
              class="form-textarea font-mono text-xs"
              style="min-height: 100px;"
              placeholder="Instructions for code style review and enforcement..."
            />
          </div>

          <!-- Telegram Notifications -->
          <div class="form-group border border-dark-surface3 rounded-lg p-3">
            <div class="label-row">
              <label>Telegram Notifications</label>
              <span class="help-btn" title="Send a Telegram message when a task changes state. Leave both fields empty to disable notifications.">?</span>
            </div>
            <label class="checkbox-item mb-2">
              <input v-model="form!.telegramNotificationsEnabled" type="checkbox" />
              <span>Enable Telegram notifications</span>
            </label>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="text-xs text-dark-text-muted mb-1 block">Bot Token</label>
                <input v-model="form!.telegramBotToken" type="password" class="form-input" placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxYZ" />
              </div>
              <div>
                <label class="text-xs text-dark-text-muted mb-1 block">Chat ID</label>
                <input v-model="form!.telegramChatId" type="text" class="form-input" placeholder="-1001234567890 or @channel_name" />
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary" :disabled="isSaving" @click="save">
            {{ isSaving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
