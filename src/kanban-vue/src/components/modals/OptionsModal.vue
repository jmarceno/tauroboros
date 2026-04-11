<script setup lang="ts">
import { ref, inject, computed, onMounted } from 'vue'
import type { useOptions } from '@/composables/useOptions'
import type { useModelSearch } from '@/composables/useModelSearch'
import type { useToasts } from '@/composables/useToasts'
import ModelPicker from '../common/ModelPicker.vue'

const emit = defineEmits<{
  close: []
}>()

const options = inject<ReturnType<typeof useOptions>>('options')!
const modelSearch = inject<ReturnType<typeof useModelSearch>>('modelSearch')!
const toasts = inject<ReturnType<typeof useToasts>>('toasts')!

const isLoading = ref(false)
const availableBranches = ref<string[]>([])
const currentBranch = ref<string | null>(null)
const branchesError = ref<string | null>(null)

const defaultCommitPrompt = `Review the changes you made and create a commit message following these rules:

1. The commit message should be clear and descriptive
2. Follow conventional commit format: <type>(<scope>): <description>
3. Types: feat, fix, docs, style, refactor, test, chore
4. Include the ticket/issue number if applicable
5. Keep the first line under 50 characters
6. Add detailed description after a blank line if needed

Commit message:`

const form = ref({
  branch: options.options.branch || '',
  planModel: options.options.planModel || 'default',
  executionModel: options.options.executionModel || 'default',
  reviewModel: options.options.reviewModel || 'default',
  repairModel: options.options.repairModel || 'default',
  command: options.options.command || '',
  commitPrompt: options.options.commitPrompt || defaultCommitPrompt,
  extraPrompt: options.options.extraPrompt || '',
  parallelTasks: options.options.parallelTasks || 1,
  maxReviews: options.options.maxReviews || 2,
  autoDeleteNormalSessions: options.options.autoDeleteNormalSessions || false,
  autoDeleteReviewSessions: options.options.autoDeleteReviewSessions || false,
  thinkingLevel: options.options.thinkingLevel || 'default',
  telegramEnabled: options.options.telegramNotificationsEnabled || false,
  telegramBotToken: options.options.telegramBotToken || '',
  telegramChatId: options.options.telegramChatId || '',
  showExecutionGraph: options.options.showExecutionGraph !== false,
})

onMounted(async () => {
  try {
    branchesError.value = null
    const branchData = await options.api.getBranches()
    availableBranches.value = branchData.branches || []
    currentBranch.value = branchData.current
    
    // If we have branches but no selected branch, select the current one
    if (availableBranches.value.length > 0 && !form.value.branch) {
      form.value.branch = currentBranch.value || availableBranches.value[0]
    }
  } catch (err) {
    branchesError.value = err instanceof Error ? err.message : 'Failed to load branches'
    console.error('Failed to load branches:', err)
    // Keep any existing branch value
  }
})

const save = async () => {
  if (!form.value.branch) {
    toasts.showToast('Select a valid default branch', 'error')
    return
  }

  isLoading.value = true
  try {
    await options.saveOptions({
      branch: form.value.branch,
      planModel: modelSearch.normalizeValue(form.value.planModel),
      executionModel: modelSearch.normalizeValue(form.value.executionModel),
      reviewModel: modelSearch.normalizeValue(form.value.reviewModel),
      repairModel: modelSearch.normalizeValue(form.value.repairModel),
      command: form.value.command,
      commitPrompt: form.value.commitPrompt,
      extraPrompt: form.value.extraPrompt,
      parallelTasks: form.value.parallelTasks,
      maxReviews: form.value.maxReviews,
      autoDeleteNormalSessions: form.value.autoDeleteNormalSessions,
      autoDeleteReviewSessions: form.value.autoDeleteReviewSessions,
      thinkingLevel: form.value.thinkingLevel,
      telegramNotificationsEnabled: form.value.telegramEnabled,
      telegramBotToken: form.value.telegramBotToken,
      telegramChatId: form.value.telegramChatId,
      showExecutionGraph: form.value.showExecutionGraph,
    })
    emit('close')
  } catch (e) {
    toasts.showToast('Options save failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
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
    <div class="modal w-[min(560px,calc(100vw-40px))]" style="max-height: calc(100vh - 40px);">
      <div class="modal-header">
        <h2>Options</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

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
          <select v-model="form.branch" class="form-select" :disabled="availableBranches.length === 0">
            <option value="" disabled v-if="availableBranches.length === 0">No branches available</option>
            <option v-for="branch in availableBranches" :key="branch" :value="branch">
              {{ branch }}
            </option>
          </select>
          <div v-if="availableBranches.length === 0 && !branchesError" class="text-xs text-dark-text-muted mt-1">
            Loading branches...
          </div>
        </div>

        <!-- Models -->
        <div class="grid grid-cols-2 gap-3">
          <ModelPicker
            v-model="form.planModel"
            label="Plan Model (global)"
            help="Default planning model for new tasks. Individual tasks can override this value."
          />
          <ModelPicker
            v-model="form.executionModel"
            label="Execution Model (global)"
            help="Default execution model for new tasks. Individual tasks can override this value."
          />
        </div>

        <ModelPicker
          v-model="form.reviewModel"
          label="Review Model"
          help="Model used by the workflow-review agent. This is stored in the database and used for all review operations."
        />

        <ModelPicker
          v-model="form.repairModel"
          label="Repair Model"
          help="Model used by the workflow-repair agent for state repair analysis."
        />

        <!-- Thinking Level -->
        <div class="form-group">
          <div class="label-row">
            <label>Thinking Level (global default)</label>
            <span class="help-btn" title="Default reasoning effort for new tasks. Higher levels are better for harder work but can be slower.">?</span>
          </div>
          <select v-model="form.thinkingLevel" class="form-select">
            <option value="default">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <!-- Pre-execution Command -->
        <div class="form-group">
          <div class="label-row">
            <label>Pre-execution Command</label>
            <span class="help-btn" title="Command to run before task execution begins, such as installing dependencies or preparing the workspace.">?</span>
          </div>
          <input v-model="form.command" type="text" class="form-input" placeholder="e.g. npm install" />
        </div>

        <!-- Parallel Tasks -->
        <div class="form-group">
          <div class="label-row">
            <label>Parallel Tasks</label>
            <span class="help-btn" title="Maximum number of tasks the workflow should execute at the same time.">?</span>
          </div>
          <input v-model.number="form.parallelTasks" type="number" min="1" max="10" class="form-input" />
        </div>

        <!-- Max Reviews -->
        <div class="form-group">
          <div class="label-row">
            <label>Maximum Review Runs</label>
            <span class="help-btn" title="Maximum number of review cycles for a task before it gets stuck. Can be overridden per-task.">?</span>
          </div>
          <input v-model.number="form.maxReviews" type="number" min="1" max="10" class="form-input" />
        </div>

        <!-- Session Cleanup -->
        <div class="form-group">
          <div class="label-row">
            <label> Session Cleanup (global)</label>
            <span class="help-btn" title="Automatically delete Pi workflow sessions after task/review runs finish. Enable only if you do not need session history for debugging.">?</span>
          </div>
          <div class="checkbox-group">
            <label class="checkbox-item">
              <input v-model="form.autoDeleteNormalSessions" type="checkbox" />
              <span> Auto-delete normal sessions</span>
            </label>
            <label class="checkbox-item">
              <input v-model="form.autoDeleteReviewSessions" type="checkbox" />
              <span> Auto-delete review sessions</span>
            </label>
          </div>
        </div>

        <!-- Show Execution Graph -->
        <div class="form-group">
          <label class="checkbox-item">
            <input v-model="form.showExecutionGraph" type="checkbox" />
            <span>Show execution graph before starting workflow</span>
          </label>
        </div>

        <!-- Commit Prompt -->
        <div class="form-group">
          <div class="label-row">
            <label>Commit Prompt <span class="text-dark-text-muted font-normal">({{base_ref}} will be replaced at runtime)</span></label>
            <span class="help-btn" title="Instructions used when the workflow asks the agent to prepare a git commit. Use {{base_ref}} anywhere you want the current base branch inserted automatically.">?</span>
          </div>
          <textarea
            v-model="form.commitPrompt"
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
            v-model="form.extraPrompt"
            class="form-textarea font-mono text-xs"
            style="min-height: 100px;"
            placeholder="Additional context or instructions for all tasks..."
          />
        </div>

        <!-- Telegram Notifications -->
        <div class="form-group border border-dark-surface3 rounded-lg p-3">
          <div class="label-row">
            <label>Telegram Notifications</label>
            <span class="help-btn" title="Send a Telegram message when a task changes state. Leave both fields empty to disable notifications.">?</span>
          </div>
          <label class="checkbox-item mb-2">
            <input v-model="form.telegramEnabled" type="checkbox" />
            <span>Enable Telegram notifications</span>
          </label>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs text-dark-text-muted mb-1 block">Bot Token</label>
              <input v-model="form.telegramBotToken" type="password" class="form-input" placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxYZ" />
            </div>
            <div>
              <label class="text-xs text-dark-text-muted mb-1 block">Chat ID</label>
              <input v-model="form.telegramChatId" type="text" class="form-input" placeholder="-1001234567890 or @channel_name" />
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="isLoading" @click="save">
          {{ isLoading ? 'Saving...' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>
