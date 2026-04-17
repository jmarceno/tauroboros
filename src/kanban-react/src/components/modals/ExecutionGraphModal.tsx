import { useState, useEffect } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useOptionsContext, useToastContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks'
import type { ExecutionGraph } from '@/types'

interface ExecutionGraphModalProps {
  onClose: () => void
}

export function ExecutionGraphModal({ onClose }: ExecutionGraphModalProps) {
  const options = useOptionsContext()
  const toasts = useToastContext()
  const api = useApi()

  const [graph, setGraph] = useState<ExecutionGraph | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const loadGraph = async () => {
      try {
        const data = await api.getExecutionGraph()
        if (!cancelled) setGraph(data)
      } catch (e) {
        if (!cancelled) {
          toasts.showToast('Failed to load execution graph: ' + (e instanceof Error ? e.message : String(e)), 'error')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadGraph()
    return () => { cancelled = true }
  }, [api, toasts])

  const startExecution = async () => {
    // Check if there are tasks to execute
    if (!graph || graph.totalTasks === 0) {
      toasts.showToast('No tasks available to execute. Create some tasks first.', 'error')
      return
    }
    try {
      await options.startExecution()
      onClose()
      toasts.showToast('Workflow run started', 'success')
    } catch (e) {
      toasts.showToast('Execution start failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  return (
    <ModalWrapper title="Execution Graph Preview" onClose={onClose} size="lg">
      <div className="space-y-4">
        {isLoading && (
          <div className="text-dark-text-muted">
            Loading execution graph...
          </div>
        )}

        {!isLoading && graph?.error && (
          <div className="text-red-400">
            {graph.error}
          </div>
        )}

        {!isLoading && graph && !graph.error && (
          <>
            {/* Summary */}
            <div className="text-sm text-dark-text-muted">
              {graph.totalTasks} task{graph.totalTasks !== 1 ? 's' : ''}
              {' '}in {graph.batches.length} batch{graph.batches.length !== 1 ? 'es' : ''}
              {' '}(parallel limit: {graph.parallelLimit})
            </div>

            {/* Run counts */}
            <div className="text-sm text-dark-text-muted p-2.5 border border-dark-surface3 rounded-lg bg-dark-bg">
              {graph.totalTasks} logical task{graph.totalTasks !== 1 ? 's' : ''},
              {' '}{graph.nodes.reduce((sum, n) => sum + (n.expandedWorkerRuns ?? 1), 0)} worker runs,
              {' '}{graph.nodes.reduce((sum, n) => sum + (n.expandedReviewerRuns ?? 0), 0)} reviewer runs,
              {' '}{graph.nodes.reduce((sum, n) => sum + (n.hasFinalApplier ? 1 : 0), 0)} final applier runs
            </div>

            {/* Warning for large runs */}
            {graph.nodes.reduce((sum, n) => sum + (n.estimatedRunCount ?? 1), 0) > 10 && (
              <div className="text-xs text-amber-400 p-2.5 border border-amber-500/45 rounded-lg bg-amber-500/10">
                Warning: this run plan expands to {graph.nodes.reduce((sum, n) => sum + (n.estimatedRunCount ?? 1), 0)}
                {' '}internal runs and may increase cost and total runtime.
              </div>
            )}

            {/* Batches */}
            <div className="flex flex-col gap-3">
              {graph.batches.map((batch) => (
                <div
                  key={batch.idx}
                  className="border border-dark-surface3 rounded-lg p-3 bg-dark-bg"
                >
                  <div className="text-xs font-semibold text-accent-primary mb-2">
                    Batch {batch.idx + 1} ({batch.taskNames.length} task{batch.taskNames.length !== 1 ? 's' : ''})
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {batch.taskNames.map((taskName, i) => {
                      const node = graph.nodes.find(n => n.id === batch.taskIds[i])
                      return (
                        <div
                          key={i}
                          className="flex items-center gap-2 py-1"
                        >
                          <span className="text-dark-text-muted text-xs">▶</span>
                          <span className="text-sm">{taskName}</span>
                          {node?.hasFinalApplier && (
                            <span className="text-xs text-dark-text-muted">
                              (workers: {node?.expandedWorkerRuns || 0},
                              {' '}reviewers: {node?.expandedReviewerRuns || 0},
                              {' '}final applier: 1)
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Pending Approvals */}
            {graph.pendingApprovals?.length > 0 && (
              <div className="border border-green-500 rounded-lg p-3 bg-green-500/5">
                <div className="text-xs font-semibold text-green-400 mb-2">
                  Pending Approvals ({graph.pendingApprovals.length})
                </div>
                <div className="flex flex-col gap-1.5">
                  {graph.pendingApprovals.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center justify-between gap-2 py-1"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-green-400 text-xs">▶</span>
                        <span className="text-sm">
                          {task.name}{task.planRevisionCount > 0 ? ` (rev ${task.planRevisionCount})` : ''}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <button className="btn btn-sm border-green-500 text-green-400 hover:bg-green-500/10">
                          Approve
                        </button>
                        <button className="btn btn-sm border-orange-500 text-orange-400 hover:bg-orange-500/10">
                          Request Changes
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="modal-footer">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={isLoading || !!graph?.error || !graph || graph.totalTasks === 0}
          onClick={startExecution}
        >
          Confirm & Start
        </button>
      </div>
    </ModalWrapper>
  )
}
