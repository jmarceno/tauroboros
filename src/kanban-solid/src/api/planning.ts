/**
 * Planning Chat API - Planning session management
 */

import { apiClient } from './client.ts'
import type {
  PlanningPrompt,
  PlanningPromptVersion,
  PlanningSession,
  CreatePlanningSessionDTO,
  SessionMessage,
  Task,
} from '@/types'

export interface ContextAttachment {
  type: 'file' | 'screenshot' | 'task'
  name: string
  content?: string
  filePath?: string
  taskId?: string
}

export const planningApi = {
  // Queries
  getPrompt: () => apiClient.get<PlanningPrompt>('/api/planning/prompt'),
  getAllPrompts: () => apiClient.get<PlanningPrompt[]>('/api/planning/prompts'),
  getPromptVersions: (key: string) => apiClient.get<PlanningPromptVersion[]>(`/api/planning/prompt/${key}/versions`),
  getSessions: () => apiClient.get<PlanningSession[]>('/api/planning/sessions'),
  getActiveSessions: () => apiClient.get<PlanningSession[]>('/api/planning/sessions/active'),
  getSession: (id: string) => apiClient.get<PlanningSession>(`/api/planning/sessions/${id}`),
  getSessionMessages: (id: string, limit = 500) => apiClient.get<SessionMessage[]>(`/api/planning/sessions/${id}/messages?limit=${limit}`),
  getSessionTimeline: (id: string) => apiClient.get(`/api/planning/sessions/${id}/timeline`),

  // Mutations
  updatePrompt: (data: { key?: string; name?: string; description?: string; promptText?: string; isActive?: boolean }) =>
    apiClient.put<PlanningPrompt>('/api/planning/prompt', data),
  
  createSession: (data: CreatePlanningSessionDTO) =>
    apiClient.post<PlanningSession>('/api/planning/sessions', data),
  
  updateSession: (id: string, data: { status?: string; errorMessage?: string }) =>
    apiClient.patch<PlanningSession>(`/api/planning/sessions/${id}`, data),
  
  reconnectSession: (id: string, data?: { model?: string; thinkingLevel?: string }) =>
    apiClient.post<PlanningSession>(`/api/planning/sessions/${id}/reconnect`, data),
  
  setSessionModel: (id: string, model: string, thinkingLevel?: string) =>
    apiClient.post<{ ok: boolean; model: string; thinkingLevel?: string }>(`/api/planning/sessions/${id}/model`, { model, thinkingLevel }),
  
  closeSession: (id: string) => apiClient.post<PlanningSession>(`/api/planning/sessions/${id}/close`),
  
  sendMessage: (id: string, content: string, contextAttachments?: ContextAttachment[]) =>
    apiClient.post<{ ok: boolean }>(`/api/planning/sessions/${id}/messages`, { content, contextAttachments }),
  
  createTasksFromSession: (id: string, tasks?: Array<{ name: string; prompt: string; status?: string; requirements?: string[] }>) =>
    apiClient.post<{ tasks?: Task[]; count?: number; message?: string }>(`/api/planning/sessions/${id}/create-tasks`, { tasks }),
}
