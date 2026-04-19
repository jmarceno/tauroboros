/**
 * Multi Select Store - Task multi-selection
 * Replaces: MultiSelectContext
 */

import { createSignal, createMemo } from 'solid-js'

export type MultiSelectMode = 'select' | 'create-group'

export function createMultiSelectStore() {
  const [selectedTaskIds, setSelectedTaskIds] = createSignal<Set<string>>(new Set())
  const [mode, setMode] = createSignal<MultiSelectMode>('select')

  const selectedCount = createMemo(() => selectedTaskIds().size)
  const isSelecting = createMemo(() => selectedCount() > 0)

  const isSelected = (taskId: string) => selectedTaskIds().has(taskId)

  const toggleSelection = (taskId: string, event: MouseEvent): boolean => {
    const ctrlOrMeta = event.ctrlKey || event.metaKey
    
    if (ctrlOrMeta) {
      setSelectedTaskIds(prev => {
        const next = new Set(prev)
        if (next.has(taskId)) {
          next.delete(taskId)
        } else {
          next.add(taskId)
        }
        return next
      })
      return true
    }
    return false
  }

  const selectSingle = (taskId: string) => {
    setSelectedTaskIds(new Set([taskId]))
  }

  const clearSelection = () => {
    setSelectedTaskIds(new Set())
    setMode('select')
  }

  const getSelectedIds = (): string[] => {
    return Array.from(selectedTaskIds())
  }

  const startGroupCreation = (): boolean => {
    if (selectedCount() >= 2) {
      setMode('create-group')
      return true
    }
    return false
  }

  const confirmGroupCreation = (): string[] => {
    const ids = getSelectedIds()
    clearSelection()
    return ids
  }

  const cancelGroupCreation = () => {
    setMode('select')
  }

  return {
    selectedTaskIds,
    selectedCount,
    isSelecting,
    mode,
    isSelected,
    toggleSelection,
    selectSingle,
    clearSelection,
    getSelectedIds,
    startGroupCreation,
    confirmGroupCreation,
    cancelGroupCreation,
  }
}
