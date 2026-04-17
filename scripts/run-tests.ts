#!/usr/bin/env bun
/**
 * Run unit tests (excluding E2E tests)
 *
 * E2E tests use Playwright and are run separately with: bun run test:e2e
 */

import { readdirSync } from "fs"
import { resolve } from "path"

// Get all .test.ts files from tests directory (not in e2e subdirectory)
const files = readdirSync("./tests", { withFileTypes: true })
const unitTestFiles = files
  .filter(f => f.isFile() && f.name.endsWith(".test.ts"))
  .map(f => resolve("./tests", f.name))

if (unitTestFiles.length === 0) {
  console.error("No test files found")
  process.exit(1)
}

console.log(`Running ${unitTestFiles.length} unit test files...`)

// Run bun test with explicit file paths
const proc = Bun.spawn({
  cmd: ["bun", "test", ...unitTestFiles],
  stdio: ["inherit", "inherit", "inherit"],
  cwd: process.cwd(),
})

const exitCode = await proc.exited
process.exit(exitCode)
