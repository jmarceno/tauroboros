/**
 * UI Store - Modal, Toast, and UI state management
 * Replaces: ModalContext, ToastContext
 */

import { createSignal, createMemo, createRoot } from 'solid-js'
import { sleepMs } from '@/api'
import type { Toast, LogEntry, ToastVariant } from '@/types'

// Modal Types
export type ModalType = 'task' | 'executionGraph' | 'approve' | 'revision' | 'startSingle' | 'session' | 'taskSessions' | 'bestOfNDetail' | 'batchEdit'

const VALID_MODALS = new Set<ModalType>(['task', 'executionGraph', 'approve', 'revision', 'startSingle', 'session', 'taskSessions', 'bestOfNDetail', 'batchEdit'])

// Toast store
function createToastStore() {
  const [toasts, setToasts] = createSignal<Toast[]>([])
  const [logs, setLogs] = createSignal<LogEntry[]>([])
  let nextToastId = 1
  const toastTokens = new Map<number, number>()

  const showToast = (message: string, variant: ToastVariant = 'info', duration = 3000): number => {
    const id = nextToastId++
    const toast: Toast = { id, message, variant }
    setToasts(prev => [...prev, toast])
    
    // Add to logs
    const now = new Date()
    const ts = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    setLogs(prev => [...prev, { ts, message, variant }])
    
    // Auto-remove with token guard so manual removal cancels pending timer work.
    const token = (toastTokens.get(id) ?? 0) + 1
    toastTokens.set(id, token)
    sleepMs(duration)
      .then(() => {
        if (toastTokens.get(id) === token) {
          removeToast(id)
        }
      })
      .catch(() => undefined)
    return id
  }

  const removeToast = (id: number) => {
    toastTokens.delete(id)
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  const addLog = (message: string, variant: ToastVariant = 'info') => {
    const now = new Date()
    const ts = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    setLogs(prev => [...prev, { ts, message, variant }])
  }

  const clearLogs = () => {
    setLogs([])
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

// Modal store
function createModalStore() {
  const [activeModal, setActiveModal] = createSignal<ModalType | null>(null)
  const [modalData, setModalData] = createSignal<Record<string, unknown>>({})
  const [showStopConfirmModal, setShowStopConfirmModal] = createSignal(false)
  const [showConfirmModal, setShowConfirmModal] = createSignal(false)
  const [confirmModalAction, setConfirmModalAction] = createSignal<'delete' | 'archive' | 'convertToTemplate'>('delete')
  const [confirmModalTaskId, setConfirmModalTaskId] = createSignal<string | null>(null)
  const [confirmModalTaskName, setConfirmModalTaskName] = createSignal('')
  const [showGroupCreateModal, setShowGroupCreateModal] = createSignal(false)
  const [groupCreateModalData, setGroupCreateModalData] = createSignal<{ taskIds: string[]; defaultName?: string }>({ taskIds: [] })
  const [showRestoreModal, setShowRestoreModal] = createSignal(false)

  const isAnyModalOpen = createMemo(() => 
    activeModal() !== null || 
    showStopConfirmModal() || 
    showConfirmModal() || 
    showGroupCreateModal() || 
    showRestoreModal()
  )

  const openModal = (name: string, data?: Record<string, unknown>) => {
    if (!VALID_MODALS.has(name as ModalType)) {
      // Invalid modal name - ignore silently
      return
    }
    setActiveModal(name as ModalType)
    setModalData(data ?? {})
  }

  const closeModal = () => {
    setActiveModal(null)
    setModalData({})
  }

  const closeTopmostModal = (): boolean => {
    if (activeModal()) {
      closeModal()
      return true
    }
    if (showRestoreModal()) {
      setShowRestoreModal(false)
      return true
    }
    if (showStopConfirmModal()) {
      setShowStopConfirmModal(false)
      return true
    }
    if (showConfirmModal()) {
      setShowConfirmModal(false)
      setConfirmModalTaskId(null)
      return true
    }
    if (showGroupCreateModal()) {
      setShowGroupCreateModal(false)
      return true
    }
    return false
  }

  return {
    activeModal,
    modalData,
    setModalData,
    showStopConfirmModal,
    setShowStopConfirmModal,
    showConfirmModal,
    setShowConfirmModal,
    confirmModalAction,
    setConfirmModalAction,
    confirmModalTaskId,
    setConfirmModalTaskId,
    confirmModalTaskName,
    setConfirmModalTaskName,
    showGroupCreateModal,
    setShowGroupCreateModal,
    groupCreateModalData,
    setGroupCreateModalData,
    showRestoreModal,
    setShowRestoreModal,
    isAnyModalOpen,
    openModal,
    closeModal,
    closeTopmostModal,
  }
}

// Export singleton stores - wrapped in createRoot for proper disposal
export const uiStore = createRoot((dispose) => {
  const toastStore = createToastStore()
  const modalStore = createModalStore()
  return {
    ...toastStore,
    ...modalStore,
  }
})
