/**
 * RestoreToGroupModal Component - Restore task to group
 * Ported from React to SolidJS
 */

import { Show, For, createSignal } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import type { Task, TaskGroup } from '@/types'

interface RestoreToGroupModalProps {
  task?: Task
  groups: TaskGroup[]
  onClose: () => void
  onRestore: (taskId: string, groupId: string) => Promise<void>
}

export function RestoreToGroupModal(props: RestoreToGroupModalProps) {
  const [isLoading, setIsLoading] = createSignal(false)
  const [selectedGroupId, setSelectedGroupId] = createSignal<string | null>(null)

  const taskId = () => props.task?.id

  const handleRestore = async () => {
    const id = taskId()
    const groupId = selectedGroupId()
    if (!id || !groupId) return

    setIsLoading(true)
    try {
      await props.onRestore(id, groupId)
    } catch (e) {
      // Error handled by parent
    } finally {
      setIsLoading(false)
    }
  }

  const handleRestoreToAny = async () => {
    const id = taskId()
    if (!id || props.groups.length === 0) return
    
    setIsLoading(true)
    try {
      // Restore to first available group
      await props.onRestore(id, props.groups[0].id)
    } catch (e) {
      // Error handled by parent
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <ModalWrapper 
      title="Restore Task to Group" 
      onClose={props.onClose}
      size="md"
    >
      <div class="space-y-4">
        <Show when={props.task} fallback={<div class="text-dark-text-secondary">No task selected</div>}>
          <p class="text-dark-text-secondary">
            Task <strong class="text-dark-text">"{props.task!.name}"</strong> can be restored to a group.
          </p>

          <Show 
            when={props.groups.length > 0} 
            fallback={<div class="text-dark-text-muted">No groups available</div>}
          >
            <div class="space-y-2">
              <p class="text-sm text-dark-text-muted">Select a group:</p>
              <For each={props.groups}>
                {(group) => (
                  <label class="flex items-center gap-3 p-3 rounded-lg border border-dark-border cursor-pointer hover:bg-dark-surface2 transition-colors">
                    <input
                      type="radio"
                      name="group"
                      value={group.id}
                      checked={selectedGroupId() === group.id}
                      onChange={() => setSelectedGroupId(group.id)}
                      class="w-4 h-4 accent-indigo-500"
                    />
                    <div class="flex items-center gap-2">
                      <div
                        class="w-3 h-3 rounded-full"
                        style={{ 'background-color': group.color }}
                      />
                      <span class="text-dark-text">{group.name}</span>
                      <span class="text-xs text-dark-text-muted">
                        ({group.taskIds.length} tasks)
                      </span>
                    </div>
                  </label>
                )}
              </For>
            </div>

            <div class="modal-footer pt-4 border-t border-dark-border">
              <button type="button" class="btn" onClick={props.onClose} disabled={isLoading()}>
                Cancel
              </button>
              <div class="flex gap-2">
                <Show when={props.groups.length > 0}>
                  <button
                    type="button"
                    class="btn"
                    onClick={handleRestoreToAny}
                    disabled={isLoading()}
                  >
                    Restore to Any
                  </button>
                </Show>
                <button
                  type="button"
                  class="btn btn-primary"
                  onClick={handleRestore}
                  disabled={isLoading() || !selectedGroupId()}
                >
                  {isLoading() ? 'Restoring...' : 'Restore to Group'}
                </button>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </ModalWrapper>
  )
}
