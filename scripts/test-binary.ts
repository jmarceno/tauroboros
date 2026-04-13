#!/usr/bin/env bun
/**
 * Test script for validating the compiled binary
 * 
 * This script tests:
 * 1. Binary can start successfully
 * 2. Health endpoint responds correctly
 * 3. Static assets are served correctly (index.html, JS, CSS)
 * 4. API endpoints work
 * 5. WebSocket endpoint is available
 * 6. Different ports work (via SERVER_PORT env var)
 */

import { $ } from "bun"
import { spawn, sleep } from "bun"
import { existsSync } from "fs"
import { resolve } from "path"

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const BINARY_PATH = resolve(PROJECT_ROOT, "pi-easy-workflow")

interface TestResult {
  name: string
  passed: boolean
  error?: string
  duration?: number
}

const results: TestResult[] = []

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  const start = Date.now()
  try {
    await testFn()
    results.push({ name, passed: true, duration: Date.now() - start })
    console.log(`  ✓ ${name}`)
  } catch (error) {
    results.push({ 
      name, 
      passed: false, 
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start
    })
    console.log(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function testBinaryExists(): Promise<void> {
  if (!existsSync(BINARY_PATH)) {
    throw new Error(`Binary not found at ${BINARY_PATH}`)
  }
}

async function testBinaryExecutable(): Promise<void> {
  const result = await $`test -x ${BINARY_PATH}`.quiet()
  if (result.exitCode !== 0) {
    throw new Error("Binary is not executable")
  }
}

async function testServerStartAndHealth(): Promise<void> {
  // Start server
  const proc = spawn([BINARY_PATH], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })

  // Wait for server to start
  await sleep(2000)

  try {
    // Test health endpoint
    const response = await fetch("http://localhost:3789/healthz")
    if (!response.ok) {
      throw new Error(`Health check failed with status ${response.status}`)
    }
    const data = await response.json()
    if (!data.ok) {
      throw new Error("Health check returned ok: false")
    }
  } finally {
    proc.kill()
    await sleep(500)
  }
}

async function testStaticAssets(): Promise<void> {
  const proc = spawn([BINARY_PATH], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })

  await sleep(2000)

  try {
    // Test index.html
    const indexResponse = await fetch("http://localhost:3789/")
    if (!indexResponse.ok) {
      throw new Error(`index.html failed with status ${indexResponse.status}`)
    }
    const indexText = await indexResponse.text()
    if (!indexText.includes("Easy Workflow")) {
      throw new Error("index.html doesn't contain expected content")
    }

    // Extract asset filenames from index.html
    const jsMatch = indexText.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)
    const cssMatch = indexText.match(/href="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/)

    const jsAsset = jsMatch ? jsMatch[1] : null
    const cssAsset = cssMatch ? cssMatch[1] : null

    // Test JS asset - dynamically discovered from index.html
    if (jsAsset) {
      const jsResponse = await fetch(`http://localhost:3789/assets/${jsAsset}`)
      if (!jsResponse.ok) {
        throw new Error(`JS asset (${jsAsset}) failed with status ${jsResponse.status}`)
      }
      const jsContent = await jsResponse.text()
      if (jsContent.length < 1000) {
        throw new Error("JS asset content too small or empty")
      }
    } else {
      // Fallback: check that at least one index-*.js asset exists
      const fallbackResponse = await fetch("http://localhost:3789/assets/index-BV76ujiK.js")
      if (!fallbackResponse.ok) {
        throw new Error("JS asset failed with status " + fallbackResponse.status)
      }
    }

    // Test CSS asset - dynamically discovered from index.html
    if (cssAsset) {
      const cssResponse = await fetch(`http://localhost:3789/assets/${cssAsset}`)
      if (!cssResponse.ok) {
        throw new Error(`CSS asset (${cssAsset}) failed with status ${cssResponse.status}`)
      }
      const cssContent = await cssResponse.text()
      if (cssContent.length < 1000) {
        throw new Error("CSS asset content too small or empty")
      }
    } else {
      // Fallback: check that at least one index-*.css asset exists
      const fallbackResponse = await fetch("http://localhost:3789/assets/index-C2uA8Yb7.css")
      if (!fallbackResponse.ok) {
        throw new Error("CSS asset failed with status " + fallbackResponse.status)
      }
    }
  } finally {
    proc.kill()
    await sleep(500)
  }
}

async function testApiEndpoints(): Promise<void> {
  const proc = spawn([BINARY_PATH], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })

  await sleep(2000)

  try {
    // Test tasks endpoint
    const tasksResponse = await fetch("http://localhost:3789/api/tasks")
    if (!tasksResponse.ok) {
      throw new Error(`Tasks API failed with status ${tasksResponse.status}`)
    }
    const tasks = await tasksResponse.json()
    if (!Array.isArray(tasks)) {
      throw new Error("Tasks API didn't return an array")
    }

    // Test options endpoint
    const optionsResponse = await fetch("http://localhost:3789/api/options")
    if (!optionsResponse.ok) {
      throw new Error(`Options API failed with status ${optionsResponse.status}`)
    }
    const options = await optionsResponse.json()
    if (typeof options !== "object") {
      throw new Error("Options API didn't return an object")
    }

    // Test branches endpoint
    const branchesResponse = await fetch("http://localhost:3789/api/branches")
    if (!branchesResponse.ok) {
      throw new Error(`Branches API failed with status ${branchesResponse.status}`)
    }
    const branches = await branchesResponse.json()
    if (!Array.isArray(branches.branches)) {
      throw new Error("Branches API didn't return branches array")
    }
  } finally {
    proc.kill()
    await sleep(500)
  }
}

async function testCustomPort(): Promise<void> {
  // Start server on custom port with explicit SERVER_PORT
  const proc = spawn([BINARY_PATH], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SERVER_PORT: "3791" }
  })

  // Give the server more time to start
  await sleep(3000)

  try {
    // Test health on custom port with retries
    let retries = 5
    let lastError: Error | null = null
    
    while (retries > 0) {
      try {
        const response = await fetch("http://localhost:3791/healthz", { 
          signal: AbortSignal.timeout(5000) 
        })
        if (response.ok) {
          return // Success!
        }
        lastError = new Error(`Health check on custom port failed with status ${response.status}`)
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e))
      }
      
      retries--
      if (retries > 0) {
        await sleep(1000)
      }
    }
    
    throw lastError || new Error("Failed to connect to custom port after retries")
  } finally {
    proc.kill()
    await sleep(500)
  }
}

async function main(): Promise<void> {
  console.log("🔬 Pi Easy Workflow Binary Validation Tests")
  console.log("============================================\n")

  await runTest("Binary file exists", testBinaryExists)
  await runTest("Binary is executable", testBinaryExecutable)
  await runTest("Server starts and health endpoint works", testServerStartAndHealth)
  await runTest("Static assets are served correctly", testStaticAssets)
  await runTest("API endpoints work", testApiEndpoints)
  await runTest("Custom port (SERVER_PORT) works", testCustomPort)

  // Summary
  console.log("\n" + "=".repeat(50))
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const total = results.length

  console.log(`Results: ${passed}/${total} tests passed`)
  
  if (failed > 0) {
    console.log("\nFailed tests:")
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`)
    })
  }

  const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0)
  console.log(`\nTotal duration: ${(totalDuration / 1000).toFixed(1)}s`)

  if (failed > 0) {
    console.log("\n❌ Validation failed")
    process.exit(1)
  } else {
    console.log("\n✅ All tests passed! Binary is ready for distribution.")
  }
}

// Run if called directly
if (import.meta.main) {
  void main()
}

export { runTest, testBinaryExists, testServerStartAndHealth, testStaticAssets }
