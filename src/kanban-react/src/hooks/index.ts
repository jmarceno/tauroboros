/**
 * Hooks - Centralized exports for all custom hooks
 */

// Re-export all hooks
export { useDragDrop, type DragDropCallback, type DragSourceContext, type DragOverTarget } from './useDragDrop.ts'
export { useKeyboard } from './useKeyboard.ts'
export { useFocusTrap } from './useFocusTrap.ts'
export { useModelSearch } from './useModelSearch.ts'
export { useMultiSelect, type MultiSelectMode } from './useMultiSelect.ts'
export { useOptions } from './useOptions.ts'
export { usePlanningChat } from './usePlanningChat.ts'
export { useRuns } from './useRuns.ts'
export { useSession } from './useSession.ts'
export { useSessionUsage } from './useSessionUsage.ts'
export { useTaskGroups, type GroupState } from './useTaskGroups.ts'
export { useTaskLastUpdate } from './useTaskLastUpdate.ts'
export { useTaskSessionUsage } from './useTaskSessionUsage.ts'
export { useTasks } from './useTasks.ts'
export { useToasts } from './useToasts.ts'
export { useVersion } from './useVersion.ts'
export { useWebSocket, type WebSocketHook } from './useWebSocket.ts'
export { useWebSocketHandlers } from './useWebSocketHandlers.ts'
export { useWorkflowControl } from './useWorkflowControl.ts'
export { useWorkflowStatus } from './useWorkflowStatus.ts'

// useApi is deprecated - use the api/ modules directly or the TanStack Query hooks
// Kept for backward compatibility during migration
export { useApi } from './useApi.ts'

// Stats
export { useStats, type UseStatsReturn } from './useStats.ts'
