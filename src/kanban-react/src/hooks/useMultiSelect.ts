import { useState, useCallback, useMemo } from "react"

export type MultiSelectMode = "batch-edit" | "create-group" | null

export function useMultiSelect() {
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<MultiSelectMode>(null)

  const isSelecting = useMemo(() => selectedTaskIds.size > 0, [selectedTaskIds])
  const selectedCount = useMemo(() => selectedTaskIds.size, [selectedTaskIds])

  const toggleSelection = useCallback((taskId: string, event: React.MouseEvent): boolean => {
    // Allow direct toggling without Ctrl if in create-group mode
    const isModifierHeld = event.ctrlKey || event.metaKey
    const canToggle = isModifierHeld || mode === 'create-group'

    if (!canToggle) {
      return false
    }

    setSelectedTaskIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(taskId)) {
        newSet.delete(taskId)
      } else {
        newSet.add(taskId)
      }
      return newSet
    })
    return true
  }, [mode])

  const selectSingle = useCallback((taskId: string) => {
    setSelectedTaskIds(new Set([taskId]))
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedTaskIds(new Set())
    setMode(null)
  }, [])

  const isSelected = useCallback((taskId: string): boolean => {
    return selectedTaskIds.has(taskId)
  }, [selectedTaskIds])

  const getSelectedIds = useCallback((): string[] => {
    return Array.from(selectedTaskIds)
  }, [selectedTaskIds])

  const startGroupCreation = useCallback((): boolean => {
    if (selectedTaskIds.size < 2) return false
    setMode('create-group')
    return true
  }, [selectedTaskIds.size])

  const confirmGroupCreation = useCallback((): string[] => {
    const ids = Array.from(selectedTaskIds)
    setMode(null)
    setSelectedTaskIds(new Set())
    return ids
  }, [selectedTaskIds])

  const cancelGroupCreation = useCallback((): void => {
    setMode(null)
  }, [])

  return {
    // Existing exports (unchanged)
    selectedTaskIds,
    isSelecting,
    selectedCount,
    toggleSelection,
    selectSingle,
    clearSelection,
    isSelected,
    getSelectedIds,

    // New exports
    mode,
    startGroupCreation,
    confirmGroupCreation,
    cancelGroupCreation,
  }
}
