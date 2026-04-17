import { spawn, ChildProcess } from "child_process"
import * as http from "http"
import * as path from "path"

export class MockServerManager {
  private process: ChildProcess | null = null
  private port: number

  constructor(port: number = 9999) {
    this.port = port
  }

  async start(mockLlmServerPath?: string): Promise<void> {
    if (this.process) {
      console.log("[MockServerManager] Server already running")
      return
    }

    const serverPath = mockLlmServerPath || path.join(process.cwd(), "mock-llm-server")
    const distPath = path.join(serverPath, "dist")

    let startCommand: string
    let startArgs: string[]

    if (this.isBuilt(distPath)) {
      startCommand = "node"
      startArgs = [path.join(distPath, "index.js")]
    } else {
      startCommand = "npx"
      startArgs = ["tsx", "src/index.ts"]
    }

    console.log(`[MockServerManager] Starting mock LLM server on port ${this.port}...`)
    console.log(`[MockServerManager] Command: ${startCommand} ${startArgs.join(" ")}`)

    return new Promise((resolve, reject) => {
      this.process = spawn(startCommand, startArgs, {
        cwd: serverPath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: this.port.toString() },
      })

      let resolved = false

      const checkReady = setInterval(() => {
        if (resolved) {
          clearInterval(checkReady)
          return
        }
        const req = http.get(`http://localhost:${this.port}/health`, (res) => {
          if (res.statusCode === 200) {
            resolved = true
            clearInterval(checkReady)
            console.log("[MockServerManager] Mock LLM server ready")
            resolve()
          }
        })
        req.on("error", () => {})
      }, 500)

      this.process.on("error", (err) => {
        if (!resolved) {
          resolved = true
          clearInterval(checkReady)
          reject(err)
        }
      })

      this.process.stderr?.on("data", (data: Buffer) => {
        console.log(`[MockServerManager] stderr: ${data.toString().trim()}`)
      })

      this.process.stdout?.on("data", (data: Buffer) => {
        console.log(`[MockServerManager] stdout: ${data.toString().trim()}`)
      })

      setTimeout(() => {
        if (!resolved) {
          resolved = true
          clearInterval(checkReady)
          reject(new Error("Mock server startup timeout"))
        }
      }, 30000)
    })
  }

  private isBuilt(distPath: string): boolean {
    try {
      const { existsSync } = require("fs")
      return existsSync(distPath)
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      console.log("[MockServerManager] Stopping mock LLM server...")
      this.process.kill("SIGTERM")
      this.process = null
      await new Promise((resolve) => setTimeout(resolve, 1000))
      console.log("[MockServerManager] Mock LLM server stopped")
    }
  }

  getPort(): number {
    return this.port
  }

  isRunning(): boolean {
    return this.process !== null
  }
}