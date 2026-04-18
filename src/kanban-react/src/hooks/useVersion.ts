import { useState, useEffect, useMemo } from "react"
import { useApi } from "./useApi"

export function useVersion() {
  const [version, setVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const api = useApi()
  const getVersion = api.getVersion

  useEffect(() => {
    const loadVersion = async () => {
      try {
        const response = await getVersion()
        setVersion(response.displayVersion)
      } catch {
        setError('Failed to load version')
      } finally {
        setLoading(false)
      }
    }
    loadVersion()
  }, [getVersion])

  const contextValue = useMemo(() => ({ version, loading, error }), [version, loading, error])

  return contextValue
}
