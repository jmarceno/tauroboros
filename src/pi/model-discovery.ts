import fs from "fs"
import path from "path"
import { Effect, Fiber, Schema } from "effect"

type NormalizedModel = {
  id: string
  label: string
  value: string
}

type NormalizedProvider = {
  id: string
  name: string
  models: NormalizedModel[]
}

export type NormalizedModelCatalog = {
  providers: NormalizedProvider[]
  defaults: Record<string, string>
  warning?: string
}

/**
 * Error for model discovery operations
 */
export class ModelDiscoveryError extends Schema.TaggedError<ModelDiscoveryError>()("ModelDiscoveryError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

let cache: { expiresAt: number; value: NormalizedModelCatalog } | null = null

function loadLocalModelsJson(): NormalizedModelCatalog | null {
  const modelsJsonPath = path.join(process.cwd(), ".tauroboros", "agent", "models.json")
  if (!fs.existsSync(modelsJsonPath)) return null

  const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) as {
    providers?: Record<string, { name?: string; models?: Array<{ id?: string; name?: string }> }>
  }

  const providers = Object.entries(raw.providers ?? {})
    .map(([providerId, provider]) => {
      const models = (provider.models ?? [])
        .filter((model): model is { id: string; name?: string } => typeof model.id === "string" && model.id.trim().length > 0)
        .map((model) => ({
          id: model.id,
          label: model.id,
          value: `${providerId}/${model.id}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label))

      return {
        id: providerId,
        name: provider.name || providerId,
        models,
      }
    })
    .filter((provider) => provider.models.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))

  if (providers.length === 0) {
    return null
  }

  return { providers, defaults: {} }
}

function parsePiListModelsOutput(stdout: string): NormalizedModelCatalog {
  const lines = stdout.split("\n").filter((line) => line.trim())
  const providersById = new Map<string, NormalizedProvider>()

  for (const line of lines) {
    // Skip header lines and separator lines
    if (line.startsWith("provider") || line.startsWith("-")) continue
    if (!line.includes("  ")) continue

    // Parse the table format: provider      model                   context  max-out  thinking  images
    const parts = line.trim().split(/\s{2,}/)
    if (parts.length < 2) continue

    const providerId = parts[0].trim()
    const modelId = parts[1].trim()

    if (!providerId || !modelId) continue

    const provider = providersById.get(providerId) ?? { id: providerId, name: providerId, models: [] }
    if (!provider.models.some((m) => m.id === modelId)) {
      provider.models.push({
        id: modelId,
        label: modelId,
        value: `${providerId}/${modelId}`,
      })
    }
    providersById.set(providerId, provider)
  }

  const providers = [...providersById.values()].map((provider) => ({
    ...provider,
    models: provider.models.sort((a, b) => a.label.localeCompare(b.label)),
  })).sort((a, b) => a.name.localeCompare(b.name))

  return { providers, defaults: {} }
}

function runPiModelCommandEffect(
  timeoutMs: number
): Effect.Effect<NormalizedModelCatalog, ModelDiscoveryError> {
  return Effect.gen(function* () {
    // Use shell to ensure proper PATH and environment
    // Note: pi --list-models outputs to stderr, not stdout!
    const command = Bun.spawn({
      cmd: ["bash", "-c", "PI_OFFLINE=1 pi --offline --list-models"],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    // Set up timeout
    const timeoutFiber = yield* Effect.fork(
      Effect.gen(function* () {
        yield* Effect.sleep(timeoutMs)
        command.kill()
      })
    )

    const outputPromise = Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ])

    const result = yield* Effect.tryPromise({
      try: () => outputPromise,
      catch: () => new ModelDiscoveryError({
        operation: "runPiModelCommand",
        message: `Pi model discovery timed out after ${timeoutMs}ms`,
      }),
    })

    // Cancel timeout if command completed
    yield* Fiber.interruptFork(timeoutFiber)

    const [stdoutText, stderrText, exitCode] = result

    // pi --list-models outputs to stderr, not stdout!
    // Combine both stdout and stderr to capture the model list
    const combinedOutput = stderrText + stdoutText

    if (exitCode !== 0 && exitCode !== null) {
      // Sometimes exit code is null if process is killed, but we may still have output
      if (!combinedOutput.includes("provider")) {
        return yield* new ModelDiscoveryError({
          operation: "runPiModelCommand",
          message: stderrText.trim() || `pi --list-models failed with exit code ${exitCode}`,
        })
      }
    }

    // Filter out extension initialization messages
    const cleanOutput = combinedOutput
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim()
        if (!trimmed) return false
        // Skip extension initialization messages
        if (trimmed.startsWith("Easy Workflow")) return false
        if (trimmed.startsWith("Easy Workflow extension")) return false
        if (trimmed.startsWith("Easy Workflow kanban")) return false
        if (trimmed.includes("extension initializing")) return false
        if (trimmed.startsWith("port:")) return false
        if (trimmed.startsWith("url:")) return false
        if (trimmed.startsWith("ownerDirectory:")) return false
        if (trimmed.startsWith("pid:")) return false
        if (trimmed.startsWith("New session")) return false
        if (trimmed.startsWith("sessionFile:")) return false
        if (trimmed.startsWith("cwd:")) return false
        return true
      })
      .join("\n")

    const parsed = parsePiListModelsOutput(cleanOutput)

    if (parsed.providers.length === 0) {
      return yield* new ModelDiscoveryError({
        operation: "runPiModelCommand",
        message: "No models found in pi CLI output",
      })
    }

    return parsed
  })
}

export function discoverPiModelsEffect(
  options: { forceRefresh?: boolean; ttlMs?: number; maxRetries?: number; commandTimeoutMs?: number } = {}
): Effect.Effect<NormalizedModelCatalog, never> {
  return Effect.gen(function* () {
    const ttlMs = options.ttlMs ?? 60_000
    const maxRetries = Math.max(1, options.maxRetries ?? 2)
    const commandTimeoutMs = Math.max(500, options.commandTimeoutMs ?? 5000)

    if (!options.forceRefresh && cache && cache.expiresAt > Date.now()) {
      return cache.value
    }

    const localCatalog = loadLocalModelsJson()
    if (localCatalog) {
      cache = { value: localCatalog, expiresAt: Date.now() + ttlMs }
      return localCatalog
    }

    let lastError: string | null = null
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = yield* runPiModelCommandEffect(commandTimeoutMs).pipe(Effect.either)

      if (result._tag === "Right" && result.right.providers.length > 0) {
        cache = { value: result.right, expiresAt: Date.now() + ttlMs }
        return result.right
      }

      if (result._tag === "Left") {
        lastError = result.left.message
      } else {
        lastError = "No models found in pi CLI output"
      }

      if (attempt < maxRetries - 1) {
        yield* Effect.sleep(500 * Math.pow(2, attempt))
      }
    }

    const emptyCatalog: NormalizedModelCatalog = {
      providers: [],
      defaults: {},
      warning: `Model catalog temporarily unavailable: ${lastError ?? "unknown error"}`,
    }
    cache = { value: emptyCatalog, expiresAt: Date.now() + 10_000 }
    return emptyCatalog
  })
}

