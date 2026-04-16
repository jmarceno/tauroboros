import { useState, useEffect } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useToastContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks'
import type { BestOfNSummary, TaskRun, Candidate } from '@/types'

interface BestOfNDetailModalProps {
  taskId: string
  onClose: () => void
}

export function BestOfNDetailModal({ taskId, onClose }: BestOfNDetailModalProps) {
  const tasks = useTasksContext()
  const api = useApi()
  const toasts = useToastContext()
  const showToast = toasts.showToast
  const getBestOfNSummary = api.getBestOfNSummary
  const getTaskRuns = api.getTaskRuns
  const getTaskCandidates = api.getTaskCandidates
  const [summary, setSummary] = useState<BestOfNSummary | null>(null)
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const task = tasks.getTaskById(taskId)

  useEffect(() => {
    let cancelled = false
    const loadData = async () => {
      setIsLoading(true)
      try {
        const [summaryData, runsData, candidatesData] = await Promise.all([
          getBestOfNSummary(taskId),
          getTaskRuns(taskId),
          getTaskCandidates(taskId),
        ])
        if (cancelled) return
        setSummary(summaryData)
        setTaskRuns(runsData)
        setCandidates(candidatesData)
      } catch (e) {
        if (!cancelled) showToast('Failed to load details', 'error')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [taskId, getBestOfNSummary, getTaskRuns, getTaskCandidates, showToast])

  return (
    <ModalWrapper title={`Best-of-N: ${task?.name || taskId}`} onClose={onClose} size="lg">
      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        {isLoading ? (
          <div className="text-center py-8 text-dark-text-muted">Loading details...</div>
        ) : !summary ? (
          <div className="text-center py-8 text-dark-text-muted">No Best-of-N data for this task.</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4">
              <div className="stat-card">
                <div className="stat-value">{summary.workersDone}/{summary.workersTotal}</div>
                <div className="stat-label">Workers</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{summary.reviewersDone}/{summary.reviewersTotal}</div>
                <div className="stat-label">Reviewers</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{summary.availableCandidates}</div>
                <div className="stat-label">Candidates</div>
              </div>
            </div>

            <div className="border-t border-dark-border pt-4">
              <h4 className="text-sm font-medium mb-2">Task Runs</h4>
              {taskRuns.length === 0 ? (
                <div className="text-dark-text-muted text-sm">No task runs yet.</div>
              ) : (
                taskRuns.map(run => (
                  <div key={run.id} className="session-entry mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${
                        run.status === 'done' ? 'bg-accent-success' :
                        run.status === 'failed' ? 'bg-accent-danger' :
                        run.status === 'running' ? 'bg-accent-warning' :
                        'bg-dark-text-muted'
                      }`} />
                      <span className="text-sm">{run.phase}</span>
                      <span className="text-xs text-dark-text-muted">({run.status})</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-dark-border pt-4">
              <h4 className="text-sm font-medium mb-2">Candidates</h4>
              {candidates.length === 0 ? (
                <div className="text-dark-text-muted text-sm">No candidates yet.</div>
              ) : (
                candidates.map(candidate => (
                  <div key={candidate.id} className="session-entry mb-2">
                    <div className="flex items-center justify-between">
                      <span className={`text-sm ${
                        candidate.status === 'selected' ? 'text-accent-success' :
                        candidate.status === 'rejected' ? 'text-accent-danger' :
                        'text-dark-text'
                      }`}>
                        {candidate.status === 'selected' ? '✓ ' : ''}
                        Candidate {candidate.id.slice(0, 8)}
                      </span>
                      <span className="text-xs text-dark-text-muted">({candidate.status})</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </ModalWrapper>
  )
}
