import { useState, useEffect, useRef, useCallback } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'

interface GroupCreateModalProps {
  taskCount: number
  defaultName?: string
  isLoading?: boolean
  onClose: () => void
  onConfirm: (name: string) => void
}

export function GroupCreateModal({ taskCount, defaultName, isLoading, onClose, onConfirm }: GroupCreateModalProps) {
  const [name, setName] = useState(defaultName || '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Group name is required')
      return
    }
    if (trimmed.length > 100) {
      setError('Group name must be 100 characters or less')
      return
    }
    setError(null)
    onConfirm(trimmed)
  }, [name, onConfirm])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [onClose])

  return (
    <ModalWrapper title="Create Task Group" onClose={onClose} size="md">
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            Create a new group with <strong className="text-slate-200">{taskCount}</strong> selected task{taskCount !== 1 ? 's' : ''}.
          </p>

          <div className="form-group">
            <label htmlFor="group-name" className="form-label">
              Group Name <span className="text-red-400">*</span>
            </label>
            <input
              ref={inputRef}
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={handleKeyDown}
              placeholder="Enter group name..."
              disabled={isLoading}
              className={`form-input ${error ? 'border-red-500' : ''}`}
              maxLength={100}
            />
            {error && (
              <span className="text-xs text-red-400 mt-1">{error}</span>
            )}
            <span className="text-xs text-slate-500 mt-1">
              {name.length}/100 characters
            </span>
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isLoading || !name.trim()}
          >
            {isLoading ? 'Creating...' : 'Create Group'}
          </button>
        </div>
      </form>
    </ModalWrapper>
  )
}
