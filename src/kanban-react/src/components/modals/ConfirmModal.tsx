import { ModalWrapper } from '../common/ModalWrapper'

interface ConfirmModalProps {
  isOpen: boolean
  action: 'delete' | 'convertToTemplate'
  taskName: string
  onClose: () => void
  onConfirm: () => void
}

export function ConfirmModal({ isOpen, action, taskName, onClose, onConfirm }: ConfirmModalProps) {
  if (!isOpen) return null

  const title = action === 'delete' ? 'Delete Task' : 'Convert to Template'
  const message = action === 'delete' 
    ? `Are you sure you want to delete "${taskName}"? This action cannot be undone.`
    : `Convert "${taskName}" to a template? The task will be moved to the Templates column.`
  const confirmText = action === 'delete' ? 'Delete' : 'Convert'
  const confirmClass = action === 'delete' ? 'btn-danger' : 'btn-primary'

  return (
    <ModalWrapper title={title} onClose={onClose} size="sm">
      <div className="space-y-4">
        <p className="text-dark-text">{message}</p>
        <p className="text-sm text-dark-text-muted">
          Tip: Hold Ctrl/Cmd and click to skip this confirmation in the future.
        </p>

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className={`btn ${confirmClass}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}
