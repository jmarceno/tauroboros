import { ModalWrapper } from '../common/ModalWrapper'

interface StopConfirmModalProps {
  isOpen: boolean
  runName?: string
  isStopping: boolean
  onClose: () => void
  onConfirmGraceful: () => void
  onConfirmDestructive: () => void
}

export function StopConfirmModal({ isOpen, runName, isStopping, onClose, onConfirmGraceful, onConfirmDestructive }: StopConfirmModalProps) {
  if (!isOpen) return null

  return (
    <ModalWrapper title={isStopping ? 'Stopping Workflow...' : 'Stop Workflow'} onClose={onClose} size="sm">
      <div className="space-y-4">
        {runName && (
          <p className="text-dark-text-secondary">
            Run: <span className="text-dark-text font-medium">{runName}</span>
          </p>
        )}

        {isStopping ? (
          <div className="text-center py-4">
            <div className="animate-spin w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full mx-auto mb-2" />
            <p className="text-dark-text">Stopping workflow...</p>
          </div>
        ) : (
          <>
            <p className="text-dark-text">How would you like to stop the workflow?</p>

            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                className="btn"
                onClick={onConfirmGraceful}
              >
                <div className="text-sm font-medium">PAUSE</div>
                <div className="text-xs text-dark-text-muted">Graceful stop</div>
                <div className="text-xs text-dark-text-muted">Preserves state</div>
              </button>

              <button
                type="button"
                className="btn btn-danger"
                onClick={onConfirmDestructive}
              >
                <div className="text-sm font-medium">STOP</div>
                <div className="text-xs">Kills containers</div>
                <div className="text-xs">Data loss risk</div>
              </button>
            </div>
          </>
        )}

        {!isStopping && (
          <p className="text-xs text-dark-text-muted text-center">
            Both options will gracefully stop the workflow and preserve work. Choose STOP for emergency only.
          </p>
        )}
      </div>
    </ModalWrapper>
  )
}
