import { ref } from 'vue'

export function useDragDrop(onDrop: (taskId: string, targetStatus: string) => void) {
  const dragTaskId = ref<string | null>(null)
  const dragOverStatus = ref<string | null>(null)

  const handleDragStart = (taskId: string) => {
    dragTaskId.value = taskId
  }

  const handleDragEnd = () => {
    dragTaskId.value = null
    dragOverStatus.value = null
  }

  const handleDragOver = (status: string, e: DragEvent) => {
    e.preventDefault()
    dragOverStatus.value = status
  }

  const handleDragLeave = () => {
    dragOverStatus.value = null
  }

  const handleDrop = (targetStatus: string, e: DragEvent) => {
    e.preventDefault()
    dragOverStatus.value = null
    if (dragTaskId.value) {
      onDrop(dragTaskId.value, targetStatus)
    }
    dragTaskId.value = null
  }

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
