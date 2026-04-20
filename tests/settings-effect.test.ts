import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Effect } from "effect"
import { loadInfrastructureSettings } from "../src/config/settings.ts"
import { runEffectOrThrow } from "./helpers/effect.ts"

describe("settings effect/schema pipeline", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it("keeps defaults when decode fails and reports warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "tauroboros-settings-"))
    dirs.push(root)
    const settingsDir = join(root, ".tauroboros")
    mkdirSync(settingsDir, { recursive: true })

    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        workflow: {
          server: {
            port: "not-a-number",
          },
          container: {
            image: "custom/image:latest",
          },
        },
        unknownRoot: true,
      }),
      "utf-8",
    )

    const result = loadInfrastructureSettings(root)

    expect(result.settings.workflow.server.port).toBe(0)
    expect(result.settings.workflow.container.image).toBe("custom/image:latest")
    expect(result.unknownFields).toContain("unknownRoot")
    expect(result.warnings.some((warning) => warning.includes("workflow.server"))).toBe(true)
  })

  it("supports Effect-based test execution helper", async () => {
    const value = await runEffectOrThrow(Effect.succeed(42))
    expect(value).toBe(42)
  })
})
