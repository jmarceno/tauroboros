<script setup lang="ts">
const emit = defineEmits<{
  openOptions: []
  openContainerConfig: []
}>()
</script>

<template>
  <div class="top-bar">
    <!-- Left: Breadcrumb -->
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2 text-sm text-dark-text-secondary">
        <div class="flex items-center gap-2">
          <span>Project</span>
        </div>
        <span class="text-dark-text-muted">/</span>
        <div class="flex items-center gap-2">
          <span class="text-dark-text font-medium">Pi Easy Workflow</span>
        </div>
      </div>
    </div>

    <!-- Right: Actions -->
    <div class="flex items-center gap-3">
      <!-- Keyboard shortcuts hint -->
      <div class="hidden md:flex items-center gap-3 text-xs text-dark-text-muted">
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">T</kbd>
          Template
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">B</kbd>
          Task
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">P</kbd>
          Chat
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">Esc</kbd>
          Close
        </span>
      </div>

      <div class="h-4 w-px bg-dark-border" />

      <!-- Action buttons -->
      <button class="icon-btn" title="Search" @click="emit('openOptions')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <path d="M21 21l-4.35-4.35"/>
        </svg>
      </button>

      <button class="icon-btn" title="Settings" @click="emit('openContainerConfig')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v6m0 6v6m4.22-10.22l4.24-4.24M6.34 17.66l-4.24 4.24M23 12h-6m-6 0H1m20.24 4.24l-4.24-4.24M6.34 6.34L2.1 2.1"/>
        </svg>
      </button>
    </div>
  </div>
</template>
