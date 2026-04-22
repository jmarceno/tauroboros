import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { Effect, Either, Schema } from "effect"
import { BASE_IMAGES } from "./base-images.ts"

export interface SkillsSettings {
  localPath: string
  autoLoad: boolean
  allowGlobal: boolean
}

export interface ProjectSettings {
  name: string
  type: string
}

export interface ServerSettings {
  port: number
  dbPath: string
}

export interface ContainerSettings {
  enabled: boolean
  piBin: string
  piArgs: string
  image: string
  imageSource: "dockerfile" | "registry"
  dockerfilePath: string
  registryUrl: string | null
  autoPrepare: boolean
  memoryMb: number
  cpuCount: number
  portRangeStart: number
  portRangeEnd: number
  mountPodmanSocket: boolean
}

export interface WorkflowSettings {
  server: ServerSettings
  container: ContainerSettings
}

export interface InfrastructureSettings {
  skills: SkillsSettings
  project: ProjectSettings
  workflow: WorkflowSettings
}

export const DEFAULT_INFRASTRUCTURE_SETTINGS: InfrastructureSettings = {
  skills: {
    localPath: "./skills",
    autoLoad: true,
    allowGlobal: false,
  },
  project: {
    name: "tauroboros",
    type: "workflow",
  },
  workflow: {
    server: {
      port: 0,
      dbPath: ".tauroboros/tasks.db",
    },
    container: {
      enabled: true,
      piBin: "pi",
      piArgs: "--mode rpc",
      image: BASE_IMAGES.piAgent,
      imageSource: "dockerfile",
      dockerfilePath: "docker/pi-agent/Dockerfile",
      registryUrl: null,
      autoPrepare: true,
      memoryMb: 512,
      cpuCount: 1,
      portRangeStart: 30000,
      portRangeEnd: 40000,
      mountPodmanSocket: false,
    },
  },
}

export interface SettingsLoadResult {
  settings: InfrastructureSettings
  warnings: string[]
  unknownFields: string[]
}

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

interface WorkflowSettingsPatch {
  server?: Partial<ServerSettings>
  container?: Partial<ContainerSettings>
}

interface InfrastructureSettingsPatch {
  skills?: Partial<SkillsSettings>
  project?: Partial<ProjectSettings>
  workflow?: WorkflowSettingsPatch
}

const IntegerSchema = Schema.Number.pipe(Schema.int())
const NonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
const PortSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(65535),
)
const ImageSourceSchema = Schema.Literal("dockerfile", "registry")
const RegistryUrlSchema = Schema.Union(Schema.String, Schema.Null)

const SkillsPartialSchema = Schema.Struct({
  localPath: Schema.optional(Schema.String),
  autoLoad: Schema.optional(Schema.Boolean),
  allowGlobal: Schema.optional(Schema.Boolean),
})

const ProjectPartialSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
})

const ServerPartialSchema = Schema.Struct({
  port: Schema.optional(PortSchema),
  dbPath: Schema.optional(Schema.String),
})

const ContainerPartialSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  piBin: Schema.optional(Schema.String),
  piArgs: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  imageSource: Schema.optional(ImageSourceSchema),
  dockerfilePath: Schema.optional(Schema.String),
  registryUrl: Schema.optional(RegistryUrlSchema),
  autoPrepare: Schema.optional(Schema.Boolean),
  memoryMb: Schema.optional(NonNegativeIntegerSchema),
  cpuCount: Schema.optional(NonNegativeIntegerSchema),
  portRangeStart: Schema.optional(IntegerSchema),
  portRangeEnd: Schema.optional(IntegerSchema),
  mountPodmanSocket: Schema.optional(Schema.Boolean),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  const result = { ...target }

  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === "object" &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof target[key] === "object" &&
        target[key] !== null
      ) {
        result[key] = deepMerge(target[key], source[key] as Partial<T[typeof key]>)
      } else {
        result[key] = source[key] as T[typeof key]
      }
    }
  }

  return result
}

function validateWithSchema<A, I>(
  path: string,
  value: unknown,
  schema: Schema.Schema<A, I, never>,
  warnings: string[],
): boolean {
  const decoded = Schema.decodeUnknownEither(schema)(value)
  if (Either.isLeft(decoded)) {
    warnings.push(`Invalid value at '${path}': ${decoded.left.message}`)
    return false
  }
  return true
}

function extractUnknownFields(
  obj: Record<string, unknown>,
  validKeys: string[],
  path: string,
): string[] {
  const unknown: string[] = []

  for (const key of Object.keys(obj)) {
    const fullPath = path ? `${path}.${key}` : key
    if (!validKeys.includes(key)) {
      unknown.push(fullPath)
    }
  }

  return unknown
}

function validateAndExtractUnknown(
  parsed: Record<string, unknown>,
  warnings: string[],
): SettingsLoadResult {
  const unknownFields: string[] = []
  const sanitized: InfrastructureSettingsPatch = {}

  const validTopKeys = ["skills", "project", "workflow"]
  unknownFields.push(...extractUnknownFields(parsed, validTopKeys, ""))

  if (parsed.skills !== undefined) {
    if (isRecord(parsed.skills)) {
      const skills = parsed.skills
      const validSkillsKeys = ["localPath", "autoLoad", "allowGlobal"]
      unknownFields.push(...extractUnknownFields(skills, validSkillsKeys, "skills"))

      const decodedSkills = Schema.decodeUnknownEither(SkillsPartialSchema)(skills)
      if (Either.isRight(decodedSkills)) {
        sanitized.skills = decodedSkills.right
      } else {
        warnings.push(`Invalid value at 'skills': ${decodedSkills.left.message}`)
      }
    } else {
      warnings.push("Invalid value at 'skills': expected an object")
    }
  }

  if (parsed.project !== undefined) {
    if (isRecord(parsed.project)) {
      const project = parsed.project
      const validProjectKeys = ["name", "type"]
      unknownFields.push(...extractUnknownFields(project, validProjectKeys, "project"))

      const decodedProject = Schema.decodeUnknownEither(ProjectPartialSchema)(project)
      if (Either.isRight(decodedProject)) {
        sanitized.project = decodedProject.right
      } else {
        warnings.push(`Invalid value at 'project': ${decodedProject.left.message}`)
      }
    } else {
      warnings.push("Invalid value at 'project': expected an object")
    }
  }

  if (parsed.workflow !== undefined) {
    if (isRecord(parsed.workflow)) {
      const workflow = parsed.workflow
      const validWorkflowKeys = ["server", "container"]
      unknownFields.push(...extractUnknownFields(workflow, validWorkflowKeys, "workflow"))

      const workflowPatch: WorkflowSettingsPatch = {}

      if (workflow.server !== undefined) {
        if (isRecord(workflow.server)) {
          const server = workflow.server
          const validServerKeys = ["port", "dbPath"]
          unknownFields.push(...extractUnknownFields(server, validServerKeys, "workflow.server"))

          const decodedServer = Schema.decodeUnknownEither(ServerPartialSchema)(server)
          if (Either.isRight(decodedServer)) {
            workflowPatch.server = decodedServer.right
          } else {
            warnings.push(`Invalid value at 'workflow.server': ${decodedServer.left.message}`)
          }
        } else {
          warnings.push("Invalid value at 'workflow.server': expected an object")
        }
      }

      if (workflow.container !== undefined) {
        if (isRecord(workflow.container)) {
          const container = workflow.container
          const validContainerKeys = [
            "enabled",
            "piBin",
            "piArgs",
            "image",
            "imageSource",
            "dockerfilePath",
            "registryUrl",
            "autoPrepare",
            "memoryMb",
            "cpuCount",
            "portRangeStart",
            "portRangeEnd",
            "mountPodmanSocket",
          ]
          unknownFields.push(
            ...extractUnknownFields(container, validContainerKeys, "workflow.container"),
          )

          const decodedContainer = Schema.decodeUnknownEither(ContainerPartialSchema)(container)
          if (Either.isRight(decodedContainer)) {
            workflowPatch.container = decodedContainer.right
          } else {
            warnings.push(`Invalid value at 'workflow.container': ${decodedContainer.left.message}`)
          }
        } else {
          warnings.push("Invalid value at 'workflow.container': expected an object")
        }
      }

      if (workflowPatch.server || workflowPatch.container) {
        sanitized.workflow = workflowPatch
      }
    } else {
      warnings.push("Invalid value at 'workflow': expected an object")
    }
  }

  // Merge with defaults
  const merged = deepMerge(DEFAULT_INFRASTRUCTURE_SETTINGS, sanitized)

  return {
    settings: merged,
    warnings,
    unknownFields,
  }
}

function loadSettingsResult(projectRoot: string): SettingsLoadResult {
  const settingsPath = join(projectRoot, ".tauroboros", "settings.json")
  const warnings: string[] = []

  if (!existsSync(settingsPath)) {
    return {
      settings: { ...DEFAULT_INFRASTRUCTURE_SETTINGS },
      warnings: ["Settings file not found, using defaults"],
      unknownFields: [],
    }
  }

  try {
    const raw = readFileSync(settingsPath, "utf-8")
    let parsed: unknown

    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`Invalid JSON in settings file: ${message}. Using defaults.`)
      return {
        settings: { ...DEFAULT_INFRASTRUCTURE_SETTINGS },
        warnings,
        unknownFields: [],
      }
    }

    if (!parsed || typeof parsed !== "object") {
      warnings.push("Settings must be a JSON object. Using defaults.")
      return {
        settings: { ...DEFAULT_INFRASTRUCTURE_SETTINGS },
        warnings,
        unknownFields: [],
      }
    }

    // Validate object shape before field-level decode
    if (!validateWithSchema("settings", parsed, Schema.Record({ key: Schema.String, value: Schema.Unknown }), warnings)) {
      return {
        settings: { ...DEFAULT_INFRASTRUCTURE_SETTINGS },
        warnings,
        unknownFields: [],
      }
    }

    return validateAndExtractUnknown(parsed as Record<string, unknown>, warnings)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(`Failed to load settings: ${message}. Using defaults.`)

    return {
      settings: { ...DEFAULT_INFRASTRUCTURE_SETTINGS },
      warnings,
      unknownFields: [],
    }
  }
}

function saveSettingsResult(
  projectRoot: string,
  settings: InfrastructureSettings,
): void {
  const settingsDir = join(projectRoot, ".tauroboros")
  mkdirSync(settingsDir, { recursive: true })

  const settingsPath = join(settingsDir, "settings.json")
  const content = JSON.stringify(settings, null, 2)
  writeFileSync(settingsPath, content, "utf-8")
}

export interface EnsureSettingsOptions {
  preferContainer?: boolean
}

function ensureSettingsResult(
  projectRoot: string,
  options?: EnsureSettingsOptions,
): SettingsLoadResult {
  const settingsPath = join(projectRoot, ".tauroboros", "settings.json")

  let result: SettingsLoadResult

  if (existsSync(settingsPath)) {
    result = loadSettingsResult(projectRoot)

    // Re-save to ensure file has all defaults and proper formatting
    saveSettingsResult(projectRoot, result.settings)
  } else {
    // Create new with defaults
    const settings = { ...DEFAULT_INFRASTRUCTURE_SETTINGS }

    // Apply container preference if specified
    if (options?.preferContainer === true) {
      settings.workflow.container.enabled = true
    }

    result = {
      settings,
      warnings: ["Created new settings.json with default values"],
      unknownFields: [],
    }
    saveSettingsResult(projectRoot, result.settings)
  }

  return result
}

function logSettingsWarnings(result: SettingsLoadResult): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const w of result.warnings) {
      yield* Effect.logWarning(`[settings] ${w}`)
    }
    for (const f of result.unknownFields) {
      yield* Effect.logWarning(`[settings] Unknown field in settings.json: ${f}`)
    }
  })
}

export const loadSettingsEffect = Effect.fn("loadSettingsEffect")(
  function* (projectRoot: string) {
    const result = yield* Effect.try({
      try: () => loadSettingsResult(projectRoot),
      catch: (e) => new SettingsError({ message: e instanceof Error ? e.message : String(e), cause: e }),
    })
    yield* logSettingsWarnings(result)
    return result
  },
)

export const saveSettingsEffect = Effect.fn("saveSettingsEffect")(
  function* (projectRoot: string, settings: InfrastructureSettings) {
    return yield* Effect.try({
      try: () => saveSettingsResult(projectRoot, settings),
      catch: (e) => new SettingsError({ message: e instanceof Error ? e.message : String(e), cause: e }),
    })
  },
)

export const ensureSettingsEffect = Effect.fn("ensureSettingsEffect")(
  function* (projectRoot: string, options?: EnsureSettingsOptions) {
    const result = yield* Effect.try({
      try: () => ensureSettingsResult(projectRoot, options),
      catch: (e) => new SettingsError({ message: e instanceof Error ? e.message : String(e), cause: e }),
    })
    yield* logSettingsWarnings(result)
    return result
  },
)
