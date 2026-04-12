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

  // Support SERVER_PORT environment variable override
  const envPort = process.env.SERVER_PORT
  const port = envPort ? parseInt(envPort, 10) : settings.workflow.server.port

  const { db, server } = createPiServer({
    port,
    dbPath,
    settings,
  })

  const actualPort = await server.start(port)
  console.log(`[pi-easy-workflow] server started on http://0.0.0.0:${actualPort}`)

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
