import { ref } from 'vue'

type ToastVariant = 'info' | 'success' | 'error'

interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

interface LogEntry {
  ts: string
  message: string
  variant: ToastVariant
}

export function useToasts() {
  const toasts = ref<Toast[]>([])
  const logs = ref<LogEntry[]>([])
  let nextId = 1

  const MAX_LOG_ENTRIES = 500

  const addLog = (message: string, variant: ToastVariant = 'info') => {
    const ts = new Date().toLocaleTimeString()
    logs.value.push({ ts, message, variant })
    if (logs.value.length > MAX_LOG_ENTRIES) {
      logs.value = logs.value.slice(-MAX_LOG_ENTRIES)
    }
  }

  const showToast = (message: string, variant: ToastVariant = 'info', duration = 5000) => {
    addLog(message, variant)

    const toast: Toast = {
      id: nextId++,
      message,
      variant,
    }
    toasts.value.push(toast)

    if (duration > 0) {
      setTimeout(() => {
        removeToast(toast.id)
      }, duration)
    }

    return toast.id
  }

  const removeToast = (id: number) => {
    const idx = toasts.value.findIndex(t => t.id === id)
    if (idx >= 0) {
      toasts.value.splice(idx, 1)
    }
  }

  const clearLogs = () => {
    logs.value = []
  }

  return {
    toasts,
    logs,
    showToast,
    removeToast,
    addLog,
    clearLogs,
  }
}
