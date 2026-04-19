/**
 * Version Store - Manages application version info
 * Replaces: useVersion hook from React
 */

import { createResource } from 'solid-js'
import { referenceApi } from '@/api'

export function createVersionStore() {
  const [versionData, { refetch }] = createResource(
    async () => {
      try {
        const data = await referenceApi.getVersion()
        return data
      } catch (e) {
        console.error('Failed to load version:', e)
        return null
      }
    },
    {
      initialValue: null,
    }
  )

  return {
    version: () => versionData()?.displayVersion ?? null,
    loading: () => versionData.loading,
    error: () => versionData.error?.message ?? null,
    refetch,
  }
}
