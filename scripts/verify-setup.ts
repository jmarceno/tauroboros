import { existsSync, mkdirSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { Effect } from "effect"
import {
  ensureSettingsEffect,
  type InfrastructureSettings,
} from "../src/config/settings.ts"
import { discoverSkills, getProjectRoot } from "./sync-skills.ts"

interface PiSettings {
  skills?: {
    localPath?: string
    autoLoad?: boolean
    allowGlobal?: boolean
  }
}

function validateSkillFrontmatter(skillFilePath: string): void {
  const content = readFileSync(skillFilePath, "utf-8")
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---\n")) {
    throw new Error(`Missing frontmatter start in ${skillFilePath}`)
  }

  const endMarkerIndex = trimmed.indexOf("\n---\n", 4)
  if (endMarkerIndex === -1) {
    throw new Error(`Missing frontmatter end in ${skillFilePath}`)
  }

  const frontmatter = trimmed.slice(4, endMarkerIndex)
  if (!/\bname\s*:/m.test(frontmatter)) {
    throw new Error(`Frontmatter missing 'name' in ${skillFilePath}`)
  }
  if (!/\bdescription\s*:/m.test(frontmatter)) {
    throw new Error(`Frontmatter missing 'description' in ${skillFilePath}`)
  }
}

function parseSettings(settingsPath: string): PiSettings {
  if (!existsSync(settingsPath)) {
    throw new Error(`Missing Pi settings file: ${settingsPath}`)
  }

  const raw = readFileSync(settingsPath, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in ${settingsPath}: ${message}`)
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Pi settings must be a JSON object: ${settingsPath}`)
  }

  return parsed as PiSettings
}

function validateSettings(settings: PiSettings): void {
  const skills = settings.skills
  if (!skills || typeof skills !== "object") {
    throw new Error("Pi settings is missing the 'skills' object")
  }

  if (skills.localPath !== "./skills") {
    throw new Error("Pi settings skills.localPath must be './skills'")
  }
  if (skills.autoLoad !== true) {
    throw new Error("Pi settings skills.autoLoad must be true")
  }
  if (skills.allowGlobal !== false) {
    throw new Error("Pi settings skills.allowGlobal must be false")
  }
}

function validateInfrastructureSettings(settings: InfrastructureSettings): void {
  // Validate server settings
  if (!settings.workflow?.server?.port || typeof settings.workflow.server.port !== "number") {
    throw new Error("Infrastructure settings workflow.server.port must be a number")
  }
  if (!settings.workflow?.server?.dbPath || typeof settings.workflow.server.dbPath !== "string") {
    throw new Error("Infrastructure settings workflow.server.dbPath must be a string")
  }

  // Validate container settings
  if (settings.workflow?.container) {
    if (typeof settings.workflow.container.enabled !== "boolean") {
      throw new Error("Infrastructure settings workflow.container.enabled must be a boolean")
    }
    if (typeof settings.workflow.container.piBin !== "string") {
      throw new Error("Infrastructure settings workflow.container.piBin must be a string")
    }
    if (typeof settings.workflow.container.piArgs !== "string") {
      throw new Error("Infrastructure settings workflow.container.piArgs must be a string")
    }
    if (typeof settings.workflow.container.image !== "string") {
      throw new Error("Infrastructure settings workflow.container.image must be a string")
    }
    if (typeof settings.workflow.container.memoryMb !== "number") {
      throw new Error("Infrastructure settings workflow.container.memoryMb must be a number")
    }
    if (typeof settings.workflow.container.cpuCount !== "number") {
      throw new Error("Infrastructure settings workflow.container.cpuCount must be a number")
    }
  }
}

export function verifySetup(projectRoot: string = getProjectRoot()): void {
  const skillsSourceDir = resolve(join(projectRoot, "skills"))
  const piDir = resolve(join(projectRoot, ".pi"))
  const piSkillsDir = resolve(join(piDir, "skills"))
  const tauroborosDir = resolve(join(projectRoot, ".tauroboros"))
  const settingsPath = resolve(join(tauroborosDir, "settings.json"))

  const skills = discoverSkills(skillsSourceDir)
  console.log(`✓ Skills source directory exists (${skills.length} skills found)`)

  for (const skill of skills) {
    validateSkillFrontmatter(skill.skillFile)
  }
  console.log("✓ Skills have required frontmatter")

  // Validate original Pi settings (skills configuration)
  const settings = parseSettings(settingsPath)
  validateSettings(settings)
  console.log("✓ Pi settings.json skills configuration is valid")

  // Ensure infrastructure settings are initialized
  const infraResult = Effect.runSync(ensureSettingsEffect(projectRoot))
  validateInfrastructureSettings(infraResult.settings)

  // Report any warnings about unknown fields
  for (const warning of infraResult.warnings) {
    console.warn(`⚠️  ${warning}`)
  }

  // Report unknown fields
  if (infraResult.unknownFields.length > 0) {
    console.warn(`⚠️  Unknown fields detected in .tauroboros/settings.json:`)
    for (const field of infraResult.unknownFields) {
      console.warn(`   - ${field}`)
    }
  }

  console.log("✓ Infrastructure settings are valid")

  mkdirSync(piSkillsDir, { recursive: true })
  console.log("✓ .pi/skills directory is writable")

  console.log("✓ Setup is reproducible")
}

if (import.meta.main) {
  try {
    verifySetup()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Setup verification failed: ${message}`)
    process.exitCode = 1
  }
}
