<script setup lang="ts">
import { ref, computed } from 'vue'

type ConfirmAction = 'delete' | 'convertToTemplate'

const props = defineProps<{
  isOpen: boolean
  action: ConfirmAction
  taskName?: string
}>()

const emit = defineEmits<{
  close: []
  confirm: []
}>()

const isVisible = computed(() => props.isOpen)

const config = computed(() => {
  switch (props.action) {
    case 'delete':
      return {
        title: 'Delete Task',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          <line x1="10" y1="11" x2="10" y2="17"/>
          <line x1="14" y1="11" x2="14" y2="17"/>
        </svg>`,
        iconColor: 'text-accent-danger',
        bgColor: 'bg-accent-danger/20',
        message: `Are you sure you want to delete "${props.taskName || 'this task'}"?`,
        description: 'This action cannot be undone. The task will be permanently removed.',
        confirmText: 'Delete',
        confirmClass: 'btn-danger'
      }
    case 'convertToTemplate':
      return {
        title: 'Convert to Template',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>`,
        iconColor: 'text-accent-primary',
        bgColor: 'bg-accent-primary/20',
        message: `Convert "${props.taskName || 'this task'}" to template?`,
        description: 'The task will be moved to the Templates column and can be deployed to backlog later.',
        confirmText: 'Convert',
        confirmClass: 'btn-primary'
      }
    default:
      return {
        title: 'Confirm',
        icon: '',
        iconColor: '',
        bgColor: '',
        message: 'Are you sure?',
        description: '',
        confirmText: 'Confirm',
        confirmClass: 'btn-primary'
      }
  }
})

const handleConfirm = () => {
  emit('confirm')
}

const handleClose = () => {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isVisible" class="modal-overlay" @click.self="handleClose">
        <div class="modal-container" @click.stop>
          <div class="modal-header">
            <div class="flex items-center gap-3">
              <div v-if="config.icon" :class="['w-10 h-10 rounded-full flex items-center justify-center', config.bgColor]">
                <div :class="['w-5 h-5', config.iconColor]" v-html="config.icon" />
              </div>
              <h3 class="modal-title text-lg font-semibold text-dark-text">{{ config.title }}</h3>
            </div>
          </div>

          <div class="modal-body">
            <p class="text-dark-text mb-2">{{ config.message }}</p>
            <p class="text-sm text-dark-text-secondary">{{ config.description }}</p>
            <p class="text-xs text-dark-text-muted mt-4">
              Tip: Hold Ctrl and click the action button to skip this confirmation in the future.
            </p>
          </div>

          <div class="modal-footer">
            <button class="btn" @click="handleClose">Cancel</button>
            <button :class="['btn', config.confirmClass]" @click="handleConfirm">
              {{ config.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.modal-container {
  background: theme('colors.dark.surface');
  border: 1px solid theme('colors.dark.border');
  border-radius: 0.75rem;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.modal-header {
  padding: 1.25rem;
  border-bottom: 1px solid theme('colors.dark.border');
}

.modal-title {
  color: theme('colors.dark.text');
}

.modal-body {
  padding: 1.25rem;
  max-height: 70vh;
  overflow-y: auto;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid theme('colors.dark.border');
  background: rgba(255, 255, 255, 0.02);
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  transition: all 0.15s ease;
  border: 1px solid theme('colors.dark.border');
  background: transparent;
  color: theme('colors.dark.text');
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: theme('colors.accent.primary');
  border-color: theme('colors.accent.primary');
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: theme('colors.accent.secondary');
  border-color: theme('colors.accent.secondary');
}

.btn-danger {
  background: theme('colors.accent.danger');
  border-color: theme('colors.accent.danger');
  color: white;
}

.btn-danger:hover:not(:disabled) {
  background: #ff5252;
  border-color: #ff5252;
}

/* Modal transitions */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-active .modal-container,
.modal-leave-active .modal-container {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  opacity: 0;
  transform: scale(0.95);
}
</style>
