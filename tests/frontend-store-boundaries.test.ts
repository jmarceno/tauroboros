import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, "..")

const readStore = (relativePath: string) =>
  readFileSync(resolve(ROOT, relativePath), "utf-8")

describe("frontend store migration boundaries", () => {
  it("keeps migrated stores free of async wrapper function declarations", () => {
    const files = [
      "src/kanban-solid/src/stores/tasksStore.ts",
      "src/kanban-solid/src/stores/runsStore.ts",
      "src/kanban-solid/src/stores/optionsStore.ts",
      "src/kanban-solid/src/stores/sseStore.ts",
    ]

    for (const file of files) {
      const content = readStore(file)
      expect(content).not.toMatch(/const\s+\w+\s*=\s+async\s*\(/)
    }
  })

  it("keeps SSE reconnection Effect-based (no sleepMs Promise loop)", () => {
    const content = readStore("src/kanban-solid/src/stores/sseStore.ts")

    expect(content).not.toContain("sleepMs(")
    expect(content).toContain("Effect.sleep")
  })

  it("keeps batch task updates Effect-based (no Promise.all orchestration)", () => {
    const content = readStore("src/kanban-solid/src/stores/tasksStore.ts")

    expect(content).not.toContain("Promise.all(")
    expect(content).toContain("Effect.forEach")
  })
})
