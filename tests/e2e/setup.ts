/**
 * Global Test Setup for E2E Tests
 *
 * This file is loaded via Bun's --preload option before tests run.
 * It ensures the container image is built and ready for E2E tests.
 *
 * Usage:
 *   bun test --preload ./tests/e2e/setup.ts tests/e2e/
 *
 * Or in package.json scripts:
 *   "test:e2e": "bun test --preload ./tests/e2e/setup.ts tests/e2e/"
 */

import { ContainerImageManager } from "../../src/runtime/container-image-manager.ts"

let setupComplete = false
let setupPromise: Promise<void> | null = null

/**
 * Ensure the container image is ready for E2E tests.
 * This function is idempotent - it only runs once even if called multiple times.
 */
export async function ensureContainerImage(): Promise<void> {
  // Return immediately if already complete
  if (setupComplete) {
    return
  }

  // Return existing promise if setup is in progress
  if (setupPromise) {
    return setupPromise
  }

  // Create new setup promise
  setupPromise = runSetup()
  return setupPromise
}

async function runSetup(): Promise<void> {
  console.log("\n🔧 E2E Test Setup: Checking container image...")

  const imageManager = new ContainerImageManager({
    imageName: "pi-agent:alpine",
    imageSource: "dockerfile",
    dockerfilePath: "docker/pi-agent/Dockerfile",
    cacheDir: ".pi/easy-workflow",
    onStatusChange: (event) => {
      if (event.status === "preparing") {
        console.log(`   ⏳ ${event.message}`)
      } else if (event.status === "ready") {
        console.log(`   ✅ ${event.message}`)
      } else if (event.status === "error") {
        console.error(`   ❌ ${event.message}${event.errorMessage ? `: ${event.errorMessage}` : ""}`)
      }
    },
  })

  try {
    await imageManager.prepare()
    setupComplete = true
    console.log("🔧 E2E Test Setup: Complete\n")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("🔧 E2E Test Setup: Failed -", message)
    // Don't mark as complete on error, allow retry
    setupPromise = null
    throw error
  }
}

// Auto-run setup when this module is loaded directly (via --preload)
// Check if we're being run as a preload script
const isPreload = import.meta.url.includes("setup.ts")

if (isPreload) {
  // Add a small delay to allow test framework to initialize
  // then run the setup
  await new Promise((resolve) => setTimeout(resolve, 100))

  try {
    await ensureContainerImage()
  } catch (error) {
    // Log error but don't exit - let tests decide what to do
    console.error("\n⚠️  Container image setup failed. E2E tests may fail.")
    console.error("   You can manually build with:")
    console.error("   podman build -t pi-agent:alpine -f docker/pi-agent/Dockerfile .\n")
  }
}
