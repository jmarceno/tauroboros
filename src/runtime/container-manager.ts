import { spawn, execSync } from "child_process"
import { randomUUID } from "crypto"
import { existsSync } from "fs"

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

  constructor(
    imageName = "pi-agent:alpine",
  ) {
    this.imageName = imageName
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

    // Ensure image exists
    await this.ensureImage(imageName)

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

    // Build the podman run command
    const podmanArgs = [
      "run",
      "-d",  // Detached mode
      "--name", containerName,
      "--rm",  // Auto-remove after exit
      "--workdir", config.worktreeDir,
      "-i",  // Interactive (keep stdin open)
      "-t",  // Allocate TTY
      "--label", `pi-easy-workflow.session-id=${config.sessionId}`,
      "--label", `pi-easy-workflow.managed=true`,
      ...resourceArgs,
      ...securityArgs,
      ...networkArgs,
      ...mountArgs,
      ...envArgs,
      imageName,
    ]

    // Execute podman run
    const { stdout } = await this.execPodman(podmanArgs)
    const containerId = stdout.trim()

    // Wait a moment for container to start
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Create process wrapper with stdio streams
    const process: ContainerProcess = {
      sessionId: config.sessionId,
      containerId,

      stdin: new WritableStream({
        write: async (chunk: Uint8Array) => {
          const proc = spawn("podman", ["exec", "-i", containerId, "sh", "-c", "cat > /dev/stdin"], {
            stdio: ["pipe", "pipe", "pipe"],
          })
          
          return new Promise((resolve, reject) => {
            proc.stdin.write(chunk, (err) => {
              if (err) reject(err)
              else {
                proc.stdin.end()
                proc.on("close", resolve)
                proc.on("error", reject)
              }
            })
          })
        },
      }),

      stdout: new ReadableStream({
        start: (controller) => {
          const proc = spawn("podman", ["logs", "-f", containerId], {
            stdio: ["pipe", "pipe", "pipe"],
          })

          proc.stdout.on("data", (data: Buffer) => {
            controller.enqueue(new Uint8Array(data))
          })

          proc.on("close", () => {
            controller.close()
          })

          proc.on("error", (err) => {
            controller.error(err)
          })
        },
      }),

      stderr: new ReadableStream({
        start: (controller) => {
          const proc = spawn("podman", ["logs", "-f", "--stderr", containerId], {
            stdio: ["pipe", "pipe", "pipe"],
          })

          proc.stdout.on("data", (data: Buffer) => {
            controller.enqueue(new Uint8Array(data))
          })

          proc.on("close", () => {
            controller.close()
          })

          proc.on("error", (err) => {
            controller.error(err)
          })
        },
      }),

      kill: async () => {
        try {
          await this.execPodman(["kill", containerId])
        } catch {
          // Container may already be stopped
        }
        this.containers.delete(config.sessionId)
      },

      inspect: async () => {
        return this.inspectContainer(containerId)
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
   * Ensure the image exists in podman.
   */
  private async ensureImage(imageName: string): Promise<void> {
    try {
      await this.execPodman(["image", "exists", imageName])
    } catch {
      throw new Error(
        `Podman image '${imageName}' not found. Please build it first with:\n` +
          `podman build -t ${imageName} -f docker/pi-agent/Dockerfile .`,
      )
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
