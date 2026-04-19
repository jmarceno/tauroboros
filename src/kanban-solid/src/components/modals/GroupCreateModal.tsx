/**
 * GroupCreateModal Component - Create group from selection
 */

import { createSignal } from 'solid-js'
import { ModalWrapper } from '../common/ModalWrapper'

interface GroupCreateModalProps {
  taskCount: number
  defaultName?: string
  isLoading?: boolean
  onClose: () => void
  onConfirm: (name: string) => Promise<void>
}

export function GroupCreateModal(props: GroupCreateModalProps) {
  const [name, setName] = createSignal(props.defaultName || '')

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    await props.onConfirm(name())
  }

  return (
    <ModalWrapper title="Create Task Group" onClose={props.onClose} size="sm">
      <form onSubmit={handleSubmit} class="space-y-4">
        <p class="text-dark-text-secondary text-sm">
          Create a group from {props.taskCount} selected tasks.
        </p>

        <div class="form-group">
          <label>Group Name</label>
          <input
            type="text"
            class="form-input"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="Enter group name..."
            required
            autofocus
          />
        </div>

        <div class="modal-footer">
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button 
            type="submit" 
            class="btn btn-primary"
            disabled={props.isLoading || !name().trim()}
          >
            {props.isLoading ? 'Creating...' : 'Create Group'}
          </button>
        </div>
      </form>
    </ModalWrapper>
  )
}
