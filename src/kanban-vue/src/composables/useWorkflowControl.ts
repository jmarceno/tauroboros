import { ref, computed } from 'vue'
import { useApi } from './useApi'
import type { WorkflowRun } from '@/types/api'

export type WorkflowControlState = 'idle' | 'running' | 'paused' | 'stopping'
export type StopType = 'graceful' | 'destructive' | null

export function useWorkflowControl(
  onStateChange?: (state: WorkflowControlState) => void,
  onRunUpdate?: (run: WorkflowRun) => void,
) {
  const api = useApi()

  const currentRunId = ref<string | null>(null)
  const controlState = ref<WorkflowControlState>('idle')
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const lastResult = ref<{ killed?: number; cleaned?: number } | null>(null)

  // Stop confirmation state
  const isConfirmingStop = ref(false)
  const stopType = ref<StopType>(null)

  const isRunning = computed(() => controlState.value === 'running')
  const isPaused = computed(() => controlState.value === 'paused')
  const isStopping = computed(() => controlState.value === 'stopping')
  const canPause = computed(() => controlState.value === 'running')
  const canResume = computed(() => controlState.value === 'paused')
  const canStop = computed(() => controlState.value === 'running' || controlState.value === 'paused')

  const setState = (newState: WorkflowControlState) => {
    controlState.value = newState
    onStateChange?.(newState)
  }

  const setRun = (run: WorkflowRun | null) => {
    if (run) {
      currentRunId.value = run.id
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
      currentRunId.value = null
      setState('idle')
    }
  }

  /**
   * Pause the current workflow run.
   * This kills active processes but preserves state for resume.
   */
  const pause = async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId.value
    if (!targetRunId) {
      error.value = 'No active run to pause'
      return false
    }

    if (!canPause.value) {
      error.value = 'Can only pause a running workflow'
      return false
    }

    isLoading.value = true
    error.value = null

    try {
      const result = await api.pauseRun(targetRunId)
      if (result.success && result.run) {
        setRun(result.run)
        return true
      }
      return false
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Resume a paused workflow run.
   * This restarts containers if needed and continues execution.
   */
  const resume = async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId.value
    if (!targetRunId) {
      error.value = 'No run to resume'
      return false
    }

    if (!canResume.value) {
      error.value = 'Can only resume a paused workflow'
      return false
    }

    isLoading.value = true
    error.value = null

    try {
      const result = await api.resumeRun(targetRunId)
      if (result.success && result.run) {
        setRun(result.run)
        return true
      }
      return false
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Request a stop with a specific type (graceful or destructive).
   * This opens the confirmation modal.
   */
  const requestStop = (type: 'graceful' | 'destructive') => {
    stopType.value = type
    isConfirmingStop.value = true
  }

  /**
   * Confirm the stop after user confirmation.
   * This performs either graceful or destructive stop based on stopType.
   */
  const confirmStop = async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId.value
    if (!targetRunId) {
      error.value = 'No active run to stop'
      isConfirmingStop.value = false
      return false
    }

    if (!stopType.value) {
      error.value = 'No stop type specified'
      isConfirmingStop.value = false
      return false
    }

    isLoading.value = true
    error.value = null
    isConfirmingStop.value = false
    setState('stopping')
    lastResult.value = null

    try {
      // Use unified stop endpoint with destructive parameter
      const result = await api.stopRun(targetRunId, { destructive: stopType.value === 'destructive' })
      if (result.success) {
        if (stopType.value === 'destructive') {
          lastResult.value = { killed: result.killed, cleaned: result.cleaned }
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
      error.value = e instanceof Error ? e.message : String(e)
      setState('running')
      return false
    } finally {
      isLoading.value = false
      stopType.value = null
    }
  }

  /**
   * Cancel the stop request and close the confirmation modal.
   */
  const cancelStop = () => {
    isConfirmingStop.value = false
    stopType.value = null
  }

  /**
   * Gracefully stop the current workflow run.
   * This sets a flag that will be checked in the execution loop.
   * @deprecated Use requestStop('graceful') and confirmStop() instead
   */
  const stop = async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId.value
    if (!targetRunId) {
      error.value = 'No active run to stop'
      return false
    }

    if (!canStop.value) {
      error.value = 'No running workflow to stop'
      return false
    }

    isLoading.value = true
    error.value = null
    setState('stopping')

    try {
      const result = await api.stopRun(targetRunId, { destructive: false })
      if (result.success && result.run) {
        setRun(result.run)
        return true
      }
      return false
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      setState('running')
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Force stop the current workflow run.
   * This immediately kills all processes and cleans up.
   * Requires confirmation from the user.
   * @deprecated Use requestStop('destructive') and confirmStop() instead
   */
  const forceStop = async (runId?: string): Promise<boolean> => {
    const targetRunId = runId || currentRunId.value
    if (!targetRunId) {
      error.value = 'No active run to stop'
      return false
    }

    isLoading.value = true
    error.value = null
    setState('stopping')
    lastResult.value = null

    try {
      // Use unified stop endpoint with destructive parameter
      const result = await api.stopRun(targetRunId, { destructive: true })
      if (result.success) {
        lastResult.value = { killed: result.killed, cleaned: result.cleaned }
        if (result.run) {
          setRun(result.run)
        } else {
          setState('idle')
        }
        return true
      }
      return false
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      setState('running')
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Check if there's a paused run that can be resumed.
   */
  const checkPausedState = async (): Promise<boolean> => {
    try {
      const result = await api.getPausedState()
      if (result.hasPausedRun && result.state) {
        const state = result.state as { runId: string; status: string }
        if (state.runId) {
          currentRunId.value = state.runId
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
  }

  /**
   * Update state from an array of workflow runs.
   * Finds the active run (running, stopping, or paused) and sets state accordingly.
   */
  const updateStateFromRuns = (runs: WorkflowRun[]) => {
    const active = runs.find(r => r.status === 'running' || r.status === 'stopping' || r.status === 'paused')
    if (!active) {
      setState('idle')
      currentRunId.value = null
      return
    }

    currentRunId.value = active.id
    if (active.status === 'paused') {
      setState('paused')
    } else if (active.status === 'stopping') {
      setState('stopping')
    } else {
      setState('running')
    }
  }

  /**
   * Update state from a WebSocket run update.
   */
  const handleRunUpdate = (run: WorkflowRun) => {
    if (currentRunId.value === run.id || !currentRunId.value) {
      setRun(run)
    }
  }

  /**
   * Clear the current run reference (e.g., after archiving).
   */
  const clearRun = () => {
    currentRunId.value = null
    setState('idle')
    lastResult.value = null
    error.value = null
  }

  return {
    // State
    currentRunId,
    controlState,
    isLoading,
    error,
    lastResult,
    isConfirmingStop,
    stopType,

    // Computed
    isRunning,
    isPaused,
    isStopping,
    canPause,
    canResume,
    canStop,

    // Actions
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
  }
}
