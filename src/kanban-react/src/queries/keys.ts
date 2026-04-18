/**
 * Query Keys - Centralized query key management for TanStack Query
 */

export const queryKeys = {
  // Tasks
  tasks: {
    all: ['tasks'] as const,
    lists: () => [...queryKeys.tasks.all, 'list'] as const,
    list: (filters?: { status?: string; groupId?: string }) =>
      [...queryKeys.tasks.lists(), filters] as const,
    details: () => [...queryKeys.tasks.all, 'detail'] as const,
    detail: (id: string) => [...queryKeys.tasks.details(), id] as const,
    runs: (id: string) => [...queryKeys.tasks.detail(id), 'runs'] as const,
    sessions: (id: string) => [...queryKeys.tasks.detail(id), 'sessions'] as const,
    candidates: (id: string) => [...queryKeys.tasks.detail(id), 'candidates'] as const,
    bestOfNSummary: (id: string) => [...queryKeys.tasks.detail(id), 'bestOfNSummary'] as const,
    reviewStatus: (id: string) => [...queryKeys.tasks.detail(id), 'reviewStatus'] as const,
    lastUpdate: (id: string) => [...queryKeys.tasks.detail(id), 'lastUpdate'] as const,
  },

  // Workflow Runs
  runs: {
    all: ['runs'] as const,
    lists: () => [...queryKeys.runs.all, 'list'] as const,
    list: (filters?: { status?: string }) => [...queryKeys.runs.lists(), filters] as const,
    details: () => [...queryKeys.runs.all, 'detail'] as const,
    detail: (id: string) => [...queryKeys.runs.details(), id] as const,
    pausedState: () => [...queryKeys.runs.all, 'pausedState'] as const,
  },

  // Options
  options: {
    all: ['options'] as const,
    current: () => [...queryKeys.options.all, 'current'] as const,
  },

  // Sessions
  sessions: {
    all: ['sessions'] as const,
    details: () => [...queryKeys.sessions.all, 'detail'] as const,
    detail: (id: string) => [...queryKeys.sessions.details(), id] as const,
    messages: (id: string) => [...queryKeys.sessions.detail(id), 'messages'] as const,
    usage: (id: string) => [...queryKeys.sessions.detail(id), 'usage'] as const,
  },

  // Task Groups
  taskGroups: {
    all: ['taskGroups'] as const,
    lists: () => [...queryKeys.taskGroups.all, 'list'] as const,
    list: (filters?: { status?: string }) => [...queryKeys.taskGroups.lists(), filters] as const,
    details: () => [...queryKeys.taskGroups.all, 'detail'] as const,
    detail: (id: string) => [...queryKeys.taskGroups.details(), id] as const,
  },

  // Reference Data
  reference: {
    all: ['reference'] as const,
    branches: () => [...queryKeys.reference.all, 'branches'] as const,
    models: () => [...queryKeys.reference.all, 'models'] as const,
    executionGraph: () => [...queryKeys.reference.all, 'executionGraph'] as const,
    version: () => [...queryKeys.reference.all, 'version'] as const,
  },

  // Containers
  containers: {
    all: ['containers'] as const,
    status: () => [...queryKeys.containers.all, 'status'] as const,
    images: () => [...queryKeys.containers.all, 'images'] as const,
  },

  // Planning Chat
  planning: {
    all: ['planning'] as const,
    prompts: () => [...queryKeys.planning.all, 'prompts'] as const,
    prompt: (key?: string) => [...queryKeys.planning.prompts(), key ?? 'default'] as const,
    sessions: () => [...queryKeys.planning.all, 'sessions'] as const,
    session: (id: string) => [...queryKeys.planning.sessions(), id] as const,
    sessionMessages: (id: string) => [...queryKeys.planning.session(id), 'messages'] as const,
    activeSessions: () => [...queryKeys.planning.sessions(), 'active'] as const,
  },

  // Stats
  stats: {
    all: ['stats'] as const,
    usage: (range: string) => [...queryKeys.stats.all, 'usage', range] as const,
    tasks: ['stats', 'tasks'] as const,
    models: ['stats', 'models'] as const,
    duration: ['stats', 'duration'] as const,
    hourly: ['stats', 'hourly'] as const,
    daily: (days: number) => [...queryKeys.stats.all, 'daily', days] as const,
  },
} as const

// Type exports for type-safe key construction
type QueryKeys = typeof queryKeys
export type TaskQueryKeys = QueryKeys['tasks']
export type RunQueryKeys = QueryKeys['runs']
export type OptionsQueryKeys = QueryKeys['options']
export type SessionQueryKeys = QueryKeys['sessions']
export type TaskGroupQueryKeys = QueryKeys['taskGroups']
export type ReferenceQueryKeys = QueryKeys['reference']
export type ContainerQueryKeys = QueryKeys['containers']
export type PlanningQueryKeys = QueryKeys['planning']
export type StatsQueryKeys = QueryKeys['stats']
