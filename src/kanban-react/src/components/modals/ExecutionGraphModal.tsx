import { ModalWrapper } from '../common/ModalWrapper'

interface ExecutionGraphModalProps {
  onClose: () => void
}

export function ExecutionGraphModal({ onClose }: ExecutionGraphModalProps) {
  return (
    <ModalWrapper title="Execution Graph" onClose={onClose} size="lg">
      <div className="text-center py-8 text-dark-text-muted">
        <p>Execution graph visualization</p>
        <p className="text-sm mt-2">This feature will be implemented in a future update.</p>
      </div>
    </ModalWrapper>
  )
}
