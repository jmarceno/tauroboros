import { ref, computed } from 'vue'

export function useMultiSelect() {
  const selectedTaskIds = ref<Set<string>>(new Set())

  const isSelecting = computed(() => selectedTaskIds.value.size > 0)
  const selectedCount = computed(() => selectedTaskIds.value.size)

  const toggleSelection = (taskId: string, event: MouseEvent): boolean => {
    // Only handle Ctrl/Cmd+click
    if (!event.ctrlKey && !event.metaKey) {
      return false
    }

    const newSet = new Set(selectedTaskIds.value)
    if (newSet.has(taskId)) {
      newSet.delete(taskId)
    } else {
      newSet.add(taskId)
    }
    selectedTaskIds.value = newSet
    return true
  }

  const selectSingle = (taskId: string) => {
    selectedTaskIds.value = new Set([taskId])
  }

  const clearSelection = () => {
    selectedTaskIds.value.clear()
  }

  const isSelected = (taskId: string): boolean => {
    return selectedTaskIds.value.has(taskId)
  }

  const getSelectedIds = (): string[] => {
    return Array.from(selectedTaskIds.value)
  }

  return {
    selectedTaskIds,
    isSelecting,
    selectedCount,
    toggleSelection,
    selectSingle,
    clearSelection,
    isSelected,
    getSelectedIds,
  }
}
