/**
 * E2E Tests: Container Lifecycle
 *
 * Tests basic Podman container creation, management, and cleanup.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  PiContainerManager,
  createVolumeMounts,
} from "../../src/runtime/container-manager.ts"
import {
  createTempGitRepo,
  createWorktree,
  setupContainerImage,
  isPodmanAvailable,
  isPiAgentImageAvailable,
} from "./utils.ts"

// Skip all tests if Podman is not available
const skipTests = !isPodmanAvailable()
if (skipTests) {
  console.log("Skipping container tests: Podman is not available")
}

const describeOrSkip = skipTests ? describe.skip : describe

describeOrSkip("Container Lifecycle", () => {
  let containerManager: PiContainerManager
  let repoDir: string
  let worktreeDir: string

  beforeAll(async () => {
    // Ensure container image is ready (builds if needed)
    await setupContainerImage()

    containerManager = new PiContainerManager()
    repoDir = createTempGitRepo()
    worktreeDir = createWorktree(repoDir, "test-task")
  })

  afterAll(async () => {
    // Clean up any remaining containers
    await containerManager.cleanup()

    // Clean up temp directories
    try {
      await Bun.write(repoDir, "", { createPath: false })
    } catch {
      // Best effort cleanup
    }
  })

  test("creates and destroys container successfully", async () => {
    const sessionId = `test-lifecycle-${Date.now()}`

    const container = await containerManager.createContainer({
      sessionId,
      worktreeDir,
      repoRoot: repoDir,
    })

    expect(container.containerId).toBeDefined()
    expect(container.sessionId).toBe(sessionId)

    // Verify container is running
    const inspect = await container.inspect()
    expect(inspect.State.Running).toBe(true)

    // Kill container
    await container.kill()

    // Wait a moment for container to stop
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Verify container is removed (AutoRemove should be enabled)
    const containers = await containerManager.listManagedContainers()
    const found = containers.find((c) => c.sessionId === sessionId)
    expect(found).toBeUndefined()
  }, 30000) // 30 second timeout

  test("creates multiple containers with different session IDs", async () => {
    const sessionIds = [
      `test-multi-1-${Date.now()}`,
      `test-multi-2-${Date.now()}`,
    ]

    const containers = await Promise.all(
      sessionIds.map((sessionId) =>
        containerManager.createContainer({
          sessionId,
          worktreeDir,
          repoRoot: repoDir,
        }),
      ),
    )

    expect(containers).toHaveLength(2)
    expect(containers[0].containerId).not.toBe(containers[1].containerId)

    // Clean up
    await Promise.all(containers.map((c) => c.kill()))
  }, 30000)

  test("emergency stop kills all managed containers", async () => {
    // Create several containers
    const containers = await Promise.all(
      [1, 2, 3].map((i) =>
        containerManager.createContainer({
          sessionId: `test-emergency-${i}-${Date.now()}`,
          worktreeDir,
          repoRoot: repoDir,
        }),
      ),
    )

    // Verify containers exist
    const beforeList = await containerManager.listManagedContainers()
    expect(beforeList.length).toBeGreaterThanOrEqual(3)

    // Emergency stop
    const killed = await containerManager.emergencyStop()
    expect(killed).toBeGreaterThanOrEqual(3)

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Verify all stopped
    const afterList = await containerManager.listManagedContainers()
    const running = afterList.filter((c) => c.status === "running")
    expect(running).toHaveLength(0)
  }, 30000)

  test("creates correct volume mounts", () => {
    const mounts = createVolumeMounts(worktreeDir, repoDir)

    // Should have: repo (ro), worktree (rw), git, gitconfig, ssh, bun
    expect(mounts.length).toBeGreaterThanOrEqual(4)

    // Check repo is read-only
    const repoMount = mounts.find((m) => m.Source === repoDir)
    expect(repoMount).toBeDefined()
    expect(repoMount?.ReadOnly).toBe(true)
    expect(repoMount?.Target).toBe(repoDir)

    // Check worktree is read-write
    const worktreeMount = mounts.find((m) => m.Source === worktreeDir)
    expect(worktreeMount).toBeDefined()
    expect(worktreeMount?.ReadOnly).toBe(false)
    expect(worktreeMount?.Target).toBe(worktreeDir)

    // Check git is mounted
    const gitMount = mounts.find((m) => m.Source === "/usr/bin/git")
    expect(gitMount).toBeDefined()
    expect(gitMount?.ReadOnly).toBe(true)
  })
})
