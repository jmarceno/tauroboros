/**
 * ExecutionGraphModal Component - Execution graph visualization
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, Show, For } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { uiStore } from '@/stores'
import { optionsApi, referenceApi, runApiEffect } from '@/api'
import type { ExecutionGraph } from '@/types'

interface ExecutionGraphModalProps {
  onClose: () => void
  pendingGroupId?: string | null
  onConfirm?: () => Promise<void>
}

export function ExecutionGraphModal(props: ExecutionGraphModalProps) {
  const [graph, setGraph] = createSignal<ExecutionGraph | null>(null)
  const [isLoading, setIsLoading] = createSignal(true)
  const nodeCount = () => graph()?.nodes.length ?? 0
  const edgeCount = () => graph()?.edges.length ?? 0

  createEffect(() => {
    const loadGraph = async () => {
      try {
        const data = await runApiEffect(referenceApi.getExecutionGraph())
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
    if (!graph() || nodeCount() === 0) {
      uiStore.showToast('No tasks available to execute. Create some tasks first.', 'error')
      return
    }
    try {
      // If onConfirm is provided, use that (handles both group and regular execution)
      if (props.onConfirm) {
        await props.onConfirm()
        return
      }
      // Default: start regular execution
      await runApiEffect(optionsApi.startExecution())
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

        <Show when={!isLoading() && graph()}>
          {/* Summary */}
          <div class="text-sm text-dark-text-muted">
            {nodeCount()} node{nodeCount() !== 1 ? 's' : ''}
            {' '}and {edgeCount()} edge{edgeCount() !== 1 ? 's' : ''}
          </div>

          <div class="text-sm text-dark-text-muted p-2.5 border border-dark-surface3 rounded-lg bg-dark-bg">
            This preview reflects the current workflow dependency graph that will be used when execution starts.
          </div>

          <Show when={nodeCount() === 0}>
            <div class="text-xs text-amber-400 p-2.5 border border-amber-500/45 rounded-lg bg-amber-500/10">
              No executable nodes are present in the graph.
            </div>
          </Show>

          <div class="flex flex-col gap-3">
            <For each={graph()!.nodes}>
              {(node) => (
                <div class="border border-dark-surface3 rounded-lg p-3 bg-dark-bg">
                  <div class="text-xs font-semibold text-accent-primary mb-2">
                    {node.name}
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center gap-2 py-1">
                      <span class="text-dark-text-muted text-xs">●</span>
                      <span class="text-sm">Status: {node.status}</span>
                    </div>
                    <Show when={node.estimatedRunCount !== undefined}>
                      <div class="flex items-center gap-2 py-1">
                        <span class="text-dark-text-muted text-xs">●</span>
                        <span class="text-sm">Estimated runs: {node.estimatedRunCount}</span>
                      </div>
                    </Show>
                    <Show when={graph()!.edges.some(edge => edge.to === node.id)}>
                      <div class="flex items-start gap-2 py-1">
                        <span class="text-dark-text-muted text-xs mt-0.5">●</span>
                        <div class="text-sm">
                          Depends on:{' '}
                          {graph()!
                            .edges
                            .filter(edge => edge.to === node.id)
                            .map(edge => graph()!.nodes.find(candidate => candidate.id === edge.from)?.name ?? edge.from)
                            .join(', ')}
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="modal-footer">
        <button class="btn" onClick={props.onClose}>Cancel</button>
        <button
          class="btn btn-primary"
          disabled={isLoading() || !graph() || nodeCount() === 0}
          onClick={startExecution}
        >
          Confirm & Start
        </button>
      </div>
    </ModalWrapper>
  )
}
