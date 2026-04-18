/**
 * Resource Extractor
 *
 * Handles extraction of embedded extensions and skills to the filesystem.
 * This ensures pi can auto-discover them from .pi/extensions/ and .pi/skills/
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "fs"
import { join, dirname } from "path"

// Import embedded assets - will be available in compiled binary
let generatedAssets: typeof import("../server/generated-assets.ts") | null = null
try {
  const mod = await import("../server/generated-assets.ts")
  // Check if the module has the actual implementation or just a placeholder
  if (mod && typeof mod.getAllExtensionAssets === 'function') {
    generatedAssets = mod
  }
} catch {
  // generated-assets.ts doesn't exist or is a placeholder
}

/**
 * Check if running from compiled binary (has embedded assets)
 */
export function isRunningFromBinary(): boolean {
  return generatedAssets !== null
}

/**
 * Ensure a directory exists, creating parent directories as needed
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Write asset data to file
 */
function writeAssetToFile(targetPath: string, asset: { isText: boolean; data: string }): void {
  ensureDir(dirname(targetPath))

  if (asset.isText) {
    writeFileSync(targetPath, asset.data, "utf-8")
  } else {
    // Decode base64 for binary files
    const buffer = Buffer.from(asset.data, "base64")
    writeFileSync(targetPath, buffer)
  }
}

/**
 * Clear a directory while preserving the directory itself
 */
function clearDirectory(dir: string): void {
  if (!existsSync(dir)) return

  const entries = readdirSync(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      rmSync(fullPath, { recursive: true, force: true })
    } else {
      rmSync(fullPath, { force: true })
    }
  }
}

/**
 * Extract all embedded extensions to .pi/extensions/
 * Only extracts if not already present (preserves user modifications)
 */
export function extractEmbeddedExtensions(projectRoot: string): { count: number; paths: string[] } {
  if (!generatedAssets) {
    return { count: 0, paths: [] }
  }

  const extensionsDir = join(projectRoot, ".pi", "extensions")
  ensureDir(extensionsDir)

  // NOTE: We do NOT clear the directory - user files are preserved
  // Only extract embedded extensions that don't already exist

  const extensionAssets = generatedAssets.getAllExtensionAssets()
  const extractedPaths: string[] = []

  for (const { path, asset } of extensionAssets) {
    const targetPath = join(extensionsDir, path)
    // Only extract if file doesn't exist (preserves user modifications)
    if (!existsSync(targetPath)) {
      writeAssetToFile(targetPath, asset)
      extractedPaths.push(targetPath)
    }
  }

  return { count: extractedPaths.length, paths: extractedPaths }
}

/**
 * Extract all embedded skills to .pi/skills/
 * Only extracts if not already present (preserves user modifications)
 */
export function extractEmbeddedSkills(projectRoot: string): { count: number; paths: string[] } {
  if (!generatedAssets) {
    return { count: 0, paths: [] }
  }

  const skillsDir = join(projectRoot, ".pi", "skills")
  ensureDir(skillsDir)

  // NOTE: We do NOT clear the directory - user files are preserved
  // Only extract embedded skills that don't already exist

  const skillAssets = generatedAssets.getAllSkillAssets()
  const extractedPaths: string[] = []

  for (const { path, asset } of skillAssets) {
    const targetPath = join(skillsDir, path)
    // Only extract if file doesn't exist (preserves user modifications)
    if (!existsSync(targetPath)) {
      writeAssetToFile(targetPath, asset)
      extractedPaths.push(targetPath)
    }
  }

  return { count: extractedPaths.length, paths: extractedPaths }
}

/**
 * Extract all embedded config files to .tauroboros/config/
 * Only extracts if not already present (preserves user modifications)
 */
export function extractEmbeddedConfig(projectRoot: string): { count: number; paths: string[] } {
  if (!generatedAssets) {
    return { count: 0, paths: [] }
  }

  const configDir = join(projectRoot, ".tauroboros", "config")
  ensureDir(configDir)

  const configAssets = generatedAssets.getAllConfigAssets()
  const extractedPaths: string[] = []

  for (const { path, asset } of configAssets) {
    const targetPath = join(configDir, path)
    // Only extract if file doesn't exist (preserves user modifications)
    if (!existsSync(targetPath)) {
      writeAssetToFile(targetPath, asset)
      extractedPaths.push(targetPath)
    }
  }

  return { count: extractedPaths.length, paths: extractedPaths }
}

/**
 * Extract all embedded docker files to .tauroboros/docker/
 * Only extracts if not already present (preserves user modifications)
 */
export function extractEmbeddedDocker(projectRoot: string): { count: number; paths: string[] } {
  if (!generatedAssets) {
    return { count: 0, paths: [] }
  }

  const dockerDir = join(projectRoot, ".tauroboros", "docker")
  ensureDir(dockerDir)

  const dockerAssets = generatedAssets.getAllDockerAssets()
  const extractedPaths: string[] = []

  for (const { path, asset } of dockerAssets) {
    const targetPath = join(dockerDir, path)
    // Only extract if file doesn't exist (preserves user modifications)
    if (!existsSync(targetPath)) {
      writeAssetToFile(targetPath, asset)
      extractedPaths.push(targetPath)
    }
  }

  return { count: extractedPaths.length, paths: extractedPaths }
}

/**
 * Copy resources from source directories (development mode)
 * Used when running from source code instead of compiled binary
 * Only copies files that don't already exist (preserves user modifications)
 */
export function copyResourcesFromSource(projectRoot: string): { extensions: number; skills: number } {
  // In development mode, extensions and skills are at the project root level
  const sourceRoot = projectRoot

  // Copy extensions - only if they don't exist
  const sourceExtensionsDir = join(sourceRoot, "extensions")
  const targetExtensionsDir = join(projectRoot, ".pi", "extensions")
  let extensionCount = 0

  if (existsSync(sourceExtensionsDir)) {
    ensureDir(targetExtensionsDir)
    // NOTE: We do NOT clear the directory - user files are preserved
    extensionCount = copyDirectoryRecursiveSkipExisting(sourceExtensionsDir, targetExtensionsDir)
  }

  // Copy skills - only if they don't exist
  const sourceSkillsDir = join(sourceRoot, "skills")
  const targetSkillsDir = join(projectRoot, ".pi", "skills")
  let skillCount = 0

  if (existsSync(sourceSkillsDir)) {
    ensureDir(targetSkillsDir)
    // NOTE: We do NOT clear the directory - user files are preserved
    skillCount = copyDirectoryRecursiveSkipExisting(sourceSkillsDir, targetSkillsDir)
  }

  return { extensions: extensionCount, skills: skillCount }
}

/**
 * Recursively copy a directory
 */
function copyDirectoryRecursive(source: string, target: string): void {
  ensureDir(target)

  const entries = readdirSync(source)
  for (const entry of entries) {
    const sourcePath = join(source, entry)
    const targetPath = join(target, entry)
    const stat = statSync(sourcePath)

    if (stat.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath)
    } else {
      const content = readFileSync(sourcePath)
      writeFileSync(targetPath, content)
    }
  }
}

/**
 * Recursively copy a directory, skipping files that already exist
 * Returns the count of files copied
 */
function copyDirectoryRecursiveSkipExisting(source: string, target: string): number {
  ensureDir(target)

  let copiedCount = 0
  const entries = readdirSync(source)

  for (const entry of entries) {
    const sourcePath = join(source, entry)
    const targetPath = join(target, entry)
    const stat = statSync(sourcePath)

    if (stat.isDirectory()) {
      copiedCount += copyDirectoryRecursiveSkipExisting(sourcePath, targetPath)
    } else if (!existsSync(targetPath)) {
      // Only copy if file doesn't exist (preserves user modifications)
      const content = readFileSync(sourcePath)
      writeFileSync(targetPath, content)
      copiedCount++
    }
  }

  return copiedCount
}

/**
 * Count files in a directory recursively
 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0

  let count = 0
  const entries = readdirSync(dir)

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      count += countFiles(fullPath)
    } else {
      count++
    }
  }

  return count
}

import { readFileSync } from "fs"

/**
 * Copy config files from source directory (development mode)
 * Only copies JSON files, not TypeScript source files
 */
export function copyConfigFromSource(projectRoot: string): { count: number } {
  const sourceConfigDir = join(projectRoot, "src", "config")
  const targetConfigDir = join(projectRoot, ".tauroboros", "config")

  if (!existsSync(sourceConfigDir)) {
    return { count: 0 }
  }

  ensureDir(targetConfigDir)

  // Copy only JSON files that don't exist in target (preserves user modifications)
  const entries = readdirSync(sourceConfigDir)
  let copiedCount = 0

  for (const entry of entries) {
    // Only copy JSON config files, not TypeScript source files
    if (!entry.endsWith(".json")) {
      continue
    }

    const sourcePath = join(sourceConfigDir, entry)
    const targetPath = join(targetConfigDir, entry)

    const stat = statSync(sourcePath)
    if (stat.isFile() && !existsSync(targetPath)) {
      const content = readFileSync(sourcePath)
      writeFileSync(targetPath, content)
      copiedCount++
    }
  }

  return { count: copiedCount }
}

/**
 * Copy docker files from source directory (development mode)
 */
export function copyDockerFromSource(projectRoot: string): { count: number } {
  const sourceDockerDir = join(projectRoot, "docker")
  const targetDockerDir = join(projectRoot, ".tauroboros", "docker")

  if (!existsSync(sourceDockerDir)) {
    return { count: 0 }
  }

  ensureDir(targetDockerDir)

  // Copy directory recursively, but skip existing files
  const copyRecursive = (source: string, target: string): number => {
    ensureDir(target)
    let count = 0

    const entries = readdirSync(source)
    for (const entry of entries) {
      const sourcePath = join(source, entry)
      const targetPath = join(target, entry)

      const stat = statSync(sourcePath)
      if (stat.isDirectory()) {
        count += copyRecursive(sourcePath, targetPath)
      } else if (!existsSync(targetPath)) {
        const content = readFileSync(sourcePath)
        writeFileSync(targetPath, content)
        count++
      }
    }

    return count
  }

  const copiedCount = copyRecursive(sourceDockerDir, targetDockerDir)
  return { count: copiedCount }
}

/**
 * Main extraction function - handles both binary and source modes
 * Call this at server startup
 */
export function extractEmbeddedResources(projectRoot: string): {
  mode: "binary" | "source" | "none"
  extensions: number
  skills: number
  config: number
  docker: number
} {
  if (isRunningFromBinary()) {
    // Running from compiled binary - extract embedded resources
    const extResult = extractEmbeddedExtensions(projectRoot)
    const skillResult = extractEmbeddedSkills(projectRoot)
    const configResult = extractEmbeddedConfig(projectRoot)
    const dockerResult = extractEmbeddedDocker(projectRoot)

    return {
      mode: "binary",
      extensions: extResult.count,
      skills: skillResult.count,
      config: configResult.count,
      docker: dockerResult.count,
    }
  } else {
    // Running from source - copy from source directories
    const result = copyResourcesFromSource(projectRoot)
    const configResult = copyConfigFromSource(projectRoot)
    const dockerResult = copyDockerFromSource(projectRoot)

    // Only return "source" mode if we actually found and copied files
    if (result.extensions > 0 || result.skills > 0 || configResult.count > 0 || dockerResult.count > 0) {
      return {
        mode: "source",
        extensions: result.extensions,
        skills: result.skills,
        config: configResult.count,
        docker: dockerResult.count,
      }
    }

    return {
      mode: "none",
      extensions: 0,
      skills: 0,
      config: 0,
      docker: 0,
    }
  }
}
