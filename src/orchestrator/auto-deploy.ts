import { Effect } from "effect"
import type { Task, WorkflowRun, AutoDeployCondition, WSMessage } from "../types.ts"
import type { PiKanbanDB } from "../db.ts"

/**
 * Context needed for auto-deploy operations.
 */
export interface AutoDeployContext {
  db: PiKanbanDB
  broadcast: (message: WSMessage) => void
}

/**
 * Get templates that should auto-deploy for a given condition.
 */
export function getAutoDeployTemplates(
  condition: AutoDeployCondition,
  db: PiKanbanDB,
): Task[] {
  return db.getTasks().filter((task) => 
    task.status === "template" && 
    task.autoDeploy === true && 
    task.autoDeployCondition === condition
  )
}

/**
 * Check if auto-deploy should be checked for a given run kind.
 */
export function shouldCheckAutoDeploy(kind: WorkflowRun["kind"]): boolean {
  return kind !== "single_task"
}

/**
 * Deploy a template task to the backlog.
 */
export function deployTemplateTask(
  template: Task,
  context: AutoDeployContext,
): Task {
  const deployed = context.db.createTask({
    name: template.name,
    prompt: template.prompt,
    status: "backlog",
    branch: template.branch,
    planModel: template.planModel,
    executionModel: template.executionModel,
    planmode: template.planmode,
    autoApprovePlan: template.autoApprovePlan,
    review: template.review,
    autoCommit: template.autoCommit,
    autoDeploy: false,
    autoDeployCondition: null,
    deleteWorktree: template.deleteWorktree,
    requirements: [...template.requirements],
    thinkingLevel: template.thinkingLevel,
    planThinkingLevel: template.planThinkingLevel,
    executionThinkingLevel: template.executionThinkingLevel,
    executionPhase: "not_started",
    awaitingPlanApproval: false,
    planRevisionCount: 0,
    executionStrategy: template.executionStrategy,
    bestOfNConfig: template.bestOfNConfig,
    bestOfNSubstage: "idle",
    skipPermissionAsking: template.skipPermissionAsking,
    maxReviewRunsOverride: template.maxReviewRunsOverride,
    smartRepairHints: template.smartRepairHints,
    reviewActivity: "idle",
    containerImage: template.containerImage,
    codeStyleReview: template.codeStyleReview,
  })

  context.broadcast({ type: "task_created", payload: deployed })
  return deployed
}

/**
 * Deploy templates for a given condition.
 */
export function deployTemplatesForCondition(
  condition: AutoDeployCondition,
  context: AutoDeployContext,
): Task[] {
  const templates = getAutoDeployTemplates(condition, context.db)
  if (templates.length === 0) {
    return []
  }

  const deployedTasks: Task[] = []
  for (const template of templates) {
    deployedTasks.push(deployTemplateTask(template, context))
  }

  return deployedTasks
}

/**
 * Launch auto-deploy post-run tasks.
 */
export function launchAutoDeployPostRunTasks(
  runKind: WorkflowRun["kind"],
  hasFailures: boolean,
  context: AutoDeployContext,
  startSingle: (taskId: string) => Effect.Effect<WorkflowRun, unknown>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (!shouldCheckAutoDeploy(runKind)) {
      return
    }

    const condition: AutoDeployCondition = hasFailures ? "workflow_failed" : "workflow_done"
    const deployedTasks = [
      ...deployTemplatesForCondition(condition, context),
      ...deployTemplatesForCondition("after_workflow_end", context),
    ]

    if (deployedTasks.length === 0) {
      return
    }

    for (const deployedTask of deployedTasks) {
      yield* startSingle(deployedTask.id)
    }
  })
}
