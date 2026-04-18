import { createContext, useContext, ReactNode } from 'react'
import type {
  Task, WorkflowRun, Session, SessionMessage,
  BestOfNSummary, ColumnSortPreferences, Options,
  ModelCatalog, Toast, LogEntry, ControlState,
  TaskRunContext, PlanningPrompt, ChatSession, SessionUsageRollup,
  TaskGroup, TaskGroupWithTasks,
} from '@/types'

// Reset task result type
interface ResetTaskResult {
  task: Task
  group?: TaskGroup
  wasInGroup: boolean
}

// Tasks context type
interface TasksContextType {
  tasks: Task[]
  setTasks: (tasks: Task[]) => void
  groupedTasks: Record<TaskStatus | 'failed' | 'stuck', Task[]>
  bonSummaries: Record<string, BestOfNSummary>
  isLoading: boolean
  error: string | null
  getTaskById: (id: string) => Task | undefined
  getTaskName: (id: string) => string
  loadTasks: () => Promise<void>
  refreshBonSummaries: (taskIds?: string[]) => Promise<void>
  createTask: (data: { name: string; prompt: string; status?: TaskStatus; branch?: string; planModel?: string; executionModel?: string; planmode?: boolean; autoApprovePlan?: boolean; review?: boolean; autoCommit?: boolean; deleteWorktree?: boolean; skipPermissionAsking?: boolean; requirements?: string[]; thinkingLevel?: string; planThinkingLevel?: string; executionThinkingLevel?: string; executionStrategy?: string; bestOfNConfig?: unknown; containerImage?: string }) => Promise<Task>
  updateTask: (id: string, data: Partial<Task>) => Promise<Task>
  deleteTask: (id: string) => Promise<{ id: string; archived?: boolean }>
  reorderTask: (id: string, newIdx: number) => Promise<void>
  archiveAllDone: () => Promise<{ archived: number; deleted: number }>
  resetTask: (id: string) => Promise<ResetTaskResult>
  resetTaskToGroup: (id: string) => Promise<Task>
  moveTaskToGroup: (id: string, groupId: string | null) => Promise<Task>
  approvePlan: (id: string, message?: string) => Promise<Task>
  requestPlanRevision: (id: string, feedback: string) => Promise<Task>
  repairTask: (id: string, action: string, options?: { errorMessage?: string; smartRepairHints?: string; additionalReviewCount?: number }) => Promise<{ ok: boolean; action: string; reason?: string; task: Task }>
  startSingleTask: (id: string) => Promise<unknown>
  removeBonSummary: (id: string) => void
}

// Runs context type
interface RunsContextType {
  runs: WorkflowRun[]
  activeRuns: WorkflowRun[]
  staleRuns: WorkflowRun[]
  hasStaleRuns: boolean
  consumedRunSlots: number
  isLoading: boolean
  error: string | null
  setTasksRef: (tasks: Task[]) => void
  isStaleRun: (run: WorkflowRun) => boolean
  getTaskRunLock: (taskId: string) => WorkflowRun | null
  isTaskMutationLocked: (taskId: string) => boolean
  getTaskRunColor: (taskId: string) => string | null
  isTaskInRun: (taskId: string, runId: string | null) => boolean
  getRunProgressLabel: (run: WorkflowRun) => string
  loadRuns: () => Promise<void>
  pauseRun: (id: string) => Promise<{ success: boolean; run: WorkflowRun }>
  resumeRun: (id: string) => Promise<{ success: boolean; run: WorkflowRun }>
  stopRun: (id: string) => Promise<{ success: boolean; run: WorkflowRun }>
  archiveRun: (id: string) => Promise<void>
  updateRunFromWebSocket: (run: WorkflowRun) => void
  removeRun: (id: string) => void
}

// Options context type
interface OptionsContextType {
  options: Options | null
  isLoading: boolean
  error: string | null
  loadOptions: () => Promise<void>
  saveOptions: (data: Partial<Options>) => Promise<Options>
  updateOptions: (data: Partial<Options>) => Promise<Options>
  startExecution: () => Promise<unknown>
  stopExecution: () => Promise<unknown>
}

// Toast context type
interface ToastContextType {
  toasts: Toast[]
  logs: LogEntry[]
  showToast: (message: string, variant?: 'info' | 'success' | 'error', duration?: number) => number
  removeToast: (id: number) => void
  addLog: (message: string, variant?: 'info' | 'success' | 'error') => void
  clearLogs: () => void
}

// Model search context type
interface ModelSearchContextType {
  catalog: ModelCatalog
  searchIndex: { value: string; label: string; providerId: string; providerName: string; labelWithProvider: string }[]
  isLoading: boolean
  error: string | null
  loadModels: () => Promise<void>
  getSuggestions: (query: string, limit?: number) => { value: string; label: string; providerId: string; providerName: string; labelWithProvider: string }[]
  normalizeValue: (rawValue: string) => string
  getModelOptions: (selected?: string) => { value: string; label: string; selected: boolean }[]
}

// Session context type
interface SessionContextType {
  sessionId: string | null
  session: Session | null
  messages: SessionMessage[]
  taskRunContext: TaskRunContext | null
  isLoading: boolean
  error: string | null
  loadSession: (id: string, context?: TaskRunContext) => Promise<void>
  closeSession: () => void
  addMessage: (message: SessionMessage) => void
  updateSession: (data: Session) => void
}

// WebSocket context type
type MessageHandler = (payload: unknown) => void

interface WebSocketContextType {
  ws: WebSocket | null
  isConnected: boolean
  reconnectAttempts: number
  connect: () => void
  disconnect: () => void
  on: (type: string, handler: MessageHandler) => () => void
  onReconnect: (callback: () => void) => void
}

// Workflow control context type
interface WorkflowControlContextType {
  currentRunId: string | null
  controlState: ControlState
  isLoading: boolean
  error: string | null
  lastResult: { killed?: number; cleaned?: number } | null
  isConfirmingStop: boolean
  stopType: 'graceful' | 'destructive' | null
  isRunning: boolean
  isPaused: boolean
  isStopping: boolean
  canPause: boolean
  canResume: boolean
  canStop: boolean
  pause: (runId?: string) => Promise<boolean>
  resume: (runId?: string) => Promise<boolean>
  stop: (runId?: string) => Promise<boolean>
  forceStop: (runId?: string) => Promise<boolean>
  requestStop: (type: 'graceful' | 'destructive') => void
  confirmStop: (runId?: string) => Promise<boolean>
  cancelStop: () => void
  checkPausedState: () => Promise<boolean>
  handleRunUpdate: (run: WorkflowRun) => void
  updateStateFromRuns: (runs: WorkflowRun[]) => void
  setRun: (run: WorkflowRun | null) => void
  clearRun: () => void
}

import type { MultiSelectMode } from '@/hooks/useMultiSelect'

// Multi-select context type
interface MultiSelectContextType {
  selectedTaskIds: Set<string>
  isSelecting: boolean
  selectedCount: number
  toggleSelection: (taskId: string, event: React.MouseEvent) => boolean
  selectSingle: (taskId: string) => void
  clearSelection: () => void
  isSelected: (taskId: string) => boolean
  getSelectedIds: () => string[]
  mode: MultiSelectMode
  startGroupCreation: () => boolean
  confirmGroupCreation: () => string[]
  cancelGroupCreation: () => void
}

// Planning chat context type
interface PlanningChatContextType {
  isOpen: boolean
  width: number
  isResizing: boolean
  sessions: ChatSession[]
  activeSessionId: string | null
  planningPrompt: PlanningPrompt | null
  isLoadingPrompt: boolean
  activeSession: ChatSession | null
  visibleSessions: ChatSession[]
  minimizedSessions: ChatSession[]
  hasSessions: boolean
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  setWidth: (newWidth: number) => void
  createNewSession: (model?: string, thinkingLevel?: string) => Promise<void>
  switchToSession: (sessionId: string) => void
  minimizeSession: (sessionId: string) => void
  closeSession: (sessionId: string) => void
  renameSession: (sessionId: string, newName: string) => void
  addMessageToSession: (sessionId: string, message: SessionMessage) => void
  loadPlanningPrompt: () => Promise<void>
  savePlanningPrompt: (updates: { name?: string; description?: string; promptText: string }) => Promise<PlanningPrompt>
  handlePlanningSessionCreated: (data: Session) => void
  handlePlanningSessionUpdated: (data: Session) => void
  handlePlanningSessionClosed: (data: { id: string }) => void
  handlePlanningSessionMessage: (data: { sessionId: string; message: SessionMessage }) => void
  sendMessage: (sessionId: string, content: string, attachments?: unknown[]) => Promise<void>
  createTasksFromChat: (sessionId: string, tasks?: unknown[]) => Promise<unknown>
  reconnectSession: (sessionId: string, model?: string, thinkingLevel?: string) => Promise<Session>
  setSessionModel: (sessionId: string, model: string, thinkingLevel?: string) => Promise<{ ok: boolean; model: string; thinkingLevel?: string }>
  addExistingSession: (session: ChatSession) => void
}

// Modal context type
interface ModalContextType {
  activeModal: string | null
  modalData: Record<string, unknown>
  openModal: (name: string, data?: Record<string, unknown>) => void
  closeModal: () => void
  closeTopmostModal: () => boolean
}

// Container status context type
interface ContainerStatusContextType {
  containerStatus: { enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null
  isContainerEnabled: boolean
  loadContainerStatus: () => Promise<void>
}

// Session usage context type
interface SessionUsageContextType {
  usageCache: Record<string, SessionUsageRollup>
  isLoading: boolean
  error: string | null
  activeSessionIds: Set<string>
  loadSessionUsage: (sessionId: string, forceRefresh?: boolean) => Promise<SessionUsageRollup | null>
  getCachedUsage: (sessionId: string) => SessionUsageRollup | null
  clearCache: () => void
  startWatching: (sessionId: string) => void
  stopWatching: (sessionId: string) => void
  formatTokenCount: (count: number) => string
  formatCost: (cost: number) => string
}

// Task last update context type
interface TaskLastUpdateContextType {
  lastUpdateMap: Record<string, number>
  getLastUpdate: (taskId: string) => number | undefined
  formatLastUpdate: (timestamp: number) => string
  getUpdateAgeClass: (timestamp: number) => string
  loadLastUpdate: (taskId: string) => Promise<void>
}

// Task groups context type
interface TaskGroupsContextType {
  groups: TaskGroup[]
  loading: boolean
  error: string | null
  activeGroupId: string | null
  activeGroup: TaskGroup | null
  activeGroups: TaskGroup[]
  completedGroups: TaskGroup[]
  loadGroups: () => Promise<TaskGroup[]>
  createGroup: (taskIds: string[], name?: string) => Promise<TaskGroup>
  openGroup: (groupId: string | null) => void
  loadGroupDetails: (groupId: string) => Promise<TaskGroupWithTasks>
  addTasksToGroup: (groupId: string, taskIds: string[]) => Promise<TaskGroup>
  removeTasksFromGroup: (groupId: string, taskIds: string[]) => Promise<TaskGroup>
  startGroup: (groupId: string) => Promise<unknown>
  deleteGroup: (groupId: string) => Promise<void>
  updateGroup: (groupId: string, updates: { name?: string; color?: string }) => Promise<TaskGroup>
  getGroupById: (id: string) => TaskGroup | undefined
  updateGroupFromWebSocket: (group: TaskGroup) => void
  removeGroupFromWebSocket: (groupId: string) => void
}

// Create contexts
export const TasksContext = createContext<TasksContextType | undefined>(undefined)
export const RunsContext = createContext<RunsContextType | undefined>(undefined)
export const OptionsContext = createContext<OptionsContextType | undefined>(undefined)
export const ToastContext = createContext<ToastContextType | undefined>(undefined)
export const ModelSearchContext = createContext<ModelSearchContextType | undefined>(undefined)
export const SessionContext = createContext<SessionContextType | undefined>(undefined)
export const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined)
export const WorkflowControlContext = createContext<WorkflowControlContextType | undefined>(undefined)
export const MultiSelectContext = createContext<MultiSelectContextType | undefined>(undefined)
export const PlanningChatContext = createContext<PlanningChatContextType | undefined>(undefined)
export const ModalContext = createContext<ModalContextType | undefined>(undefined)
export const ContainerStatusContext = createContext<ContainerStatusContextType | undefined>(undefined)
export const SessionUsageContext = createContext<SessionUsageContextType | undefined>(undefined)
export const TaskLastUpdateContext = createContext<TaskLastUpdateContextType | undefined>(undefined)
export const TaskGroupsContext = createContext<TaskGroupsContextType | undefined>(undefined)

// Export hook functions
export function useTasksContext() {
  const context = useContext(TasksContext)
  if (!context) throw new Error('useTasksContext must be used within TasksProvider')
  return context
}

export function useRunsContext() {
  const context = useContext(RunsContext)
  if (!context) throw new Error('useRunsContext must be used within RunsProvider')
  return context
}

export function useOptionsContext() {
  const context = useContext(OptionsContext)
  if (!context) throw new Error('useOptionsContext must be used within OptionsProvider')
  return context
}

export function useToastContext() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToastContext must be used within ToastProvider')
  return context
}

export function useModelSearchContext() {
  const context = useContext(ModelSearchContext)
  if (!context) throw new Error('useModelSearchContext must be used within ModelSearchProvider')
  return context
}

export function useSessionContext() {
  const context = useContext(SessionContext)
  if (!context) throw new Error('useSessionContext must be used within SessionProvider')
  return context
}

export function useWebSocketContext() {
  const context = useContext(WebSocketContext)
  if (!context) throw new Error('useWebSocketContext must be used within WebSocketProvider')
  return context
}

export function useWorkflowControlContext() {
  const context = useContext(WorkflowControlContext)
  if (!context) throw new Error('useWorkflowControlContext must be used within WorkflowControlProvider')
  return context
}

export function useMultiSelectContext() {
  const context = useContext(MultiSelectContext)
  if (!context) throw new Error('useMultiSelectContext must be used within MultiSelectProvider')
  return context
}

export function usePlanningChatContext() {
  const context = useContext(PlanningChatContext)
  if (!context) throw new Error('usePlanningChatContext must be used within PlanningChatProvider')
  return context
}

export function useModalContext() {
  const context = useContext(ModalContext)
  if (!context) throw new Error('useModalContext must be used within ModalProvider')
  return context
}

export function useContainerStatusContext() {
  const context = useContext(ContainerStatusContext)
  if (!context) throw new Error('useContainerStatusContext must be used within ContainerStatusProvider')
  return context
}

export function useSessionUsageContext() {
  const context = useContext(SessionUsageContext)
  if (!context) throw new Error('useSessionUsageContext must be used within SessionUsageProvider')
  return context
}

export function useTaskLastUpdateContext() {
  const context = useContext(TaskLastUpdateContext)
  if (!context) throw new Error('useTaskLastUpdateContext must be used within TaskLastUpdateProvider')
  return context
}

export function useTaskGroupsContext() {
  const context = useContext(TaskGroupsContext)
  if (!context) throw new Error('useTaskGroupsContext must be used within TaskGroupsProvider')
  return context
}
