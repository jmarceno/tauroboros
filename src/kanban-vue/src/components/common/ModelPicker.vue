<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { inject } from 'vue'
import type { useModelSearch } from '@/composables/useModelSearch'

const props = defineProps<{
  modelValue: string
  label: string
  help?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const modelSearch = inject<ReturnType<typeof useModelSearch>>('modelSearch')!

const query = ref(props.modelValue)
const showDropdown = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)

const suggestions = computed(() => {
  return modelSearch.getSuggestions(query.value, 12)
})

watch(() => props.modelValue, (val) => {
  query.value = val
})

const onInput = () => {
  showDropdown.value = true
}

const onFocus = () => {
  showDropdown.value = true
}

const onBlur = () => {
  // Delay to allow clicking on dropdown
  setTimeout(() => {
    showDropdown.value = false
    // Normalize value on blur and emit only
    // Let the parent update the prop, which will trigger the watcher to update query
    const normalized = modelSearch.normalizeValue(query.value)
    if (normalized !== props.modelValue) {
      emit('update:modelValue', normalized)
    }
  }, 200)
}

const selectOption = (value: string) => {
  query.value = value
  emit('update:modelValue', value)
  showDropdown.value = false
  inputRef.value?.blur()
}
</script>

<template>
  <div class="form-group">
    <div class="label-row">
      <label>{{ label }}</label>
      <span v-if="help" class="help-btn" :title="help">?</span>
    </div>
    <div class="relative">
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="form-input"
        placeholder="Type model name..."
        :disabled="disabled"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
      />
      <!-- Dropdown -->
      <div
        v-if="showDropdown && suggestions.length > 0"
        class="absolute top-full left-0 right-0 mt-1 bg-[#1a1a1a] border border-dark-surface3 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto"
      >
        <div
          v-for="suggestion in suggestions"
          :key="suggestion.value + '-' + suggestion.providerId"
          class="px-3 py-2 text-sm cursor-pointer hover:bg-accent-primary/10"
          @mousedown.prevent
          @click="selectOption(suggestion.value)"
        >
          <div class="font-medium">{{ suggestion.label }}</div>
          <div v-if="suggestion.providerName && suggestion.providerName !== 'default'" class="text-xs text-dark-text-muted">
            {{ suggestion.providerName }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
