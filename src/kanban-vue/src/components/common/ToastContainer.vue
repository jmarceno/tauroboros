<script setup lang="ts">
const props = defineProps<{
  toasts: { id: number; message: string; variant: 'info' | 'success' | 'error' }[]
  bottomOffset: number
}>()

const emit = defineEmits<{
  remove: [id: number]
}>()

const variantClasses: Record<string, string> = {
  info: 'bg-accent-primary text-white',
  success: 'bg-accent-success text-white',
  error: 'bg-accent-danger text-white',
}
</script>

<template>
  <div
    class="fixed right-4 z-50 flex flex-col gap-2"
    :style="{ bottom: bottomOffset + 'px' }"
  >
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :class="[
          'px-4 py-2.5 rounded-lg text-sm shadow-lg cursor-pointer',
          variantClasses[toast.variant]
        ]"
        @click="emit('remove', toast.id)"
      >
        {{ toast.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
