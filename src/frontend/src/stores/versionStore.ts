/**
 * Version Store - Manages application version info
 * Replaces: useVersion hook from React
 */

import { createResource } from 'solid-js'
import { referenceApi, runApiEffect } from '@/api'

export function createVersionStore() {
  const [versionData, { refetch }] = createResource(
    () => runApiEffect(referenceApi.getVersion()),
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
