/**
 * ContainerConfigModal Component - Container configuration modal
 * Ported from React to SolidJS
 * Note: This is a simplified version that redirects to the ContainersTab
 */

import { Show } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { tabStore } from '@/stores'

interface ContainerConfigModalProps {
  isOpen: boolean
  onClose: () => void
}

export function ContainerConfigModal(props: ContainerConfigModalProps) {
  const handleGoToContainersTab = () => {
    tabStore.setActiveTab('containers')
    props.onClose()
  }

  return (
    <Show when={props.isOpen}>
      <ModalWrapper title="Container Configuration" onClose={props.onClose} size="md">
        <div class="space-y-4">
          <p class="text-dark-text-secondary">
            Container configuration has been moved to the Containers tab for a better experience.
          </p>
          <div class="bg-dark-surface rounded-lg p-4">
            <p class="text-sm text-dark-text-muted mb-3">
              The Containers tab provides:
            </p>
            <ul class="text-sm text-dark-text space-y-2 list-disc list-inside">
              <li>Profile-based Dockerfile management</li>
              <li>Build history and logs</li>
              <li>Available images overview</li>
              <li>Image deletion with safety checks</li>
            </ul>
          </div>
          <div class="modal-footer">
            <button class="btn" onClick={props.onClose}>Cancel</button>
            <button class="btn btn-primary" onClick={handleGoToContainersTab}>
              Go to Containers Tab
            </button>
          </div>
        </div>
      </ModalWrapper>
    </Show>
  )
}
