/**
 * Container API - Container image management
 */

import { apiClient } from './client.ts'
import type { ContainerImage } from '@/types'

export const containersApi = {
  // Queries
  getImageStatus: () => apiClient.get('/api/container/image-status'),
  getImages: () => apiClient.get<{ images: ContainerImage[] }>('/api/container/images'),

  // Mutations
  deleteImage: (tag: string) => apiClient.delete<{ success: boolean; message: string; tasksUsing?: string[] }>(`/api/container/images/${encodeURIComponent(tag)}`),
  validateImage: (tag: string) => apiClient.post<{ exists: boolean; tag: string; availableInPodman: boolean }>('/api/container/validate-image', { tag }),
}
