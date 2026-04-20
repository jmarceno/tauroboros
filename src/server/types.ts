import type { PiKanbanDB } from "../db.ts"
import type { RunQueueStatus, SlotUtilization, WSMessage, WorkflowRun } from "../types.ts"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { ContainerImageManager } from "../runtime/container-image-manager.ts"
import type { PiContainerManager } from "../runtime/container-manager.ts"
import type { SmartRepairService } from "../runtime/smart-repair.ts"
import type { PlanningSessionManager } from "../runtime/planning-session.ts"
import type { PackageDefinition } from "../db/types.ts"

export interface RouteParams {
  [key: string]: string
}

export interface RequestContext {
  req: Request
  url: URL
  params: RouteParams
  db: PiKanbanDB
  json: (data: unknown, status?: number) => Response
  text: (data: string, status?: number) => Response
  broadcast: (message: WSMessage) => void
  sessionUrlFor: (sessionId: string) => string
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response

// Server callback function types
export type RunControlFn = (runId: string) => Promise<unknown>
export type StartFn = () => Promise<unknown>
export type StartSingleFn = (taskId: string) => Promise<WorkflowRun | null>
export type StartGroupFn = (groupId: string) => Promise<WorkflowRun>
export type StopFn = () => Promise<unknown>
export type StopRunFn = (
  runId: string,
  options?: { destructive?: boolean },
) => Promise<{ success: boolean; run: WorkflowRun; killed?: number; cleaned?: number }>
export type GetSlotsFn = () => SlotUtilization
export type GetRunQueueStatusFn = (runId: string) => Promise<RunQueueStatus> | RunQueueStatus
export type ManualSelfHealRecoverFn = (
  taskId: string,
  reportId: string,
  action: "restart_task" | "keep_failed",
) => Promise<{ ok: boolean; message: string }>

/**
 * Server-level dependency context passed to route registration functions.
 * Contains all deps beyond what is available in RequestContext (db, json, broadcast, sessionUrlFor).
 */
export interface ServerRouteContext {
  settings?: InfrastructureSettings
  projectRoot: string
  onStart: StartFn
  onStartSingle: StartSingleFn
  onStartGroup: StartGroupFn | null
  onStop: StopFn
  onPauseRun: RunControlFn | null
  onResumeRun: RunControlFn | null
  onStopRun: StopRunFn | null
  onGetSlots: GetSlotsFn | null
  onGetRunQueueStatus: GetRunQueueStatusFn | null
  onManualSelfHealRecover: ManualSelfHealRecoverFn | null
  imageManager?: ContainerImageManager
  containerManager?: PiContainerManager
  validateContainerImage: (tag: string) => Promise<boolean>
  getContainerProfilesPath: () => string
  getDockerfilePath: (subpath?: string) => string
  getPodmanImages: () => Promise<Array<{ tag: string; createdAt: number; size: string }>>
  hashPackages: (packages: PackageDefinition[]) => string
  planningSessionManager: PlanningSessionManager
  smartRepair: SmartRepairService
  getPort: () => number
}
