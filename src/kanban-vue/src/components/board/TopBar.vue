<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  consumedSlots: number
  parallelTasks: number
  isConnected: boolean
}>()

const emit = defineEmits<{
  toggleExecution: []
  openOptions: []
}>()

const isRunning = computed(() => props.consumedSlots > 0)
</script>

<template>
  <div class="flex items-center justify-center gap-4 px-6 py-3 bg-dark-surface border-b border-dark-surface3 sticky top-0 z-40">
    <button
      :class="[
        'btn btn-primary font-semibold',
        isRunning ? 'bg-accent-danger border-accent-danger hover:bg-red-600' : ''
      ]"
      @click="emit('toggleExecution')"
    >
      {{ isRunning ? 'Stop Workflow' : `Start Workflow (${consumedSlots}/${parallelTasks})` }}
    </button>

    <div class="flex flex-col items-center gap-1 min-w-[240px]">
      <h1 class="text-lg font-semibold inline-flex items-center gap-2">
        <span>Easy Workflow Kanban</span>
        <span
          :class="[
            'w-2 h-2 rounded-full shadow-[0_0_0_3px_rgba(139,148,158,0.12)]',
            isConnected ? 'bg-accent-success' : 'bg-accent-danger'
          ]"
          :title="isConnected ? 'Connected' : 'Disconnected'"
        />
      </h1>
      <div class="flex flex-wrap justify-center gap-2 text-dark-text-muted text-xs">
        <span class="inline-flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-surface3 rounded px-1 bg-dark-surface2">T</kbd>
          Create template
        </span>
        <span class="inline-flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-surface3 rounded px-1 bg-dark-surface2">B</kbd>
          Create backlog task
        </span>
        <span class="inline-flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-surface3 rounded px-1 bg-dark-surface2">S</kbd>
          Start workflow
        </span>
        <span class="inline-flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-surface3 rounded px-1 bg-dark-surface2">D</kbd>
          Archive all done
        </span>
      </div>
    </div>

    <div class="flex items-center gap-3 flex-wrap justify-end">
      <button class="btn bg-gray-300 border-gray-400 text-gray-900 hover:bg-gray-400" @click="emit('openOptions')">
        Options
      </button>
    </div>
  </div>
</template>
