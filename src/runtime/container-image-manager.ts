import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { spawn } from "child_process"

export type ImageStatus = "not_present" | "preparing" | "ready" | "error"

export interface ImageCache {
  imageName: string
  status: ImageStatus
  lastUpdated: string
  source: "dockerfile" | "registry"
  buildTimeMs?: number
  errorMessage?: string
}

export interface ImageStatusChangeEvent {
  status: ImageStatus
  message: string
  progress?: number
  errorMessage?: string
}

export type ImageStatusChangeHandler = (event: ImageStatusChangeEvent) => void

export interface ContainerImageManagerOptions {
  imageName: string
  imageSource: "dockerfile" | "registry"
  dockerfilePath?: string
  registryUrl?: string | null
  cacheDir: string
  onStatusChange?: ImageStatusChangeHandler
}

/**
 * ContainerImageManager handles the lifecycle of the container image.
 *
 * Responsibilities:
 * - Check if image exists in Podman
 * - Build from Dockerfile or pull from registry
 * - Track status via cache file
 * - Broadcast status updates
 * - Provide console progress output
 */
export class ContainerImageManager {
  private readonly options: ContainerImageManagerOptions
  private currentStatus: ImageStatus = "not_present"
  private cache: ImageCache | null = null

  constructor(options: ContainerImageManagerOptions) {
    this.options = options
    this.ensureCacheDir()
    this.loadCache()
  }

  /**
   * Get the current image status.
   */
  getStatus(): ImageStatus {
    return this.currentStatus
  }

  /**
   * Get the full cache information.
   */
  getCache(): ImageCache | null {
    return this.cache
  }

  /**
   * Check if the image exists in Podman.
   */
  async checkImageExists(): Promise<boolean> {
    try {
      await this.execPodman(["image", "exists", this.options.imageName])
      return true
    } catch {
      return false
    }
  }

  /**
   * Prepare the image - build or pull as needed.
   * This is the main entry point for ensuring the image is ready.
   */
  async prepare(): Promise<void> {
    // First check if image already exists
    const exists = await this.checkImageExists()
    if (exists) {
      this.updateStatus("ready", "Container image is ready")
      return
    }

    // Need to build or pull
    this.updateStatus("preparing", "Preparing container image...")

    const startTime = Date.now()

    try {
      if (this.options.imageSource === "dockerfile") {
        await this.buildFromDockerfile()
      } else if (this.options.imageSource === "registry") {
        await this.pullFromRegistry()
      }

      const buildTime = Date.now() - startTime
      this.saveCache({
        imageName: this.options.imageName,
        status: "ready",
        lastUpdated: new Date().toISOString(),
        source: this.options.imageSource,
        buildTimeMs: buildTime,
      })

      this.updateStatus("ready", `Container image ready (took ${Math.round(buildTime / 1000)}s)`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.saveCache({
        imageName: this.options.imageName,
        status: "error",
        lastUpdated: new Date().toISOString(),
        source: this.options.imageSource,
        errorMessage,
      })
      this.updateStatus("error", "Failed to prepare container image", undefined, errorMessage)
      throw error
    }
  }

  /**
   * Build the image from Dockerfile with progress reporting.
   */
  private async buildFromDockerfile(): Promise<void> {
    const dockerfilePath = this.options.dockerfilePath || "docker/pi-agent/Dockerfile"
    const projectRoot = process.cwd()
    const fullDockerfilePath = join(projectRoot, dockerfilePath)

    if (!existsSync(fullDockerfilePath)) {
      throw new Error(`Dockerfile not found at ${fullDockerfilePath}`)
    }

    console.log(`🔄 Building container image from ${dockerfilePath}...`)
    console.log(`   This may take a minute on first run...`)

    return new Promise((resolve, reject) => {
      const proc = spawn(
        "podman",
        ["build", "-t", this.options.imageName, "-f", dockerfilePath, "."],
        {
          cwd: projectRoot,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )

      let stdout = ""
      let stderr = ""
      let lastLine = ""

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString()
        stdout += chunk

        // Parse build output for progress indication
        const lines = chunk.split("\n")
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed) {
            lastLine = trimmed
            // Show progress for step completion
            if (trimmed.startsWith("STEP ")) {
              console.log(`   ${trimmed}`)
              this.updateStatus("preparing", "Building container image...", undefined)
            }
          }
        }
      })

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        // Podman often outputs to stderr even for normal operations
        const lines = chunk.split("\n").filter((l) => l.trim())
        for (const line of lines) {
          if (line.includes("error") || line.includes("Error")) {
            console.error(`   ${line}`)
          }
        }
      })

      proc.on("close", (code) => {
        if (code === 0) {
          console.log(`✅ Container image built successfully: ${this.options.imageName}`)
          resolve()
        } else {
          reject(new Error(`Failed to build image: ${stderr || stdout || `exit code ${code}`}`))
        }
      })

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn podman build: ${err.message}`))
      })
    })
  }

  /**
   * Pull the image from a registry.
   * Future implementation for pulling pre-built images.
   */
  private async pullFromRegistry(): Promise<void> {
    const registryUrl = this.options.registryUrl
    if (!registryUrl) {
      throw new Error("registryUrl is required when imageSource is 'registry'")
    }

    console.log(`🔄 Pulling container image from ${registryUrl}...`)

    return new Promise((resolve, reject) => {
      const proc = spawn("podman", ["pull", registryUrl], {
        stdio: ["pipe", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString()
        const lines = data.toString().split("\n").filter((l) => l.trim())
        for (const line of lines) {
          if (line.includes("Downloading") || line.includes("Extracting")) {
            console.log(`   ${line}`)
          }
        }
      })

      proc.on("close", (code) => {
        if (code === 0) {
          // Tag the pulled image with our local name if different
          if (registryUrl !== this.options.imageName) {
            this.execPodman(["tag", registryUrl, this.options.imageName])
              .then(() => resolve())
              .catch(reject)
          } else {
            resolve()
          }
        } else {
          reject(new Error(`Failed to pull image: ${stderr || stdout || `exit code ${code}`}`))
        }
      })

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn podman pull: ${err.message}`))
      })
    })
  }

  /**
   * Update status and notify listeners.
   */
  private updateStatus(
    status: ImageStatus,
    message: string,
    progress?: number,
    errorMessage?: string,
  ): void {
    this.currentStatus = status

    const event: ImageStatusChangeEvent = {
      status,
      message,
      progress,
      errorMessage,
    }

    // Notify via callback
    if (this.options.onStatusChange) {
      try {
        this.options.onStatusChange(event)
      } catch {
        // Ignore listener errors
      }
    }

    // Console output for server logs
    if (status === "error") {
      console.error(`❌ ${message}${errorMessage ? `: ${errorMessage}` : ""}`)
    } else if (status === "ready") {
      console.log(`✅ ${message}`)
    }
  }

  /**
   * Ensure the cache directory exists.
   */
  private ensureCacheDir(): void {
    if (!existsSync(this.options.cacheDir)) {
      mkdirSync(this.options.cacheDir, { recursive: true })
    }
  }

  /**
   * Load cache from file.
   */
  private loadCache(): void {
    const cachePath = join(this.options.cacheDir, "image-cache.json")

    if (!existsSync(cachePath)) {
      this.currentStatus = "not_present"
      return
    }

    try {
      const raw = readFileSync(cachePath, "utf-8")
      this.cache = JSON.parse(raw) as ImageCache
      this.currentStatus = this.cache.status
    } catch {
      // Invalid cache, start fresh
      this.currentStatus = "not_present"
      this.cache = null
    }
  }

  /**
   * Save cache to file.
   */
  private saveCache(cache: ImageCache): void {
    this.cache = cache
    const cachePath = join(this.options.cacheDir, "image-cache.json")

    try {
      // Ensure directory exists
      const dir = dirname(cachePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8")
    } catch {
      // Cache write failures are non-fatal
    }
  }

  /**
   * Execute a podman command.
   */
  private execPodman(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
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
