import { useEffect, useCallback, useMemo } from "react"

interface KeyboardOptions {
  onCreateTemplate?: () => void
  onCreateBacklog?: () => void
  onStartWorkflow?: () => void
  onArchiveDone?: () => void
  onTogglePlanningChat?: () => void
  onCreateGroup?: () => void
  onEscape?: () => boolean
  onCloseGroupPanel?: () => void
  onSwitchTab?: (tabIndex: number) => void
  isModalOpen?: () => boolean
  isEditableFocused?: () => boolean
  isGroupPanelOpen?: () => boolean
  selectedCount?: () => number
  /** Whether the kanban board is the active tab - workflow shortcuts only work when true */
  isKanbanActive?: () => boolean
}

export type { KeyboardOptions }

export function useKeyboard(options: KeyboardOptions) {
  const isEditableControlFocused = useCallback((): boolean => {
    const active = document.activeElement
    if (!active) return false

    const tag = active.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (active.isContentEditable) return true

    const shadowRoot = (active as HTMLElement).shadowRoot
    if (shadowRoot) {
      const inner = shadowRoot.activeElement
      if (inner) {
        const innerTag = inner.tagName
        if (innerTag === 'INPUT' || innerTag === 'TEXTAREA' || innerTag === 'SELECT') return true
        if (inner.isContentEditable) return true
      }
    }

    return false
  }, [])

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Priority 1: Close group panel if open
        if (options.isGroupPanelOpen?.()) {
          options.onCloseGroupPanel?.()
          e.preventDefault()
          return
        }
        // Priority 2: Call generic escape handler (for modals)
        if (options.onEscape) {
          const closed = options.onEscape()
          if (closed) {
            e.preventDefault()
          }
        }
        return
      }

      // Skip when modals are open or editable controls are focused
      if (options.isModalOpen?.()) return
      if (isEditableControlFocused()) return
      if (options.isEditableFocused?.()) return

      // Ctrl+G: Create group (requires 2+ tasks selected)
      if ((e.ctrlKey || e.metaKey) && e.key.toUpperCase() === 'G') {
        const count = options.selectedCount?.() ?? 0
        if (count >= 2) {
          e.preventDefault()
          options.onCreateGroup?.()
        }
        return
      }

      // Handle Ctrl+1-5 for tab switching before skipping other modifier shortcuts
      if ((e.ctrlKey || e.metaKey) && /^[1-5]$/.test(e.key)) {
        e.preventDefault()
        const tabIndex = parseInt(e.key, 10)
        options.onSwitchTab?.(tabIndex)
        return
      }

      // Skip other shortcuts when modifier keys are held
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key.toUpperCase()

      // Check if kanban is active for workflow-related shortcuts
      const isKanbanActive = options.isKanbanActive?.() ?? true

      switch (key) {
        case 'T':
          if (!isKanbanActive) return
          e.preventDefault()
          options.onCreateTemplate?.()
          break
        case 'B':
          if (!isKanbanActive) return
          e.preventDefault()
          options.onCreateBacklog?.()
          break
        case 'S':
          if (!isKanbanActive) return
          e.preventDefault()
          options.onStartWorkflow?.()
          break
        case 'D':
          if (!isKanbanActive) return
          e.preventDefault()
          options.onArchiveDone?.()
          break
        case 'P':
          // Planning chat can work on any tab
          e.preventDefault()
          options.onTogglePlanningChat?.()
          break
      }
    }

    document.addEventListener('keydown', handleKeydown)
    return () => {
      document.removeEventListener('keydown', handleKeydown)
    }
  }, [options, isEditableControlFocused])

  const contextValue = useMemo(() => ({
    isEditableControlFocused,
  }), [isEditableControlFocused])

  return contextValue
}
