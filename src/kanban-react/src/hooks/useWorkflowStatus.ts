import { useState, useEffect, useCallback, useMemo } from "react"

export function useWorkflowStatus() {
  const [hasRunningWorkflows, setHasRunningWorkflows] = useState(false)

  const checkStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/workflow/status")
      if (response.ok) {
        const data = await response.json()
        setHasRunningWorkflows(data.hasRunningWorkflows)
      }
    } catch {
      // Silent fail - status check is non-critical
    }
  }, [])

  useEffect(() => {
    checkStatus()
    const interval = setInterval(checkStatus, 5000)
    return () => clearInterval(interval)
  }, [checkStatus])

  const contextValue = useMemo(() => ({
    hasRunningWorkflows,
    checkStatus,
  }), [hasRunningWorkflows, checkStatus])

  return contextValue
}
