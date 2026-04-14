#!/usr/bin/env bun
/**
 * Verify Podman container setup
 * Checks Podman and image availability
 */

import { PiContainerManager } from "../src/runtime/container-manager.ts"

console.log("=========================================")
console.log("TaurOboros - Container Setup Verification")
console.log("=========================================\n")

const manager = new PiContainerManager()

async function verify() {
  console.log("Checking container runtime setup...\n")

  const status = await manager.validateSetup()

  // Podman check
  if (status.podman) {
    console.log("✓ Podman is available")
  } else {
    console.log("✗ Podman is not available")
  }

  // Image check
  if (status.image) {
    console.log("✓ pi-agent:alpine image is available")
  } else {
    console.log("✗ pi-agent:alpine image not found")
    console.log("  Run: podman build -t pi-agent:alpine -f docker/pi-agent/Dockerfile .")
  }

  // Errors
  if (status.errors.length > 0) {
    console.log("\nIssues found:")
    for (const error of status.errors) {
      console.log(`  - ${error}`)
    }
  }

  // Summary
  console.log("\n=========================================")
  if (status.podman && status.image) {
    console.log("✓ All checks passed! Container runtime is ready.")
    process.exit(0)
  } else {
    console.log("✗ Some checks failed. Please fix the issues above.")
    console.log("\nTo set up the environment, run:")
    console.log("  ./scripts/setup-e2e-tests.sh")
    process.exit(1)
  }
}

verify().catch((error) => {
  console.error("Verification failed:", error)
  process.exit(1)
})
