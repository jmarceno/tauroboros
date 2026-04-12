#!/usr/bin/env bun
/**
 * Compile script for Pi Easy Workflow
 * Creates a single executable binary using Bun's compile feature
 * 
 * This script:
 * 1. Builds the kanban-vue frontend if needed
 * 2. Generates embedded-assets.ts with all static files inlined
 * 3. Compiles the application into a single binary
 */

import { $ } from "bun"
import { existsSync } from "fs"
import { resolve, join } from "path"

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const KANBAN_VUE_DIR = join(PROJECT_ROOT, "src", "kanban-vue")
const DIST_DIR = join(KANBAN_VUE_DIR, "dist")
const GENERATED_ASSETS_FILE = join(PROJECT_ROOT, "src", "server", "generated-assets.ts")
const BIN_OUTPUT = join(PROJECT_ROOT, "pi-easy-workflow")

console.log("🔨 Pi Easy Workflow Compile Script")
console.log("===================================\n")

// Check if kanban-vue/dist exists and has content
function checkKanbanBuild(): boolean {
  if (!existsSync(DIST_DIR)) {
    return false
  }
  const indexHtml = join(DIST_DIR, "index.html")
  const assetsDir = join(DIST_DIR, "assets")
  return existsSync(indexHtml) && existsSync(assetsDir)
}

// Build kanban-vue if needed
async function buildKanban(): Promise<void> {
  console.log("📦 Building kanban-vue frontend...")
  
  const packageJsonPath = join(KANBAN_VUE_DIR, "package.json")
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${KANBAN_VUE_DIR}`)
  }

  // Install dependencies
  console.log("  → Installing npm dependencies...")
  const installResult = await $`cd ${KANBAN_VUE_DIR} && npm install`.quiet()
  if (installResult.exitCode !== 0) {
    throw new Error(`npm install failed: ${installResult.stderr}`)
  }

  // Build the frontend
  console.log("  → Building with Vite...")
  const buildResult = await $`cd ${KANBAN_VUE_DIR} && npm run build`.quiet()
  if (buildResult.exitCode !== 0) {
    throw new Error(`npm run build failed: ${buildResult.stderr}`)
  }

  console.log("  ✓ Kanban build complete\n")
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
    join(PROJECT_ROOT, "src", "index.ts")
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

// Clean up generated file
async function cleanup(): Promise<void> {
  try {
    await Bun.write(GENERATED_ASSETS_FILE, "// Placeholder - run compile script to regenerate\n")
    console.log("🧹 Cleaned up generated-assets.ts (set to placeholder)\n")
  } catch (err) {
    // Ignore cleanup errors
  }
}

// Main execution
async function main(): Promise<void> {
  const startTime = Date.now()
  
  try {
    // Step 1: Check/build kanban-vue
    if (!checkKanbanBuild()) {
      console.log("⚠️  Kanban dist not found or incomplete")
      await buildKanban()
    } else {
      console.log("✓ Kanban build found\n")
    }

    // Step 2: Generate embedded assets
    await generateEmbeddedAssets()

    // Step 3: Compile binary
    await compileBinary()

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`🎉 Success! Binary compiled in ${duration}s`)
    console.log(`\nUsage:`)
    console.log(`  ./pi-easy-workflow                    # Run with default settings`)
    console.log(`  ./pi-easy-workflow --help             # Show help`)
    console.log(`  SERVER_PORT=3790 ./pi-easy-workflow   # Run on specific port`)
    console.log(`\nThe binary includes all frontend assets and can be run standalone.`)
    console.log(`Runtime data (database, settings) will be stored in ./.pi/\n`)

    // Optional: Clean up generated file
    await cleanup()

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

export { buildKanban, compileBinary, checkKanbanBuild, generateEmbeddedAssets }
