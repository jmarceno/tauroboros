import { useState, useCallback } from 'react'

export function useDragDrop(onDrop: (taskId: string, targetStatus: string) => void) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null)

  const handleDragStart = useCallback((taskId: string) => {
    setDragTaskId(taskId)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDragTaskId(null)
    setDragOverStatus(null)
  }, [])

  const handleDragOver = useCallback((status: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverStatus(status)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverStatus(null)
  }, [])

  const handleDrop = useCallback((targetStatus: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverStatus(null)
    if (dragTaskId) {
      onDrop(dragTaskId, targetStatus)
    }
    setDragTaskId(null)
  }, [dragTaskId, onDrop])

  return {
    dragTaskId,
    dragOverStatus,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
