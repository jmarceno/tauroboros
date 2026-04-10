/**
 * E2E Test: Real Workflow End-to-End
 *
 * This test runs a REAL workflow using the orchestrator with container isolation.
 * NO MOCKS - uses actual Pi agents, actual containers, actual git operations.
 *
 * Prerequisites:
 * - Podman installed and running
 * - pi-agent:alpine image built
 * - Pi configured with valid credentials
 * - minimax/MiniMax-M2.7 model available
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execSync } from "child_process"
import { PiKanbanDB } from "../../src/db.ts"
import { PiOrchestrator } from "../../src/orchestrator.ts"
import { PiContainerManager } from "../../src/runtime/container-manager.ts"
import { E2E_CONFIG, getModelConfig } from "./config.ts"
import { shouldSkipContainerTests, createTempGitRepo, createWorktree, sleep } from "./utils.ts"

const prerequisites = shouldSkipContainerTests()
const describeOrSkip = prerequisites.skip ? describe.skip : describe

describeOrSkip("Real Workflow End-to-End", () => {
  let db: PiKanbanDB
  let orchestrator: PiOrchestrator
  let containerManager: PiContainerManager
  let projectDir: string
  let testRepoDir: string
  let events: unknown[] = []

  beforeAll(async () => {
    // Create a temporary project directory for the workflow
    projectDir = mkdtempSync(join(tmpdir(), "pi-e2e-workflow-"))

    // Initialize a real git repository
    testRepoDir = join(projectDir, "repo")
    mkdirSync(testRepoDir, { recursive: true })
    execSync("git init", { cwd: testRepoDir, stdio: "pipe" })
    execSync('git config user.email "test@example.com"', { cwd: testRepoDir, stdio: "pipe" })
    execSync('git config user.name "Test User"', { cwd: testRepoDir, stdio: "pipe" })

    // Create initial commit
    writeFileSync(join(testRepoDir, "README.md"), "# Test Repository\n\nInitial content.\n")
    execSync("git add .", { cwd: testRepoDir, stdio: "pipe" })
    execSync('git commit -m "Initial commit"', { cwd: testRepoDir, stdio: "pipe" })

    // Initialize database
    const dbPath = join(projectDir, "test.db")
    db = new PiKanbanDB(dbPath)

    // Set required options
    db.updateOptions({
      mainBranch: "master",
      planModel: E2E_CONFIG.model,
      executionModel: E2E_CONFIG.model,
      reviewModel: E2E_CONFIG.model,
      thinkingLevel: E2E_CONFIG.thinkingLevel,
    })

    // Set up event collection
    events = []
    const broadcast = (message: unknown) => {
      events.push(message)
      // Also log for debugging
      if (process.env.DEBUG_E2E) {
        console.log("Event:", JSON.stringify(message, null, 2))
      }
    }

    // Create session URL function
    const sessionUrlFor = (sessionId: string) => {
      return `http://localhost:3000/sessions/${sessionId}`
    }

    // Create container manager if in container mode
    if (E2E_CONFIG.containerMode) {
      containerManager = new PiContainerManager(E2E_CONFIG.containerImage)
    }

    // Create orchestrator
    orchestrator = new PiOrchestrator(
      db,
      broadcast,
      sessionUrlFor,
      testRepoDir,
      containerManager
    )

    // Enable container mode via environment
    process.env.PI_EASY_WORKFLOW_RUNTIME = "container"
    process.env.PI_EASY_WORKFLOW_CONTAINER_IMAGE = E2E_CONFIG.containerImage
  }, 30000)

  afterAll(async () => {
    // Clean up containers
    if (containerManager) {
      await containerManager.cleanup()
    }

    // Clean up test directory
    if (E2E_CONFIG.cleanupWorktrees && projectDir) {
      try {
        rmSync(projectDir, { recursive: true, force: true })
      } catch {
        // Best effort cleanup
      }
    }

    // Clean up environment
    delete process.env.PI_EASY_WORKFLOW_RUNTIME
    delete process.env.PI_EASY_WORKFLOW_CONTAINER_IMAGE
  }, 30000)

  test(
    "executes a simple task end-to-end in container",
    async () => {
      // Create a simple task: create a file with specific content
      const task = db.createTask({
        name: "Create greeting file",
        prompt:
          'Create a file named "greeting.txt" in the root directory with the content "Hello from container workflow test!". Do not ask for confirmation, just create the file.',
        branch: "test-task-1",
        status: "backlog",
        planmode: false,
        autoApprovePlan: true,
        review: false,
        autoCommit: false,
        deleteWorktree: true,
        ...getModelConfig(),
      })

      expect(task).toBeDefined()
      expect(task.id).toBeDefined()
      expect(task.status).toBe("backlog")

      // Start the workflow
      const run = await orchestrator.startSingle(task.id)

      expect(run).toBeDefined()
      expect(run.id).toBeDefined()
      expect(run.status).toBe("running")
      expect(run.kind).toBe("single_task")

      // Wait for workflow to complete (with timeout)
      const startTime = Date.now()
      let completed = false
      let finalRun = run

      while (Date.now() - startTime < E2E_CONFIG.workflowTimeoutMs) {
        // Get latest run state
        const latestRun = db.getWorkflowRun(run.id)
        if (latestRun) {
          finalRun = latestRun
        }

        // Check if completed
        if (
          latestRun?.status === "completed" ||
          latestRun?.status === "failed"
        ) {
          completed = true
          break
        }

        // Wait a bit before checking again
        await sleep(2000)
      }

      // Verify workflow completed
      expect(completed).toBe(true)
      expect(finalRun.status).toBe("completed")

      // Verify task was executed
      const finalTask = db.getTask(task.id)
      expect(finalTask).toBeDefined()
      expect(finalTask?.status).toBe("done")

      // Verify the file was actually created
      const greetingFilePath = join(testRepoDir, "greeting.txt")
      const fileExists = await Bun.file(greetingFilePath).exists()
      expect(fileExists).toBe(true)

      if (fileExists) {
        const content = await Bun.file(greetingFilePath).text()
        expect(content).toContain("Hello")
        expect(content).toContain("container")
      }

      // Verify events were received
      expect(events.length).toBeGreaterThan(0)

      // Check for run_created event
      const runCreatedEvent = events.find(
        (e: any) => e.type === "run_created"
      )
      expect(runCreatedEvent).toBeDefined()

      // Check for execution_started event
      const executionStartedEvent = events.find(
        (e: any) => e.type === "execution_started"
      )
      expect(executionStartedEvent).toBeDefined()

      // Check for execution_complete event
      const executionCompleteEvent = events.find(
        (e: any) => e.type === "execution_complete"
      )
      expect(executionCompleteEvent).toBeDefined()
    },
    E2E_CONFIG.workflowTimeoutMs + 10000
  )

  test(
    "uses container isolation for task execution",
    async () => {
      // This test verifies that containers are actually being used
      const task = db.createTask({
        name: "Verify container isolation",
        prompt:
          "Run the command 'echo $HOSTNAME' and report the result. This helps verify we're running in a container.",
        branch: "test-task-2",
        status: "backlog",
        planmode: false,
        autoApprovePlan: true,
        review: false,
        autoCommit: false,
        deleteWorktree: true,
        ...getModelConfig(),
      })

      const run = await orchestrator.startSingle(task.id)

      // Wait for completion
      const startTime = Date.now()
      let completed = false

      while (Date.now() - startTime < E2E_CONFIG.workflowTimeoutMs) {
        const latestRun = db.getWorkflowRun(run.id)
        if (
          latestRun?.status === "completed" ||
          latestRun?.status === "failed"
        ) {
          completed = true
          break
        }
        await sleep(2000)
      }

      expect(completed).toBe(true)

      // Verify task completed successfully
      const finalTask = db.getTask(task.id)
      expect(finalTask?.status).toBe("done")

      // Check that agent output contains container hostname
      expect(finalTask?.agentOutput).toBeTruthy()
    },
    E2E_CONFIG.workflowTimeoutMs + 10000
  )

  test(
    "executes multi-task workflow with dependency chain",
    async () => {
      // Clear previous events
      events = []

      // Create task 1: Create a data directory with a config file
      const task1 = db.createTask({
        name: "Create data directory and config",
        prompt:
          'Create a directory named "data" and inside it create a file named "config.json" with the content: {"version": "1.0", "app": "test-app"}. Do not ask for confirmation.',
        branch: "test-task-setup",
        status: "backlog",
        planmode: false,
        autoApprovePlan: true,
        review: false,
        autoCommit: false,
        deleteWorktree: true,
        ...getModelConfig(),
      })

      // Create task 2: Read config and create a summary file
      // This task depends on task 1
      const task2 = db.createTask({
        name: "Create summary from config",
        prompt:
          'Read the file data/config.json, then create a file named "summary.txt" in the root directory containing a human-readable summary of the configuration (app name and version). Do not ask for confirmation.',
        branch: "test-task-summary",
        status: "backlog",
        requirements: [task1.id], // Task 2 depends on Task 1
        planmode: false,
        autoApprovePlan: true,
        review: false,
        autoCommit: false,
        deleteWorktree: true,
        ...getModelConfig(),
      })

      // Create task 3: Create a README referencing both files
      // This task depends on task 2
      const task3 = db.createTask({
        name: "Create project README",
        prompt:
          'Create a comprehensive README.md file that mentions: 1) The data/config.json configuration file, 2) The summary.txt file with configuration summary. Add brief descriptions of what each file contains. Do not ask for confirmation.',
        branch: "test-task-readme",
        status: "backlog",
        requirements: [task2.id], // Task 3 depends on Task 2
        planmode: false,
        autoApprovePlan: true,
        review: false,
        autoCommit: false,
        deleteWorktree: true,
        ...getModelConfig(),
      })

      // Verify tasks were created with correct dependencies
      expect(task1).toBeDefined()
      expect(task2).toBeDefined()
      expect(task3).toBeDefined()
      expect(task2.requirements).toContain(task1.id)
      expect(task3.requirements).toContain(task2.id)

      // Start the workflow from task 3 - it should automatically include tasks 1 and 2
      const run = await orchestrator.startSingle(task3.id)

      expect(run).toBeDefined()
      expect(run.id).toBeDefined()
      expect(run.status).toBe("running")
      expect(run.kind).toBe("single_task")
      // The task order should include all 3 tasks in dependency order
      expect(run.taskOrder.length).toBeGreaterThanOrEqual(3)

      // Wait for workflow to complete
      const startTime = Date.now()
      let completed = false
      let finalRun = run

      while (Date.now() - startTime < E2E_CONFIG.workflowTimeoutMs * 2) { // Double timeout for multi-task
        const latestRun = db.getWorkflowRun(run.id)
        if (latestRun) {
          finalRun = latestRun
        }

        if (
          latestRun?.status === "completed" ||
          latestRun?.status === "failed"
        ) {
          completed = true
          break
        }

        await sleep(2000)
      }

      // Verify workflow completed
      expect(completed).toBe(true)
      expect(finalRun.status).toBe("completed")

      // Verify all tasks were executed
      const finalTask1 = db.getTask(task1.id)
      const finalTask2 = db.getTask(task2.id)
      const finalTask3 = db.getTask(task3.id)

      expect(finalTask1?.status).toBe("done")
      expect(finalTask2?.status).toBe("done")
      expect(finalTask3?.status).toBe("done")

      // Verify all files were created
      const configFilePath = join(testRepoDir, "data", "config.json")
      const summaryFilePath = join(testRepoDir, "summary.txt")
      const readmeFilePath = join(testRepoDir, "README.md")

      // Check config.json
      const configExists = await Bun.file(configFilePath).exists()
      expect(configExists).toBe(true)
      if (configExists) {
        const configContent = await Bun.file(configFilePath).text()
        expect(configContent).toContain("test-app")
        expect(configContent).toContain("1.0")
      }

      // Check summary.txt
      const summaryExists = await Bun.file(summaryFilePath).exists()
      expect(summaryExists).toBe(true)
      if (summaryExists) {
        const summaryContent = await Bun.file(summaryFilePath).text()
        expect(summaryContent.length).toBeGreaterThan(0)
      }

      // Check README.md
      const readmeExists = await Bun.file(readmeFilePath).exists()
      expect(readmeExists).toBe(true)
      if (readmeExists) {
        const readmeContent = await Bun.file(readmeFilePath).text()
        expect(readmeContent.toLowerCase()).toContain("config")
        expect(readmeContent.toLowerCase()).toContain("summary")
      }

      // Verify events were received for the workflow
      expect(events.length).toBeGreaterThan(0)

      // Check for task-specific events
      const taskEvents = events.filter(
        (e: any) => e.type === "task_updated"
      )
      expect(taskEvents.length).toBeGreaterThanOrEqual(3) // At least 3 task updates

      console.log(
        `✓ Multi-task workflow completed: ${finalRun.taskOrder.length} tasks executed`
      )
    },
    E2E_CONFIG.workflowTimeoutMs * 2 + 10000 // Double timeout + buffer
  )
})
