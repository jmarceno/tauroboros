<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  isOpen: boolean
  runName?: string
  isStopping?: boolean
}>()

const emit = defineEmits<{
  close: []
  confirmGraceful: []
  confirmDestructive: []
}>()

const isVisible = computed(() => props.isOpen)
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isVisible" class="modal-overlay" @click.self="emit('close')">
        <div class="modal-container" @click.stop>
          <div class="modal-header">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full bg-accent-warning/10 flex items-center justify-center">
                <svg class="w-5 h-5 text-accent-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <div>
                <h3 class="modal-title text-lg font-semibold text-dark-text">Stop Workflow</h3>
                <p class="text-sm text-dark-text-secondary mt-0.5">
                  {{ runName || 'Current workflow run' }}
                </p>
              </div>
            </div>
          </div>

          <div class="modal-body">
            <div class="bg-accent-warning/5 border border-accent-warning/20 rounded-lg p-4 mb-6">
              <div class="flex items-start gap-3">
                <svg class="w-5 h-5 text-accent-warning flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <div class="text-sm text-dark-text">
                  <p class="font-medium text-accent-warning mb-1">Are you sure you want to stop this workflow?</p>
                  <p class="text-dark-text-secondary">
                    Choose how you want to stop the workflow. The destructive option will lose any uncommitted work.
                  </p>
                </div>
              </div>
            </div>

            <div class="options-grid">
              <!-- Graceful Stop -->
              <button
                class="option-btn graceful"
                :disabled="isStopping"
                @click="emit('confirmGraceful')"
              >
                <div class="option-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="6" y="4" width="4" height="16"/>
                    <rect x="14" y="4" width="4" height="16"/>
                  </svg>
                </div>
                <div class="option-content">
                  <div class="option-title">Pause & Stop Gracefully</div>
                  <div class="option-desc">
                    Stop after current task completes. Work is preserved and can be resumed.
                  </div>
                </div>
              </button>

              <!-- Destructive Stop -->
              <button
                class="option-btn destructive"
                :disabled="isStopping"
                @click="emit('confirmDestructive')"
              >
                <div class="option-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    <line x1="10" y1="11" x2="10" y2="17"/>
                    <line x1="14" y1="11" x2="14" y2="17"/>
                  </svg>
                </div>
                <div class="option-content">
                  <div class="option-title">Stop & Delete Everything</div>
                  <div class="option-desc">
                    <span class="text-accent-danger font-medium">Danger:</span> Kills all agents, deletes containers & worktrees immediately. All work is lost.
                  </div>
                </div>
              </button>
            </div>
          </div>

          <div class="modal-footer">
            <button
              class="btn"
              :disabled="isStopping"
              @click="emit('close')"
            >
              Cancel
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
  max-width: 560px;
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

.options-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.option-btn {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem;
  background: theme('colors.dark.bg');
  border: 2px solid theme('colors.dark.border');
  border-radius: 0.5rem;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}

.option-btn:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.1);
}

.option-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.option-btn.graceful:hover:not(:disabled) {
  border-color: theme('colors.accent.success');
  background: rgba(0, 255, 136, 0.05);
}

.option-btn.destructive {
  border-color: theme('colors.accent.danger');
}

.option-btn.destructive:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.1);
}

.option-icon {
  width: 20px;
  height: 20px;
  color: theme('colors.dark.text-muted');
  flex-shrink: 0;
}

.option-btn.graceful .option-icon {
  color: theme('colors.accent.success');
}

.option-btn.destructive .option-icon {
  color: theme('colors.accent.danger');
}

.option-title {
  font-weight: 600;
  color: theme('colors.dark.text');
  margin-bottom: 0.25rem;
}

.option-desc {
  font-size: 0.75rem;
  color: theme('colors.dark.text-secondary');
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
