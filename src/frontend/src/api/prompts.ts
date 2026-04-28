/**
 * Prompts API - Fetch prompts from backend (single source of truth is prompt-catalog.json)
 */
import { apiClient } from './client'

export interface PromptTemplate {
  id: number
  key: string
  name: string
  description: string
  templateText: string
  variablesJson: string
  isActive: boolean
  createdAt: number
  updatedAt: number
}

export const promptsApi = {
  /** Get a specific prompt template by key */
  getByKey: (key: string) => apiClient.get<PromptTemplate>(`/api/prompts/${key}`),
  /** List all prompt templates */
  list: () => apiClient.get<PromptTemplate[]>('/api/prompts'),
  /** Render a template with variables */
  render: (key: string, variables?: Record<string, string>) =>
    apiClient.post<{ template: PromptTemplate; renderedText: string; variables: unknown }>(
      `/api/prompts/${key}/render`,
      { variables },
    ),
}
