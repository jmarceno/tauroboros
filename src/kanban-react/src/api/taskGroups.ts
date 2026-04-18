/**
 * Task Groups API - Task group management
 */

import { apiClient } from './client.ts'
import type { TaskGroup, TaskGroupWithTasks } from '@/types'

export const taskGroupsApi = {
  // Queries
  getAll: () => apiClient.get<TaskGroup[]>('/api/task-groups'),
  getById: (id: string) => apiClient.get<TaskGroupWithTasks>(`/api/task-groups/${id}`),

  // Mutations
  create: (data: { name?: string; color?: string; taskIds?: string[] }) =>
    apiClient.post<TaskGroup>('/api/task-groups', data),
  update: (id: string, data: { name?: string; color?: string; status?: 'active' | 'completed' | 'archived' }) =>
    apiClient.patch<TaskGroup>(`/api/task-groups/${id}`, data),
  delete: (id: string) => apiClient.delete(`/api/task-groups/${id}`),
  addTasks: (groupId: string, taskIds: string[]) =>
    apiClient.post<TaskGroup>(`/api/task-groups/${groupId}/tasks`, { taskIds }),
  removeTasks: (groupId: string, taskIds: string[]) =>
    apiClient.request<TaskGroup>('DELETE', `/api/task-groups/${groupId}/tasks`, { taskIds }),
  start: (groupId: string) =>
    apiClient.post(`/api/task-groups/${groupId}/start`),
}
