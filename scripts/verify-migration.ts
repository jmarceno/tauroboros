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
const MIGRATED_FRONTEND_STORES = [
  `${FRONTEND_DIR}/stores/tasksStore.ts`,
  `${FRONTEND_DIR}/stores/runsStore.ts`,
  `${FRONTEND_DIR}/stores/optionsStore.ts`,
  `${FRONTEND_DIR}/stores/websocketStore.ts`,
].join(" ")

interface CheckResult {
  readonly name: string
  readonly pattern: string
  readonly files: string
  readonly allowed?: number
  readonly minimum?: number
  readonly found: number
  readonly violations: string[]
  readonly passed: boolean
  readonly kind: "max" | "min" | "info"
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
    kind: "max",
  }
}

function measurePattern(
  name: string,
  pattern: string,
  files: string,
  minimum = 0,
): CheckResult {
  const lines = runGrep(pattern, files)
  return {
    name,
    pattern,
    files,
    minimum,
    found: lines.length,
    violations: [],
    passed: lines.length >= minimum,
    kind: minimum > 0 ? "min" : "info",
  }
}

function printResult(result: CheckResult): void {
  const status = result.kind === "info" ? "•" : result.passed ? "✓" : "✗"
  const color = result.kind === "info" ? "\x1b[36m" : result.passed ? "\x1b[32m" : "\x1b[31m"
  const reset = "\x1b[0m"

  console.log(`${color}${status}${reset} ${result.name}`)
  console.log(`  Pattern: ${result.pattern}`)
  console.log(`  Files: ${result.files}`)
  if (result.kind === "max") {
    console.log(`  Found: ${result.found} (allowed: ${result.allowed})`)
  } else if (result.kind === "min") {
    console.log(`  Found: ${result.found} (minimum expected: ${result.minimum})`)
  } else {
    console.log(`  Found: ${result.found}`)
  }

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
  const strict = process.argv.includes("--strict")

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
      0,
      ["kanban-solid/", "node_modules/", "mock-llm-server/"]
    ),

    checkPattern(
      "console.error (backend)",
      "console\\.error",
      SRC_DIR,
      0,
      ["kanban-solid/", "node_modules/", "mock-llm-server/"]
    ),

    checkPattern(
      "console.warn (backend)",
      "console\\.warn",
      SRC_DIR,
      0,
      ["kanban-solid/", "node_modules/", "mock-llm-server/"]
    ),

    // Check 3: Effect.runPromise should only be at boundaries
    checkPattern(
      "Effect.run* outside approved boundaries",
      "Effect\\.run(Promise|Sync|Fork|Callback)",
      SRC_DIR,
      0,
      [
        "index.ts", // Entry point is allowed
        "server/route-interpreter.ts", // Bun request boundary
        "kanban-solid/src/api/client.ts", // Frontend UI boundary helper
      ]
    ),

    // Frontend migration checks
    checkPattern(
      "raw fetch outside frontend API client",
      "\\bfetch\\(",
      FRONTEND_DIR,
      0,
      ["api/client.ts"]
    ),

    checkPattern(
      "frontend Promise signatures in API/stores",
      ": .*Promise<|=> Promise<",
      `${FRONTEND_DIR}/api ${FRONTEND_DIR}/stores`,
      0,
      ["api/client.ts"]
    ),

    checkPattern(
      "frontend async wrappers in migrated stores",
      "const\\s+\\w+\\s*=\\s+async\\s*\\(",
      MIGRATED_FRONTEND_STORES,
      0,
    ),

    checkPattern(
      "Promise.all in migrated task store",
      "Promise\\.all\\(",
      `${FRONTEND_DIR}/stores/tasksStore.ts`,
      0,
    ),

    checkPattern(
      "sleepMs usage in websocket store",
      "sleepMs\\(",
      `${FRONTEND_DIR}/stores/websocketStore.ts`,
      0,
    ),

    // Migration signal metrics
    measurePattern(
      "Context.GenericTag usage",
      "Context\\.GenericTag",
      SRC_DIR,
      1,
    ),

    measurePattern(
      "Layer usage",
      "Layer\\.",
      SRC_DIR,
      1,
    ),

    measurePattern(
      "Schema.TaggedError usage",
      "Schema\\.TaggedError",
      SRC_DIR,
      1,
    ),

    measurePattern(
      "Effect.log usage",
      "Effect\\.log",
      SRC_DIR,
      1,
    ),
  ]

  let passed = 0
  let failed = 0

  for (const check of checks) {
    printResult(check)
    if (check.kind === "info") {
      continue
    }
    if (check.passed) {
      passed++
    } else {
      failed++
    }
  }

  console.log("=============================")
  console.log(`Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    console.log(`\nMigration ${strict ? "failed strict verification" : "still in progress"}`)
    process.exit(strict ? 1 : 0)
  }
}

main()
