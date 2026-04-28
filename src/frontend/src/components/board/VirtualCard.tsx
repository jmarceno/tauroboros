/**
 * VirtualCard Component - Group virtual card in backlog
 * Ported from React to SolidJS
 */

import { createSignal, Show } from 'solid-js'
import type { TaskGroup, TaskGroupStatus } from '@/types'
import { formatLocalDate } from '@/utils/date'

interface VirtualCardProps {
  group: TaskGroup
  taskCount: number
  onClick: () => void
  onDelete: () => void
  onStart?: () => void
}

export function VirtualCard(props: VirtualCardProps) {
  const [showConfirm, setShowConfirm] = createSignal(false)

  const handleDeleteClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey) {
      props.onDelete()
    } else {
      setShowConfirm(true)
    }
  }

  const handleConfirmDelete = () => {
    setShowConfirm(false)
    props.onDelete()
  }

  const handleCancelDelete = () => {
    setShowConfirm(false)
  }

  const handleStartClick = (e: MouseEvent) => {
    e.stopPropagation()
    props.onStart?.()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onClick()
    }
  }

  const getStatusIcon = (status: TaskGroupStatus) => {
    switch (status) {
      case 'active':
        return (
          <svg class="virtual-card-icon text-accent-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )
      case 'running':
        return (
          <svg class="virtual-card-icon text-accent-success animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20" />
          </svg>
        )
      case 'completed':
        return (
          <svg class="virtual-card-icon text-accent-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 13l4 4L19 7" />
          </svg>
        )
      default:
        return (
          <svg class="virtual-card-icon text-dark-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )
    }
  }

  return (
    <>
      <div
        class="virtual-card"
        data-group-color={props.group.color}
        style={{ 
          'border-left-color': props.group.color, 
          '--group-color': `${props.group.color}66` 
        }}
        onClick={props.onClick}
        onKeyDown={handleKeyDown}
        tabindex={0}
        role="button"
        aria-label={`${props.group.name} group with ${props.taskCount} task${props.taskCount !== 1 ? 's' : ''}, status ${props.group.status}. Press Enter to open.`}
        title={`Created: ${formatLocalDate(props.group.createdAt)}\nClick to manage group`}
      >
        {/* Header */}
        <div class="virtual-card-header">
          {getStatusIcon(props.group.status)}
          <span class="virtual-card-title" title={props.group.name}>
            {props.group.name}
          </span>
        </div>

        {/* Body */}
        <div class="virtual-card-body">
          <span class="virtual-card-label">Virtual Workflow</span>
          <span class="text-[11px] text-dark-text-secondary">
            {props.taskCount} task{props.taskCount !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Footer */}
        <div class="virtual-card-footer">
          <Show when={props.onStart && props.group.status === 'active'}>
            <button
              class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
              title="Start group execution"
              onClick={handleStartClick}
              aria-label={`Start execution for ${props.group.name}`}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </Show>
          <button
            class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-danger transition-colors ml-auto"
            title="Delete group"
            onClick={handleDeleteClick}
            aria-label={`Delete ${props.group.name} group`}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <Show when={showConfirm()}>
        <div class="modal-overlay" onClick={handleCancelDelete}>
          <div class="modal max-w-modal-sm" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Delete Group</h2>
            </div>
            <div class="modal-body">
              <p class="text-dark-text">
                Are you sure you want to delete "{props.group.name}"? This action cannot be undone.
              </p>
              <p class="text-sm text-dark-text-muted mt-2">
                Tip: Hold Ctrl/Cmd and click to skip this confirmation in the future.
              </p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn" onClick={handleCancelDelete}>
                Cancel
              </button>
              <button type="button" class="btn btn-danger" onClick={handleConfirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  )
}
