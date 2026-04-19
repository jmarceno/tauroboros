/**
 * ConfirmModal Component - Generic confirmation dialog
 */

import { ModalWrapper } from '../common/ModalWrapper'

interface ConfirmModalProps {
  isOpen: boolean
  action: 'delete' | 'archive' | 'convertToTemplate'
  taskName: string
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmModal(props: ConfirmModalProps) {
  if (!props.isOpen) return null

  const title = () => {
    if (props.action === 'delete') return 'Confirm Delete'
    if (props.action === 'archive') return 'Confirm Archive'
    return 'Convert to Template'
  }
  
  const message = () => {
    if (props.action === 'delete') {
      return `Are you sure you want to delete "${props.taskName}"? This cannot be undone.`
    }
    if (props.action === 'archive') {
      return `Are you sure you want to archive "${props.taskName}"? Archived tasks can be viewed in the Archived tab.`
    }
    return `Convert "${props.taskName}" to a template? The task will be moved to the Templates column.`
  }
  
  const buttonClass = () => {
    if (props.action === 'delete') return 'btn btn-danger'
    if (props.action === 'archive') return 'btn btn-primary'
    return 'btn btn-primary'
  }
  
  const buttonText = () => {
    if (props.action === 'delete') return 'Delete'
    if (props.action === 'archive') return 'Archive'
    return 'Convert'
  }

  return (
    <ModalWrapper title={title()} onClose={props.onClose} size="sm">
      <p class="text-dark-text-secondary mb-6">{message()}</p>
      
      <div class="modal-footer">
        <button class="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button 
          class={buttonClass()}
          onClick={props.onConfirm}
        >
          {buttonText()}
        </button>
      </div>
    </ModalWrapper>
  )
}
