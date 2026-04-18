/**
 * Container Queries - TanStack Query hooks for container management
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { containersApi } from '@/api'
import { queryKeys } from './keys.ts'
import type { ContainerImage } from '@/types'

// ============================================================================
// Queries
// ============================================================================

/**
 * Get container image status
 */
export function useContainerStatusQuery(
  options?: Omit<UseQueryOptions<unknown, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.containers.status(),
    queryFn: containersApi.getImageStatus,
    staleTime: 10000,
    ...options,
  })
}

/**
 * Get available container images
 */
export function useContainerImagesQuery(
  options?: Omit<UseQueryOptions<{ images: ContainerImage[] }, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: queryKeys.containers.images(),
    queryFn: containersApi.getImages,
    staleTime: 30000,
    ...options,
  })
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Delete a container image
 */
export function useDeleteContainerImageMutation(
  options?: Omit<UseMutationOptions<{ success: boolean; message: string; tasksUsing?: string[] }, Error, string>, 'mutationFn'>
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: containersApi.deleteImage,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.containers.images() })
    },
    ...options,
  })
}

/**
 * Validate a container image
 */
export function useValidateContainerImageMutation(
  options?: Omit<UseMutationOptions<{ exists: boolean; tag: string; availableInPodman: boolean }, Error, string>, 'mutationFn'>
) {
  return useMutation({
    mutationFn: containersApi.validateImage,
    ...options,
  })
}
