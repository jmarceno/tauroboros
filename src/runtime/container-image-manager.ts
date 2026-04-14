import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { spawn } from "child_process"
import type { PackageDefinition, ContainerConfig, ContainerProfile, PackageValidationResult, ContainerBuildResult, ContainerBuildStatus } from "../db/types.ts"

// ===== Standalone Container Config Utilities (no ContainerImageManager instance required) =====

/**
 * Load container configuration from .pi/tauroboros/container-config.json
 * This is a standalone function - no ContainerImageManager instance required.
 */
export function loadContainerConfig(projectRoot: string): ContainerConfig {
  const configPath = join(projectRoot, ".pi", "tauroboros", "container-config.json")
  const defaultConfig: ContainerConfig = {
    version: 1,
    baseImage: "docker.io/alpine:3.19",
    customDockerfilePath: ".pi/tauroboros/Dockerfile.custom",
    generatedDockerfilePath: ".pi/tauroboros/Dockerfile.generated",
    packages: [],
    lastBuild: null,
  }

  if (!existsSync(configPath)) {
    return defaultConfig
  }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw)
    return {
      ...defaultConfig,
      ...parsed,
      packages: parsed.packages || [],
    }
  } catch {
    return defaultConfig
  }
}

/**
 * Save container configuration to .pi/tauroboros/container-config.json
 * This is a standalone function - no ContainerImageManager instance required.
 */
export function saveContainerConfig(projectRoot: string, config: ContainerConfig): void {
  const configDir = join(projectRoot, ".pi", "tauroboros")
  const configPath = join(configDir, "container-config.json")

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
}

export type ImageStatus = "not_present" | "preparing" | "ready" | "error"
export type BuildStatus = "pending" | "running" | "success" | "failed" | "cancelled"

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

export interface ContainerBuildProgressHandler {
  onLog: (line: string) => void
  onStatus: (status: ContainerBuildStatus) => void
  isCancelled: () => boolean
}

export interface ContainerImageManagerOptions {
  imageName: string
  imageSource: "dockerfile" | "registry"
  dockerfilePath?: string
  registryUrl?: string | null
  cacheDir: string
  onStatusChange?: ImageStatusChangeHandler
}

// Dockerfile template for Alpine-based custom images
const DOCKERFILE_TEMPLATE = `# Generated Dockerfile - Custom Pi Agent Image
# Base: docker.io/alpine:3.19

FROM docker.io/alpine:3.19

# Install base dependencies
RUN apk add --no-cache \\
    curl \\
    git \\
    bash \\
    nodejs \\
    npm

# Install user-selected packages (sorted by install order)
{{PACKAGES}}

# Set working directory
WORKDIR /workspace

# Custom user Dockerfile content (preserved)
{{CUSTOM_DOCKERFILE}}

# Default command
CMD ["sh"]
`

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
  private isPrepared = false
  private preparingPromise: Promise<void> | null = null

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
   * Check if the image has been prepared and is ready for use.
   * Returns true only if prepare() has been called successfully at least once.
   */
  isReady(): boolean {
    return this.isPrepared
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
   * 
   * Uses a mutex to prevent concurrent builds. If prepare() is already
   * running, subsequent calls wait for it to complete and then check
   * readiness. Once successfully prepared, subsequent calls return
   * immediately without spawning any subprocess.
   */
  async prepare(): Promise<void> {
    // Fast path: if already prepared, return immediately
    if (this.isPrepared) {
      this.updateStatus("ready", "Container image is ready")
      return
    }

    // If another prepare() is already running, wait for it
    if (this.preparingPromise) {
      await this.preparingPromise
      // After waiting, the image should be ready
      if (!this.isPrepared) {
        throw new Error("Container image preparation failed")
      }
      return
    }

    // We're the first caller - start preparation
    this.preparingPromise = this.doPrepare()
    try {
      await this.preparingPromise
    } finally {
      this.preparingPromise = null
    }
  }

  private async doPrepare(): Promise<void> {
    // First check if image already exists
    const exists = await this.checkImageExists()
    if (exists) {
      this.isPrepared = true
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
      this.isPrepared = true
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
      this.isPrepared = false
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

  // ===== Custom Container Image Configuration =====

  /**
   * Generate a Dockerfile from template + packages + custom content
   */
  generateDockerfile(config: ContainerConfig): string {
    const baseImage = config.baseImage || "docker.io/alpine:3.19"
    const packages = config.packages || []

    // Sort packages by install order
    const sortedPackages = [...packages].sort((a, b) => (a.installOrder || 0) - (b.installOrder || 0))

    // Generate package installation commands
    const packageLines = sortedPackages.map(pkg => {
      if (pkg.versionConstraint) {
        return `    ${pkg.name}=${pkg.versionConstraint} \\\n`
      }
      return `    ${pkg.name} \\\n`
    }).join("")

    // Read custom Dockerfile if exists
    let customContent = ""
    if (config.customDockerfilePath && existsSync(config.customDockerfilePath)) {
      try {
        customContent = readFileSync(config.customDockerfilePath, "utf-8")
        // Add comment if not already present
        if (!customContent.includes("# User custom Dockerfile")) {
          customContent = `# User custom Dockerfile\n${customContent}`
        }
      } catch {
        // Ignore read errors
      }
    }

    // Build package install block
    const packageBlock = packages.length > 0
      ? `RUN apk add --no-cache \\\n${packageLines}`
      : "# No additional packages selected"

    return DOCKERFILE_TEMPLATE
      .replace("docker.io/alpine:3.19", baseImage)
      .replace("{{PACKAGES}}", packageBlock)
      .replace("{{CUSTOM_DOCKERFILE}}", customContent || "# No custom Dockerfile content")
  }

  /**
   * Validate packages exist in Alpine repos using apk search
   */
  async validatePackages(packages: string[]): Promise<PackageValidationResult> {
    const valid: string[] = []
    const invalid: string[] = []
    const suggestions: Record<string, string[]> = {}

    for (const pkg of packages) {
      try {
        // Use apk search to check if package exists
        const result = await this.execPodman([
          "run", "--rm", "docker.io/alpine:3.19",
          "sh", "-c", `apk search --exact "${pkg}" 2>/dev/null | head -1`
        ])

        const found = result.stdout.trim()
        if (found && (found === pkg || found.startsWith(pkg + "-"))) {
          valid.push(pkg)
        } else {
          invalid.push(pkg)
          // Try to find suggestions
          try {
            const suggestResult = await this.execPodman([
              "run", "--rm", "docker.io/alpine:3.19",
              "sh", "-c", `apk search "${pkg}*" 2>/dev/null | head -5`
            ])
            const suggestionsList = suggestResult.stdout.trim().split("\n").filter(Boolean)
            if (suggestionsList.length > 0) {
              suggestions[pkg] = suggestionsList.slice(0, 5)
            }
          } catch {
            // Ignore suggestion errors
          }
        }
      } catch {
        invalid.push(pkg)
      }
    }

    return { valid, invalid, suggestions }
  }

  /**
   * Build a custom image with the generated Dockerfile
   */
  async buildCustomImage(
    config: ContainerConfig,
    imageTag: string,
    progressHandler?: ContainerBuildProgressHandler
  ): Promise<ContainerBuildResult> {
    const logs: string[] = []
    const dockerfile = this.generateDockerfile(config)
    const dockerfilePath = join(this.options.cacheDir, "Dockerfile.generated")

    // Save generated Dockerfile
    try {
      writeFileSync(dockerfilePath, dockerfile, "utf-8")
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, imageTag, logs: [`Failed to save Dockerfile: ${errorMessage}`] }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        "podman",
        ["build", "-t", imageTag, "-f", dockerfilePath, "."],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
        },
      )

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString()
        const lines = chunk.split("\n").filter(l => l.trim())
        for (const line of lines) {
          logs.push(line)
          progressHandler?.onLog(line)
        }
      })

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString()
        const lines = chunk.split("\n").filter(l => l.trim())
        for (const line of lines) {
          logs.push(line)
          progressHandler?.onLog(line)
        }
      })

      proc.on("close", (code) => {
        if (code === 0) {
          progressHandler?.onStatus({
            status: "success",
            message: "Build completed successfully",
            logs,
            canCancel: false,
          })
          resolve({ success: true, imageTag, logs })
        } else {
          const errorMessage = `Build failed with exit code ${code}`
          progressHandler?.onStatus({
            status: "failed",
            message: errorMessage,
            logs,
            canCancel: false,
          })
          resolve({ success: false, imageTag, logs })
        }
      })

      proc.on("error", (err) => {
        const errorMessage = `Failed to spawn podman build: ${err.message}`
        progressHandler?.onStatus({
          status: "failed",
          message: errorMessage,
          logs,
          canCancel: false,
        })
        resolve({ success: false, imageTag, logs: [...logs, errorMessage] })
      })
    })
  }

  /**
   * Load container configuration from .pi/tauroboros/container-config.json
   * Delegates to the standalone loadContainerConfig function.
   */
  loadContainerConfig(projectRoot: string): ContainerConfig {
    return loadContainerConfig(projectRoot)
  }

  /**
   * Save container configuration to .pi/tauroboros/container-config.json
   * Delegates to the standalone saveContainerConfig function.
   */
  saveContainerConfig(projectRoot: string, config: ContainerConfig): void {
    saveContainerConfig(projectRoot, config)
  }

  /**
   * Ensure custom Dockerfile exists with template content
   */
  ensureCustomDockerfile(projectRoot: string): string {
    const customPath = join(projectRoot, ".pi", "tauroboros", "Dockerfile.custom")

    if (!existsSync(customPath)) {
      const template = `# Custom Dockerfile - User Editable
# Add your custom RUN commands here
# These will be appended to the generated Dockerfile

# Example:
# RUN echo "Custom configuration" >> /etc/motd
`
      const customDir = dirname(customPath)
      if (!existsSync(customDir)) {
        mkdirSync(customDir, { recursive: true })
      }
      writeFileSync(customPath, template, "utf-8")
    }

    return customPath
  }

  /**
   * Apply a preset profile to the configuration
   */
  applyProfile(config: ContainerConfig, profile: ContainerProfile): ContainerConfig {
    const existingPackages = new Map(config.packages.map(p => [p.name, p]))

    // Add profile packages
    for (const pkg of profile.packages) {
      if (!existingPackages.has(pkg.name)) {
        existingPackages.set(pkg.name, {
          name: pkg.name,
          category: pkg.category,
          installOrder: config.packages.length + profile.packages.findIndex(p => p.name === pkg.name),
        })
      }
    }

    return {
      ...config,
      packages: Array.from(existingPackages.values()),
    }
  }
}
