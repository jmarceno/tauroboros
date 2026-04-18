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
    throw new Error(`Invalid toast variant: ${variant}. Expected one of: ${Object.keys(VARIANT_CLASSES).join(', ')}`)
  }
  return classes
}

export function ToastContainer({ toasts, bottomOffset, onRemove }: ToastContainerProps) {
  return (
    <div
      className="fixed right-4 z-[1100] flex flex-col gap-2"
      data-bottom-offset={bottomOffset}
      style={{ bottom: bottomOffset }}
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`px-4 py-3 rounded-lg shadow-lg border transition-all animate-slide-in ${getVariantClasses(toast.variant)}`}
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">{toast.message}</span>
            <button
              aria-label="Close toast notification"
              className="text-dark-text-muted hover:text-dark-text"
              onClick={() => onRemove(toast.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
