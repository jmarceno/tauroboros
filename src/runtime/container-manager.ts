import { spawn, execSync } from "child_process"
import { randomUUID } from "crypto"
import { Effect, Schema } from "effect"
import { ContainerImageManager, type ImageStatusChangeHandler } from "./container-image-manager.ts"
import { MockServerManager, MockServerManagerError } from "./mock-server-manager.ts"
import { BASE_IMAGES } from "../config/base-images.ts"
import * as path from "path"
import * as fs from "fs"

// Logging helpers using Effect.log for observability
function logInfo(message: string): Effect.Effect<void> {
  return Effect.logInfo(message)
}

function logDebug(message: string): Effect.Effect<void> {
  return Effect.logDebug(message)
}

function logError(message: string): Effect.Effect<void> {
  return Effect.logError(message)
}

// Legacy sync logging functions for backward compatibility during migration
// These should NOT be used in new code - use logInfo/logDebug/logError instead
function writeInfo(message: string): void {
  process.stdout.write(`${message}\n`)
}

function writeDebug(message: string): void {
  process.stderr.write(`${message}\n`)
}

function writeError(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * Tagged error for container operations
 */
export class ContainerManagerError extends Schema.TaggedError<ContainerManagerError>()("ContainerManagerError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export { ContainerImageManager, type ImageStatusChangeHandler }

export interface ContainerConfig {
  sessionId: string
  worktreeDir: string // Same path on host and in container
  repoRoot: string // Same path on host and in container
  env?: Record<string, string>
  networkMode?: string // Default: bridge
  cpuCount?: number
  memoryMb?: number
  imageName?: string
  useMockLLM?: boolean
  mountPodmanSocket?: boolean // Mount host's podman socket for container nesting
}

export interface ContainerProcess {
  sessionId: string
  containerId: string
  stdin: WritableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  kill(): Effect.Effect<void, ContainerManagerError>
  inspect(): Effect.Effect<{ State: { Status: string; Running: boolean } }, ContainerManagerError>
}

export interface VolumeMount {
  Source: string
  Target: string
  Type: "bind" | "volume"
  ReadOnly: boolean
}

/**
 * Creates volume mounts for container with same-path binding strategy.
 * All paths must be identical inside and outside the container for git worktrees to work.
 */
export function createVolumeMounts(
  worktreeDir: string,
  repoRoot: string,
  mountPodmanSocket = false,
  agentDirOverride?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = []

  // Repository root (read-write) - must be writable for git cherry-pick/merge
  // and worktree metadata operations (.git/worktrees/ etc.)
  mounts.push({
    Source: repoRoot,
    Target: repoRoot,
    Type: "bind",
    ReadOnly: false,
  })

  // Worktree (read-write) - same path inside/outside
  mounts.push({
    Source: worktreeDir,
    Target: worktreeDir,
    Type: "bind",
    ReadOnly: false,
  })

  // Git config - map from host home to container root
  const homeDir = process.env.HOME || "/home/user"
  mounts.push({
    Source: `${homeDir}/.gitconfig`,
    Target: "/root/.gitconfig",
    Type: "bind",
    ReadOnly: true,
  })

  // SSH keys for git operations
  mounts.push({
    Source: `${homeDir}/.ssh`,
    Target: "/root/.ssh",
    Type: "bind",
    ReadOnly: true,
  })

  // Pi config directory (contains models.json, auth.json, etc.)
  mounts.push({
    Source: `${homeDir}/.pi`,
    Target: "/root/.pi",
    Type: "bind",
    ReadOnly: false,
  })

  if (agentDirOverride) {
    mounts.push({
      Source: agentDirOverride,
      Target: "/root/.pi/agent",
      Type: "bind",
      ReadOnly: false,
    })
  }

  // Podman socket for container nesting (Docker-in-Docker via socket mount)
  if (mountPodmanSocket) {
    const uid = process.getuid?.() || 1000
    const podmanSocketPath = `/run/user/${uid}/podman/podman.sock`
    mounts.push({
      Source: podmanSocketPath,
      Target: "/var/run/docker.sock",
      Type: "bind",
      ReadOnly: false,
    })
  }

  return mounts
}

/**
 * Container Manager using pure Podman (without gVisor)
 *
 * Uses an Ubuntu-based image with Bun and Pi pre-installed.
 * Provides filesystem and port isolation through standard container boundaries.
 */
export class PiContainerManager {
  private readonly imageName: string
  private readonly containers = new Map<string, ContainerProcess>()
  private imageManager?: ContainerImageManager
  private mockServerManager?: MockServerManager

  constructor(
    imageName: string = BASE_IMAGES.piAgent,
    imageManager?: ContainerImageManager,
  ) {
    this.imageName = imageName
    this.imageManager = imageManager
  }

  setMockServerManager(manager: MockServerManager): void {
    this.mockServerManager = manager
  }

  getMockServerManager(): MockServerManager | undefined {
    return this.mockServerManager
  }

  private startMockServerIfNeeded(config: ContainerConfig): Effect.Effect<number | null, ContainerManagerError> {
    return Effect.gen(this, function* () {
      if (!config.useMockLLM) {
        return null
      }

      const port = process.env.MOCK_LLM_PORT ? parseInt(process.env.MOCK_LLM_PORT, 10) : 9999
      if (!this.mockServerManager) {
        return yield* new ContainerManagerError({
          operation: "startMockServerIfNeeded",
          message: "Mock LLM was requested but no MockServerManager is configured",
        })
      }

      const mockLlmServerPath = path.join(process.cwd(), 'mock-llm-server')
      yield* this.mockServerManager.start(mockLlmServerPath).pipe(
        Effect.mapError((cause) => new ContainerManagerError({
          operation: "startMockServerIfNeeded",
          message: cause instanceof MockServerManagerError ? cause.message : String(cause),
          cause,
        })),
      )

      return port
    })
  }

  private generateModelsJson(containerId: string, mockPort: number, repoRoot: string, useHostNetwork: boolean = false): Effect.Effect<void, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const modelsJson = {
        providers: {
          fake: {
            baseUrl: `http://localhost:${mockPort}/v1`,
            apiKey: 'fake-key-not-used',
            api: 'openai-completions',
            models: [
              {
                id: 'fake-model',
                name: 'Fake Model',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }

      const tauroborosDir = path.join(repoRoot, '.tauroboros')
      const piDir = path.join(tauroborosDir, 'agent')
      const modelsJsonPath = path.join(piDir, 'models.json')

      yield* Effect.try({
        try: () => {
          fs.mkdirSync(piDir, { recursive: true })
          fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsJson, null, 2))
        },
        catch: (cause) => new ContainerManagerError({
          operation: "generateModelsJson",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      yield* logInfo(`[container-manager] Generated models.json at ${modelsJsonPath}`)
    })
  }

  /**
   * Get the image manager if configured.
   */
  getImageManager(): ContainerImageManager | undefined {
    return this.imageManager
  }

  /**
   * Set the image manager after construction.
   */
  setImageManager(imageManager: ContainerImageManager): void {
    this.imageManager = imageManager
  }

  /**
   * Ensure the container image is ready for use.
   * Called at server startup (not on every container creation).
   * This method triggers a build/pull if the image is missing.
   */
  ensureImageReady(): Effect.Effect<void, ContainerManagerError> {
    const self = this
    return Effect.gen(function* () {
      if (self.imageManager) {
        yield* self.imageManager.prepare().pipe(
          Effect.mapError((cause) => new ContainerManagerError({
            operation: "ensureImageReady",
            message: `Failed to prepare image: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          })),
        )
      } else {
        const exists = yield* self.execPodman(["image", "exists", self.imageName]).pipe(
          Effect.match({
            onSuccess: () => true,
            onFailure: () => false,
          })
        )
        if (!exists) {
          return yield* new ContainerManagerError({
            operation: "ensureImageReady",
            message: `Podman image '${self.imageName}' not found. Build it with: podman build -t ${self.imageName} -f docker/pi-agent/Dockerfile .`,
          })
        }
      }
    })
  }

  /**
   * Verify that the container image is ready (must have been prepared already).
   * This does NOT trigger image builds - it only checks the prepared flag.
   * Returns an Effect that fails if the image was not prepared, preventing any
   * fallback to building/pulling during task execution.
   */
  verifyImageReady(): Effect.Effect<void, ContainerManagerError> {
    return Effect.gen(this, function* () {
      if (this.imageManager && !this.imageManager.isReady()) {
        return yield* new ContainerManagerError({
          operation: "verifyImageReady",
          message: `Container image '${this.imageName}' has not been prepared. The server must prepare the image on startup before containers can be created. Ensure 'autoPrepare: true' is set in .tauroboros/settings.json or manually prepare the image.`,
        })
      }
    })
  }

  /**
   * Check if podman is available
   */
  static isAvailable(): Effect.Effect<boolean, never> {
    return Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => {
          execSync("podman --version", { stdio: "pipe" })
          return true
        },
        catch: () => false,
      }).pipe(
        Effect.catchAll(() => Effect.succeed(false))
      )
      if (!result) {
        yield* logDebug(`[container-manager] Podman not available`)
      }
      return result
    })
  }

  /**
   * Create and start a new container for a pi agent session.
   */
  createContainer(config: ContainerConfig): Effect.Effect<ContainerProcess, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const imageName = config.imageName || this.imageName

      yield* this.verifyImageReady()

      const mockPort = yield* this.startMockServerIfNeeded(config)
      if (mockPort !== null) {
        yield* this.generateModelsJson(imageName, mockPort, config.repoRoot)
      }

      return yield* this.createContainerInternal(config)
    })
  }

  private createContainerInternal(config: ContainerConfig): Effect.Effect<ContainerProcess, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const imageName = config.imageName || this.imageName

      // Use host network when mock LLM is enabled so container can reach mock server on localhost
      const networkMode = config.useMockLLM ? "host" : (config.networkMode || "bridge")

      const agentDirOverride = config.useMockLLM ? path.join(config.repoRoot, '.tauroboros', 'agent') : undefined
      const mounts = createVolumeMounts(config.worktreeDir, config.repoRoot, config.mountPodmanSocket, agentDirOverride)

      // Build mount arguments for podman
      const mountArgs: string[] = []
      for (const mount of mounts) {
        const roFlag = mount.ReadOnly ? ",ro" : ""
        mountArgs.push("--volume", `${mount.Source}:${mount.Target}:z${roFlag}`)
      }

      // Environment variables
      // PI_OFFLINE=1 prevents pi's package manager from auto-installing
      // packages on every startup. Packages listed in ~/.pi/agent/settings.json
      // would otherwise trigger npm install on each fresh container start
      // (containers are ephemeral with --rm, so installed packages don't persist).
      // PI_CODING_AGENT=true allows subprocesses to detect they are running inside the coding agent.
      const defaultEnv: Record<string, string> = {
        PI_OFFLINE: "1",
        PI_CODING_AGENT: "true",
      }

      // If mounting podman socket, set DOCKER_HOST so docker-compose can find it
      if (config.mountPodmanSocket) {
        defaultEnv.DOCKER_HOST = "unix:///var/run/docker.sock"
      }
      if (!config.env) {
        return yield* new ContainerManagerError({
          operation: "createContainer",
          message: "Container config.env is required but was not provided",
        })
      }
      const envVars = { ...defaultEnv, ...config.env }
      const envArgs: string[] = []
      for (const [key, value] of Object.entries(envVars)) {
        envArgs.push("-e", `${key}=${value}`)
      }

      // Generate container name
      const containerName = `tauroboros-${config.sessionId}`

      // Resource limits
      const resourceArgs: string[] = []
      if (config.memoryMb) {
        resourceArgs.push("--memory", `${config.memoryMb}m`)
      }
      if (config.cpuCount) {
        resourceArgs.push("--cpus", config.cpuCount.toString())
      }

      // Security options
      const securityArgs = [
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
      ]

      // Network
      const networkArgs = ["--network", networkMode]

      // Build the podman run command (without -d for proper stdin handling)
      const podmanArgs = [
        "run",
        "--rm",  // Auto-remove after exit
        "--name", containerName,
        "--workdir", config.worktreeDir,
        "-i",  // Interactive (keep stdin open)
        "--label", `tauroboros.session-id=${config.sessionId}`,
        "--label", `tauroboros.managed=true`,
        ...resourceArgs,
        ...securityArgs,
        ...networkArgs,
        ...mountArgs,
        ...envArgs,
        imageName,
      ]

      // Spawn podman run directly for proper stdin/stdout handling
      const proc = spawn("podman", podmanArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      })

      // Wait for container to be ready by polling podman ps
      // instead of a fixed 15-second delay
      let containerId = ""
      const startTime = Date.now()
      const maxWaitMs = 15000 // Max 15 seconds, but usually much faster
      const pollIntervalMs = 500

      while (Date.now() - startTime < maxWaitMs) {
        const result = yield* this.execPodman([
          "ps", "-q", "-f", `name=${containerName}`,
        ]).pipe(
          Effect.catchAll((err) => {
            // Container not ready yet, continue polling
            // This is expected during startup polling, so we only log at debug level
            writeDebug(`[container-manager] Container not ready yet during polling: ${err.message}`)
            return Effect.succeed({ stdout: "", stderr: "" })
          })
        )
        
        containerId = result.stdout.trim()
        if (containerId) {
          // Container is running, pi should be ready soon
          break
        }
        
        yield* Effect.sleep(pollIntervalMs)
      }

      if (!containerId) {
        return yield* new ContainerManagerError({
          operation: "createContainer",
          message: `Container failed to start within ${maxWaitMs}ms. The container process started but podman could not find a running container with name ${containerName}. Check podman logs with: podman logs ${containerName}`,
        })
      }

      // Create process wrapper with stdio streams
      const self = this
      const process: ContainerProcess = {
        sessionId: config.sessionId,
        containerId: containerId || `proc-${proc.pid}`,

        stdin: new WritableStream({
          write: async (chunk: Uint8Array) => {
            return new Promise((resolve, reject) => {
              if (!proc.stdin) {
                reject(new Error("Process stdin not available"))
                return
              }
              proc.stdin.write(chunk, (err) => {
                if (err) reject(err)
                else resolve()
              })
            })
          },
        }),

        stdout: new ReadableStream({
          start: (controller) => {
            if (!proc.stdout) {
              controller.close()
              return
            }

            let isClosed = false

            proc.stdout.on("data", (data: Buffer) => {
              if (!isClosed) {
                try {
                  controller.enqueue(new Uint8Array(data))
                } catch (err) {
                  writeDebug(`[container-manager] stdout controller already closed: ${err instanceof Error ? err.message : String(err)}`)
                }
              }
            })

            proc.stdout.on("end", () => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.close()
                } catch (err) {
                  writeDebug(`[container-manager] stdout controller already closed on end: ${err instanceof Error ? err.message : String(err)}`)
                }
              }
            })

            proc.on("error", (err) => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.error(err)
                } catch (closeErr) {
                  writeError(`[container-manager] Failed to error stdout controller: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`)
                }
              }
            })
          },
        }),

        stderr: new ReadableStream({
          start: (controller) => {
            if (!proc.stderr) {
              controller.close()
              return
            }

            let isClosed = false

            proc.stderr.on("data", (data: Buffer) => {
              if (!isClosed) {
                try {
                  controller.enqueue(new Uint8Array(data))
                } catch (err) {
                  writeDebug(`[container-manager] stderr controller already closed: ${err instanceof Error ? err.message : String(err)}`)
                }
              }
            })

            proc.stderr.on("end", () => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.close()
                } catch (err) {
                  writeDebug(`[container-manager] stderr controller already closed on end: ${err instanceof Error ? err.message : String(err)}`)
                }
              }
            })

            proc.on("error", (err) => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.error(err)
                } catch (closeErr) {
                  writeError(`[container-manager] Failed to error stderr controller: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`)
                }
              }
            })
          },
        }),

        kill: () => Effect.gen(function* () {
          if (containerId && !containerId.startsWith("pending") && !containerId.startsWith("proc-")) {
            yield* self.execPodman(["kill", containerName]).pipe(
              Effect.catchAll((err) => {
                writeDebug(`[container-manager] Error killing container (may already be stopped): ${err.message}`)
                return Effect.void
              })
            )
          } else {
            proc.kill()
          }
          self.containers.delete(config.sessionId)
        }),

        inspect: () => Effect.gen(function* () {
          if (containerId && !containerId.startsWith("pending") && !containerId.startsWith("proc-")) {
            return yield* self.inspectContainer(containerId)
          }
          return { State: { Status: "running", Running: true } }
        }),
      }

      this.containers.set(config.sessionId, process)
      return process
    })
  }

  /**
   * Kill a container by session ID.
   */
  killContainer(sessionId: string): Effect.Effect<void, ContainerManagerError> {
    return this.killContainerInternal(sessionId)
  }

  private killContainerInternal(sessionId: string): Effect.Effect<void, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const process = this.containers.get(sessionId)
      if (process) {
        yield* process.kill()
      }
    })
  }

  /**
   * Check if a container exists and is running by session ID.
   * Returns the container info if found and running, null otherwise.
   */
  checkContainerExists(sessionId: string): Effect.Effect<{
    containerId: string
    containerName: string
    status: string
    running: boolean
  } | null, ContainerManagerError> {
    return this.checkContainerExistsInternal(sessionId)
  }

  private checkContainerExistsInternal(sessionId: string): Effect.Effect<{
    containerId: string
    containerName: string
    status: string
    running: boolean
  } | null, ContainerManagerError> {
    return Effect.gen(this, function* () {
      // First check our managed containers
      const managedProcess = this.containers.get(sessionId)
      if (managedProcess) {
        const inspectionResult = yield* managedProcess.inspect().pipe(
          Effect.match({
            onSuccess: (inspection) => {
              if (inspection.State.Running) {
                return {
                  containerId: managedProcess.containerId,
                  containerName: `tauroboros-${sessionId}`,
                  status: inspection.State.Status,
                  running: true,
                }
              }
              return null
            },
            onFailure: (err) => {
              writeDebug(`[container-manager] Container ${sessionId} exists in map but inspection failed: ${err.message}`)
              return null
            },
          })
        )
        if (inspectionResult) {
          return inspectionResult
        }
      }

      // Check if container exists in podman but is not in our managed map
      // (e.g., after server restart)
      const containerName = `tauroboros-${sessionId}`
      const result = yield* this.execPodman([
        "ps",
        "-a",
        "-f", `name=${containerName}`,
        "--format", "{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}",
      ]).pipe(
        Effect.catchAll((err) => {
          writeDebug(`[container-manager] Error checking container existence for ${sessionId}: ${err.message}`)
          return Effect.succeed({ stdout: "", stderr: "" })
        })
      )

      if (!result.stdout.trim()) {
        return null
      }

      const [id, name, state, status] = result.stdout.trim().split("|")
      if (!id) {
        return null
      }

      const isRunning = state === "running"

      // If container exists but not in our map, add it so we can manage it
      if (isRunning && !managedProcess) {
        // We'll create a minimal process wrapper - the caller will need to
        // properly reconnect stdin/stdout if they want to interact with it
        this.containers.set(sessionId, {
          sessionId,
          containerId: id,
          stdin: new WritableStream(),
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          kill: () => Effect.gen(this, function* () {
            yield* this.execPodman(["kill", id]).pipe(
              Effect.catchAll((err) => {
                writeDebug(`[container-manager] Error killing recovered container (may already be stopped): ${err.message}`)
                return Effect.void
              })
            )
            this.containers.delete(sessionId)
          }),

          inspect: () => Effect.succeed({
            State: { Status: state, Running: true },
          }),
        })
      }

      return {
        containerId: id,
        containerName: containerName,
        status: state,
        running: isRunning,
      }
    })
  }

  /**
   * Check if a container exists and is running by container ID.
   * This is used for resume operations when we only have the container ID.
   */
  checkContainerById(containerId: string): Effect.Effect<{
    containerId: string
    status: string
    running: boolean
  } | null, ContainerManagerError> {
    return this.checkContainerByIdInternal(containerId)
  }

  private checkContainerByIdInternal(containerId: string): Effect.Effect<{
    containerId: string
    status: string
    running: boolean
  } | null, never> {
    return Effect.gen(this, function* () {
      const result = yield* this.execPodman([
        "ps",
        "-a",
        "-f", `id=${containerId}`,
        "--format", "{{.ID}}|{{.State}}|{{.Status}}",
      ]).pipe(
        Effect.match({
          onSuccess: ({ stdout }) => stdout,
          onFailure: (err) => {
            writeDebug(`[container-manager] Error checking container by ID ${containerId}: ${err.message}`)
            return ""
          },
        })
      )

      if (!result.trim()) {
        return null
      }

      const [id, state] = result.trim().split("|")
      if (!id) {
        return null
      }

      return {
        containerId: id,
        status: state,
        running: state === "running",
      }
    })
  }

  /**
   * Attach to an existing container (for resume).
   *
   * CRITICAL: This is the RECOMMENDED approach for container resume operations.
   * Reattaching to an existing container preserves:
   *   - All file system state (modified files, installed packages)
   *   - Environment variables set during execution
   *   - Running processes and their state
   *   - Network connections
   *
   * Container recreation (the fallback) loses all unsaved work and requires
   * re-execution from scratch. Only use recreation when attach fails.
   *
   * Implementation uses 'podman exec' to create a new session in the existing
   * container while preserving all container state.
   *
   * @param containerId - The ID of the container to attach to
   * @param sessionId - The session ID for tracking this attachment
   * @returns ContainerProcess if successful, null if container not running or attach failed
   */
  attachToContainer(containerId: string, sessionId: string): Effect.Effect<ContainerProcess | null, ContainerManagerError> {
    return this.attachToContainerInternal(containerId, sessionId)
  }

  private attachToContainerInternal(containerId: string, sessionId: string): Effect.Effect<ContainerProcess | null, ContainerManagerError> {
    return Effect.gen(this, function* () {
      // Verify container exists and is running
      const containerInfo = yield* this.checkContainerByIdInternal(containerId)
      if (!containerInfo?.running) {
        yield* logInfo(`[container-manager] Container ${containerId} not running, cannot attach`)
        return null
      }

      try {
        yield* logInfo(`[container-manager] Attaching to existing container ${containerId} for session ${sessionId}`)

        // Spawn podman exec to create a new pi rpc session in the existing container
        // The -i flag keeps stdin open, allowing us to send commands
        // The -e flag passes the PI_CODING_AGENT environment variable
        const proc = spawn("podman", [
          "exec",
          "-i",  // Interactive mode - keep stdin open
          "-e", "PI_CODING_AGENT=true",  // Pass environment variable to container
          containerId,
          "pi", "rpc", "--session-id", sessionId,
        ], {
          stdio: ["pipe", "pipe", "pipe"],
        })

        // Wait a moment for the exec to initialize
        yield* Effect.sleep(500)

        // Verify the exec session is still running by checking the process
        if (!proc.pid) {
          yield* logError(`[container-manager] Failed to start podman exec for container ${containerId}`)
          return null
        }

        // Create process wrapper with proper stdio streams
        const self = this
        const process: ContainerProcess = {
          sessionId,
          containerId,

          stdin: new WritableStream({
            write: async (chunk: Uint8Array) => {
              return new Promise((resolve, reject) => {
                if (!proc.stdin) {
                  reject(new Error("Process stdin not available"))
                  return
                }
                proc.stdin.write(chunk, (err) => {
                  if (err) reject(err)
                  else resolve()
                })
              })
            },
          }),

          stdout: new ReadableStream({
            start: (controller) => {
              if (!proc.stdout) {
                controller.close()
                return
              }

              let isClosed = false

              proc.stdout.on("data", (data: Buffer) => {
                if (!isClosed) {
                  try {
                    controller.enqueue(new Uint8Array(data))
                  } catch (err) {
                    writeDebug(`[container-manager] attach stdout controller already closed: ${err instanceof Error ? err.message : String(err)}`)
                  }
                }
              })

              proc.stdout.on("end", () => {
                if (!isClosed) {
                  isClosed = true
                  try {
                    controller.close()
                  } catch (err) {
                    writeDebug(`[container-manager] attach stdout controller already closed on end: ${err instanceof Error ? err.message : String(err)}`)
                  }
                }
              })

              proc.on("error", (err) => {
                if (!isClosed) {
                  isClosed = true
                  try {
                    controller.error(err)
                  } catch (closeErr) {
                    writeError(`[container-manager] Failed to error attach stdout controller: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`)
                  }
                }
              })
            },
          }),

          stderr: new ReadableStream({
            start: (controller) => {
              if (!proc.stderr) {
                controller.close()
                return
              }

              let isClosed = false

              proc.stderr.on("data", (data: Buffer) => {
                if (!isClosed) {
                  try {
                    controller.enqueue(new Uint8Array(data))
                  } catch (err) {
                    writeDebug(`[container-manager] attach stderr controller already closed: ${err instanceof Error ? err.message : String(err)}`)
                  }
                }
              })

              proc.stderr.on("end", () => {
                if (!isClosed) {
                  isClosed = true
                  try {
                    controller.close()
                  } catch (err) {
                    writeDebug(`[container-manager] attach stderr controller already closed on end: ${err instanceof Error ? err.message : String(err)}`)
                  }
                }
              })

              proc.on("error", (err) => {
                if (!isClosed) {
                  isClosed = true
                  try {
                    controller.error(err)
                  } catch (closeErr) {
                    writeError(`[container-manager] Failed to error attach stderr controller: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`)
                  }
                }
              })
            },
          }),

          kill: () => Effect.gen(function* () {
            // Kill the exec session by killing the podman exec process
            proc.kill("SIGTERM")
            // Also try to kill any processes in the container with this session ID
            yield* self.execPodman([
              "exec", containerId,
              "sh", "-c",
              `pkill -f "pi.*${sessionId}" || true`
            ]).pipe(
              Effect.catchAll((err) => {
                writeDebug(`[container-manager] pkill command failed (process may already be stopped): ${err.message}`)
                return Effect.void
              })
            )
            self.containers.delete(sessionId)
          }),

          inspect: () => Effect.gen(function* () {
            // Check if the container is still running
            const info = yield* self.checkContainerByIdInternal(containerId)
            return {
              State: {
                Status: info?.status || "unknown",
                Running: info?.running || false
              },
            }
          }),
        }

        // Register in managed containers
        this.containers.set(sessionId, process)

        yield* logInfo(`[container-manager] Successfully attached to container ${containerId}`)
        return process
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        yield* logError(`[container-manager] Failed to attach to container ${containerId}: ${errorMessage}`)
        return null
      }
    })
  }

  /**
   * Force kill a container (SIGKILL).
   * Used for emergency stop and destructive operations.
   * Never fails - if container doesn't exist, it's considered already stopped.
   */
  forceKillContainer(sessionId: string): Effect.Effect<boolean, never> {
    return this.forceKillContainerInternal(sessionId)
  }

  private forceKillContainerInternal(sessionId: string): Effect.Effect<boolean, never> {
    return Effect.gen(this, function* () {
      const containerName = `tauroboros-${sessionId}`
      // Use Effect.match to handle failures gracefully - container not found is ok
      const result = yield* this.execPodman(["kill", "-s", "SIGKILL", containerName]).pipe(
        Effect.match({
          onSuccess: () => true,
          onFailure: (err) => err,
        })
      )

      if (result === true) {
        this.containers.delete(sessionId)
        return true
      }

      // Log but don't fail - container not existing is acceptable during stop
      const errorMessage = result instanceof Error ? result.message : String(result)
      yield* logDebug(`[container-manager] Container ${sessionId} kill result: ${errorMessage}`)
      this.containers.delete(sessionId)
      return false
    })
  }

  /**
   * Restart a container that exists but is not running.
   * Returns true if successful, false otherwise.
   */
  restartContainer(sessionId: string): Effect.Effect<boolean, ContainerManagerError> {
    return this.restartContainerInternal(sessionId)
  }

  private restartContainerInternal(sessionId: string): Effect.Effect<boolean, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const containerName = `tauroboros-${sessionId}`
      try {
        // First try to start the existing container
        yield* this.execPodman(["start", containerName])

        // Wait a moment for it to be ready
        yield* Effect.sleep(2000)

        // Verify it's running
        const check = yield* this.checkContainerExists(sessionId)
        return check?.running ?? false
      } catch (err) {
        yield* logDebug(`[container-manager] Failed to restart container ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    })
  }

  /**
   * Remove a container by session ID (forcefully if needed).
   */
  removeContainer(sessionId: string, force = false): Effect.Effect<boolean, ContainerManagerError> {
    return this.removeContainerInternal(sessionId, force)
  }

  private removeContainerInternal(sessionId: string, force = false): Effect.Effect<boolean, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const containerName = `tauroboros-${sessionId}`
      try {
        const args = ["rm"]
        if (force) {
          args.push("-f")
        }
        args.push(containerName)
        yield* this.execPodman(args)
        this.containers.delete(sessionId)
        return true
      } catch (err) {
        yield* logDebug(`[container-manager] Failed to remove container ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    })
  }

  /**
   * Clean up all managed containers.
   */
  cleanup(): Effect.Effect<void, ContainerManagerError> {
    return this.cleanupInternal()
  }

  private cleanupInternal(): Effect.Effect<void, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const killEffects = Array.from(this.containers.values()).map((proc) => proc.kill())
      const killResults = yield* Effect.all(killEffects, { mode: "either" })

      // Log any failures but continue clearing the map
      for (let i = 0; i < killResults.length; i++) {
        const result = killResults[i]
        if (result._tag === "Left") {
          yield* logError(`[container-manager] Failed to kill container at index ${i}: ${result.left.message}`)
        }
      }

      this.containers.clear()
    })
  }

  close(): Effect.Effect<void, ContainerManagerError> {
    return Effect.gen(this, function* () {
      yield* this.cleanupInternal()

      if (this.mockServerManager?.isRunning()) {
        yield* this.mockServerManager.stop().pipe(
          Effect.mapError((cause) => new ContainerManagerError({
            operation: "close",
            message: cause instanceof MockServerManagerError ? cause.message : String(cause),
            cause,
          })),
        )
      }
    })
  }

  /**
   * List all managed containers.
   */
  listManagedContainers(): Effect.Effect<
    { sessionId: string; containerId: string; status: string }[],
    never
  > {
    return this.listManagedContainersInternal()
  }

  private listManagedContainersInternal(): Effect.Effect<
    { sessionId: string; containerId: string; status: string }[],
    never
  > {
    return Effect.gen(this, function* () {
      const { stdout } = yield* this.execPodman([
        "ps",
        "-a",
        "--filter", "label=tauroboros.managed=true",
        "--format", "{{.ID}}|{{.Names}}|{{.State}}|{{.Labels}}",
      ]).pipe(
        Effect.catchAll((err) =>
          Effect.gen(this, function* () {
            yield* logDebug(`[container-manager] Failed to list managed containers: ${err.message}`)
            return { stdout: "", stderr: "" }
          })
        )
      )

      const containers: { sessionId: string; containerId: string; status: string }[] = []

      for (const line of stdout.trim().split("\n")) {
        if (!line) continue
        const [id, names, state, labels] = line.split("|")

        const sessionIdMatch = labels?.match(/tauroboros\.session-id=([^,]+)/)
        const sessionId = sessionIdMatch?.[1] || "unknown"

        containers.push({
          sessionId,
          containerId: id,
          status: state,
        })
      }

      return containers
    })
  }

  /**
   * Emergency stop - kill all tauroboros containers.
   */
  emergencyStop(): Effect.Effect<number, never> {
    return this.emergencyStopInternal()
  }

  private emergencyStopInternal(): Effect.Effect<number, never> {
    return Effect.gen(this, function* () {
      const containers = yield* this.listManagedContainersInternal()
      let killed = 0

      for (const info of containers) {
        const killResult = yield* this.execPodman(["kill", info.containerId]).pipe(
          Effect.match({
            onSuccess: () => {
              killed++
              return true
            },
            onFailure: (err) => {
              return err
            },
          })
        )

        if (killResult !== true) {
          yield* logDebug(`[container-manager] Failed to kill container ${info.containerId} during emergency stop: ${killResult instanceof Error ? killResult.message : String(killResult)}`)
        }
      }

      this.containers.clear()
      return killed
    })
  }

  /**
   * Check if podman and the image are available.
   */
  validateSetup(): Effect.Effect<{
    podman: boolean
    image: boolean
    errors: string[]
  }, never> {
    return this.validateSetupInternal()
  }

  private validateSetupInternal(): Effect.Effect<{
    podman: boolean
    image: boolean
    errors: string[]
  }, never> {
    return Effect.gen(this, function* () {
      const errors: string[] = []

      let podman = false
      const podmanResult = yield* this.execPodman(["--version"]).pipe(
        Effect.match({
          onSuccess: () => true,
          onFailure: () => false,
        })
      )

      if (podmanResult) {
        podman = true
      } else {
        errors.push("Podman is not available")
      }

      let image = false
      if (podman) {
        const imageResult = yield* this.execPodman(["image", "exists", this.imageName]).pipe(
          Effect.match({
            onSuccess: () => true,
            onFailure: () => false,
          })
        )

        if (imageResult) {
          image = true
        } else {
          errors.push(
            `Podman image '${this.imageName}' not found. Run: podman build -t ${this.imageName} -f docker/pi-agent/Dockerfile .`,
          )
        }
      }

      return { podman, image, errors }
    })
  }

  /**
   * Check if a specific image exists in Podman.
   */
  checkImageExists(imageName: string): Effect.Effect<boolean, ContainerManagerError> {
    return this.checkImageExistsInternal(imageName)
  }

  private checkImageExistsInternal(imageName: string): Effect.Effect<boolean, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const result = yield* this.execPodman(["image", "exists", imageName]).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false))
      )
      return result
    })
  }

  /**
   * List all available pi-agent images from Podman.
   */
  listImages(): Effect.Effect<Array<{
    tag: string
    createdAt: number
    size: string
  }>, never> {
    return this.listImagesInternal()
  }

  private listImagesInternal(): Effect.Effect<Array<{
    tag: string
    createdAt: number
    size: string
  }>, never> {
    return Effect.gen(this, function* () {
      const { stdout } = yield* this.execPodman([
        "images",
        "--format", "json",
        "--filter", "reference=*pi-agent*"
      ]).pipe(
        Effect.catchAll((err) =>
          Effect.gen(this, function* () {
            yield* logError(`[container-manager] Failed to list images: ${err.message}`)
            return { stdout: "[]", stderr: "" }
          })
        )
      )

      let images: Array<{
        Names?: string[]
        CreatedAt?: string
        Size?: string
        RepoTags?: string[]
      }> = []
      
      try {
        images = JSON.parse(stdout) as Array<{
          Names?: string[]
          CreatedAt?: string
          Size?: string
          RepoTags?: string[]
        }>
      } catch {
        images = []
      }

      const result: Array<{ tag: string; createdAt: number; size: string }> = []

      for (const img of images) {
        const tags = img.Names || img.RepoTags || []
        for (const tag of tags) {
          if (tag.includes("pi-agent")) {
            result.push({
              tag,
              createdAt: img.CreatedAt ? new Date(img.CreatedAt).getTime() : Date.now(),
              size: img.Size || "unknown",
            })
          }
        }
      }

      return result.sort((a, b) => b.createdAt - a.createdAt)
    })
  }

  /**
   * Delete an image by tag.
   */
  deleteImage(imageName: string): Effect.Effect<{ success: boolean; error?: string }, ContainerManagerError> {
    return this.deleteImageInternal(imageName)
  }

  private deleteImageInternal(imageName: string): Effect.Effect<{ success: boolean; error?: string }, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const result = yield* this.execPodman(["rmi", imageName]).pipe(
        Effect.map(() => ({ success: true as const })),
        Effect.catchAll((err) => Effect.succeed({
          success: false as const,
          error: err instanceof Error ? err.message : String(err)
        }))
      )
      return result
    })
  }

  /**
   * Inspect a container and return its state.
   */
  private inspectContainer(containerId: string): Effect.Effect<{ State: { Status: string; Running: boolean } }, ContainerManagerError> {
    return Effect.gen(this, function* () {
      const { stdout } = yield* this.execPodman([
        "inspect",
        "--format", "{{.State.Status}}|{{.State.Running}}",
        containerId,
      ])

      const [status, running] = stdout.trim().split("|")
      return {
        State: {
          Status: status,
          Running: running === "true",
        },
      }
    })
  }

  /**
   * Execute a podman command and return stdout/stderr.
   */
  private execPodman(args: string[]): Effect.Effect<{ stdout: string; stderr: string }, ContainerManagerError> {
    return Effect.async((resume) => {
      const proc = spawn("podman", args, {
        stdio: ["pipe", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on("close", (code) => {
        if (code === 0) {
          resume(Effect.succeed({ stdout, stderr }))
        } else {
          resume(Effect.fail(new ContainerManagerError({
            operation: "execPodman",
            message: `Podman command failed with code ${code}: ${stderr || stdout}`,
          })))
        }
      })

      proc.on("error", (err) => {
        resume(Effect.fail(new ContainerManagerError({
          operation: "execPodman",
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        })))
      })
    })
  }

}
