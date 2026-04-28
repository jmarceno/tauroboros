/**
 * ToastContainer Component - Toast notifications
 * Ported from React to SolidJS - Full feature parity
 */

import { For } from 'solid-js'
import type { Toast, ToastVariant } from '@/types'

interface ToastContainerProps {
  toasts: Toast[]
  bottomOffset: number
  onRemove: (id: number) => void
}

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  error: 'bg-accent-danger/20 border-accent-danger text-accent-danger',
  success: 'bg-accent-success/20 border-accent-success text-accent-success',
  info: 'bg-dark-surface2 border-dark-border text-dark-text',
}

function getVariantClasses(variant: ToastVariant): string {
  const classes = VARIANT_CLASSES[variant]
  if (!classes) {
    // Invalid variant - fallback to info style
    return VARIANT_CLASSES.info
  }
  return classes
}

export function ToastContainer(props: ToastContainerProps) {
  return (
    <div
      class="fixed right-4 z-[1100] flex flex-col gap-2"
      data-bottom-offset={props.bottomOffset}
      style={{ bottom: `${props.bottomOffset}px` }}
    >
      <For each={props.toasts}>
        {(toast) => (
          <div
            class={`px-4 py-3 rounded-lg shadow-lg border transition-all animate-slide-in ${getVariantClasses(toast.variant)}`}
          >
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm">{toast.message}</span>
              <button
                aria-label="Close toast notification"
                class="text-dark-text-muted hover:text-dark-text"
                onClick={() => props.onRemove(toast.id)}
              >
                ×
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
