#!/usr/bin/env bun
/**
 * Compile script for TaurOboros
 * Creates a single executable binary using Bun's compile feature
 *
 * This script:
 * 1. Builds the kanban-solid frontend if needed
 * 2. Generates embedded-assets.ts with all static files inlined
 * 3. Compiles the application into a single binary
 */

import { $ } from "bun"
import { existsSync, rmSync } from "fs"
import { resolve, join } from "path"

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const KANBAN_SOLID_DIR = join(PROJECT_ROOT, "src", "frontend")
const DIST_DIR = join(KANBAN_SOLID_DIR, "dist")
const BIN_OUTPUT = join(PROJECT_ROOT, "tauroboros")

console.log("🔨 TaurOboros Compile Script")
console.log("===================================\n")

// Build kanban-solid frontend
async function buildKanban(): Promise<void> {
  console.log("📦 Building kanban-solid frontend...")

  const packageJsonPath = join(KANBAN_SOLID_DIR, "package.json")
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${KANBAN_SOLID_DIR}`)
  }

  // Install dependencies
  console.log("  → Installing npm dependencies...")
  const installResult = await $`cd ${KANBAN_SOLID_DIR} && npm ci`.quiet()
  if (installResult.exitCode !== 0) {
    throw new Error(`npm ci failed: ${installResult.stderr}`)
  }

  // Remove previous build output so every compile run regenerates fresh assets
  rmSync(DIST_DIR, { recursive: true, force: true })

  // Build the frontend
  console.log("  → Building with Vite...")
  const buildResult = await $`cd ${KANBAN_SOLID_DIR} && npm run build`.quiet()
  if (buildResult.exitCode !== 0) {
    throw new Error(`npm run build failed: ${buildResult.stderr}`)
  }

  console.log("  ✓ Kanban build complete\n")
}

// Generate version module
async function generateVersion(): Promise<void> {
  console.log("🏷️  Generating version module...")
  const result = await $`bun run ${join(PROJECT_ROOT, "scripts", "generate-version.ts")}`.quiet()
  if (result.exitCode !== 0) {
    throw new Error(`Failed to generate version: ${result.stderr}`)
  }
  console.log("")
}

// Generate embedded assets module
async function generateEmbeddedAssets(): Promise<void> {
  console.log("🔧 Generating embedded assets module...")
  const result = await $`bun run ${join(PROJECT_ROOT, "scripts", "generate-embedded-assets.ts")}`.quiet()
  if (result.exitCode !== 0) {
    throw new Error(`Failed to generate embedded assets: ${result.stderr}`)
  }
  console.log("")
}

// Compile the binary
async function compileBinary(): Promise<void> {
  console.log("🔨 Compiling binary with Bun...")

  const compileCmd = [
    "build",
    "--compile",
    "--target=bun",
    "--outfile", BIN_OUTPUT,
    join(PROJECT_ROOT, "src", "backend-ts", "index.ts")
  ]

  console.log("  → Running bun build --compile...")

  const result = await $`bun ${compileCmd}`.quiet()

  if (result.exitCode !== 0) {
    throw new Error(`Compilation failed: ${result.stderr}`)
  }

  // Make executable
  await $`chmod +x ${BIN_OUTPUT}`.quiet()

  // Get file size
  const { statSync: stat } = require("fs")
  const stats = stat(BIN_OUTPUT)
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2)

  console.log(`  ✓ Binary created: ${BIN_OUTPUT}`)
  console.log(`  📊 Size: ${sizeMB} MB\n`)
}

// Main execution
async function main(): Promise<void> {
  const startTime = Date.now()

  try {
    // Step 1: Always rebuild kanban-solid to ensure fresh assets
    console.log("📦 Building kanban-solid frontend...")
    await buildKanban()

    // Step 2: Generate version info
    await generateVersion()

    // Step 3: Generate embedded assets
    await generateEmbeddedAssets()

    // Step 4: Compile binary
    await compileBinary()

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`🎉 Success! Binary compiled in ${duration}s`)
    console.log(`\nUsage:`)
    console.log(`  ./tauroboros                    # Run with default settings`)
    console.log(`  ./tauroboros --help             # Show help`)
    console.log(`  SERVER_PORT=3790 ./tauroboros   # Run on specific port`)
    console.log(`\nThe binary includes all frontend assets and can be run standalone.`)
    console.log(`Runtime data (database, settings) will be stored in ./.tauroboros/\n`)

  } catch (error) {
    console.error("\n❌ Compilation failed:")
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  void main()
}

export { buildKanban, compileBinary, generateEmbeddedAssets, generateVersion }
