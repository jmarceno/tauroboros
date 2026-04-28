/**
 * Sessions API - Session management and messages
 */

import { apiClient } from './client.ts'
import type { Session, SessionMessage, SessionUsageRollup } from '@/types'

export const sessionsApi = {
  // Queries
  getById: (id: string) => apiClient.get<Session>(`/api/sessions/${id}`),
  getMessages: (id: string, limit = 1000) => apiClient.get<SessionMessage[]>(`/api/sessions/${id}/messages?limit=${limit}`),
  getUsage: (id: string) => apiClient.get<SessionUsageRollup>(`/api/sessions/${id}/usage`),
}
