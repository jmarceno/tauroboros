/**
 * BestOfNDetailModal Component - Best-of-N execution details
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, For, Show } from 'solid-js'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { uiStore } from '@/stores'
import { tasksApi, runApiEffect } from '@/api'
import type { Task, BestOfNSummary, TaskRun, Candidate } from '@/types'

interface BestOfNDetailModalProps {
  task?: Task
  onClose: () => void
  onSelectWinner: (sessionId: string) => Promise<void>
}

export function BestOfNDetailModal(props: BestOfNDetailModalProps) {
  const [summary, setSummary] = createSignal<BestOfNSummary | null>(null)
  const [taskRuns, setTaskRuns] = createSignal<TaskRun[]>([])
  const [candidates, setCandidates] = createSignal<Candidate[]>([])
  const [isLoading, setIsLoading] = createSignal(true)
  const [isSelecting, setIsSelecting] = createSignal(false)

  const taskId = () => props.task?.id

  createEffect(() => {
    const id = taskId()
    if (!id) return

    const loadData = async () => {
      setIsLoading(true)
      try {
        const [summaryData, runsData, candidatesData] = await Promise.all([
          runApiEffect(tasksApi.getBestOfNSummary(id)),
          runApiEffect(tasksApi.getTaskRuns(id)),
          runApiEffect(tasksApi.getTaskCandidates(id)),
        ])
        setSummary(summaryData)
        setTaskRuns(runsData)
        setCandidates(candidatesData)
      } catch (e) {
        uiStore.showToast('Failed to load details', 'error')
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  })

  const handleSelectWinner = async (candidateId: string) => {
    setIsSelecting(true)
    try {
      await props.onSelectWinner(candidateId)
      uiStore.showToast('Winner selected', 'success')
    } catch (e) {
      uiStore.showToast('Failed to select winner', 'error')
    } finally {
      setIsSelecting(false)
    }
  }

  return (
    <ModalWrapper title={`Best-of-N: ${props.task?.name || taskId() || 'Unknown'}`} onClose={props.onClose} size="lg">
      <div class="space-y-4 max-h-[60vh] overflow-y-auto">
        <Show
          when={!isLoading()}
          fallback={<div class="text-center py-8 text-dark-text-muted">Loading details...</div>}
        >
          <Show
            when={summary()}
            fallback={<div class="text-center py-8 text-dark-text-muted">No Best-of-N data for this task.</div>}
          >
            <div class="grid grid-cols-3 gap-4">
              <div class="stat-card">
                <div class="stat-value">{summary()!.workersDone}/{summary()!.workersTotal}</div>
                <div class="stat-label">Workers</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{summary()!.reviewersDone}/{summary()!.reviewersTotal}</div>
                <div class="stat-label">Reviewers</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{summary()!.availableCandidates}</div>
                <div class="stat-label">Candidates</div>
              </div>
            </div>

            <div class="border-t border-dark-border pt-4">
              <h4 class="text-sm font-medium mb-2">Task Runs</h4>
              <Show
                when={taskRuns().length > 0}
                fallback={<div class="text-dark-text-muted text-sm">No task runs yet.</div>}
              >
                <For each={taskRuns()}>
                  {(run) => (
                    <div class="session-entry mb-2">
                      <div class="flex items-center gap-2">
                        <span class={`w-2 h-2 rounded-full ${
                          run.status === 'done' ? 'bg-accent-success' :
                          run.status === 'failed' ? 'bg-accent-danger' :
                          run.status === 'running' ? 'bg-accent-warning' :
                          'bg-dark-text-muted'
                        }`} />
                        <span class="text-sm">{run.phase}</span>
                        <span class="text-xs text-dark-text-muted">({run.status})</span>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <div class="border-t border-dark-border pt-4">
              <h4 class="text-sm font-medium mb-2">Candidates</h4>
              <Show
                when={candidates().length > 0}
                fallback={<div class="text-dark-text-muted text-sm">No candidates yet.</div>}
              >
                <For each={candidates()}>
                  {(candidate) => (
                    <div class="session-entry mb-2">
                      <div class="flex items-center justify-between">
                        <span class={`text-sm ${
                          candidate.status === 'selected' ? 'text-accent-success' :
                          candidate.status === 'rejected' ? 'text-accent-danger' :
                          'text-dark-text'
                        }`}>
                          {candidate.status === 'selected' ? '✓ ' : ''}
                          Candidate {candidate.id.slice(0, 8)}
                        </span>
                        <div class="flex items-center gap-2">
                          <span class="text-xs text-dark-text-muted">({candidate.status})</span>
                          <Show when={candidate.status === 'pending'}>
                            <button
                              class="btn btn-xs btn-primary"
                              onClick={() => handleSelectWinner(candidate.id)}
                              disabled={isSelecting()}
                            >
                              {isSelecting() ? '...' : 'Select'}
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </ModalWrapper>
  )
}
