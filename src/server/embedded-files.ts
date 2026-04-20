/**
 * Embedded file utilities for compiled binaries
 *
 * This module provides file serving capabilities that work in both:
 * 1. Development mode - reads from filesystem
 * 2. Compiled binary - uses embedded assets from generated-assets.ts
 */

import { existsSync } from "fs"
import * as generatedAssetsModule from "./generated-assets.ts"
import type { GeneratedAssetsModule } from "./generated-assets.ts"
import { dirname, join, basename } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Static file serving paths - SolidJS kanban
export const KANBAN_DIST = join(__dirname, "..", "kanban-solid", "dist")
export const KANBAN_INDEX = join(KANBAN_DIST, "index.html")

// Static import ensures Bun compile captures generated assets at compile time.
const generatedAssets: GeneratedAssetsModule | null =
  typeof generatedAssetsModule.getEmbeddedAsset === "function"
    ? (generatedAssetsModule as unknown as GeneratedAssetsModule)
    : null

/**
 * Extract asset key from full path
 * Converts "/path/to/kanban-solid/dist/assets/file.js" → "/assets/file.js"
 */
function extractAssetKey(path: string): string | null {
  // Look for /assets/ in the path
  const assetsMatch = path.match(/\/assets\/(.+)$/)
  if (assetsMatch) {
    return `/assets/${assetsMatch[1]}`
  }

  // Check for index.html
  if (path.endsWith("index.html")) {
    return "/index.html"
  }

  return null
}

/**
 * Read a file using either embedded assets or filesystem
 */
export async function readEmbeddedFile(path: string): Promise<Uint8Array> {
  // First try embedded assets if available
  if (generatedAssets) {
    const key = extractAssetKey(path)
    if (key) {
      const asset = generatedAssets.getEmbeddedAsset(key)
      if (asset) {
        if (asset.isText) {
          return new TextEncoder().encode(asset.data)
        } else {
          // Decode base64
          const binary = atob(asset.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          return bytes
        }
      }
    }
  }

  // Fallback to filesystem using Bun.file()
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`File not found: ${path}`)
  }
  return await file.bytes()
}

/**
 * Read a file as text using either embedded assets or filesystem
 */
export async function readEmbeddedText(path: string): Promise<string> {
  // First try embedded assets if available
  if (generatedAssets) {
    const key = extractAssetKey(path)
    if (key) {
      const asset = generatedAssets.getEmbeddedAsset(key)
      if (asset?.isText) {
        return asset.data
      }
    }
  }

  // Fallback to filesystem using Bun.file()
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`File not found: ${path}`)
  }
  return await file.text()
}

/**
 * Check if an embedded file exists (in memory or filesystem)
 */
export async function embeddedFileExists(path: string): Promise<boolean> {
  // First check embedded assets
  if (generatedAssets) {
    const key = extractAssetKey(path)
    if (key) {
      const asset = generatedAssets.getEmbeddedAsset(key)
      if (asset) return true
    }
  }

  // Fallback to filesystem
  const file = Bun.file(path)
  return await file.exists()
}

/**
 * Get content type based on file extension
 */
export function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase()
  const types: Record<string, string> = {
    html: "text/html",
    js: "application/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    woff2: "font/woff2",
    woff: "font/woff",
    ttf: "font/ttf",
    json: "application/json",
    ico: "image/x-icon",
  }
  return types[ext || ""] || "application/octet-stream"
}

/**
 * Get index.html content
 */
export async function getIndexHtml(): Promise<string | undefined> {
  // First try embedded assets
  if (generatedAssets) {
    return generatedAssets.getIndexHtml()
  }

  // Fallback to filesystem
  try {
    return await Bun.file(KANBAN_INDEX).text()
  } catch {
    return undefined
  }
}

/**
 * Check if running from a compiled binary (with embedded assets)
 */
export function isCompiledBinary(): boolean {
  return generatedAssets !== null
}

/**
 * Get all config assets for extraction
 */
export function getAllConfigAssets(): Array<{ path: string; asset: { contentType: string; isText: boolean; data: string } }> {
  if (!generatedAssets) {
    return []
  }
  return generatedAssets.getAllConfigAssets()
}

/**
 * Get all docker assets for extraction
 */
export function getAllDockerAssets(): Array<{ path: string; asset: { contentType: string; isText: boolean; data: string } }> {
  if (!generatedAssets) {
    return []
  }
  return generatedAssets.getAllDockerAssets()
}
