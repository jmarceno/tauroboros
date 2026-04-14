<script setup lang="ts">
// No emits needed - all functionality available in sidebar
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

    </div>
  </div>
</template>
