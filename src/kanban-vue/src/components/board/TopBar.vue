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
  <div class="flex items-center justify-center gap-4 px-6 py-3 bg-dark-bg/80 backdrop-blur-md border-b border-dark-surface3 sticky top-0 z-40">
    <button
      :class="[
        'btn font-semibold',
        isRunning 
          ? 'bg-accent-danger/80 border-accent-danger/50 hover:bg-accent-danger text-white' 
          : 'bg-accent-success/80 border-accent-success/50 hover:bg-accent-success text-white'
      ]"
      @click="emit('toggleExecution')"
    >
      {{ isRunning ? 'Stop Workflow' : `Start Workflow (${consumedSlots ?? 0}/${parallelTasks ?? 1})` }}
    </button>

    <div class="flex flex-col items-center gap-1 min-w-[240px]">
      <h1 class="text-lg font-semibold inline-flex items-center gap-2 text-dark-text">
        <span>Easy Workflow Kanban</span>
        <span
          :class="[
            'w-2 h-2 rounded-full',
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
      <button class="btn bg-dark-surface2 border-dark-surface3 text-dark-text hover:bg-dark-surface" @click="emit('openOptions')">
        Options
      </button>
    </div>
  </div>
</template>
