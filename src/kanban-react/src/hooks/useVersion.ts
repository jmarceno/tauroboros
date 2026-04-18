/**
 * Version Hook - TanStack Query Wrapper
 */

import { useVersionQuery } from '@/queries'

export function useVersion() {
  const { data: versionData, isLoading, error } = useVersionQuery()

  return {
    version: versionData?.displayVersion ?? null,
    loading: isLoading,
    error: error?.message ?? null,
  }
}
