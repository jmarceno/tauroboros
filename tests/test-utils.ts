import { Effect } from "effect"
import type { InfrastructureSettings } from "../src/config/settings.ts"
import { BASE_IMAGES } from "../src/config/base-images.ts"
import { createPiServerEffect, type CreateServerOptions } from "../src/server.ts"

export function createTestSettings(): InfrastructureSettings {
  return {
    skills: {
      localPath: "./skills",
      autoLoad: true,
      allowGlobal: false,
    },
    project: {
      name: "tauroboros-test",
      type: "workflow",
    },
    workflow: {
      server: {
        port: 0,
        dbPath: ".tauroboros/tasks.db",
      },
      runtime: {
        mode: "native",
        piBin: "mock-pi",
        piArgs: "",
      },
      container: {
        enabled: false,
        image: BASE_IMAGES.piAgent,
        memoryMb: 512,
        cpuCount: 1,
        portRangeStart: 30000,
        portRangeEnd: 40000,
      },
    },
  }
}

export function createPiServer(options: CreateServerOptions = {}) {
  return Effect.runSync(createPiServerEffect(options))
}