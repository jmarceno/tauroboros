import { useState, useCallback } from "react"
import type { DropAction } from "@/utils/dropValidation"

export type { DropAction } from "@/utils/dropValidation"

export type { GroupDropSource, GroupDropValidationResult, DropValidationResult, DropTargetType } from "@/utils/dropValidation"

export type DragSourceContext = 'column' | 'group' | null

export interface DragOverTarget {
  type: 'column' | 'group'
  id: string
}

export interface DragDropState {
  dragTaskId: string | null
  dragSourceContext: DragSourceContext
  dragSourceGroupId: string | null
  dragOverTarget: DragOverTarget | null
}

export type DragDropCallback = (
  taskId: string,
  target: string,
  action: DropAction
) => void

export function useDragDrop(onDrop: DragDropCallback) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [dragSourceContext, setDragSourceContext] = useState<DragSourceContext>(null)
  const [dragSourceGroupId, setDragSourceGroupId] = useState<string | null>(null)
  const [dragOverTarget, setDragOverTarget] = useState<DragOverTarget | null>(null)

  // Legacy state for backward compatibility with columns
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null)

  const handleDragStart = useCallback((
    taskId: string,
    context: { source: 'column'; status: string } | { source: 'group'; groupId: string }
  ) => {
    setDragTaskId(taskId)
    setDragSourceContext(context.source)
    if (context.source === 'group') {
      setDragSourceGroupId(context.groupId)
    } else {
      setDragSourceGroupId(null)
    }
  }, [])

  const handleDragEnd = useCallback(() => {
    setDragTaskId(null)
    setDragSourceContext(null)
    setDragSourceGroupId(null)
    setDragOverTarget(null)
    setDragOverStatus(null)
  }, [])

  const handleDragOver = useCallback((status: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverStatus(status)
    setDragOverTarget({ type: 'column', id: status })
  }, [])

  const handleDragOverGroup = useCallback((groupId: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverTarget({ type: 'group', id: groupId })
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverStatus(null)
    setDragOverTarget(null)
  }, [])

  const handleDrop = useCallback((targetStatus: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverStatus(null)
    setDragOverTarget(null)

    if (!dragTaskId) return

    // Determine action based on source and target
    let action: DropAction
    if (dragSourceContext === 'group' && targetStatus === 'backlog') {
      // Dropping from group to backlog - remove from group
      action = 'remove-from-group'
    } else if (targetStatus === 'backlog') {
      action = 'reset-to-backlog'
    } else if (targetStatus === 'done') {
      action = 'move-to-done'
    } else if (targetStatus === 'review') {
      action = 'move-to-review'
    } else {
      action = 'reset-to-backlog'
    }

    onDrop(dragTaskId, targetStatus, action)
    setDragTaskId(null)
    setDragSourceContext(null)
    setDragSourceGroupId(null)
  }, [dragTaskId, dragSourceContext, onDrop])

  const handleDropOnGroup = useCallback((targetGroupId: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOverTarget(null)

    if (!dragTaskId) return

    // Adding task to group
    onDrop(dragTaskId, targetGroupId, 'add-to-group')
    setDragTaskId(null)
    setDragSourceContext(null)
    setDragSourceGroupId(null)
  }, [dragTaskId, onDrop])

  return {
    // State
    dragTaskId,
    dragSourceContext,
    dragSourceGroupId,
    dragOverTarget,
    dragOverStatus,
    // Handlers
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragOverGroup,
    handleDragLeave,
    handleDrop,
    handleDropOnGroup,
  }
}
