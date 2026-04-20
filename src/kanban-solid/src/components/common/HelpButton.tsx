/**
 * HelpButton Component - Help tooltip button
 * Ported from React to SolidJS
 */

import { Show, createSignal, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'

interface HelpButtonProps {
  tooltip: string
  'aria-label'?: string
}

export function HelpButton(props: HelpButtonProps) {
  const [visible, setVisible] = createSignal(false)
  const [position, setPosition] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 })

  let anchorRef: HTMLSpanElement | undefined

  const updatePosition = () => {
    if (!anchorRef) return
    const rect = anchorRef.getBoundingClientRect()
    setPosition({
      top: rect.top - 8,
      left: rect.left + rect.width / 2,
    })
  }

  const showTooltip = () => {
    updatePosition()
    setVisible(true)
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
  }

  const hideTooltip = () => {
    setVisible(false)
    window.removeEventListener('scroll', updatePosition, true)
    window.removeEventListener('resize', updatePosition)
  }

  onCleanup(() => {
    window.removeEventListener('scroll', updatePosition, true)
    window.removeEventListener('resize', updatePosition)
  })

  return (
    <span class="tooltip-container" ref={anchorRef}>
      <span
        class="help-btn"
        aria-label={props['aria-label']}
        role="button"
        tabIndex={0}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        ?
      </span>
      <Show when={visible()}>
        <Portal>
          <span
            class="tooltip"
            style={{
              top: `${position().top}px`,
              left: `${position().left}px`,
              transform: 'translate(-50%, -100%)',
            }}
          >
            {props.tooltip}
          </span>
        </Portal>
      </Show>
    </span>
  )
}
