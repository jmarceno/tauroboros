import { resolve } from "path"
import { ensureInfrastructureSettings } from "./config/settings.ts"
import { createPiServer, findProjectRoot } from "./server.ts"

export async function main(): Promise<void> {
  const projectRoot = findProjectRoot()
  
  // Ensure settings.json exists (creates with defaults if missing)
  // NO FALLBACKS - server ONLY reads from settings.json
  const { settings, warnings } = ensureInfrastructureSettings(projectRoot)

  // Report any warnings about settings
  for (const warning of warnings) {
    console.warn(`[pi-easy-workflow] ${warning}`)
  }

  // Resolve dbPath relative to project root
  const dbPath = resolve(projectRoot, settings.workflow.server.dbPath)

  const { db, server } = createPiServer({
    port: settings.workflow.server.port,
    dbPath,
  })

  const port = await server.start(settings.workflow.server.port)
  console.log(`[pi-easy-workflow] server started on http://0.0.0.0:${port}`)

  const shutdown = () => {
    try {
      server.stop()
    } finally {
      db.close()
    }
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

void main()
