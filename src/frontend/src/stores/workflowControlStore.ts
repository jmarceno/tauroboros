/**
 * Workflow Control Store - Workflow execution control
 * Replaces: WorkflowControlContext
 */

import { createSignal, createMemo } from 'solid-js'
import { Effect } from 'effect'
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

  const getErrorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback

  const checkPausedStateEffect = () =>
    api.runsApi.getPausedState().pipe(
      Effect.map((paused) => {
      const pausedState = paused.state as { runId?: unknown } | null

      if (paused.hasPausedRun && pausedState && typeof pausedState.runId === 'string') {
        setCurrentRunId(pausedState.runId)
        setControlState('paused')
        return true
      }
      return false
      }),
      Effect.catchAll(() => Effect.succeed(false)),
    )

  const checkPausedState = () => runApi(checkPausedStateEffect())

  const pauseEffect = (runId?: string) => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      return Effect.sync(() => {
        setError('No active run to pause')
        return false
      })
    }

    return Effect.sync(() => {
      setIsLoading(true)
      setError(null)
      setControlState('pausing')
    }).pipe(
      Effect.flatMap(() => api.runsApi.pause(targetId)),
      Effect.map((result) => {
        if (result.success) {
          setControlState('paused')
          onStateChange?.('paused')
          return true
        }

        setError('Failed to pause run')
        setControlState('running')
        return false
      }),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          setError(getErrorMessage(error, 'Pause failed'))
          setControlState('running')
          return false
        })
      ),
      Effect.ensuring(Effect.sync(() => setIsLoading(false))),
    )
  }

  const pause = (runId?: string) => runApi(pauseEffect(runId))

  const resumeEffect = (runId?: string) => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      return Effect.sync(() => {
        setError('No active run to resume')
        return false
      })
    }

    return Effect.sync(() => {
      setIsLoading(true)
      setError(null)
      setControlState('resuming')
    }).pipe(
      Effect.flatMap(() => api.runsApi.resume(targetId)),
      Effect.map((result) => {
        if (result.success) {
          setControlState('running')
          onStateChange?.('running')
          return true
        }

        setError('Failed to resume run')
        setControlState('paused')
        return false
      }),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          setError(getErrorMessage(error, 'Resume failed'))
          setControlState('paused')
          return false
        })
      ),
      Effect.ensuring(Effect.sync(() => setIsLoading(false))),
    )
  }

  const resume = (runId?: string) => runApi(resumeEffect(runId))

  const stopEffect = (runId?: string) => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      return Effect.sync(() => {
        setError('No active run to stop')
        return false
      })
    }

    return Effect.sync(() => {
      setIsLoading(true)
      setError(null)
    }).pipe(
      Effect.flatMap(() => api.runsApi.stop(targetId)),
      Effect.map((result) => {
        if (result.success) {
          setControlState('idle')
          setCurrentRunId(null)
          onStateChange?.('idle')
          return true
        }

        setError('Failed to stop run')
        return false
      }),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          setError(getErrorMessage(error, 'Stop failed'))
          return false
        })
      ),
      Effect.ensuring(Effect.sync(() => setIsLoading(false))),
    )
  }

  const stop = (runId?: string) => runApi(stopEffect(runId))

  const forceStopEffect = (runId?: string) => {
    const targetId = runId || currentRunId()
    if (!targetId) {
      return Effect.sync(() => {
        setError('No active run to stop')
        return false
      })
    }

    return Effect.sync(() => {
      setIsLoading(true)
      setError(null)
    }).pipe(
      Effect.flatMap(() => api.runsApi.forceStop(targetId)),
      Effect.map((result) => {
        if (result.success) {
          setLastResult({ killed: result.killed, cleaned: result.cleaned })
          setControlState('idle')
          setCurrentRunId(null)
          onStateChange?.('idle')
          return true
        }

        setError('Failed to force stop')
        return false
      }),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          setError(getErrorMessage(error, 'Force stop failed'))
          return false
        })
      ),
      Effect.ensuring(Effect.sync(() => setIsLoading(false))),
    )
  }

  const forceStop = (runId?: string) => runApi(forceStopEffect(runId))

  const requestStop = (type: 'graceful' | 'destructive') => {
    setIsConfirmingStop(true)
    setStopType(type)
  }

  const confirmStop = (runId?: string) => {
    const type = stopType()
    if (!type) {
      setError('No stop type specified')
      return Promise.resolve(false)
    }

    if (type === 'graceful') {
      return runApi(pauseEffect(runId))
    }

    return runApi(forceStopEffect(runId))
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
