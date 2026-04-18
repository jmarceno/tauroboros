import { useState, useEffect, useCallback, useMemo } from 'react'
import { useApi } from '@/hooks'
import type { Task, WorkflowRun } from '@/types'
import { formatLocalDateTime } from '@/utils/date'
import { SessionModal } from '@/components/modals/SessionModal'

type ArchivedTask = Omit<Task, 'sessionId' | 'completedAt'> & {
  sessionId: string | null
  completedAt: number | null
}

type StatusColorKey = Task['status'] | WorkflowRun['status']

const STATUS_COLORS: Record<StatusColorKey, string> = {
  // Task statuses
  done: 'text-green-400 bg-green-500/10',
  failed: 'text-red-400 bg-red-500/10',
  stuck: 'text-orange-400 bg-orange-500/10',
  template: 'text-blue-400 bg-blue-500/10',
  backlog: 'text-gray-400 bg-gray-500/10',
  executing: 'text-yellow-400 bg-yellow-500/10',
  review: 'text-purple-400 bg-purple-500/10',
  'code-style': 'text-pink-400 bg-pink-500/10',
  // Workflow run statuses
  running: 'text-yellow-400 bg-yellow-500/10',
  stopping: 'text-orange-400 bg-orange-500/10',
  paused: 'text-blue-400 bg-blue-500/10',
  completed: 'text-green-400 bg-green-500/10',
}

interface ArchivedRun {
  run: WorkflowRun
  tasks: ArchivedTask[]
  taskCount: number
  expanded: boolean
}

interface SessionModalState {
  isOpen: boolean
  sessionId: string | null
}

export function ArchivedTasksTab() {
  const api = useApi()
  const [archivedRuns, setArchivedRuns] = useState<ArchivedRun[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sessionModal, setSessionModal] = useState<SessionModalState>({ isOpen: false, sessionId: null })
  const [selectedTask, setSelectedTask] = useState<ArchivedTask | null>(null)

  const loadArchivedTasks = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await api.getArchivedTasks()
      
      if (!Array.isArray(data.runs)) {
        throw new Error('Invalid response: runs must be an array')
      }
      
      const runs: ArchivedRun[] = data.runs.map((runData) => {
        if (!runData.run || !Array.isArray(runData.tasks)) {
          throw new Error('Invalid run data: missing run or tasks array')
        }
        return {
          run: runData.run,
          tasks: runData.tasks.map((task): ArchivedTask => {
            if (!task.id || !task.name) {
              throw new Error(`Invalid task data: missing required fields for task in run ${runData.run.id}`)
            }
            return {
              ...task,
              sessionId: task.sessionId ?? null,
              completedAt: task.completedAt ?? null,
            }
          }),
          taskCount: runData.tasks.length,
          expanded: false,
        }
      })
      
      setArchivedRuns(runs)
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to load archived tasks'
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }, [api])

  useEffect(() => {
    loadArchivedTasks()
  }, [])

  const toggleRunExpanded = useCallback((runId: string) => {
    setArchivedRuns(prev => prev.map(run => 
      run.run.id === runId ? { ...run, expanded: !run.expanded } : run
    ))
  }, [])

  const expandAll = useCallback(() => {
    setArchivedRuns(prev => prev.map(run => ({ ...run, expanded: true })))
  }, [])

  const collapseAll = useCallback(() => {
    setArchivedRuns(prev => prev.map(run => ({ ...run, expanded: false })))
  }, [])

  const filteredRuns = useMemo(() => {
    if (!searchQuery.trim()) return archivedRuns
    
    const query = searchQuery.toLowerCase()
    return archivedRuns.map(run => ({
      ...run,
      tasks: run.tasks.filter(task => 
        task.name.toLowerCase().includes(query) ||
        task.id.toLowerCase().includes(query) ||
        task.prompt.toLowerCase().includes(query)
      ),
    })).filter(run => run.tasks.length > 0)
  }, [archivedRuns, searchQuery])

  const totalArchivedTasks = useMemo(() => 
    archivedRuns.reduce((sum, run) => sum + run.tasks.length, 0)
  , [archivedRuns])

  const openSessionModal = useCallback((sessionId: string) => {
    setSessionModal({ isOpen: true, sessionId })
  }, [])

  const closeSessionModal = useCallback(() => {
    setSessionModal({ isOpen: false, sessionId: null })
  }, [])

  const openTaskDetail = useCallback((task: ArchivedTask) => {
    setSelectedTask(task)
  }, [])

  const closeTaskDetail = useCallback(() => {
    setSelectedTask(null)
  }, [])

  const getStatusColor = (status: string): string => {
    if (status in STATUS_COLORS) {
      return STATUS_COLORS[status as StatusColorKey]
    }
    throw new Error(`Invalid status: "${status}". Expected one of: ${Object.keys(STATUS_COLORS).join(', ')}`)
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex items-center gap-3 text-dark-text-muted">
          <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading archived tasks...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="text-red-400 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-dark-text mb-2">Failed to Load Archived Tasks</h3>
          <p className="text-dark-text-muted mb-4">{error}</p>
          <button className="btn btn-primary" onClick={loadArchivedTasks}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-dark-surface3">
          <div>
            <h2 className="text-xl font-semibold text-dark-text flex items-center gap-2">
              <svg className="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              Archived Tasks
            </h2>
            <p className="text-sm text-dark-text-muted mt-1">
              {totalArchivedTasks} archived tasks across {archivedRuns.length} workflow runs
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm" onClick={expandAll}>
              Expand All
            </button>
            <button className="btn btn-sm" onClick={collapseAll}>
              Collapse All
            </button>
            <button className="btn btn-primary btn-sm" onClick={loadArchivedTasks}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="form-group">
          <div className="relative">
            <input
              type="text"
              className="form-input pl-10"
              placeholder="Search archived tasks by name, ID, or prompt..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <svg 
              className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-dark-text-muted" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* No Results */}
        {filteredRuns.length === 0 && (
          <div className="text-center py-12">
            <svg className="w-16 h-16 mx-auto mb-4 text-dark-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            <h3 className="text-lg font-medium text-dark-text mb-2">
              {searchQuery ? 'No matching archived tasks' : 'No archived tasks'}
            </h3>
            <p className="text-dark-text-muted">
              {searchQuery 
                ? 'Try adjusting your search query' 
                : 'Tasks that are archived will appear here grouped by workflow run'}
            </p>
          </div>
        )}

        {/* Archived Runs List */}
        <div className="space-y-3">
          {filteredRuns.map((run) => (
            <div 
              key={run.run.id} 
              className="border border-dark-surface3 rounded-lg overflow-hidden"
            >
              {/* Run Header */}
              <button
                className="w-full flex items-center justify-between p-4 bg-dark-surface hover:bg-dark-surface2 transition-colors text-left"
                onClick={() => toggleRunExpanded(run.run.id)}
              >
                <div className="flex items-center gap-3">
                  <svg 
                    className={`w-5 h-5 text-dark-text-muted transition-transform ${run.expanded ? 'rotate-90' : ''}`} 
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <div>
                    <div className="font-medium text-dark-text flex items-center gap-2">
                      {run.run.displayName}
                      <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(run.run.status)}`}>
                        {run.run.status}
                      </span>
                    </div>
                    <div className="text-xs text-dark-text-muted mt-1">
                      {formatLocalDateTime(run.run.createdAt)} • {run.taskCount} task{run.taskCount === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-dark-text-muted">
                    {run.tasks.length} archived
                  </span>
                </div>
              </button>

              {/* Tasks List */}
              {run.expanded && (
                <div className="border-t border-dark-surface3">
                  {run.tasks.length === 0 ? (
                    <div className="p-4 text-sm text-dark-text-muted text-center">
                      No archived tasks in this run
                    </div>
                  ) : (
                    <div className="divide-y divide-dark-surface3">
                      {run.tasks.map((task) => (
                        <div 
                          key={task.id} 
                          className="p-4 hover:bg-dark-surface/50 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs text-dark-text-muted">#{task.id}</span>
                                <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(task.status)}`}>
                                  {task.status}
                                </span>
                                {task.reviewCount > 0 && (
                                  <span className="text-xs px-2 py-0.5 rounded text-purple-400 bg-purple-500/10 flex items-center gap-1">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                    </svg>
                                    {task.reviewCount} {task.reviewCount === 1 ? 'review' : 'reviews'}
                                  </span>
                                )}
                                {task.sessionId && (
                                  <button
                                    className="text-xs text-accent-info hover:text-accent-primary flex items-center gap-1"
                                    onClick={() => openSessionModal(task.sessionId!)}
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                                    </svg>
                                    View Session
                                  </button>
                                )}
                              </div>
                              <h4 
                                className="font-medium text-dark-text truncate cursor-pointer hover:text-accent-primary"
                                onClick={() => openTaskDetail(task)}
                              >
                                {task.name}
                              </h4>
                              <p className="text-sm text-dark-text-muted line-clamp-2 mt-1">
                                {task.prompt}
                              </p>
                              <div className="flex items-center gap-4 mt-2 text-xs text-dark-text-muted">
                                {task.completedAt && (
                                  <span>Completed: {formatLocalDateTime(task.completedAt)}</span>
                                )}
                                {task.archivedAt && (
                                  <span>Archived: {formatLocalDateTime(task.archivedAt)}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Task Detail Modal */}
      {selectedTask && (
        <div
          className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50 p-4"
          onClick={closeTaskDetail}
        >
          <div
            className="bg-dark-surface2 rounded-lg shadow-xl w-[min(600px,calc(100vw-40px))] max-h-[80vh] flex flex-col border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-dark-text-muted">#{selectedTask.id}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(selectedTask.status)}`}>
                  {selectedTask.status}
                </span>
              </div>
              <button
                className="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={closeTaskDetail}
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <h3 className="text-lg font-medium text-dark-text mb-2">{selectedTask.name}</h3>
                <div className="bg-dark-surface rounded-lg p-3">
                  <h4 className="text-xs font-medium text-dark-text-muted uppercase mb-2">Prompt</h4>
                  <p className="text-sm text-dark-text whitespace-pre-wrap">{selectedTask.prompt}</p>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-dark-surface rounded-lg p-3">
                  <h4 className="text-xs font-medium text-dark-text-muted uppercase mb-2">Models</h4>
                  <div className="space-y-1 text-sm">
                    <div><span className="text-dark-text-muted">Plan:</span> <span className="text-dark-text">{selectedTask.planModel || 'Default'}</span></div>
                    <div><span className="text-dark-text-muted">Execution:</span> <span className="text-dark-text">{selectedTask.executionModel || 'Default'}</span></div>
                  </div>
                </div>
                <div className="bg-dark-surface rounded-lg p-3">
                  <h4 className="text-xs font-medium text-dark-text-muted uppercase mb-2">Execution</h4>
                  <div className="space-y-1 text-sm">
                    <div><span className="text-dark-text-muted">Branch:</span> <span className="text-dark-text">{selectedTask.branch || 'Default'}</span></div>
                    <div><span className="text-dark-text-muted">Strategy:</span> <span className="text-dark-text">{selectedTask.executionStrategy}</span></div>
                  </div>
                </div>
              </div>

              <div className="bg-dark-surface rounded-lg p-3">
                <h4 className="text-xs font-medium text-dark-text-muted uppercase mb-2">Timeline</h4>
                <div className="space-y-1 text-sm">
                  <div><span className="text-dark-text-muted">Created:</span> <span className="text-dark-text">{formatLocalDateTime(selectedTask.createdAt)}</span></div>
                  {selectedTask.completedAt && (
                    <div><span className="text-dark-text-muted">Completed:</span> <span className="text-dark-text">{formatLocalDateTime(selectedTask.completedAt)}</span></div>
                  )}
                  {selectedTask.archivedAt && (
                    <div><span className="text-dark-text-muted">Archived:</span> <span className="text-dark-text">{formatLocalDateTime(selectedTask.archivedAt)}</span></div>
                  )}
                </div>
              </div>

              {selectedTask.agentOutput && (
                <div className="bg-dark-surface rounded-lg p-3">
                  <h4 className="text-xs font-medium text-dark-text-muted uppercase mb-2">Agent Output</h4>
                  <p className="text-sm text-dark-text whitespace-pre-wrap">{selectedTask.agentOutput}</p>
                </div>
              )}

              {selectedTask.errorMessage && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <h4 className="text-xs font-medium text-red-400 uppercase mb-2">Error</h4>
                  <p className="text-sm text-red-300">{selectedTask.errorMessage}</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-dark-surface3">
              {selectedTask.sessionId && (
                <button 
                  className="btn btn-primary"
                  onClick={() => {
                    closeTaskDetail()
                    openSessionModal(selectedTask.sessionId!)
                  }}
                >
                  View Session
                </button>
              )}
              <button className="btn" onClick={closeTaskDetail}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {sessionModal.isOpen && sessionModal.sessionId && (
        <SessionModal
          sessionId={sessionModal.sessionId}
          onClose={closeSessionModal}
        />
      )}
    </div>
  )
}
