import { resolve } from "path"
import { existsSync } from "fs"
import { Effect, Schema } from "effect"
import { ensureSettingsEffect, saveSettingsEffect, type InfrastructureSettings } from "./config/settings.ts"
import { createPiServerScopedEffect, findProjectRootEffect, NotAGitRepositoryError } from "./server.ts"
import { PiContainerManager } from "./runtime/container-manager.ts"
import { ContainerImageManager } from "./runtime/container-image-manager.ts"
import { validateContainerSetupEffect } from "./runtime/pi-process-factory.ts"
import { extractEmbeddedResources } from "./resource-extractor.ts"
import { BASE_IMAGES } from "./config/base-images.ts"

interface CliArgs {
  native: boolean
}

type ContainerSetupStatus = {
  ready: boolean
  podmanAvailable: boolean
  imageReady: boolean
  error?: string
}

class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {
  message: Schema.String,
}) {}

function parseCliArgs(args: string[]): CliArgs {
  return {
    native: args.includes("--native"),
  }
}

const checkAndPrepareContainerEffect = Effect.fn("checkAndPrepareContainerEffect")(
  function* (projectRoot: string) {
    // Check if podman is available
    const podmanAvailable = PiContainerManager.isAvailable()

    if (!podmanAvailable) {
      return {
        ready: false,
        podmanAvailable: false,
        imageReady: false,
        error: "Podman is not available. Install Podman or run with --native flag to use native mode.",
      } as const satisfies ContainerSetupStatus
    }

    // Check if image exists
    const manager = new PiContainerManager()
    const setupStatus = yield* manager.validateSetup().pipe(
      Effect.mapError((cause) => new StartupError({ message: `Failed to validate container setup: ${String(cause)}` })),
      Effect.map((status) => ({
        ready: status.podman && status.image,
        podmanAvailable: status.podman,
        imageReady: status.image,
        error: status.errors.length > 0 ? status.errors.join("\n") : undefined,
      }) as const satisfies ContainerSetupStatus),
    )

    if (!setupStatus.imageReady) {
      // Image not found, need to auto-build
      yield* Effect.logInfo("[tauroboros] Building container image for first run (this may take a minute)...")
      const cacheDir = resolve(projectRoot, ".tauroboros")
      const imageManager = new ContainerImageManager({
        imageName: BASE_IMAGES.piAgent,
        imageSource: "dockerfile",
        dockerfilePath: "docker/pi-agent/Dockerfile",
        cacheDir,
        onStatusChange: (event) => {
          if (event.status === "error") {
            process.stderr.write(`[tauroboros] ${event.message}\n`)
          }
        }
      })

      return yield* imageManager.prepare().pipe(
        Effect.map(() => ({
          ready: true,
          podmanAvailable: true,
          imageReady: true,
        } as const satisfies ContainerSetupStatus)),
        Effect.mapError((error) => {
          const message = error instanceof Error ? error.message : String(error)
          return new StartupError({ message: `Failed to build container image: ${message}` })
        }),
        Effect.catchTag("StartupError", (error) =>
          Effect.succeed({
            ready: false,
            podmanAvailable: true,
            imageReady: false,
            error: error.message,
          } as const satisfies ContainerSetupStatus),
        ),
      )
    }

    return {
      ready: true,
      podmanAvailable: true,
      imageReady: true,
    } as const satisfies ContainerSetupStatus
  },
)

function createInitialSettings(
  projectRoot: string,
  preferContainer: boolean,
): Effect.Effect<{ settings: InfrastructureSettings; warnings: string[] }, StartupError> {
  return ensureSettingsEffect(projectRoot, { preferContainer }).pipe(
    Effect.map((result) => ({ settings: result.settings, warnings: result.warnings })),
    Effect.mapError((cause) => new StartupError({ message: cause.message })),
  )

}

const loadSettings = Effect.fn("loadSettings")(function* (projectRoot: string, args: CliArgs) {
  const settingsPath = resolve(projectRoot, ".tauroboros", "settings.json")
  const isFirstStart = !existsSync(settingsPath)

  if (isFirstStart) {
    if (args.native) {
      yield* Effect.logInfo("[tauroboros] First run - creating settings with native mode...")
      return yield* createInitialSettings(projectRoot, false)
    }

    yield* Effect.logInfo("[tauroboros] First run detected - setting up container mode...")
    const containerCheck = yield* checkAndPrepareContainerEffect(projectRoot)

    if (!containerCheck.ready) {
        return yield* new StartupError({ message: `${containerCheck.error}\n[tauroboros] To start in native mode instead, run: bun run start -- --native` })
    }

    const created = yield* createInitialSettings(projectRoot, true)
    yield* Effect.logInfo("[tauroboros] Settings created with container mode enabled")
    return created
  }

  const result = yield* ensureSettingsEffect(projectRoot).pipe(
    Effect.mapError((cause) => new StartupError({ message: cause.message })),
  )
  const settings = result.settings

  if (settings.workflow.container.enabled !== false) {
    yield* Effect.logInfo("[tauroboros] Validating container runtime availability...")

    if (!PiContainerManager.isAvailable()) {
        return yield* new StartupError({ message: "CRITICAL: Container mode is enabled but Podman is not available.\n[tauroboros] Install Podman or explicitly disable container mode by running with --native flag:\n[tauroboros]   bun run start -- --native\n[tauroboros] Or set workflow.container.enabled to false in .tauroboros/settings.json" })
    }

    const containerRuntime = yield* validateContainerSetupEffect(new PiContainerManager(), settings).pipe(
      Effect.mapError((cause: unknown) => new StartupError({ message: `Failed to validate container runtime: ${cause instanceof Error ? cause.message : String(cause)}` })),
    )

    if (!containerRuntime.available) {
      const runtimeIssues = containerRuntime.issues.join("\n")
      return yield* new StartupError({
        message:
          `CRITICAL: Container mode is enabled but runtime validation failed.\n${runtimeIssues}\n` +
          `[tauroboros] Build it with: podman build -t ${settings.workflow.container.image} -f docker/pi-agent/Dockerfile .\n` +
          `[tauroboros] Or disable container mode by running with --native flag:\n[tauroboros]   bun run start -- --native`,
      })
    }

    yield* Effect.logInfo("[tauroboros] Container runtime validated successfully")
  }

  return result
})

const waitForShutdownSignalEffect = Effect.async<void>((resume) => {
  let done = false

  const cleanup = () => {
    process.off("SIGINT", handleSignal)
    process.off("SIGTERM", handleSignal)
  }

  const handleSignal = () => {
    if (done) {
      return
    }
    done = true
    cleanup()
    resume(Effect.void)
  }

  process.on("SIGINT", handleSignal)
  process.on("SIGTERM", handleSignal)

  return Effect.sync(() => {
    done = true
    cleanup()
  })
})

const runProgram = Effect.fn("runProgram")(function* () {
  const projectRoot = yield* findProjectRootEffect().pipe(
    Effect.catchTag("NotAGitRepositoryError", (error) =>
      new StartupError({
        message: `\n❌ Not a Git Repository\n` +
          `========================\n\n` +
          `TaurOboros must be run from within a git repository.\n\n` +
          `Current directory: ${error.cwd}\n\n` +
          `To use TaurOboros:\n` +
          `  1. Navigate to a git repository:\n` +
          `     cd /path/to/your/git/repo\n\n` +
          `  2. Or initialize a new git repository:\n` +
          `     git init\n\n` +
          `  3. Then run tauroboros again\n`,
      }),
    ),
  )
  const extractionResult = extractEmbeddedResources(projectRoot)
  if (extractionResult.mode === "binary") {
    yield* Effect.logInfo(`[tauroboros] Extracted ${extractionResult.skills} skills, ${extractionResult.config} configs, and ${extractionResult.docker} docker files from binary`)
  } else if (extractionResult.mode === "source") {
    yield* Effect.logInfo(`[tauroboros] Copied ${extractionResult.skills} skills, ${extractionResult.config} configs, and ${extractionResult.docker} docker files from source`)
  }

  const args = parseCliArgs(process.argv.slice(2))
  const { settings, warnings } = yield* loadSettings(projectRoot, args)

  for (const warning of warnings) {
    yield* Effect.logWarning(`[tauroboros] ${warning}`)
  }

  const dbPath = resolve(projectRoot, settings.workflow.server.dbPath)
  const envPort = process.env.SERVER_PORT
  const port = envPort ? parseInt(envPort, 10) : settings.workflow.server.port
  if (Number.isNaN(port)) {
    return yield* new StartupError({ message: `Invalid SERVER_PORT value '${envPort ?? ""}'. Expected an integer.` })
  }

  const { server } = yield* createPiServerScopedEffect({
    port,
    dbPath,
    settings,
  })

  const actualPort = yield* server.startEffect(port).pipe(
    Effect.mapError((cause) => new StartupError({ message: cause.message })),
  )

  yield* Effect.logInfo(`[tauroboros] server started on http://0.0.0.0:${actualPort}`)
  const devPort = process.env.DEV_PORT?.trim()
  if (devPort) {
    yield* Effect.logInfo(`[tauroboros] frontend dev server (hot reload) is expected at http://0.0.0.0:${devPort}`)
    yield* Effect.logInfo(`[tauroboros] open the frontend URL above for UI changes; backend API remains on http://0.0.0.0:${actualPort}`)
  }

  if (actualPort !== settings.workflow.server.port) {
    settings.workflow.server.port = actualPort
    yield* saveSettingsEffect(projectRoot, settings).pipe(
      Effect.mapError((cause) => new StartupError({ message: cause.message })),
    )
  }

  yield* waitForShutdownSignalEffect
})

void Effect.runPromise(Effect.scoped(runProgram())).catch((error) => {
  // Handle NotAGitRepositoryError with a friendly message
  // Check for _tag property as Effect Schema errors may be serialized
  const errorTag = typeof error === "object" && error !== null ? (error as { _tag?: string })._tag : undefined
  const errorCwd = typeof error === "object" && error !== null ? (error as { cwd?: string }).cwd : undefined
  
  if (error instanceof NotAGitRepositoryError || errorTag === "NotAGitRepositoryError") {
    const cwd = error instanceof NotAGitRepositoryError ? error.cwd : errorCwd ?? process.cwd()
    process.stderr.write(`\n❌ Not a Git Repository\n`)
    process.stderr.write(`========================\n\n`)
    process.stderr.write(`TaurOboros must be run from within a git repository.\n\n`)
    process.stderr.write(`Current directory: ${cwd}\n\n`)
    process.stderr.write(`To use TaurOboros:\n`)
    process.stderr.write(`  1. Navigate to a git repository:\n`)
    process.stderr.write(`     cd /path/to/your/git/repo\n\n`)
    process.stderr.write(`  2. Or initialize a new git repository:\n`)
    process.stderr.write(`     git init\n\n`)
    process.stderr.write(`  3. Then run tauroboros again\n\n`)
    process.exit(1)
  }

  const message = error instanceof StartupError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error)
  process.stderr.write(`[tauroboros] ${message}\n`)
  process.exit(1)
})

