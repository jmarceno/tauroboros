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
 * Always overwrites existing files
 */
export function extractEmbeddedExtensions(projectRoot: string): { count: number; paths: string[] } {
  if (!generatedAssets) {
    return { count: 0, paths: [] }
  }
  
  const extensionsDir = join(projectRoot, ".pi", "extensions")
  ensureDir(extensionsDir)
  
  // Clear existing extensions (always extract fresh)
  clearDirectory(extensionsDir)
  
  const extensionAssets = generatedAssets.getAllExtensionAssets()
  const extractedPaths: string[] = []
  
  for (const { path, asset } of extensionAssets) {
    const targetPath = join(extensionsDir, path)
    writeAssetToFile(targetPath, asset)
    extractedPaths.push(targetPath)
  }
  
  return { count: extensionAssets.length, paths: extractedPaths }
}

/**
 * Extract all embedded skills to .pi/skills/
 * Always overwrites existing files
 */
export function extractEmbeddedSkills(projectRoot: string): { count: number; paths: string[] } {
  if (!generatedAssets) {
    return { count: 0, paths: [] }
  }
  
  const skillsDir = join(projectRoot, ".pi", "skills")
  ensureDir(skillsDir)
  
  // Clear existing skills (always extract fresh)
  clearDirectory(skillsDir)
  
  const skillAssets = generatedAssets.getAllSkillAssets()
  const extractedPaths: string[] = []
  
  for (const { path, asset } of skillAssets) {
    const targetPath = join(skillsDir, path)
    writeAssetToFile(targetPath, asset)
    extractedPaths.push(targetPath)
  }
  
  return { count: skillAssets.length, paths: extractedPaths }
}

/**
 * Copy resources from source directories (development mode)
 * Used when running from source code instead of compiled binary
 */
export function copyResourcesFromSource(projectRoot: string): { extensions: number; skills: number } {
  // In development mode, extensions and skills are at the project root level
  const sourceRoot = projectRoot
  
  // Copy extensions
  const sourceExtensionsDir = join(sourceRoot, "extensions")
  const targetExtensionsDir = join(projectRoot, ".pi", "extensions")
  let extensionCount = 0
  
  if (existsSync(sourceExtensionsDir)) {
    ensureDir(targetExtensionsDir)
    clearDirectory(targetExtensionsDir)
    copyDirectoryRecursive(sourceExtensionsDir, targetExtensionsDir)
    extensionCount = countFiles(targetExtensionsDir)
  }
  
  // Copy skills
  const sourceSkillsDir = join(sourceRoot, "skills")
  const targetSkillsDir = join(projectRoot, ".pi", "skills")
  let skillCount = 0
  
  if (existsSync(sourceSkillsDir)) {
    ensureDir(targetSkillsDir)
    clearDirectory(targetSkillsDir)
    copyDirectoryRecursive(sourceSkillsDir, targetSkillsDir)
    skillCount = countFiles(targetSkillsDir)
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
 * Main extraction function - handles both binary and source modes
 * Call this at server startup
 */
export function extractEmbeddedResources(projectRoot: string): {
  mode: "binary" | "source" | "none"
  extensions: number
  skills: number
} {
  if (isRunningFromBinary()) {
    // Running from compiled binary - extract embedded resources
    const extResult = extractEmbeddedExtensions(projectRoot)
    const skillResult = extractEmbeddedSkills(projectRoot)
    
    return {
      mode: "binary",
      extensions: extResult.count,
      skills: skillResult.count,
    }
  } else {
    // Running from source - copy from source directories
    const result = copyResourcesFromSource(projectRoot)
    
    // Only return "source" mode if we actually found and copied files
    if (result.extensions > 0 || result.skills > 0) {
      return {
        mode: "source",
        extensions: result.extensions,
        skills: result.skills,
      }
    }
    
    return {
      mode: "none",
      extensions: 0,
      skills: 0,
    }
  }
}
