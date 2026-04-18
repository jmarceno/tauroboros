import { useState, useCallback, useMemo } from "react"
import { useApi } from "./useApi"
import type { WorkflowRun, ControlState } from "@/types"

export type StopType = "graceful" | "destructive" | null

export function useWorkflowControl(
  onStateChange?: (state: ControlState) => void,
  onRunUpdate?: (run: WorkflowRun) => void,
) {
  const api = useApi()

  const [currentRunId, setCurrentRunId] = useState<string | null>(null)
  const [controlState, setControlState] = useState<ControlState>('idle')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ killed?: number; cleaned?: number } | null>(null)

  // Stop confirmation state
  const [isConfirmingStop, setIsConfirmingStop] = useState(false)
  const [stopType, setStopType] = useState<StopType>(null)

  const isRunning = useMemo(() => controlState === 'running', [controlState])
  const isPaused = useMemo(() => controlState === 'paused', [controlState])
  const isStopping = useMemo(() => controlState === 'stopping', [controlState])
  const canPause = useMemo(() => controlState === 'running', [controlState])
  const canResume = useMemo(() => controlState === 'paused', [controlState])
  const canStop = useMemo(() => controlState === 'running' || controlState === 'paused', [controlState])

  const setState = useCallback((newState: ControlState) => {
    setControlState(newState)
    onStateChange?.(newState)
  }, [onStateChange])

  const setRun = useCallback((run: WorkflowRun | null) => {
    if (run) {
      setCurrentRunId(run.id)
      if (run.status === 'running') {
        setState('running')
      } else if (run.status === 'paused') {
        setState('paused')
      } else if (run.status === 'stopping') {
        setState('stopping')
      } else {
        setState('idle')
      }
      onRunUpdate?.(run)
    } else {
      setCurrentRunId(null)
      setState('idle')
    }
  }, [setState, onRunUpdate])

  const pause = useCallback(async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId
    if (!targetRunId) {
      setError('No active run to pause')
      return false
    }

    if (!canPause) {
      setError('Can only pause a running workflow')
      return false
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await api.pauseRun(targetRunId)
      if (result.success && result.run) {
        setRun(result.run)
        return true
      }
      return false
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setIsLoading(false)
    }
  }, [api, currentRunId, canPause, setRun])

  const resume = useCallback(async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId
    if (!targetRunId) {
      setError('No run to resume')
      return false
    }

    if (!canResume) {
      setError('Can only resume a paused workflow')
      return false
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await api.resumeRun(targetRunId)
      if (result.success && result.run) {
        setRun(result.run)
        return true
      }
      return false
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setIsLoading(false)
    }
  }, [api, currentRunId, canResume, setRun])

  const requestStop = useCallback((type: 'graceful' | 'destructive') => {
    setStopType(type)
    setIsConfirmingStop(true)
  }, [])

  const confirmStop = useCallback(async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId
    if (!targetRunId) {
      setError('No active run to stop')
      setIsConfirmingStop(false)
      return false
    }

    if (!stopType) {
      setError('No stop type specified')
      setIsConfirmingStop(false)
      return false
    }

    setIsLoading(true)
    setError(null)
    setIsConfirmingStop(false)
    setState('stopping')
    setLastResult(null)

    try {
      const result = await api.stopRun(targetRunId, { destructive: stopType === 'destructive' })
      if (result.success) {
        if (stopType === 'destructive') {
          setLastResult({ killed: result.killed, cleaned: result.cleaned })
        }
        if (result.run) {
          setRun(result.run)
        } else {
          setState('idle')
        }
        return true
      }
      return false
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('running')
      return false
    } finally {
      setIsLoading(false)
      setStopType(null)
    }
  }, [api, currentRunId, stopType, setState, setRun])

  const cancelStop = useCallback(() => {
    setIsConfirmingStop(false)
    setStopType(null)
  }, [])

  const stop = useCallback(async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId
    if (!targetRunId) {
      setError('No active run to stop')
      return false
    }

    if (!canStop) {
      setError('No running workflow to stop')
      return false
    }

    setIsLoading(true)
    setError(null)
    setState('stopping')

    try {
      const result = await api.stopRun(targetRunId, { destructive: false })
      if (result.success && result.run) {
        setRun(result.run)
        return true
      }
      return false
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('running')
      return false
    } finally {
      setIsLoading(false)
    }
  }, [api, currentRunId, canStop, setState, setRun])

  const forceStop = useCallback(async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId
    if (!targetRunId) {
      setError('No active run to stop')
      return false
    }

    setIsLoading(true)
    setError(null)
    setState('stopping')
    setLastResult(null)

    try {
      const result = await api.stopRun(targetRunId, { destructive: true })
      if (result.success) {
        setLastResult({ killed: result.killed, cleaned: result.cleaned })
        if (result.run) {
          setRun(result.run)
        } else {
          setState('idle')
        }
        return true
      }
      return false
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('running')
      return false
    } finally {
      setIsLoading(false)
    }
  }, [api, currentRunId, setState, setRun])

  const checkPausedState = useCallback(async (): Promise<boolean> => {
    try {
      const result = await api.getPausedState()
      if (result.hasPausedRun && result.state) {
        const state = result.state as { runId: string; status: string }
        if (state.runId) {
          setCurrentRunId(state.runId)
          if (state.status === 'paused') {
            setState('paused')
          }
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }, [api, setState])

  const updateStateFromRuns = useCallback((runs: WorkflowRun[]) => {
    const active = runs.find(r => r.status === 'running' || r.status === 'stopping' || r.status === 'paused')
    if (!active) {
      setState('idle')
      setCurrentRunId(null)
      return
    }

    setCurrentRunId(active.id)
    if (active.status === 'paused') {
      setState('paused')
    } else if (active.status === 'stopping') {
      setState('stopping')
    } else {
      setState('running')
    }
  }, [setState])

  const handleRunUpdate = useCallback((run: WorkflowRun) => {
    if (currentRunId === run.id || !currentRunId) {
      setRun(run)
    }
  }, [currentRunId, setRun])

  const clearRun = useCallback(() => {
    setCurrentRunId(null)
    setState('idle')
    setLastResult(null)
    setError(null)
  }, [setState])

  const contextValue = useMemo(() => ({
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
    pause,
    resume,
    stop,
    forceStop,
    requestStop,
    confirmStop,
    cancelStop,
    checkPausedState,
    handleRunUpdate,
    updateStateFromRuns,
    setRun,
    clearRun,
  }), [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    currentRunId, controlState, lastResult, isConfirmingStop, stopType,
    isRunning, isPaused, isStopping, canPause, canResume, canStop,
    pause, resume, stop, forceStop, requestStop, confirmStop, cancelStop,
    checkPausedState, handleRunUpdate, updateStateFromRuns, setRun, clearRun
  ])

  return contextValue
}
