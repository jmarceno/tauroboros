import { resolve } from "path"
import { loadInfrastructureSettings } from "./config/settings.ts"
import { createPiServer, findProjectRoot } from "./server.ts"

export async function main(): Promise<void> {
  const projectRoot = findProjectRoot()
  const { settings, warnings } = loadInfrastructureSettings(projectRoot)

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
