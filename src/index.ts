import { resolve } from "path"
import { existsSync } from "fs"
import { ensureInfrastructureSettings, saveInfrastructureSettings, type InfrastructureSettings } from "./config/settings.ts"
import { createPiServer, findProjectRoot } from "./server.ts"
import { PiContainerManager } from "./runtime/container-manager.ts"
import { ContainerImageManager } from "./runtime/container-image-manager.ts"
import { extractEmbeddedResources } from "./resource-extractor.ts"

interface CliArgs {
  native: boolean
}

function parseCliArgs(args: string[]): CliArgs {
  return {
    native: args.includes("--native"),
  }
}

async function checkAndPrepareContainer(projectRoot: string): Promise<{
  ready: boolean
  podmanAvailable: boolean
  imageReady: boolean
  error?: string
}> {
  // Check if podman is available
  const podmanAvailable = PiContainerManager.isAvailable()
  if (!podmanAvailable) {
    return {
      ready: false,
      podmanAvailable: false,
      imageReady: false,
      error: "Podman is not available. Install Podman or run with --native flag to use native mode.",
    }
  }

  // Check if image exists
  const manager = new PiContainerManager()
  const setupStatus = await manager.validateSetup()

  if (!setupStatus.image) {
    // Image not found, need to auto-build
    console.log("[tauroboros] Building container image for first run (this may take a minute)...")

    const cacheDir = resolve(projectRoot, ".tauroboros")
    const imageManager = new ContainerImageManager({
      imageName: "pi-agent:alpine",
      imageSource: "dockerfile",
      dockerfilePath: "docker/pi-agent/Dockerfile",
      cacheDir,
      onStatusChange: (event) => {
        if (event.status === "error") {
          console.error(`[tauroboros] ${event.message}`)
        }
      },
    })

    try {
      await imageManager.prepare()
      return {
        ready: true,
        podmanAvailable: true,
        imageReady: true,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ready: false,
        podmanAvailable: true,
        imageReady: false,
        error: `Failed to build container image: ${message}`,
      }
    }
  }

  return {
    ready: true,
    podmanAvailable: true,
    imageReady: true,
  }
}

async function createInitialSettings(
  projectRoot: string,
  preferContainer: boolean,
): Promise<{ settings: InfrastructureSettings; warnings: string[] }> {
  const result = ensureInfrastructureSettings(projectRoot, { preferContainer })
  return { settings: result.settings, warnings: result.warnings }
}

export async function main(): Promise<void> {
  const projectRoot = findProjectRoot()
  
  // Extract embedded resources (extensions and skills) to .pi/
  // This works in both binary mode (extracts embedded) and source mode (copies from source)
  const extractionResult = extractEmbeddedResources(projectRoot)
  if (extractionResult.mode === "binary") {
    console.log(`[tauroboros] Extracted ${extractionResult.extensions} extensions, ${extractionResult.skills} skills, ${extractionResult.config} configs, and ${extractionResult.docker} docker files from binary`)
  } else if (extractionResult.mode === "source") {
    console.log(`[tauroboros] Copied ${extractionResult.extensions} extensions, ${extractionResult.skills} skills, ${extractionResult.config} configs, and ${extractionResult.docker} docker files from source`)
  }
  
  const args = parseCliArgs(process.argv.slice(2))

  const settingsPath = resolve(projectRoot, ".tauroboros", "settings.json")
  const isFirstStart = !existsSync(settingsPath)

  let settings: InfrastructureSettings
  let warnings: string[]

  if (isFirstStart) {
    // First start - determine mode based on CLI args and container availability
    if (args.native) {
      // User explicitly requested native mode
      console.log("[tauroboros] First run - creating settings with native mode...")
      ;({ settings, warnings } = await createInitialSettings(projectRoot, false))
    } else {
      // Default to container mode - check requirements
      console.log("[tauroboros] First run detected - setting up container mode...")
      const containerCheck = await checkAndPrepareContainer(projectRoot)

      if (!containerCheck.ready) {
        console.error(`[tauroboros] ${containerCheck.error}`)
        console.error("[tauroboros] To start in native mode instead, run: bun run start -- --native")
        process.exit(1)
      }

      // Container is ready, create settings with container enabled
      ;({ settings, warnings } = await createInitialSettings(projectRoot, true))
      console.log("[tauroboros] Settings created with container mode enabled")
    }
  } else {
    // Existing settings - load normally
    const result = ensureInfrastructureSettings(projectRoot)
    settings = result.settings
    warnings = result.warnings
  }

  // Report any warnings about settings
  for (const warning of warnings) {
    console.warn(`[tauroboros] ${warning}`)
  }

  // Resolve dbPath relative to project root
  const dbPath = resolve(projectRoot, settings.workflow.server.dbPath)

  // Support SERVER_PORT environment variable override
  const envPort = process.env.SERVER_PORT
  const port = envPort ? parseInt(envPort, 10) : settings.workflow.server.port

  const { db, server } = createPiServer({
    port,
    dbPath,
    settings,
  })

  const actualPort = await server.start(port)
  console.log(`[tauroboros] server started on http://0.0.0.0:${actualPort}`)

  // Persist the assigned port to settings.json for subsequent runs
  if (actualPort !== settings.workflow.server.port) {
    settings.workflow.server.port = actualPort
    saveInfrastructureSettings(projectRoot, settings)
  }

  const shutdown = () => {
    try {
      server.stop()
    } finally {
      db.close()
    }
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

void main()
