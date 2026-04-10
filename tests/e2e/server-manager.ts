/**
 * E2E Test Server Manager
 * 
 * Handles starting and stopping the pi-easy-workflow server for e2e tests.
 * Uses a temporary database and project directory to avoid conflicts.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { execSync } from "child_process"
import { PiKanbanDB } from "../../src/db.ts"
import { PiKanbanServer } from "../../src/server/server.ts"
import { PiOrchestrator } from "../../src/orchestrator.ts"
import type { InfrastructureSettings } from "../../src/config/settings.ts"

export interface TestServer {
  url: string
  dbPath: string
  projectDir: string
  stop: () => Promise<void>
}

/**
 * Start a test server on an available port
 */
export async function startTestServer(): Promise<TestServer> {
  // Create temporary project directory
  const projectDir = mkdtempSync(join(tmpdir(), "pi-e2e-"))
  const dbPath = join(projectDir, "test.db")
  
  // Initialize a git repository
  const repoDir = join(projectDir, "repo")
  mkdirSync(repoDir, { recursive: true })
  execSync("git init", { cwd: repoDir, stdio: "pipe" })
  execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: "pipe" })
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: "pipe" })
  
  // Create initial commit
  writeFileSync(join(repoDir, "README.md"), "# Test Repository\n")
  execSync("git add .", { cwd: repoDir, stdio: "pipe" })
  execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: "pipe" })
  
  // Find an available port
  const port = await findAvailablePort()
  
  // Create settings
  const settings: InfrastructureSettings = {
    skills: {
      localPath: "./skills",
      autoLoad: true,
      allowGlobal: false,
    },
    project: {
      name: "pi-easy-workflow-test",
      type: "workflow",
    },
    workflow: {
      server: {
        port: port,
        dbPath: dbPath,
      },
      runtime: {
        mode: "native",
        piBin: "pi",
        piArgs: "--mode rpc --no-extensions",
      },
      container: {
        enabled: false,
        image: "pi-agent:alpine",
        imageSource: "dockerfile",
        dockerfilePath: "docker/pi-agent/Dockerfile",
        registryUrl: null,
        autoPrepare: true,
        memoryMb: 512,
        cpuCount: 1,
        portRangeStart: 30000,
        portRangeEnd: 40000,
      },
    },
  }
  
  // Create database
  const db = new PiKanbanDB(dbPath)
  
  let server: PiKanbanServer
  let orchestrator: PiOrchestrator
  
  const createServer = () => {
    server = new PiKanbanServer(db, {
      port: port,
      settings: settings,
      onStart: async () => {
        return await orchestrator.startAll()
      },
      onStartSingle: async (taskId: string) => {
        return await orchestrator.startSingle(taskId)
      },
      onStop: async () => {
        await orchestrator.stop()
        return { ok: true }
      },
    })
    
    orchestrator = new PiOrchestrator(
      db,
      (message) => server.broadcast(message),
      (sessionId) => `/#session/${encodeURIComponent(sessionId)}`,
      repoDir,
      settings,
    )
    
    return server
  }
  
  // Create and start server
  createServer()
  await server.start(port)
  
  return {
    url: `http://localhost:${port}`,
    dbPath,
    projectDir,
    stop: async () => {
      server.stop()
      db.close()
      
      // Cleanup
      try {
        rmSync(projectDir, { recursive: true, force: true })
      } catch {
        // Best effort cleanup
      }
    },
  }
}

/**
 * Find an available port
 */
async function findAvailablePort(): Promise<number> {
  // Try ports starting from 33333
  for (let port = 33333; port < 33400; port++) {
    try {
      const result = execSync(`lsof -i :${port} 2>/dev/null || echo "available"`, { encoding: "utf-8" })
      if (result.includes("available")) {
        return port
      }
    } catch {
      return port
    }
  }
  throw new Error("Could not find available port")
}

/**
 * Wait for server to be ready
 */
async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/tasks`)
      if (response.status === 200) {
        return
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  
  throw new Error(`Server did not start within ${timeoutMs}ms`)
}
