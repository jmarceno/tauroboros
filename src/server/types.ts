import type { Effect } from "effect"
import type { PiKanbanDB } from "../db.ts"
import type { RunQueueStatus, SlotUtilization, WSMessage, WorkflowRun } from "../types.ts"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { ContainerImageManager } from "../runtime/container-image-manager.ts"
import type { PiContainerManager } from "../runtime/container-manager.ts"
import type { SmartRepairService } from "../runtime/smart-repair.ts"
import type { PlanningSessionManager } from "../runtime/planning-session.ts"
import type { PackageDefinition } from "../db/types.ts"
import type { HttpRouteError } from "./route-interpreter.ts"
import type { OrchestratorOperationError } from "../orchestrator.ts"

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

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response | Effect.Effect<Response, HttpRouteError>

// Server callback function types
type OrchestratorRouteEffect<A> = Effect.Effect<A, OrchestratorOperationError>

export type RunControlFn = (runId: string) => OrchestratorRouteEffect<unknown>
export type StartFn = () => OrchestratorRouteEffect<unknown>
export type StartSingleFn = (taskId: string) => OrchestratorRouteEffect<WorkflowRun | null>
export type StartGroupFn = (groupId: string) => OrchestratorRouteEffect<WorkflowRun>
export type StopFn = () => OrchestratorRouteEffect<unknown>
export type StopRunFn = (
  runId: string,
  options?: { destructive?: boolean },
) => OrchestratorRouteEffect<{ success: boolean; run: WorkflowRun; killed?: number; cleaned?: number }>
export type GetSlotsFn = () => OrchestratorRouteEffect<SlotUtilization>
export type GetRunQueueStatusFn = (runId: string) => OrchestratorRouteEffect<RunQueueStatus>
export type ManualSelfHealRecoverFn = (
  taskId: string,
  reportId: string,
  action: "restart_task" | "keep_failed",
) => OrchestratorRouteEffect<{ ok: boolean; message: string }>

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
