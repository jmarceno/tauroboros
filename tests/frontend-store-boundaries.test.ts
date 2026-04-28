import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

const readStore = (relativePath: string) =>
  readFileSync(resolve(ROOT, relativePath), "utf-8")

describe("frontend store migration boundaries", () => {
  it("keeps migrated stores free of async wrapper function declarations", () => {
    const files = [
      "src/frontend/src/stores/tasksStore.ts",
      "src/frontend/src/stores/runsStore.ts",
      "src/frontend/src/stores/optionsStore.ts",
      "src/frontend/src/stores/sseStore.ts",
    ]

    for (const file of files) {
      const content = readStore(file)
      expect(content).not.toMatch(/const\s+\w+\s*=\s+async\s*\(/)
    }
  })

  it("keeps SSE reconnection Effect-based (no sleepMs Promise loop)", () => {
    const content = readStore("src/frontend/src/stores/sseStore.ts")

    expect(content).not.toContain("sleepMs(")
    expect(content).toContain("Effect.sleep")
  })

  it("keeps batch task updates Effect-based (no Promise.all orchestration)", () => {
    const content = readStore("src/frontend/src/stores/tasksStore.ts")

    expect(content).not.toContain("Promise.all(")
    expect(content).toContain("Effect.forEach")
  })
})
