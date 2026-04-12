<script setup lang="ts">
import type { ThinkingLevel } from '@/types/api'

const props = defineProps<{
  modelValue: ThinkingLevel
  label?: string
  help?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: ThinkingLevel]
}>()

const onChange = (e: Event) => {
  const target = e.target as HTMLSelectElement
  emit('update:modelValue', target.value as ThinkingLevel)
}
</script>

<template>
  <div class="form-group">
    <div v-if="label" class="label-row">
      <label>{{ label }}</label>
      <span v-if="help" class="help-btn" :title="help">?</span>
    </div>
    <select
      :value="modelValue"
      class="form-select"
      :disabled="disabled"
      @change="onChange"
    >
      <option value="default">Default</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
    </select>
  </div>
</template>
