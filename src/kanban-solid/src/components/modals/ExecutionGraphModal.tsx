/**
 * ExecutionGraphModal Component - Execution graph visualization
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, Show, For } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { uiStore } from '@/stores'
import { optionsApi } from '@/api'
import type { ExecutionGraph } from '@/types'

interface ExecutionGraphModalProps {
  onClose: () => void
}

export function ExecutionGraphModal(props: ExecutionGraphModalProps) {
  const [graph, setGraph] = createSignal<ExecutionGraph | null>(null)
  const [isLoading, setIsLoading] = createSignal(true)

  createEffect(() => {
    const loadGraph = async () => {
      try {
        const data = await optionsApi.getExecutionGraph()
        setGraph(data)
      } catch (e) {
        uiStore.showToast('Failed to load execution graph: ' + (e instanceof Error ? e.message : String(e)), 'error')
      } finally {
        setIsLoading(false)
      }
    }
    loadGraph()
  })

  const startExecution = async () => {
    if (!graph() || graph()!.totalTasks === 0) {
      uiStore.showToast('No tasks available to execute. Create some tasks first.', 'error')
      return
    }
    try {
      await optionsApi.startExecution()
      props.onClose()
      uiStore.showToast('Workflow run started', 'success')
    } catch (e) {
      uiStore.showToast('Execution start failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  return (
    <ModalWrapper title="Execution Graph Preview" onClose={props.onClose} size="lg">
      <div class="space-y-4">
        <Show when={isLoading()}>
          <div class="text-dark-text-muted">
            Loading execution graph...
          </div>
        </Show>

        <Show when={!isLoading() && graph()?.error}>
          <div class="text-red-400">
            {graph()?.error}
          </div>
        </Show>

        <Show when={!isLoading() && graph() && !graph()!.error}>
          {/* Summary */}
          <div class="text-sm text-dark-text-muted">
            {graph()!.totalTasks} task{graph()!.totalTasks !== 1 ? 's' : ''}
            {' '}in {graph()!.batches.length} batch{graph()!.batches.length !== 1 ? 'es' : ''}
            {' '}(parallel limit: {graph()!.parallelLimit})
          </div>

          {/* Run counts */}
          <div class="text-sm text-dark-text-muted p-2.5 border border-dark-surface3 rounded-lg bg-dark-bg">
            {graph()!.totalTasks} logical task{graph()!.totalTasks !== 1 ? 's' : ''},
            {' '}{graph()!.nodes.reduce((sum, n) => sum + (n.expandedWorkerRuns ?? 1), 0)} worker runs,
            {' '}{graph()!.nodes.reduce((sum, n) => sum + (n.expandedReviewerRuns ?? 0), 0)} reviewer runs,
            {' '}{graph()!.nodes.reduce((sum, n) => sum + (n.hasFinalApplier ? 1 : 0), 0)} final applier runs
          </div>

          {/* Warning for large runs */}
          <Show when={graph()!.nodes.reduce((sum, n) => sum + (n.estimatedRunCount ?? 1), 0) > 10}>
            <div class="text-xs text-amber-400 p-2.5 border border-amber-500/45 rounded-lg bg-amber-500/10">
              Warning: this run plan expands to {graph()!.nodes.reduce((sum, n) => sum + (n.estimatedRunCount ?? 1), 0)}
              {' '}internal runs and may increase cost and total runtime.
            </div>
          </Show>

          {/* Batches */}
          <div class="flex flex-col gap-3">
            <For each={graph()!.batches}>
              {(batch) => (
                <div class="border border-dark-surface3 rounded-lg p-3 bg-dark-bg">
                  <div class="text-xs font-semibold text-accent-primary mb-2">
                    Batch {batch.idx + 1} ({batch.taskNames.length} task{batch.taskNames.length !== 1 ? 's' : ''})
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <For each={batch.taskNames}>
                      {(taskName, i) => {
                        const node = () => graph()!.nodes.find(n => n.id === batch.taskIds[i()])
                        return (
                          <div class="flex items-center gap-2 py-1">
                            <span class="text-dark-text-muted text-xs">▶</span>
                            <span class="text-sm">{taskName}</span>
                            <Show when={node()?.hasFinalApplier}>
                              <span class="text-xs text-dark-text-muted">
                                (workers: {node()?.expandedWorkerRuns || 0},
                                {' '}reviewers: {node()?.expandedReviewerRuns || 0},
                                {' '}final applier: 1)
                              </span>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* Pending Approvals */}
          <Show when={graph()!.pendingApprovals && graph()!.pendingApprovals.length > 0}>
            <div class="border border-green-500 rounded-lg p-3 bg-green-500/5">
              <div class="text-xs font-semibold text-green-400 mb-2">
                Pending Approvals ({graph()!.pendingApprovals.length})
              </div>
              <div class="flex flex-col gap-1.5">
                <For each={graph()!.pendingApprovals}>
                  {(task) => (
                    <div class="flex items-center justify-between gap-2 py-1">
                      <div class="flex items-center gap-2">
                        <span class="text-green-400 text-xs">▶</span>
                        <span class="text-sm">
                          {task.name}{task.planRevisionCount > 0 ? ` (rev ${task.planRevisionCount})` : ''}
                        </span>
                      </div>
                      <div class="flex gap-1">
                        <button class="btn btn-sm border-green-500 text-green-400 hover:bg-green-500/10">
                          Approve
                        </button>
                        <button class="btn btn-sm border-orange-500 text-orange-400 hover:bg-orange-500/10">
                          Request Changes
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>

      <div class="modal-footer">
        <button class="btn" onClick={props.onClose}>Cancel</button>
        <button
          class="btn btn-primary"
          disabled={isLoading() || !!graph()?.error || !graph() || graph()!.totalTasks === 0}
          onClick={startExecution}
        >
          Confirm & Start
        </button>
      </div>
    </ModalWrapper>
  )
}
