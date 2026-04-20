/**
 * Workflow Control Store - Workflow execution control
 * Replaces: WorkflowControlContext
 */

import { createSignal, createMemo } from 'solid-js'
import type { WorkflowRun, ControlState } from '@/types'
import * as api from '@/api'

export function createWorkflowControlStore(
  onStateChange?: (state: ControlState) => void,
  onRunUpdate?: (run: WorkflowRun) => void
) {
  const runApi = api.runApiEffect
  const [currentRunId, setCurrentRunId] = createSignal<string | null>(null)
  const [controlState, setControlState] = createSignal<ControlState>('idle')
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [lastResult, setLastResult] = createSignal<{ killed?: number; cleaned?: number } | null>(null)
  const [isConfirmingStop, setIsConfirmingStop] = createSignal(false)
  const [stopType, setStopType] = createSignal<'graceful' | 'destructive' | null>(null)

  // Derived state
  const isRunning = createMemo(() => controlState() === 'running')
  const isPaused = createMemo(() => controlState() === 'paused')
  const isStopping = createMemo(() => controlState() === 'stopping')
  const canPause = createMemo(() => isRunning() && !isPaused())
  const canResume = createMemo(() => isPaused())
  const canStop = createMemo(() => isRunning() || isPaused())

  // Actions
  const setRun = (run: WorkflowRun | null) => {
    if (run) {
      setCurrentRunId(run.id)
      updateStateFromRuns([run])
    } else {
      setCurrentRunId(null)
      setControlState('idle')
    }
  }

  const clearRun = () => {
    setCurrentRunId(null)
    setControlState('idle')
  }

  const updateStateFromRuns = (runs: WorkflowRun[]) => {
    const active = runs.find(r => r.status === 'queued' || r.status === 'running' || r.status === 'paused')
    if (!active) {
      setControlState('idle')
      return
    }

    if (active.status === 'paused') {
      setControlState('paused')
    } else if (active.pauseRequested) {
      setControlState('pausing')
    } else if (active.stopRequested) {
      setControlState('stopping')
    } else {
      setControlState('running')
    }
  }

  const handleRunUpdate = (run: WorkflowRun) => {
    onRunUpdate?.(run)
    updateStateFromRuns([run])
  }

  const checkPausedState = async (): Promise<boolean> => {
    try {
      const paused = await runApi(api.runsApi.getPausedState())
      const pausedState = paused.state as { runId?: unknown } | null

      if (paused.hasPausedRun && pausedState && typeof pausedState.runId === 'string') {
        setCurrentRunId(pausedState.runId)
        setControlState('paused')
        return true
      }
      return false
    } catch (e) {
      return false
    }
  }

  const pause = async (runId?: string): Promise<boolean> => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      setError('No active run to pause')
      return false
    }

    setIsLoading(true)
    setError(null)
    setControlState('pausing')

    try {
      const result = await runApi(api.runsApi.pause(targetId))
      if (result.success) {
        setControlState('paused')
        onStateChange?.('paused')
        return true
      } else {
        setError('Failed to pause run')
        setControlState('running')
        return false
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pause failed')
      setControlState('running')
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const resume = async (runId?: string): Promise<boolean> => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      setError('No active run to resume')
      return false
    }

    setIsLoading(true)
    setError(null)
    setControlState('resuming')

    try {
      const result = await runApi(api.runsApi.resume(targetId))
      if (result.success) {
        setControlState('running')
        onStateChange?.('running')
        return true
      } else {
        setError('Failed to resume run')
        setControlState('paused')
        return false
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resume failed')
      setControlState('paused')
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const stop = async (runId?: string): Promise<boolean> => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      setError('No active run to stop')
      return false
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await runApi(api.runsApi.stop(targetId))
      if (result.success) {
        setControlState('idle')
        setCurrentRunId(null)
        onStateChange?.('idle')
        return true
      } else {
        setError('Failed to stop run')
        return false
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed')
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const forceStop = async (runId?: string): Promise<boolean> => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      setError('No active run to stop')
      return false
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await runApi(api.runsApi.forceStop(targetId))
      if (result.success) {
        setLastResult({ killed: result.killed, cleaned: result.cleaned })
        setControlState('idle')
        setCurrentRunId(null)
        onStateChange?.('idle')
        return true
      } else {
        setError('Failed to force stop')
        return false
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Force stop failed')
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const requestStop = (type: 'graceful' | 'destructive') => {
    setIsConfirmingStop(true)
    setStopType(type)
  }

  const confirmStop = async (runId?: string): Promise<boolean> => {
    const type = stopType()
    if (!type) {
      setError('No stop type specified')
      return false
    }

    if (type === 'graceful') {
      return await pause(runId)
    } else {
      return await forceStop(runId)
    }
  }

  const cancelStop = () => {
    setIsConfirmingStop(false)
    setStopType(null)
  }

  return {
    currentRunId,
    controlState,
    isLoading,
    error,
    lastResult,
    isConfirmingStop,
    stopType,
    isRunning,
    isPaused,
    isStopping,
    canPause,
    canResume,
    canStop,
    setRun,
    clearRun,
    updateStateFromRuns,
    handleRunUpdate,
    checkPausedState,
    pause,
    resume,
    stop,
    forceStop,
    requestStop,
    confirmStop,
    cancelStop,
  }
}
