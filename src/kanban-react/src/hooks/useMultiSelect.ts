import { useState, useCallback, useMemo } from 'react'

export function useMultiSelect() {
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())

  const isSelecting = useMemo(() => selectedTaskIds.size > 0, [selectedTaskIds])
  const selectedCount = useMemo(() => selectedTaskIds.size, [selectedTaskIds])

  const toggleSelection = useCallback((taskId: string, event: React.MouseEvent): boolean => {
    // Only handle Ctrl/Cmd+click
    if (!event.ctrlKey && !event.metaKey) {
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
  }, [])

  const selectSingle = useCallback((taskId: string) => {
    setSelectedTaskIds(new Set([taskId]))
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedTaskIds(new Set())
  }, [])

  const isSelected = useCallback((taskId: string): boolean => {
    return selectedTaskIds.has(taskId)
  }, [selectedTaskIds])

  const getSelectedIds = useCallback((): string[] => {
    return Array.from(selectedTaskIds)
  }, [selectedTaskIds])

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
