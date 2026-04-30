/**
 * Runs Store - Workflow run management
 * Replaces: RunsContext
 */

import { createMemo } from 'solid-js'
import { createQuery, useQueryClient, createMutation } from '@tanstack/solid-query'
import type { WorkflowRun } from '@/types'
import * as api from '@/api'

const queryKeys = {
  runs: {
    all: ['runs'] as const,
    lists: () => [...queryKeys.runs.all, 'list'] as const,
  },
}

export function createRunsStore() {
  const queryClient = useQueryClient()
  const runApi = api.runApiEffect

  // Query
  const runsQuery = createQuery(() => ({
    queryKey: queryKeys.runs.lists(),
    queryFn: () => runApi(api.runsApi.getAll()),
    staleTime: 3000,
  }))

  const runs = createMemo(() => runsQuery.data || [])
  const isLoading = () => runsQuery.isLoading
  const error = () => runsQuery.error?.message || null

  // Derived state
  const activeRuns = createMemo(() => 
    runs().filter(r => r.status === 'queued' || r.status === 'running' || r.status === 'paused')
  )

  const staleRuns = createMemo(() => 
    runs().filter(r => r.status === 'completed' || r.status === 'failed')
  )

  const hasStaleRuns = createMemo(() => staleRuns().length > 0)

  const consumedRunSlots = createMemo(() => activeRuns().length)

  // Helper functions
  const isStaleRun = (run: WorkflowRun) => {
    return run.status === 'completed' || run.status === 'failed'
  }

  const getTaskRunLock = (taskId: string): WorkflowRun | null => {
    return activeRuns().find(r => r.taskOrder.includes(taskId)) || null
  }

  const isTaskMutationLocked = (taskId: string): boolean => {
    const run = getTaskRunLock(taskId)
    return run !== null && (run.status === 'queued' || run.status === 'running')
  }

  const getTaskRunColor = (taskId: string): string | null => {
    const run = getTaskRunLock(taskId)
    return run?.color || null
  }

  const isTaskInRun = (taskId: string, runId: string | null): boolean => {
    if (!runId) return false
    const run = runs().find(r => r.id === runId)
    return run ? run.taskOrder.includes(taskId) : false
  }

  const getRunProgressLabel = (run: WorkflowRun): string => {
    if (!run) return ''
    const current = Math.min(run.currentTaskIndex + (run.currentTaskId ? 1 : 0), run.taskOrder.length)
    const total = run.taskOrder.length
    return `${current}/${total}`
  }

  // Actions
  const loadRuns = () => Promise.resolve(queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() })).then(() => undefined)

  const updateRunFromWebSocket = (run: WorkflowRun) => {
    queryClient.setQueryData(queryKeys.runs.lists(), (old: WorkflowRun[] | undefined) => {
      if (!old) return [run]
      const index = old.findIndex(r => r.id === run.id)
      if (index >= 0) {
        const next = [...old]
        next[index] = run
        return next
      }
      return [...old, run]
    })
  }

  const removeRun = (id: string) => {
    queryClient.setQueryData(queryKeys.runs.lists(), (old: WorkflowRun[] | undefined) => {
      if (!old) return []
      return old.filter(r => r.id !== id)
    })
  }

  // Mutations
  const pauseRunMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.runsApi.pause(id)),
    onSuccess: () => {
      void loadRuns()
    },
  }))

  const resumeRunMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.runsApi.resume(id)),
    onSuccess: () => {
      void loadRuns()
    },
  }))

  const stopRunMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.runsApi.stop(id)),
    onSuccess: () => {
      void loadRuns()
    },
  }))

  const archiveRunMutation = createMutation(() => ({
    mutationFn: (id: string) => runApi(api.runsApi.archive(id)),
    onSuccess: () => {
      void loadRuns()
    },
  }))

  const pauseRun = (id: string) => pauseRunMutation.mutateAsync(id)

  const resumeRun = (id: string) => resumeRunMutation.mutateAsync(id)

  const stopRun = (id: string) => stopRunMutation.mutateAsync(id)

  const archiveRun = (id: string) => archiveRunMutation.mutateAsync(id)

  return {
    runs,
    activeRuns,
    staleRuns,
    hasStaleRuns,
    consumedRunSlots,
    isLoading,
    error,
    isStaleRun,
    getTaskRunLock,
    isTaskMutationLocked,
    getTaskRunColor,
    isTaskInRun,
    getRunProgressLabel,
    loadRuns,
    updateRunFromWebSocket,
    removeRun,
    pauseRun,
    resumeRun,
    stopRun,
    archiveRun,
  }
}
