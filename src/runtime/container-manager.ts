import { spawn, execSync } from "child_process"
import { randomUUID } from "crypto"
import { existsSync } from "fs"
import { ContainerImageManager, type ImageStatusChangeHandler } from "./container-image-manager.ts"

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
): VolumeMount[] {
  const mounts: VolumeMount[] = []

  // Repository root (read-only) - same path inside/outside
  mounts.push({
    Source: repoRoot,
    Target: repoRoot,
    Type: "bind",
    ReadOnly: true,
  })

  // Worktree (read-write) - same path inside/outside
  mounts.push({
    Source: worktreeDir,
    Target: worktreeDir,
    Type: "bind",
    ReadOnly: false,
  })

  // Git binary
  mounts.push({
    Source: "/usr/bin/git",
    Target: "/usr/bin/git",
    Type: "bind",
    ReadOnly: true,
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

  // Bun binary (needed for some pi operations)
  // Detect bun location on host system
  let bunPath = "/usr/local/bin/bun"
  try {
    bunPath = execSync("which bun", { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    // Fallback to common locations
    if (existsSync("/usr/bin/bun")) {
      bunPath = "/usr/bin/bun"
    }
  }
  mounts.push({
    Source: bunPath,
    Target: "/usr/local/bin/bun",
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

  return mounts
}

/**
 * Container Manager using pure Podman (without gVisor)
 * 
 * Uses a minimal Alpine-based image with Bun and Pi pre-installed.
 * Provides filesystem and port isolation through standard container boundaries.
 */
export class PiContainerManager {
  private readonly imageName: string
  private readonly containers = new Map<string, ContainerProcess>()
  private imageManager?: ContainerImageManager

  constructor(
    imageName = "pi-agent:alpine",
    imageManager?: ContainerImageManager,
  ) {
    this.imageName = imageName
    this.imageManager = imageManager
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
   * Ensure the container image is ready before creating containers.
   * If an image manager is configured, this will build/pull the image if needed.
   */
  async ensureImageReady(): Promise<void> {
    if (this.imageManager) {
      await this.imageManager.prepare()
    } else {
      // Check if image exists directly in podman
      try {
        await this.execPodman(["image", "exists", this.imageName])
      } catch {
        throw new Error(
          `Podman image '${this.imageName}' not found. ` +
          `Build it with: podman build -t ${this.imageName} -f docker/pi-agent/Dockerfile .`,
        )
      }
    }
  }

  /**
   * Check if podman is available
   */
  static isAvailable(): boolean {
    try {
      execSync("podman --version", { stdio: "pipe" })
      return true
    } catch {
      return false
    }
  }

  /**
   * Create and start a new container for a pi agent session.
   */
  async createContainer(config: ContainerConfig): Promise<ContainerProcess> {
    const imageName = config.imageName || this.imageName

    // Ensure image is ready (uses image manager if available)
    await this.ensureImageReady()

    // Create volume mounts
    const mounts = createVolumeMounts(config.worktreeDir, config.repoRoot)

    // Build mount arguments for podman
    const mountArgs: string[] = []
    for (const mount of mounts) {
      const roFlag = mount.ReadOnly ? ",ro" : ""
      mountArgs.push("--volume", `${mount.Source}:${mount.Target}:z${roFlag}`)
    }

    // Environment variables
    const envArgs: string[] = []
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        envArgs.push("-e", `${key}=${value}`)
      }
    }

    // Generate container name
    const containerName = `pi-easy-workflow-${config.sessionId}`

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
    const networkArgs = ["--network", config.networkMode || "bridge"]

    // Build the podman run command (without -d for proper stdin handling)
    const podmanArgs = [
      "run",
      "--rm",  // Auto-remove after exit
      "--name", containerName,
      "--workdir", config.worktreeDir,
      "-i",  // Interactive (keep stdin open)
      "--label", `pi-easy-workflow.session-id=${config.sessionId}`,
      "--label", `pi-easy-workflow.managed=true`,
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

    // Wait for container to start and pi to initialize (includes npm install for extensions)
    // This can take 10-15 seconds on first run as pi installs its extensions
    await new Promise((resolve) => setTimeout(resolve, 15000))
    
    // Get container ID from podman ps
    let containerId = ""
    try {
      const { stdout } = await this.execPodman([
        "ps", "-q", "-f", `name=${containerName}`,
      ])
      containerId = stdout.trim()
    } catch {
      // Container might not be visible yet, generate a fallback ID
      containerId = `pending-${Date.now()}`
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
              } catch {
                // Controller might be closed
              }
            }
          })

          proc.stdout.on("end", () => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.close()
              } catch {
                // Already closed
              }
            }
          })

          proc.on("error", (err) => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.error(err)
              } catch {
                // Already closed
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
              } catch {
                // Controller might be closed
              }
            }
          })

          proc.stderr.on("end", () => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.close()
              } catch {
                // Already closed
              }
            }
          })

          proc.on("error", (err) => {
            if (!isClosed) {
              isClosed = true
              try {
                controller.error(err)
              } catch {
                // Already closed
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
        } catch {
          // Container may already be stopped
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
   * Clean up all managed containers.
   */
  async cleanup(): Promise<void> {
    const kills = Array.from(this.containers.values()).map((proc) =>
      proc.kill().catch(() => {}),
    )
    await Promise.all(kills)
    this.containers.clear()
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
        "--filter", "label=pi-easy-workflow.managed=true",
        "--format", "{{.ID}}|{{.Names}}|{{.State}}|{{.Labels}}",
      ])

      const containers: { sessionId: string; containerId: string; status: string }[] = []
      
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue
        const [id, names, state, labels] = line.split("|")
        
        const sessionIdMatch = labels?.match(/pi-easy-workflow\.session-id=([^,]+)/)
        const sessionId = sessionIdMatch?.[1] || "unknown"
        
        containers.push({
          sessionId,
          containerId: id,
          status: state,
        })
      }

      return containers
    } catch {
      return []
    }
  }

  /**
   * Emergency stop - kill all pi-easy-workflow containers.
   */
  async emergencyStop(): Promise<number> {
    const containers = await this.listManagedContainers()
    let killed = 0

    for (const info of containers) {
      try {
        await this.execPodman(["kill", info.containerId])
        killed++
      } catch {
        // Container may already be stopped
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

    // Check Podman
    let podman = false
    try {
      await this.execPodman(["--version"])
      podman = true
    } catch {
      errors.push("Podman is not available")
    }

    // Check image
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
