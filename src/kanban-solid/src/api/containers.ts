/**
 * Container API - Container image management
 */

import { apiClient } from './client.ts'
import type { ContainerImage } from '@/types'

export interface ContainerProfile {
  id: string
  name: string
  description: string
  image: string
  dockerfileTemplate: string
}

export interface ContainerBuild {
  id: number
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  startedAt: number | null
  completedAt: number | null
  packagesHash: string | null
  errorMessage: string | null
  imageTag: string | null
  logs: string | null
}

export interface ContainerStatus {
  enabled: boolean
  available: boolean
  hasRunningWorkflows: boolean
  message: string
}

export const containersApi = {
  // Queries
  getImageStatus: () => apiClient.get('/api/container/image-status'),
  getStatus: () => apiClient.get<ContainerStatus>('/api/container/status'),
  getProfiles: () => apiClient.get<{ profiles: ContainerProfile[] }>('/api/container/profiles'),
  getBuilds: (limit = 10) => apiClient.get<{ builds: ContainerBuild[] }>(`/api/container/build-status?limit=${limit}`),
  getDockerfile: (profileId: string) => apiClient.get<{ dockerfile: string; image: string; profile: Omit<ContainerProfile, 'dockerfileTemplate' | 'image'> }>('/api/container/dockerfile/' + encodeURIComponent(profileId)),
  getImages: () => apiClient.get<{ images: ContainerImage[] }>('/api/container/images'),

  // Mutations
  build: (payload: { profileId: string; dockerfile: string }) =>
    apiClient.post<{ buildId: number; status: string; imageTag: string; profileId: string }>('/api/container/build', payload),
  createProfile: (payload: ContainerProfile) =>
    apiClient.post<{ ok: boolean; profile: ContainerProfile }>('/api/container/profiles', payload),
  deleteImage: (tag: string) => apiClient.delete<{ success: boolean; message: string; tasksUsing?: string[] }>(`/api/container/images/${encodeURIComponent(tag)}`),
  validateImage: (tag: string) => apiClient.post<{ exists: boolean; tag: string; availableInPodman: boolean }>('/api/container/validate-image', { tag }),
}
