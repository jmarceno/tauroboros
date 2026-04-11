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

const isLoading = ref(false)

const task = computed(() => tasks.getTaskById(props.taskId))
const taskName = computed(() => task.value?.name || props.taskId)

const dependencyNames = computed(() => {
  if (!task.value) return []
  const depIds = task.value.requirements.filter(depId => {
    const depTask = tasks.getTaskById(depId)
    return depTask && (depTask.status === 'backlog' || depTask.executionPhase === 'implementation_pending' || depTask.executionPhase === 'plan_revision_pending')
  })
  return depIds.map(id => tasks.getTaskName(id)).filter(Boolean)
})

const confirm = async () => {
  isLoading.value = true
  try {
    await tasks.startSingleTask(props.taskId)
    toasts.showToast('Task started', 'success')
    emit('close')
  } catch (e) {
    toasts.showToast('Start task failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
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
        <h2>Start Single Task</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="mb-3 text-sm">
          Start "{{ taskName }}" and its dependency chain?
        </div>
        <div class="text-sm text-dark-text-muted">
          <template v-if="dependencyNames.length > 0">
            Dependencies to run: {{ dependencyNames.join(', ') }}
          </template>
          <template v-else>
            No dependencies to run.
          </template>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="isLoading" @click="confirm">
          {{ isLoading ? 'Starting...' : 'Start Task' }}
        </button>
      </div>
    </div>
  </div>
</template>
