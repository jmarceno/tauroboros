import { useState, useCallback, useMemo } from "react"
import type { Options } from "@/types"
import { useApi } from "./useApi"

export function useOptions() {
  const api = useApi()
  const [options, setOptions] = useState<Options | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadOptions = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await api.getOptions()
      setOptions(data)
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
    }
  }, [api])

  const saveOptions = useCallback(async (data: Partial<Options>) => {
    const updated = await api.updateOptions(data)
    setOptions(updated)
    return updated
  }, [api])

  const startExecution = useCallback(async () => {
    return await api.startExecution()
  }, [api])

  const stopExecution = useCallback(async () => {
    return await api.stopExecution()
  }, [api])

  const contextValue = useMemo(() => ({
    options,
    isLoading,
    error,
    loadOptions,
    saveOptions,
    updateOptions: saveOptions,
    startExecution,
    stopExecution,
  }), [options, isLoading, error, loadOptions, saveOptions, startExecution, stopExecution])

  return contextValue
}
