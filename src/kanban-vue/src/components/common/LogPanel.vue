<script setup lang="ts">
const props = defineProps<{
  logs: { ts: string; message: string; variant: 'info' | 'success' | 'error' }[]
}>()

const collapsed = defineModel<boolean>('collapsed', { default: true })

const emit = defineEmits<{
  clear: []
}>()

const toggleIcon = collapsed.value ? '▼' : '▲'
</script>

<template>
  <div
    :class="[
      'border-t border-dark-border bg-dark-surface flex flex-col transition-all duration-200 shrink-0',
      collapsed ? 'h-auto' : 'h-44 min-h-[120px]'
    ]"
  >
    <div
      class="px-3.5 py-2 text-xs font-semibold text-dark-text-secondary border-b border-dark-border uppercase tracking-wider flex items-center justify-between cursor-pointer select-none"
      @click="collapsed = !collapsed"
    >
      <span>Event Log</span>
      <div class="flex items-center gap-2">
        <button
          class="bg-transparent border-0 text-dark-text-secondary cursor-pointer p-1 hover:text-dark-text"
          @click.stop="collapsed = !collapsed"
        >
          <svg v-if="collapsed" class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 9l-7 7-7-7"/>
          </svg>
          <svg v-else class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 15l7-7 7 7"/>
          </svg>
        </button>
        <button class="btn btn-sm" @click.stop="emit('clear')">Clear</button>
      </div>
    </div>
    <div
      v-if="!collapsed"
      ref="logBody"
      class="flex-1 overflow-y-auto px-3.5 py-2 font-mono text-xs leading-relaxed"
    >
      <div
        v-for="(log, idx) in logs"
        :key="idx"
        :class="[
          'mb-1',
          log.variant === 'info' && 'text-dark-text-secondary',
          log.variant === 'success' && 'text-accent-success',
          log.variant === 'error' && 'text-accent-danger'
        ]"
      >
        [{{ log.ts }}] {{ log.message }}
      </div>
      <div v-if="logs.length === 0" class="text-dark-text-muted italic">
        No events yet...
      </div>
    </div>
  </div>
</template>
