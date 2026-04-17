import type { Toast } from '@/types'

interface ToastContainerProps {
  toasts: Toast[]
  bottomOffset: number
  onRemove: (id: number) => void
}

export function ToastContainer({ toasts, bottomOffset, onRemove }: ToastContainerProps) {
  return (
    <div
      className="fixed right-4 z-50 flex flex-col gap-2"
      style={{ bottom: bottomOffset }}
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`px-4 py-3 rounded-lg shadow-lg border transition-all animate-slide-in ${
            toast.variant === 'error' ? 'bg-accent-danger/20 border-accent-danger text-accent-danger' :
            toast.variant === 'success' ? 'bg-accent-success/20 border-accent-success text-accent-success' :
            'bg-dark-surface2 border-dark-border text-dark-text'
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">{toast.message}</span>
            <button
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
