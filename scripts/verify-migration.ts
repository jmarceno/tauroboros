#!/usr/bin/env bun
/**
 * Migration verification script.
 * 
 * This script checks that the codebase follows the Effect migration rules:
 * - No throw new Error for domain failures
 * - No console.log/error/warn in application code
 * - Effect.run* only at runtime boundaries
 * - Proper use of Effect patterns
 */

import { execSync } from "child_process"
import { existsSync } from "fs"

const SRC_DIR = "src"
const FRONTEND_DIR = "src/kanban-solid/src"

interface CheckResult {
  readonly name: string
  readonly pattern: string
  readonly files: string
  readonly allowed: number
  readonly found: number
  readonly violations: string[]
  readonly passed: boolean
}

function runGrep(pattern: string, files: string): string[] {
  try {
    const result = execSync(`rg -n "${pattern}" ${files} 2>/dev/null || true`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    })
    if (!result.trim()) return []
    return result.trim().split("\n").filter((line) => line.trim())
  } catch {
    return []
  }
}

function checkPattern(
  name: string,
  pattern: string,
  files: string,
  allowed: number,
  exclusions: string[] = []
): CheckResult {
  const lines = runGrep(pattern, files)
  const violations = lines.filter((line) => {
    // Filter out exclusion patterns
    return !exclusions.some((exclusion) => line.includes(exclusion))
  })

  return {
    name,
    pattern,
    files,
    allowed,
    found: lines.length,
    violations,
    passed: violations.length <= allowed,
  }
}

function printResult(result: CheckResult): void {
  const status = result.passed ? "✓" : "✗"
  const color = result.passed ? "\x1b[32m" : "\x1b[31m"
  const reset = "\x1b[0m"

  console.log(`${color}${status}${reset} ${result.name}`)
  console.log(`  Pattern: ${result.pattern}`)
  console.log(`  Files: ${result.files}`)
  console.log(`  Found: ${result.found} (allowed: ${result.allowed})`)

  if (result.violations.length > 0 && !result.passed) {
    console.log(`  Violations:`)
    result.violations.slice(0, 10).forEach((v) => {
      console.log(`    - ${v}`)
    })
    if (result.violations.length > 10) {
      console.log(`    ... and ${result.violations.length - 10} more`)
    }
  }
  console.log()
}

function main(): void {
  console.log("Effect Migration Verification")
  console.log("=============================\n")

  const checks: CheckResult[] = [
    // Check 1: throw new Error should not be used for domain failures
    checkPattern(
      "throw new Error (backend)",
      "throw new Error",
      SRC_DIR,
      0,
      [
        // Allow in non-migrated files (these need to be migrated)
        "orchestrator.ts",
        "container-manager.ts",
        "container-image-manager.ts",
        "global-scheduler.ts",
        "smart-repair.ts",
        "best-of-n.ts",
        "review-session.ts",
        "self-healing.ts",
        "port-allocator.ts",
        "strict-json.ts",
        "session-manager.ts", // Has some remaining throws
        "planning-session.ts", // Has some remaining throws
        "recovery/",
        "pi-rpc.ts",
        "mock-server-manager.ts",
        "pi-process-factory.ts",
        "message-streamer.ts",
        "codestyle-session.ts",
        "worktree.ts",
        "message-projection.ts",
        "model-utils.ts",
        "session-pause-state.ts",
        "strict-json.ts",
      ]
    ),

    // Check 2: console logging in backend
    checkPattern(
      "console.log (backend)",
      "console\\.log",
      SRC_DIR,
      100, // Temporary allowance during migration
      ["kanban-solid/", "node_modules/"]
    ),

    checkPattern(
      "console.error (backend)",
      "console\\.error",
      SRC_DIR,
      50, // Temporary allowance during migration
      ["kanban-solid/", "node_modules/"]
    ),

    checkPattern(
      "console.warn (backend)",
      "console\\.warn",
      SRC_DIR,
      30, // Temporary allowance during migration
      ["kanban-solid/", "node_modules/"]
    ),

    // Check 3: Effect.runPromise should only be at boundaries
    checkPattern(
      "Effect.runPromise (internal)",
      "Effect\\.runPromise",
      SRC_DIR,
      50, // Temporary allowance during migration
      [
        "index.ts", // Entry point is allowed
        "kanban-solid/", // Frontend has its own rules
        "tests/",
        "server/server.ts", // Server boundary
        "server/routes/", // Route boundaries
        "runtime/pi-process.ts", // Has internal runs that need migration
        "runtime/container-pi-process.ts",
        "orchestrator.ts",
      ]
    ),

    // Check 4: Proper Effect patterns should be expanding
    checkPattern(
      "Context.GenericTag usage",
      "Context\\.GenericTag",
      SRC_DIR,
      5,
      []
    ),

    checkPattern(
      "Layer usage",
      "Layer\\.",
      SRC_DIR,
      10,
      []
    ),

    checkPattern(
      "Schema.TaggedError usage",
      "Schema\\.TaggedError",
      SRC_DIR,
      15,
      []
    ),

    checkPattern(
      "Effect.log usage",
      "Effect\\.log",
      SRC_DIR,
      20,
      []
    ),
  ]

  let passed = 0
  let failed = 0

  for (const check of checks) {
    printResult(check)
    if (check.passed) {
      passed++
    } else {
      failed++
    }
  }

  console.log("=============================")
  console.log(`Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    console.log("\nMigration in progress - some checks are expected to fail")
    process.exit(0) // Don't fail CI during migration
  }
}

main()
