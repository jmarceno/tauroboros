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

const message = ref('')
const isLoading = ref(false)

const task = computed(() => tasks.getTaskById(props.taskId))
const taskName = computed(() => task.value?.name || props.taskId)

const confirm = async () => {
  isLoading.value = true
  try {
    await tasks.approvePlan(props.taskId, message.value.trim() || undefined)
    toasts.showToast('Plan approved', 'success')
    emit('close')
  } catch (e) {
    toasts.showToast('Approve plan failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
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
        <h2>Approve Plan</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="mb-3 text-sm">{{ taskName }}</div>
        <label class="block text-sm text-dark-text-muted mb-1.5">
          Message to agent (optional)
        </label>
        <textarea
          v-model="message"
          rows="3"
          class="form-textarea"
          placeholder="Add guidance or feedback for the agent..."
        />
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="isLoading" @click="confirm">
          {{ isLoading ? 'Approving...' : 'Approve and Run' }}
        </button>
      </div>
    </div>
  </div>
</template>
