/**
 * Queries - Centralized exports for all TanStack Query hooks
 */

// Query Keys
export { queryKeys } from './keys.ts'
export type {
  TaskQueryKeys,
  RunQueryKeys,
  OptionsQueryKeys,
  SessionQueryKeys,
  TaskGroupQueryKeys,
  ReferenceQueryKeys,
  ContainerQueryKeys,
  PlanningQueryKeys,
  StatsQueryKeys,
} from './keys.ts'

// Tasks
export {
  useTasksQuery,
  useTaskQuery,
  useBestOfNSummariesQuery,
  useCreateTaskMutation,
  useCreateTaskAndWaitMutation,
  useUpdateTaskMutation,
  useDeleteTaskMutation,
  useReorderTaskMutation,
  useArchiveAllDoneMutation,
  useResetTaskMutation,
  useResetTaskToGroupMutation,
  useMoveTaskToGroupMutation,
  useApprovePlanMutation,
  useRequestPlanRevisionMutation,
  useRepairTaskMutation,
  useStartSingleTaskMutation,
  useSelectCandidateMutation,
  useAbortBestOfNMutation,
  type UpdateTaskVariables,
  type ReorderTaskVariables,
  type ResetTaskResult,
  type MoveTaskToGroupVariables,
  type ApprovePlanVariables,
  type RequestPlanRevisionVariables,
  type RepairTaskVariables,
  type RepairTaskResult,
  type SelectCandidateVariables,
} from './tasks.ts'

// Runs
export {
  useRunsQuery,
  usePausedStateQuery,
  usePauseRunMutation,
  useResumeRunMutation,
  useStopRunMutation,
  useForceStopRunMutation,
  useArchiveRunMutation,
  type StopRunVariables,
} from './runs.ts'

// Options
export {
  useOptionsQuery,
  useUpdateOptionsMutation,
  useStartExecutionMutation,
  useStopExecutionMutation,
} from './options.ts'

// Sessions
export {
  useSessionQuery,
  useSessionMessagesQuery,
  useSessionUsageQuery,
  updateSessionMessagesCache,
  updateSessionCache,
} from './sessions.ts'

// Task Groups
export {
  useTaskGroupsQuery,
  useTaskGroupQuery,
  useCreateTaskGroupMutation,
  useUpdateTaskGroupMutation,
  useDeleteTaskGroupMutation,
  useAddTasksToGroupMutation,
  useRemoveTasksFromGroupMutation,
  useStartGroupMutation,
  updateTaskGroupCache,
  removeTaskGroupCache,
  type CreateTaskGroupVariables,
  type UpdateTaskGroupVariables,
  type AddTasksToGroupVariables,
  type RemoveTasksFromGroupVariables,
} from './taskGroups.ts'

// Reference Data
export {
  useBranchesQuery,
  useModelsQuery,
  useExecutionGraphQuery,
  useVersionQuery,
} from './reference.ts'

// Containers
export {
  useContainerStatusQuery,
  useContainerImagesQuery,
  useDeleteContainerImageMutation,
  useValidateContainerImageMutation,
} from './containers.ts'

// Planning Chat
export {
  usePlanningPromptQuery,
  useAllPlanningPromptsQuery,
  usePlanningPromptVersionsQuery,
  usePlanningSessionsQuery,
  useActivePlanningSessionsQuery,
  usePlanningSessionQuery,
  usePlanningSessionMessagesQuery,
  useUpdatePlanningPromptMutation,
  useCreatePlanningSessionMutation,
  useUpdatePlanningSessionMutation,
  useReconnectPlanningSessionMutation,
  useSetPlanningSessionModelMutation,
  useClosePlanningSessionMutation,
  useSendPlanningMessageMutation,
  useCreateTasksFromPlanningMutation,
  updatePlanningSessionMessagesCache,
  updatePlanningSessionCache,
  type UpdatePlanningSessionVariables,
  type ReconnectSessionVariables,
  type SetSessionModelVariables,
  type SendPlanningMessageVariables,
  type CreateTasksFromPlanningVariables,
} from './planning.ts'

// Stats
export {
  useUsageStatsQuery,
  useTaskStatsQuery,
  useModelUsageQuery,
  useAverageDurationQuery,
  useHourlyUsageQuery,
  useDailyUsageQuery,
} from './stats.ts'
