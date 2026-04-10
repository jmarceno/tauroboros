import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

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

export interface RuntimeSettings {
  mode: "native" | "container"
  piBin: string
  piArgs: string
}

export interface ContainerSettings {
  enabled: boolean
  image: string
  memoryMb: number
  cpuCount: number
  portRangeStart: number
  portRangeEnd: number
}

export interface WorkflowSettings {
  server: ServerSettings
  runtime: RuntimeSettings
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
    name: "pi-easy-workflow",
    type: "workflow",
  },
  workflow: {
    server: {
      port: 3789,
      dbPath: ".pi/easy-workflow/tasks.db",
    },
    runtime: {
      mode: "native",
      piBin: "pi",
      piArgs: "--mode rpc --no-extensions",
    },
    container: {
      enabled: false,
      image: "pi-agent:alpine",
      memoryMb: 512,
      cpuCount: 1,
      portRangeStart: 30000,
      portRangeEnd: 40000,
    },
  },
}

export interface SettingsLoadResult {
  settings: InfrastructureSettings
  warnings: string[]
  unknownFields: string[]
}

function deepMerge<T>(target: T, source: Partial<T>): T {
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

function validateFieldType(
  path: string,
  value: unknown,
  expectedType: string,
  warnings: string[],
): boolean {
  const actualType = typeof value

  if (expectedType === "number" && actualType === "number") {
    if (Number.isNaN(value)) {
      warnings.push(`Invalid value at '${path}': must be a valid number, got NaN`)
      return false
    }
    return true
  }

  if (expectedType === "integer" && actualType === "number") {
    if (!Number.isInteger(value)) {
      warnings.push(`Invalid value at '${path}': must be an integer, got ${value}`)
      return false
    }
    return true
  }

  if (expectedType === "boolean" && actualType === "boolean") {
    return true
  }

  if (expectedType === "string" && actualType === "string") {
    return true
  }

  if (actualType !== expectedType) {
    warnings.push(
      `Invalid type at '${path}': expected ${expectedType}, got ${actualType}`,
    )
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

  // Check top-level keys
  const validTopKeys = ["skills", "project", "workflow"]
  unknownFields.push(...extractUnknownFields(parsed, validTopKeys, ""))

  // Validate skills if present
  if (parsed.skills !== undefined) {
    if (typeof parsed.skills === "object" && parsed.skills !== null) {
      const skills = parsed.skills as Record<string, unknown>
      const validSkillsKeys = ["localPath", "autoLoad", "allowGlobal"]
      unknownFields.push(...extractUnknownFields(skills, validSkillsKeys, "skills"))

      if (skills.localPath !== undefined) {
        validateFieldType("skills.localPath", skills.localPath, "string", warnings)
      }
      if (skills.autoLoad !== undefined) {
        validateFieldType("skills.autoLoad", skills.autoLoad, "boolean", warnings)
      }
      if (skills.allowGlobal !== undefined) {
        validateFieldType("skills.allowGlobal", skills.allowGlobal, "boolean", warnings)
      }
    }
  }

  // Validate project if present
  if (parsed.project !== undefined) {
    if (typeof parsed.project === "object" && parsed.project !== null) {
      const project = parsed.project as Record<string, unknown>
      const validProjectKeys = ["name", "type"]
      unknownFields.push(...extractUnknownFields(project, validProjectKeys, "project"))

      if (project.name !== undefined) {
        validateFieldType("project.name", project.name, "string", warnings)
      }
      if (project.type !== undefined) {
        validateFieldType("project.type", project.type, "string", warnings)
      }
    }
  }

  // Validate workflow if present
  if (parsed.workflow !== undefined) {
    if (typeof parsed.workflow === "object" && parsed.workflow !== null) {
      const workflow = parsed.workflow as Record<string, unknown>
      const validWorkflowKeys = ["server", "runtime", "container"]
      unknownFields.push(...extractUnknownFields(workflow, validWorkflowKeys, "workflow"))

      // Validate server settings
      if (workflow.server !== undefined) {
        if (typeof workflow.server === "object" && workflow.server !== null) {
          const server = workflow.server as Record<string, unknown>
          const validServerKeys = ["port", "dbPath"]
          unknownFields.push(...extractUnknownFields(server, validServerKeys, "workflow.server"))

          if (server.port !== undefined) {
            validateFieldType("workflow.server.port", server.port, "integer", warnings)
          }
          if (server.dbPath !== undefined) {
            validateFieldType("workflow.server.dbPath", server.dbPath, "string", warnings)
          }
        }
      }

      // Validate runtime settings
      if (workflow.runtime !== undefined) {
        if (typeof workflow.runtime === "object" && workflow.runtime !== null) {
          const runtime = workflow.runtime as Record<string, unknown>
          const validRuntimeKeys = ["mode", "piBin", "piArgs"]
          unknownFields.push(...extractUnknownFields(runtime, validRuntimeKeys, "workflow.runtime"))

          if (runtime.mode !== undefined) {
            if (validateFieldType("workflow.runtime.mode", runtime.mode, "string", warnings)) {
              if (runtime.mode !== "native" && runtime.mode !== "container") {
                warnings.push(
                  `Invalid value at 'workflow.runtime.mode': must be "native" or "container", got "${runtime.mode}"`,
                )
              }
            }
          }
          if (runtime.piBin !== undefined) {
            validateFieldType("workflow.runtime.piBin", runtime.piBin, "string", warnings)
          }
          if (runtime.piArgs !== undefined) {
            validateFieldType("workflow.runtime.piArgs", runtime.piArgs, "string", warnings)
          }
        }
      }

      // Validate container settings
      if (workflow.container !== undefined) {
        if (typeof workflow.container === "object" && workflow.container !== null) {
          const container = workflow.container as Record<string, unknown>
          const validContainerKeys = [
            "enabled",
            "image",
            "memoryMb",
            "cpuCount",
            "portRangeStart",
            "portRangeEnd",
          ]
          unknownFields.push(
            ...extractUnknownFields(container, validContainerKeys, "workflow.container"),
          )

          if (container.enabled !== undefined) {
            validateFieldType("workflow.container.enabled", container.enabled, "boolean", warnings)
          }
          if (container.image !== undefined) {
            validateFieldType("workflow.container.image", container.image, "string", warnings)
          }
          if (container.memoryMb !== undefined) {
            validateFieldType("workflow.container.memoryMb", container.memoryMb, "integer", warnings)
          }
          if (container.cpuCount !== undefined) {
            validateFieldType("workflow.container.cpuCount", container.cpuCount, "integer", warnings)
          }
          if (container.portRangeStart !== undefined) {
            validateFieldType(
              "workflow.container.portRangeStart",
              container.portRangeStart,
              "integer",
              warnings,
            )
          }
          if (container.portRangeEnd !== undefined) {
            validateFieldType(
              "workflow.container.portRangeEnd",
              container.portRangeEnd,
              "integer",
              warnings,
            )
          }
        }
      }
    }
  }

  // Merge with defaults
  const merged = deepMerge(DEFAULT_INFRASTRUCTURE_SETTINGS, parsed as Partial<InfrastructureSettings>)

  return {
    settings: merged,
    warnings,
    unknownFields,
  }
}

export function loadInfrastructureSettings(projectRoot: string): SettingsLoadResult {
  const settingsPath = join(projectRoot, ".pi", "settings.json")
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
      throw new Error(`Invalid JSON in settings file: ${message}`)
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Settings must be a JSON object")
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

export function saveInfrastructureSettings(
  projectRoot: string,
  settings: InfrastructureSettings,
): void {
  const settingsPath = join(projectRoot, ".pi", "settings.json")
  const content = JSON.stringify(settings, null, 2)
  writeFileSync(settingsPath, content, "utf-8")
}

export function ensureInfrastructureSettings(projectRoot: string): SettingsLoadResult {
  const settingsPath = join(projectRoot, ".pi", "settings.json")

  let result: SettingsLoadResult

  if (existsSync(settingsPath)) {
    result = loadInfrastructureSettings(projectRoot)

    // Re-save to ensure file has all defaults and proper formatting
    saveInfrastructureSettings(projectRoot, result.settings)
  } else {
    // Create new with defaults
    result = {
      settings: { ...DEFAULT_INFRASTRUCTURE_SETTINGS },
      warnings: ["Created new settings.json with default values"],
      unknownFields: [],
    }
    saveInfrastructureSettings(projectRoot, result.settings)
  }

  return result
}
