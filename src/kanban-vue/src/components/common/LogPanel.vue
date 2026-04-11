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
      'border-t border-dark-surface3 bg-dark-surface flex flex-col transition-all duration-200',
      collapsed ? 'h-auto' : 'h-44 min-h-[120px]'
    ]"
  >
    <div
      class="px-3.5 py-2 text-xs font-semibold text-dark-text-muted border-b border-dark-surface3 uppercase tracking-wider flex items-center justify-between cursor-pointer select-none"
      @click="collapsed = !collapsed"
    >
      <span>Event Log</span>
      <div class="flex items-center gap-2">
        <button
          class="bg-transparent border-0 text-dark-text-muted cursor-pointer p-1 hover:text-dark-text"
          @click.stop="collapsed = !collapsed"
        >
          {{ collapsed ? '▼' : '▲' }}
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
          log.variant === 'info' && 'text-dark-text-muted',
          log.variant === 'success' && 'text-green-400',
          log.variant === 'error' && 'text-red-400'
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
