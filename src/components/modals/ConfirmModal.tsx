/**
 * ConfirmModal Component - Generic confirmation dialog
 */

import { ModalWrapper } from '../common/ModalWrapper'

interface ConfirmModalProps {
  isOpen: boolean
  action: 'delete' | 'convertToTemplate'
  taskName: string
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmModal(props: ConfirmModalProps) {
  if (!props.isOpen) return null

  const title = () => props.action === 'delete' ? 'Confirm Delete' : 'Convert to Template'
  const message = () => 
    props.action === 'delete' 
      ? `Are you sure you want to delete "${props.taskName}"? This cannot be undone.`
      : `Convert "${props.taskName}" to a template? The task will be moved to the Templates column.`

  return (
    <ModalWrapper title={title()} onClose={props.onClose} size="sm">
      <p class="text-dark-text-secondary mb-6">{message()}</p>
      
      <div class="modal-footer">
        <button class="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button 
          class={`btn ${props.action === 'delete' ? 'btn-danger' : 'btn-primary'}`}
          onClick={props.onConfirm}
        >
          {props.action === 'delete' ? 'Delete' : 'Convert'}
        </button>
      </div>
    </ModalWrapper>
  )
}
