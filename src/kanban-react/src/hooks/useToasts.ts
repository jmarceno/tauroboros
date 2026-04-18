import { useState, useCallback, useRef } from "react"
import type { Toast, ToastVariant, LogEntry } from "@/types"

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const nextIdRef = useRef(1)

  const MAX_LOG_ENTRIES = 500

  const addLog = useCallback((message: string, variant: ToastVariant = 'info') => {
    const ts = new Date().toLocaleTimeString()
    setLogs(prev => {
      const newLogs = [...prev, { ts, message, variant }]
      if (newLogs.length > MAX_LOG_ENTRIES) {
        return newLogs.slice(-MAX_LOG_ENTRIES)
      }
      return newLogs
    })
  }, [])

  const showToast = useCallback((message: string, variant: ToastVariant = 'info', duration = 5000) => {
    addLog(message, variant)

    const id = nextIdRef.current++
    const toast: Toast = { id, message, variant }
    setToasts(prev => [...prev, toast])

    if (duration > 0) {
      setTimeout(() => {
        setToasts(curr => curr.filter(t => t.id !== id))
      }, duration)
    }

    return id
  }, [addLog])

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  return {
    toasts,
    logs,
    showToast,
    removeToast,
    addLog,
    clearLogs,
  }
}
