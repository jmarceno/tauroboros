/**
 * Sidebar Component - Left sidebar with stats and controls
 * Ported from React to SolidJS - Full feature parity
 */

import { createMemo } from 'solid-js'
import type { ControlState } from '@/types'
import { createVersionStore } from '@/stores'

interface SidebarProps {
  consumedSlots: number
  parallelTasks: number
  controlState: ControlState
  canPause: boolean
  canResume: boolean
  canStop: boolean
  isControlLoading: boolean
  isPaused: boolean
  activeRunId: string | null
  totalTasks?: number
  doneCount?: number
  activeCount?: number
  reviewCount?: number
  onToggleExecution: () => void
  onPauseExecution: (runId: string) => void
  onResumeExecution: (runId: string) => void
  onStopExecution: (type: 'graceful' | 'destructive') => void
  onOpenTemplateModal: () => void
  onOpenTaskModal: () => void
  onArchiveAllDone: () => void
  onTogglePlanningChat: () => void
}

export function Sidebar(props: SidebarProps) {
  const versionStore = createVersionStore()
  const isRunning = () => props.consumedSlots > 0
  const freeSlots = () => props.parallelTasks - props.consumedSlots

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 bg-accent-primary rounded-md flex items-center justify-center flex-shrink-0">
            <svg class="w-4 h-4 text-dark-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9"/>
            </svg>
          </div>
          <span class="sidebar-title text-sm font-bold text-accent-primary whitespace-nowrap">TaurOboros</span>
        </div>
      </div>

      <div class="sidebar-content overflow-y-auto">
        <div class="sidebar-section">
          <div class="sidebar-section-title">Overview ({props.totalTasks ?? 0})</div>
          <div class="grid grid-cols-2 gap-2">
            <div class="stat-card">
              <div class="stat-value">{props.totalTasks ?? 0}</div>
              <div class="stat-label">Total</div>
            </div>
            <div class="stat-card">
              <div class="stat-value text-accent-success">{props.doneCount ?? 0}</div>
              <div class="stat-label">Done</div>
            </div>
            <div class="stat-card">
              <div class="stat-value text-blue-400">{props.activeCount ?? 0}</div>
              <div class="stat-label">Active</div>
            </div>
            <div class="stat-card">
              <div class="stat-value text-accent-warning">{props.reviewCount ?? 0}</div>
              <div class="stat-label">Review</div>
            </div>
          </div>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Workflow Control</div>

          <div class="action-group">
            <button
              class={`sidebar-btn primary ${isRunning() || props.controlState === 'paused' || props.isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={isRunning() || props.controlState === 'paused' || props.isControlLoading}
              onClick={props.onToggleExecution}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span class="sidebar-label">Start Workflow</span>
            </button>

            <button
              class={`sidebar-btn warning ${!props.canPause || !isRunning() || props.isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={!props.canPause || !isRunning() || props.isControlLoading}
              onClick={() => props.activeRunId && props.onPauseExecution(props.activeRunId)}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="6" width="4" height="12" rx="1"/>
                <rect x="14" y="6" width="4" height="12" rx="1"/>
              </svg>
              <span class="sidebar-label">Pause</span>
            </button>

            <button
              class={`sidebar-btn primary ${!props.canResume || (props.controlState !== 'paused' && !props.isPaused) || props.isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={!props.canResume || (props.controlState !== 'paused' && !props.isPaused) || props.isControlLoading}
              onClick={() => props.activeRunId && props.onResumeExecution(props.activeRunId)}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span class="sidebar-label">Resume</span>
            </button>

            <button
              class={`sidebar-btn danger ${!props.canStop || (!isRunning() && props.controlState !== 'paused' && !props.isPaused) || props.isControlLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={!props.canStop || (!isRunning() && props.controlState !== 'paused' && !props.isPaused) || props.isControlLoading}
              onClick={() => props.onStopExecution('destructive')}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
              <span class="sidebar-label">Stop</span>
            </button>
          </div>

          <button class="sidebar-btn" onClick={props.onOpenTemplateModal}>
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            <span class="sidebar-label">New Template</span>
          </button>

          <button class="sidebar-btn" onClick={props.onOpenTaskModal}>
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 4v16m8-8H4"/>
            </svg>
            <span class="sidebar-label">New Task</span>
          </button>

          <button class="sidebar-btn" onClick={props.onArchiveAllDone}>
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <span class="sidebar-label">Archive Done</span>
          </button>

          <button class="sidebar-btn" onClick={props.onTogglePlanningChat}>
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span class="sidebar-label">Planning Chat</span>
          </button>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Status</div>
          <div class="system-badge">
            <div
              class={`status-dot ${isRunning() ? 'pulse' : ''}`}
              style={{ '--status-color': isRunning() ? '#00ff88' : '#6a6a80' }}
            />
            <span class={`text-xs ${isRunning() ? 'text-accent-success' : 'text-dark-text-muted'}`}>
              {freeSlots()}/{props.parallelTasks} Slots Free
            </span>
          </div>
        </div>

        {versionStore.version() && (
          <div class="version-section">
            <div class="version-display">
              {versionStore.version()}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
