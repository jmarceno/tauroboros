<script setup lang="ts">
import { ref, computed, inject } from 'vue'
import type { useTasks } from '@/composables/useTasks'
import type { useToasts } from '@/composables/useToasts'

const props = defineProps<{
  taskId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const tasks = inject<ReturnType<typeof useTasks>>('tasks')!
const toasts = inject<ReturnType<typeof useToasts>>('toasts')!

const feedback = ref('')
const isLoading = ref(false)

const task = computed(() => tasks.getTaskById(props.taskId))
const taskName = computed(() => task.value?.name || props.taskId)

const confirm = async () => {
  if (!feedback.value.trim()) {
    toasts.showToast('Feedback cannot be empty', 'error')
    return
  }

  isLoading.value = true
  try {
    await tasks.requestPlanRevision(props.taskId, feedback.value.trim())
    toasts.showToast('Revision requested', 'success')
    emit('close')
  } catch (e) {
    toasts.showToast('Request revision failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
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
    <div class="modal w-[440px]">
      <div class="modal-header">
        <h2>Request Plan Changes</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="mb-3 text-sm">{{ taskName }}</div>
        <label class="block text-sm text-dark-text-muted mb-1.5">
          What should be changed?
        </label>
        <textarea
          v-model="feedback"
          rows="4"
          class="form-textarea"
          placeholder="Describe the changes you want in the plan..."
        />
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button
          class="btn"
          style="border-color: #f59e0b; color: #f59e0b;"
          :disabled="isLoading"
          @click="confirm"
        >
          {{ isLoading ? 'Sending...' : 'Send Feedback' }}
        </button>
      </div>
    </div>
  </div>
</template>
