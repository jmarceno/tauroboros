import { ref, onMounted, onUnmounted } from 'vue'

const hasRunningWorkflows = ref(false)
let pollInterval: NodeJS.Timeout | null = null

const checkStatus = async () => {
  try {
    const response = await fetch('/api/workflow/status')
    if (response.ok) {
      const data = await response.json()
      hasRunningWorkflows.value = data.hasRunningWorkflows
    }
  } catch (error) {
    // Silent fail - status check is non-critical
  }
}

const startPolling = () => {
  checkStatus()
  pollInterval = setInterval(checkStatus, 5000) // Check every 5 seconds
}

const stopPolling = () => {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

export function useWorkflowStatus() {
  onMounted(startPolling)
  onUnmounted(stopPolling)

  return {
    hasRunningWorkflows,
    checkStatus,
  }
}
