import { useState, memo } from 'react'
import { useVersion } from '@/hooks'
import type { ControlState } from '@/types'

interface SidebarProps {
  consumedSlots: number
  parallelTasks: number
  isConnected: boolean
  controlState: ControlState
  canPause: boolean
  canResume: boolean
  canStop: boolean
  isControlLoading: boolean
  isPaused: boolean
  activeRunId: string | null
  onToggleExecution: () => void
  onPauseExecution: (runId: string) => void
  onResumeExecution: (runId: string) => void
  onStopExecution: (type: 'graceful' | 'destructive') => void
  onOpenOptions: () => void
  onOpenContainerConfig: () => void
  onOpenTemplateModal: () => void
  onOpenTaskModal: () => void
  onArchiveAllDone: () => void
  onTogglePlanningChat: () => void
  totalTasks?: number
  doneCount?: number
  activeCount?: number
  reviewCount?: number
  isContainerEnabled?: boolean
}

export const Sidebar = memo(function Sidebar({
  consumedSlots,
  parallelTasks,
  isConnected,
  controlState,
  canPause,
  canResume,
  canStop,
  isControlLoading,
  isPaused,
  activeRunId,
  onToggleExecution,
  onPauseExecution,
  onResumeExecution,
  onStopExecution,
  onOpenOptions,
  onOpenContainerConfig,
  onOpenTemplateModal,
  onOpenTaskModal,
  onArchiveAllDone,
  onTogglePlanningChat,
  totalTasks = 0,
  doneCount = 0,
  activeCount = 0,
  reviewCount = 0,
  isContainerEnabled = false,
}: SidebarProps) {
  const { version } = useVersion()
  const isRunning = consumedSlots > 0
  const freeSlots = parallelTasks - consumedSlots

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-accent-primary rounded-md flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-dark-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9"/>
            </svg>
          </div>
          <span className="sidebar-title text-sm font-bold text-accent-primary whitespace-nowrap">TaurOboros</span>
        </div>
      </div>

      <div className="sidebar-content overflow-y-auto">
        <div className="sidebar-section">
          <div className="sidebar-section-title">Overview ({totalTasks})</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="stat-card">
              <div className="stat-value">{totalTasks}</div>
              <div className="stat-label">Total</div>
            </div>
            <div className="stat-card">
              <div className="stat-value text-accent-success">{doneCount}</div>
              <div className="stat-label">Done</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: '#60a5fa' }}>{activeCount}</div>
              <div className="stat-label">Active</div>
            </div>
            <div className="stat-card">
              <div className="stat-value text-accent-warning">{reviewCount}</div>
              <div className="stat-label">Review</div>
            </div>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">Workflow Control</div>

          <div className="action-group">
            <button
              className={`sidebar-btn primary ${isRunning || controlState === 'paused' || isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={isRunning || controlState === 'paused' || isControlLoading}
              onClick={onToggleExecution}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span className="sidebar-label">Start Workflow</span>
            </button>

            <button
              className={`sidebar-btn warning ${!canPause || !isRunning || isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={!canPause || !isRunning || isControlLoading}
              onClick={() => activeRunId && onPauseExecution(activeRunId)}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="6" y="6" width="4" height="12" rx="1"/>
                <rect x="14" y="6" width="4" height="12" rx="1"/>
              </svg>
              <span className="sidebar-label">Pause</span>
            </button>

            <button
              className={`sidebar-btn primary ${!canResume || (controlState !== 'paused' && !isPaused) || isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={!canResume || (controlState !== 'paused' && !isPaused) || isControlLoading}
              onClick={() => activeRunId && onResumeExecution(activeRunId)}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span className="sidebar-label">Resume</span>
            </button>

            <button
              className={`sidebar-btn danger ${!canStop || (!isRunning && controlState !== 'paused' && !isPaused) || isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={!canStop || (!isRunning && controlState !== 'paused' && !isPaused) || isControlLoading}
              onClick={() => onStopExecution('destructive')}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
              <span className="sidebar-label">Stop</span>
            </button>
          </div>

          <button className="sidebar-btn" onClick={onOpenTemplateModal}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            <span className="sidebar-label">New Template</span>
          </button>

          <button className="sidebar-btn" onClick={onOpenTaskModal}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 4v16m8-8H4"/>
            </svg>
            <span className="sidebar-label">New Task</span>
          </button>

          <button className="sidebar-btn" onClick={onArchiveAllDone}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <span className="sidebar-label">Archive Done</span>
          </button>

          <button className="sidebar-btn" onClick={onTogglePlanningChat}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="sidebar-label">Planning Chat</span>
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">Configuration</div>
          <button className="sidebar-btn" onClick={onOpenOptions}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v6m0 6v6m4.22-10.22l4.24-4.24M6.34 17.66l-4.24 4.24M23 12h-6m-6 0H1m20.24 4.24l-4.24-4.24M6.34 6.34L2.1 2.1"/>
            </svg>
            <span className="sidebar-label">Options</span>
          </button>

          <button
            className={`sidebar-btn ${!isContainerEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            disabled={!isContainerEnabled}
            title={isContainerEnabled ? 'Container configuration' : 'Container mode is disabled. Enable it in .tauroboros/settings.json'}
            onClick={onOpenContainerConfig}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
              <path d="M4 12h16M12 4v16"/>
            </svg>
            <span className="sidebar-label">Containers</span>
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">Status</div>
          <div className="system-badge">
            <div
              className={`status-dot ${isRunning ? 'pulse' : ''}`}
              style={{ '--status-color': isRunning ? '#00ff88' : '#6a6a80' } as React.CSSProperties}
            />
            <span className={`text-xs ${isRunning ? 'text-accent-success' : 'text-dark-text-muted'}`}>
              {freeSlots}/{parallelTasks} Slots Free
            </span>
          </div>
        </div>

        {version && (
          <div className="version-section">
            <div className="version-display">
              {version}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
})
