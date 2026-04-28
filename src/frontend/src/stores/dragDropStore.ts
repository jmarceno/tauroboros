/**
 * Drag Drop Store - Drag and drop state management
 * Replaces: useDragDrop hook
 */

import { createSignal } from 'solid-js'
import type { DropAction } from '@/utils/dropValidation'

type Awaitable<T> = T | PromiseLike<T>

export function createDragDropStore(
  onDrop: (taskId: string, target: string, action: DropAction) => Awaitable<void>
) {
  const [draggedTaskId, setDraggedTaskId] = createSignal<string | null>(null)
  const [dragSourceStatus, setDragSourceStatus] = createSignal<string | null>(null)
  const [dragSourceContext, setDragSourceContext] = createSignal<'column' | 'group'>('column')
  const [dragOverTarget, setDragOverTarget] = createSignal<string | null>(null)
  const [isDragging, setIsDragging] = createSignal(false)

  const handleDragStart = (taskId: string, sourceStatus: string, context: 'column' | 'group' = 'column') => {
    setDraggedTaskId(taskId)
    setDragSourceStatus(sourceStatus)
    setDragSourceContext(context)
    setIsDragging(true)
  }

  const handleDragEnd = () => {
    setDraggedTaskId(null)
    setDragSourceStatus(null)
    setDragSourceContext('column')
    setDragOverTarget(null)
    setIsDragging(false)
  }

  const handleDragOver = (target: string) => {
    setDragOverTarget(target)
  }

  const handleDragLeave = () => {
    setDragOverTarget(null)
  }

  const handleDrop = async (target: string, action: DropAction) => {
    const taskId = draggedTaskId()
    if (!taskId) return

    await onDrop(taskId, target, action)
    handleDragEnd()
  }

  return {
    draggedTaskId,
    dragSourceStatus,
    dragSourceContext,
    dragOverTarget,
    isDragging,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
