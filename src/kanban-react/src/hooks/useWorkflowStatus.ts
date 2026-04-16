import { useState, useEffect, useCallback } from 'react'

export function useWorkflowStatus() {
  const [hasRunningWorkflows, setHasRunningWorkflows] = useState(false)

  const checkStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/workflow/status')
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

  return {
    hasRunningWorkflows,
    checkStatus,
  }
}
