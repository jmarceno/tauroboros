/**
 * Service tags for Effect dependency injection.
 * 
 * This module defines all Context.GenericTag instances used in the application.
 * Services are defined here to avoid circular dependencies and provide a central
 * registry of all injectable services.
 */

import { Context } from "effect"
import type { InfrastructureSettings } from "../config/settings.ts"
import type { PiKanbanDB } from "../db.ts"
import type { PiOrchestrator } from "../orchestrator.ts"
import type { PiKanbanServer } from "../server/server.ts"
import type { ContainerImageManager } from "../runtime/container-image-manager.ts"
import type { PiContainerManager } from "../runtime/container-manager.ts"
import type { PlanningSessionManager } from "../runtime/planning-session.ts"
import type { WebSocketHub } from "../server/websocket.ts"
import type { SmartRepairService } from "../runtime/smart-repair.ts"
import type { LoggerService } from "./logger.ts"

/**
 * Project root path service.
 */
export const ProjectRootContext = Context.GenericTag<string>("ProjectRootContext")

/**
 * Infrastructure settings service.
 */
export const SettingsContext = Context.GenericTag<InfrastructureSettings>("SettingsContext")

/**
 * Database service.
 */
export const DatabaseContext = Context.GenericTag<PiKanbanDB>("DatabaseContext")

/**
 * Orchestrator service.
 */
export const OrchestratorContext = Context.GenericTag<PiOrchestrator>("OrchestratorContext")

/**
 * Server service.
 */
export const ServerContext = Context.GenericTag<PiKanbanServer>("ServerContext")

/**
 * Container image manager service.
 */
export const ContainerImageManagerContext = Context.GenericTag<ContainerImageManager>("ContainerImageManagerContext")

/**
 * Container manager service.
 */
export const ContainerManagerContext = Context.GenericTag<PiContainerManager>("ContainerManagerContext")

/**
 * Planning session manager service.
 */
export const PlanningSessionManagerContext = Context.GenericTag<PlanningSessionManager>("PlanningSessionManagerContext")

/**
 * WebSocket hub service.
 */
export const WebSocketHubContext = Context.GenericTag<WebSocketHub>("WebSocketHubContext")

/**
 * Smart repair service.
 */
export const SmartRepairContext = Context.GenericTag<SmartRepairService>("SmartRepairContext")

/**
 * Logger service (re-export from logger module for convenience).
 */
export { LoggerService }

/**
 * Server port configuration.
 */
export const ServerPortContext = Context.GenericTag<number>("ServerPortContext")

/**
 * Database path configuration.
 */
export const DatabasePathContext = Context.GenericTag<string>("DatabasePathContext")

/**
 * Server runtime context - contains all server-level dependencies.
 */
export interface ServerRuntimeContext {
  readonly db: PiKanbanDB
  readonly server: PiKanbanServer
  readonly orchestrator: PiOrchestrator
  readonly projectRoot: string
  readonly settings: InfrastructureSettings
}

/**
 * Server runtime context tag.
 */
export const ServerRuntimeContext = Context.GenericTag<ServerRuntimeContext>("ServerRuntimeContext")
