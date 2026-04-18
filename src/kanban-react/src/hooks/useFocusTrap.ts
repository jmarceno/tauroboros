import { useEffect, useRef, useCallback, useMemo } from 'react'

interface FocusTrapOptions {
  isActive: boolean
  containerRef: React.RefObject<HTMLElement | null>
  restoreFocusTo?: HTMLElement | null
  onEscape?: () => void
}

/**
 * Hook to trap focus within a container when active.
 * Focus is trapped to focusable elements (button, input, etc.)
 * and cycles within the container.
 */
export function useFocusTrap({
  isActive,
  containerRef,
  restoreFocusTo,
  onEscape,
}: FocusTrapOptions) {
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && isActive) {
      e.preventDefault()
      onEscape?.()
    }
  }, [isActive, onEscape])

  useEffect(() => {
    if (!isActive) return

    const container = containerRef.current
    if (!container) return

    // Store current focus element
    previousFocusRef.current = document.activeElement as HTMLElement

    // Find focusable elements
    const focusableSelectors = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ')

    const focusableElements = Array.from(
      container.querySelectorAll<HTMLElement>(focusableSelectors)
    ).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null)

    if (focusableElements.length === 0) return

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]

    // Focus first element
    firstElement.focus()

    // Handle tab key to cycle focus within container
    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return

      if (e.shiftKey) {
        // Shift+Tab: go to previous element
        if (document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        }
      } else {
        // Tab: go to next element
        if (document.activeElement === lastElement) {
          e.preventDefault()
          firstElement.focus()
        }
      }
    }

    // Handle Escape key
    container.addEventListener('keydown', handleTabKey)
    container.addEventListener('keydown', handleEscape)

    return () => {
      container.removeEventListener('keydown', handleTabKey)
      container.removeEventListener('keydown', handleEscape)

      // Restore focus to previous element or specified element
      const elementToFocus = restoreFocusTo || previousFocusRef.current
      if (elementToFocus && document.contains(elementToFocus)) {
        elementToFocus.focus()
      }
    }
  }, [isActive, containerRef, restoreFocusTo, handleEscape])

  const contextValue = useMemo(() => ({
    previousFocusRef,
  }), [previousFocusRef])

  return contextValue
}
