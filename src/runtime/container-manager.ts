import { spawn, execSync } from "child_process"
import { randomUUID } from "crypto"
import { Effect, Schema } from "effect"
import { ContainerImageManager, type ImageStatusChangeHandler } from "./container-image-manager.ts"
import { MockServerManager } from "./mock-server-manager.ts"
import { BASE_IMAGES } from "../config/base-images.ts"
import * as path from "path"
import * as fs from "fs"

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
  kill(): Promise<void>
  inspect(): Promise<{ State: { Status: string; Running: boolean } }>
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

  async startMockServerIfNeeded(config: ContainerConfig): Promise<number | null> {
    if (!config.useMockLLM) {
      return null
    }

    const port = process.env.MOCK_LLM_PORT ? parseInt(process.env.MOCK_LLM_PORT, 10) : 9999
    if (this.mockServerManager) {
      const mockLlmServerPath = path.join(process.cwd(), 'mock-llm-server')
      await this.mockServerManager.start(mockLlmServerPath)
    }

    return port
  }

  async generateModelsJson(containerId: string, mockPort: number, repoRoot: string, useHostNetwork: boolean = false): Promise<void> {
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

    fs.mkdirSync(piDir, { recursive: true })
    fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsJson, null, 2))
    console.log(`[container-manager] Generated models.json at ${modelsJsonPath}`)
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
        yield* Effect.tryPromise({
          try: () => self.imageManager!.prepare(),
          catch: (cause) => new ContainerManagerError({
            operation: "ensureImageReady",
            message: `Failed to prepare image: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
        })
      } else {
        const exists = yield* Effect.promise(() =>
          self.execPodman(["image", "exists", self.imageName]).then(
            () => true,
            () => false,
          ),
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
   * Throws a hard error if the image was not prepared, preventing any
   * fallback to building/pulling during task execution.
   */
  verifyImageReady(): void {
    if (this.imageManager && !this.imageManager.isReady()) {
      throw new ContainerManagerError({
        operation: "verifyImageReady",
        message: `Container image '${this.imageName}' has not been prepared. The server must prepare the image on startup before containers can be created. Ensure 'autoPrepare: true' is set in .tauroboros/settings.json or manually prepare the image.`,
      })
    }
  }

  /**
   * Check if podman is available
   */
  static isAvailable(): boolean {
    try {
      execSync("podman --version", { stdio: "pipe" })
      return true
    } catch (err) {
      console.debug(`[container-manager] Podman not available:`, err)
      return false
    }
  }

  /**
   * Create and start a new container for a pi agent session.
   */
  async createContainer(config: ContainerConfig): Promise<ContainerProcess> {
    const imageName = config.imageName || this.imageName

    // Verify image was prepared at server startup - no fallback build during task execution
    this.verifyImageReady()

    // Start mock LLM server if needed and generate models.json
    const mockPort = await this.startMockServerIfNeeded(config)
    if (mockPort !== null) {
      await this.generateModelsJson(imageName, mockPort, config.repoRoot)
    }

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
      throw new ContainerManagerError({
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
      try {
        const { stdout } = await this.execPodman([
          "ps", "-q", "-f", `name=${containerName}`,
        ])
        containerId = stdout.trim()
        if (containerId) {
          // Container is running, pi should be ready soon
          break
        }
      } catch (err) {
        // Container not ready yet, continue polling
        // This is expected during startup polling, so we only log at debug level
        console.debug(`[container-manager] Container not ready yet during polling:`, err)
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    if (!containerId) {
      throw new ContainerManagerError({
        operation: "createContainer",
        message: `Container failed to start within ${maxWaitMs}ms. The container process started but podman could not find a running container with name ${containerName}. Check podman logs with: podman logs ${containerName}`,
      })
    }

    // Create process wrapper with stdio streams
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
                console.debug(`[container-manager] stdout controller already closed:`, err)
              }
            }
          })

          proc.stdout.on("end", () => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.close()
              } catch (err) {
                console.debug(`[container-manager] stdout controller already closed on end:`, err)
              }
            }
          })

          proc.on("error", (err) => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.error(err)
              } catch (closeErr) {
                console.error(`[container-manager] Failed to error stdout controller:`, closeErr)
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
                console.debug(`[container-manager] stderr controller already closed:`, err)
              }
            }
          })

          proc.stderr.on("end", () => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.close()
              } catch (err) {
                console.debug(`[container-manager] stderr controller already closed on end:`, err)
              }
            }
          })

          proc.on("error", (err) => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.error(err)
              } catch (closeErr) {
                console.error(`[container-manager] Failed to error stderr controller:`, closeErr)
              }
            }
          })
        },
      }),

      kill: async () => {
        try {
          if (containerId && !containerId.startsWith("pending") && !containerId.startsWith("proc-")) {
            await this.execPodman(["kill", containerName])
          } else {
            proc.kill()
          }
        } catch (err) {
          console.debug(`[container-manager] Error killing container (may already be stopped):`, err)
        }
        this.containers.delete(config.sessionId)
      },

      inspect: async () => {
        if (containerId && !containerId.startsWith("pending") && !containerId.startsWith("proc-")) {
          return this.inspectContainer(containerId)
        }
        return { State: { Status: "running", Running: true } }
      },
    }

    this.containers.set(config.sessionId, process)
    return process
  }

  /**
   * Kill a container by session ID.
   */
  async killContainer(sessionId: string): Promise<void> {
    const process = this.containers.get(sessionId)
    if (process) {
      await process.kill()
    }
  }

  /**
   * Check if a container exists and is running by session ID.
   * Returns the container info if found and running, null otherwise.
   */
  async checkContainerExists(sessionId: string): Promise<{
    containerId: string
    containerName: string
    status: string
    running: boolean
  } | null> {
    // First check our managed containers
    const managedProcess = this.containers.get(sessionId)
    if (managedProcess) {
      try {
        const inspection = await managedProcess.inspect()
        if (inspection.State.Running) {
          return {
            containerId: managedProcess.containerId,
            containerName: `tauroboros-${sessionId}`,
            status: inspection.State.Status,
            running: true,
          }
        }
      } catch (err) {
        console.debug(`[container-manager] Container ${sessionId} exists in map but inspection failed:`, err)
      }
    }

    // Check if container exists in podman but is not in our managed map
    // (e.g., after server restart)
    const containerName = `tauroboros-${sessionId}`
    try {
      const { stdout } = await this.execPodman([
        "ps",
        "-a",
        "-f", `name=${containerName}`,
        "--format", "{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}",
      ])

      if (!stdout.trim()) {
        return null
      }

      const [id, name, state, status] = stdout.trim().split("|")
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
          kill: async () => {
            await this.execPodman(["kill", id])
          },
          inspect: async () => ({
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
    } catch (err) {
      console.debug(`[container-manager] Error checking container existence for ${sessionId}:`, err)
      return null
    }
  }

  /**
   * Check if a container exists and is running by container ID.
   * This is used for resume operations when we only have the container ID.
   */
  async checkContainerById(containerId: string): Promise<{
    containerId: string
    status: string
    running: boolean
  } | null> {
    try {
      const { stdout } = await this.execPodman([
        "ps",
        "-a",
        "-f", `id=${containerId}`,
        "--format", "{{.ID}}|{{.State}}|{{.Status}}",
      ])

      if (!stdout.trim()) {
        return null
      }

      const [id, state] = stdout.trim().split("|")
      if (!id) {
        return null
      }

      return {
        containerId: id,
        status: state,
        running: state === "running",
      }
    } catch (err) {
      console.debug(`[container-manager] Error checking container by ID ${containerId}:`, err)
      return null
    }
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
  async attachToContainer(containerId: string, sessionId: string): Promise<ContainerProcess | null> {
    // Verify container exists and is running
    const containerInfo = await this.checkContainerById(containerId)
    if (!containerInfo?.running) {
      console.log(`[container-manager] Container ${containerId} not running, cannot attach`)
      return null
    }

    try {
      console.log(`[container-manager] Attaching to existing container ${containerId} for session ${sessionId}`)

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
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Verify the exec session is still running by checking the process
      if (!proc.pid) {
        console.error(`[container-manager] Failed to start podman exec for container ${containerId}`)
        return null
      }

      // Create process wrapper with proper stdio streams
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
                  console.debug(`[container-manager] attach stdout controller already closed:`, err)
                }
              }
            })

            proc.stdout.on("end", () => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.close()
                } catch (err) {
                  console.debug(`[container-manager] attach stdout controller already closed on end:`, err)
                }
              }
            })

            proc.on("error", (err) => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.error(err)
                } catch (closeErr) {
                  console.error(`[container-manager] Failed to error attach stdout controller:`, closeErr)
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
                  console.debug(`[container-manager] attach stderr controller already closed:`, err)
                }
              }
            })

            proc.stderr.on("end", () => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.close()
                } catch (err) {
                  console.debug(`[container-manager] attach stderr controller already closed on end:`, err)
                }
              }
            })

            proc.on("error", (err) => {
              if (!isClosed) {
                isClosed = true
                try {
                  controller.error(err)
                } catch (closeErr) {
                  console.error(`[container-manager] Failed to error attach stderr controller:`, closeErr)
                }
              }
            })
          },
        }),

        kill: async () => {
          try {
            // Kill the exec session by killing the podman exec process
            proc.kill("SIGTERM")
            // Also try to kill any processes in the container with this session ID
            try {
              await this.execPodman([
                "exec", containerId,
                "sh", "-c",
                `pkill -f "pi.*${sessionId}" || true`
              ])
            } catch (err) {
              console.debug(`[container-manager] pkill command failed (process may already be stopped):`, err)
            }
          } catch (err) {
            console.debug(`[container-manager] Error killing attached container process:`, err)
          }
          this.containers.delete(sessionId)
        },

        inspect: async () => {
          // Check if the container is still running
          const info = await this.checkContainerById(containerId)
          return {
            State: {
              Status: info?.status || "unknown",
              Running: info?.running || false
            },
          }
        },
      }

      // Register in managed containers
      this.containers.set(sessionId, process)

      console.log(`[container-manager] Successfully attached to container ${containerId}`)
      return process
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[container-manager] Failed to attach to container ${containerId}: ${message}`)
      return null
    }
  }

  /**
   * Force kill a container (SIGKILL).
   * Used for emergency stop and destructive operations.
   */
  async forceKillContainer(sessionId: string): Promise<boolean> {
    const containerName = `tauroboros-${sessionId}`
    try {
      // Send SIGKILL instead of graceful stop
      await this.execPodman(["kill", "-s", "SIGKILL", containerName])
      this.containers.delete(sessionId)
      return true
    } catch (err) {
      console.debug(`[container-manager] Failed to force kill container ${sessionId}:`, err)
      return false
    }
  }

  /**
   * Restart a container that exists but is not running.
   * Returns true if successful, false otherwise.
   */
  async restartContainer(sessionId: string): Promise<boolean> {
    const containerName = `tauroboros-${sessionId}`
    try {
      // First try to start the existing container
      await this.execPodman(["start", containerName])

      // Wait a moment for it to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Verify it's running
      const check = await this.checkContainerExists(sessionId)
      return check?.running ?? false
    } catch (err) {
      console.debug(`[container-manager] Failed to restart container ${sessionId}:`, err)
      return false
    }
  }

  /**
   * Remove a container by session ID (forcefully if needed).
   */
  async removeContainer(sessionId: string, force = false): Promise<boolean> {
    const containerName = `tauroboros-${sessionId}`
    try {
      const args = ["rm"]
      if (force) {
        args.push("-f")
      }
      args.push(containerName)
      await this.execPodman(args)
      this.containers.delete(sessionId)
      return true
    } catch (err) {
      console.debug(`[container-manager] Failed to remove container ${sessionId}:`, err)
      return false
    }
  }

  /**
   * Clean up all managed containers.
   */
  async cleanup(): Promise<void> {
    const killResults = await Promise.allSettled(
      Array.from(this.containers.values()).map((proc) => proc.kill())
    )

    // Log any failures but continue clearing the map
    for (let i = 0; i < killResults.length; i++) {
      const result = killResults[i]
      if (result.status === "rejected") {
        console.error(`[container-manager] Failed to kill container at index ${i}:`, result.reason)
      }
    }

    this.containers.clear()
  }

  async close(): Promise<void> {
    await this.cleanup()

    if (this.mockServerManager?.isRunning()) {
      await this.mockServerManager.stop()
    }
  }

  /**
   * List all managed containers.
   */
  async listManagedContainers(): Promise<
    { sessionId: string; containerId: string; status: string }[]
  > {
    try {
      const { stdout } = await this.execPodman([
        "ps",
        "-a",
        "--filter", "label=tauroboros.managed=true",
        "--format", "{{.ID}}|{{.Names}}|{{.State}}|{{.Labels}}",
      ])

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
    } catch (err) {
      console.debug(`[container-manager] Failed to list managed containers:`, err)
      return []
    }
  }

  /**
   * Emergency stop - kill all tauroboros containers.
   */
  async emergencyStop(): Promise<number> {
    const containers = await this.listManagedContainers()
    let killed = 0

    for (const info of containers) {
      try {
        await this.execPodman(["kill", info.containerId])
        killed++
      } catch (err) {
        console.debug(`[container-manager] Failed to kill container ${info.containerId} during emergency stop:`, err)
      }
    }

    this.containers.clear()
    return killed
  }

  /**
   * Check if podman and the image are available.
   */
  async validateSetup(): Promise<{
    podman: boolean
    image: boolean
    errors: string[]
  }> {
    const errors: string[] = []

    let podman = false
    try {
      await this.execPodman(["--version"])
      podman = true
    } catch {
      errors.push("Podman is not available")
    }

    let image = false
    if (podman) {
      try {
        await this.execPodman(["image", "exists", this.imageName])
        image = true
      } catch {
        errors.push(
          `Podman image '${this.imageName}' not found. Run: podman build -t ${this.imageName} -f docker/pi-agent/Dockerfile .`,
        )
      }
    }

    return { podman, image, errors }
  }

  /**
   * Check if a specific image exists in Podman.
   */
  async checkImageExists(imageName: string): Promise<boolean> {
    try {
      await this.execPodman(["image", "exists", imageName])
      return true
    } catch {
      return false
    }
  }

  /**
   * List all available pi-agent images from Podman.
   */
  async listImages(): Promise<Array<{
    tag: string
    createdAt: number
    size: string
  }>> {
    try {
      const { stdout } = await this.execPodman([
        "images",
        "--format", "json",
        "--filter", "reference=*pi-agent*"
      ])

      const images = JSON.parse(stdout) as Array<{
        Names?: string[]
        CreatedAt?: string
        Size?: string
        RepoTags?: string[]
      }>

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
    } catch (err) {
      console.error("[container-manager] Failed to list images:", err)
      return []
    }
  }

  /**
   * Delete an image by tag.
   */
  async deleteImage(imageName: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.execPodman(["rmi", imageName])
      return { success: true }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Inspect a container and return its state.
   */
  private async inspectContainer(containerId: string): Promise<{ State: { Status: string; Running: boolean } }> {
    const { stdout } = await this.execPodman([
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
  }

  /**
   * Execute a podman command and return stdout/stderr.
   */
  private execPodman(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("podman", args, {
        stdio: ["pipe", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(`Podman command failed with code ${code}: ${stderr || stdout}`))
        }
      })

      proc.on("error", (err) => {
        reject(err)
      })
    })
  }

}
