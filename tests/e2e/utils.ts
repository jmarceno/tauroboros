/**
 * E2E Test Utilities for Container Tests
 *
 * These utilities create real git repositories, worktrees, and manage Podman containers.
 * NO MOCKS - all tests use real infrastructure.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execSync } from "child_process"
import type { ContainerProcess } from "../../src/runtime/container-manager.ts"
import { ensureContainerImage } from "./setup.ts"

/**
 * Create a temporary directory.
 */
export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Create a temporary git repository with an initial commit.
 */
export function createTempGitRepo(): string {
  const dir = createTempDir("git-repo-")

  execSync("git init", { cwd: dir, stdio: "pipe" })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" })
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" })

  writeFileSync(join(dir, "README.md"), "# Test Repository\n")
  execSync("git add .", { cwd: dir, stdio: "pipe" })
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: "pipe" })

  return dir
}

/**
 * Create a git worktree in a repository.
 */
export function createWorktree(repoDir: string, name: string): string {
  const worktreeDir = join(repoDir, ".worktrees", name)

  // Ensure parent directory exists
  mkdirSync(join(repoDir, ".worktrees"), { recursive: true })

  execSync(`git worktree add -b ${name} ${worktreeDir}`, {
    cwd: repoDir,
    stdio: "pipe",
  })

  return worktreeDir
}

/**
 * Send an RPC command to a container process.
 */
export async function sendRpcCommand(
  container: ContainerProcess,
  command: object,
): Promise<void> {
  const line = JSON.stringify(command) + "\n"
  const writer = container.stdin.getWriter()
  await writer.write(new TextEncoder().encode(line))
  writer.releaseLock()
}

/**
 * Collect events from a container process until timeout.
 */
export async function collectEvents(
  container: ContainerProcess,
  timeoutMs: number,
): Promise<unknown[]> {
  const events: unknown[] = []
  const reader = container.stdout.getReader()
  const decoder = new TextDecoder()
  const startTime = Date.now()

  // Buffer for incomplete lines across chunks
  let buffer = ""
  let done = false

  try {
    while (!done) {
      // Check if overall timeout has been reached
      const elapsed = Date.now() - startTime
      if (elapsed >= timeoutMs) {
        break
      }

      try {
        const result = await reader.read()
        if (result.done) {
          done = true
          break
        }

        const chunk = decoder.decode(result.value, { stream: true })
        buffer += chunk

        // Process complete lines from buffer
        const lines = buffer.split("\n")
        // Keep the last (potentially incomplete) line in buffer
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            events.push(JSON.parse(trimmed))
          } catch {
            // Ignore non-JSON lines
          }
        }
      } catch {
        // Stream error - break out
        break
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      try {
        events.push(JSON.parse(buffer.trim()))
      } catch {
        // Ignore non-JSON
      }
    }
  } finally {
    reader.releaseLock()
  }

  return events
}

/**
 * Wait for a specific event type in the event stream.
 */
export async function waitForEvent(
  container: ContainerProcess,
  eventType: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const reader = container.stdout.getReader()
  const decoder = new TextDecoder()

  return new Promise((resolve, reject) => {
    let resolved = false

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        reader.releaseLock()
      }
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)

    const processChunk = (value: Uint8Array) => {
      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split("\n").filter((l) => l.trim())

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          if (event.type === eventType) {
            clearTimeout(timeout)
            cleanup()
            resolve(event)
            return
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    }

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) processChunk(value)
        }
        // Stream ended naturally
        clearTimeout(timeout)
        cleanup()
        resolve(null)
      } catch (error) {
        clearTimeout(timeout)
        cleanup()
        reject(error)
      }
    }

    readLoop()
  })
}

/**
 * Read file contents.
 */
export function readFile(path: string): string {
  return execSync(`cat "${path}"`, { encoding: "utf-8", stdio: "pipe" })
}

/**
 * Check if a file exists.
 */
export function fileExists(path: string): boolean {
  try {
    execSync(`test -f "${path}"`, { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Execute a command in a container (for testing purposes).
 * Note: This requires exec support which is not directly available via the
       ContainerProcess interface. For tests, we can inspect the container
       using Podman API directly if needed.
 */
export async function execInContainer(
  _container: ContainerProcess,
  _command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // This would require additional Podman API calls
  // For now, tests should rely on the RPC interface
  throw new Error("execInContainer not yet implemented")
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Check if Podman is available.
 */
export function isPodmanAvailable(): boolean {
  try {
    execSync("podman --version", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Check if gVisor (runsc) is available.
 * Note: gVisor is no longer used - we use standard Podman containers.
 * @deprecated Kept for backwards compatibility, always returns true now.
 */
export function isGVisorAvailable(): boolean {
  // gVisor is no longer required - we use standard Podman containers
  return true
}

/**
 * Check if pi-agent image is built in Podman.
 */
export function isPiAgentImageAvailable(): boolean {
  try {
    const result = execSync("podman images pi-agent:alpine -q", {
      encoding: "utf-8",
      stdio: "pipe",
    })
    return result.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Setup promise for ensuring image is ready.
 * This is shared across all tests to prevent duplicate setup work.
 */
let imageSetupPromise: Promise<void> | null = null

/**
 * Ensure container image is ready for tests.
 * This function is idempotent and safe to call from any test.
 */
export async function setupContainerImage(): Promise<void> {
  if (!imageSetupPromise) {
    imageSetupPromise = ensureContainerImage()
  }
  await imageSetupPromise
}

/**
 * Skip test helper that checks prerequisites.
 * Also triggers image setup if needed.
 */
export async function shouldSkipContainerTests(): Promise<{
  skip: boolean
  reason?: string
}> {
  if (!isPodmanAvailable()) {
    return { skip: true, reason: "Podman is not available" }
  }

  // Try to ensure image is ready (may build if needed)
  try {
    await setupContainerImage()
    return { skip: false }
  } catch {
    // If setup fails, check if image exists anyway
    if (isPiAgentImageAvailable()) {
      return { skip: false }
    }
    return {
      skip: true,
      reason:
        "pi-agent:alpine image not found. Run: podman build -t pi-agent:alpine -f docker/pi-agent/Dockerfile .",
    }
  }
}
