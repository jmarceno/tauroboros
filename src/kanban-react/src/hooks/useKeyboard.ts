import { useEffect, useCallback } from "react"

interface KeyboardOptions {
  onCreateTemplate?: () => void
  onCreateBacklog?: () => void
  onStartWorkflow?: () => void
  onArchiveDone?: () => void
  onTogglePlanningChat?: () => void
  onCreateGroup?: () => void
  onEscape?: () => boolean
  isModalOpen?: () => boolean
  isEditableFocused?: () => boolean
}

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
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key.toUpperCase()

      switch (key) {
        case 'T':
          e.preventDefault()
          options.onCreateTemplate?.()
          break
        case 'B':
          e.preventDefault()
          options.onCreateBacklog?.()
          break
        case 'S':
          e.preventDefault()
          options.onStartWorkflow?.()
          break
        case 'D':
          e.preventDefault()
          options.onArchiveDone?.()
          break
        case 'P':
          e.preventDefault()
          options.onTogglePlanningChat?.()
          break
        case 'G':
          e.preventDefault()
          options.onCreateGroup?.()
          break
      }
    }

    document.addEventListener('keydown', handleKeydown)
    return () => {
      document.removeEventListener('keydown', handleKeydown)
    }
  }, [options, isEditableControlFocused])

  return {
    isEditableControlFocused,
  }
}
