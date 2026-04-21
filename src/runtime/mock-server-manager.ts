import { spawn, ChildProcess } from "child_process"
import * as http from "http"
import * as path from "path"
import { Effect } from "effect"

type StartOptions = {
  detached?: boolean
}

export class MockServerManager {
  private process: ChildProcess | null = null
  private port: number

  constructor(port: number = 9999) {
    this.port = port
  }

  async start(mockLlmServerPath?: string, options: StartOptions = {}): Promise<void> {
    if (this.process) {
      Effect.runSync(Effect.logInfo("[MockServerManager] Server already running"))
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

    Effect.runSync(Effect.logInfo(`[MockServerManager] Starting mock LLM server on port ${this.port}...`))
    Effect.runSync(Effect.logInfo(`[MockServerManager] Command: ${startCommand} ${startArgs.join(" ")}`))

    return new Promise((resolve, reject) => {
      const detached = options.detached === true

      this.process = spawn(startCommand, startArgs, {
        cwd: serverPath,
        stdio: detached ? "ignore" : ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: this.port.toString() },
        detached,
      })

      if (detached) {
        this.process.unref()
      }

      let resolved = false

      const cleanup = () => {
        clearInterval(checkReady)
        clearTimeout(startupTimeout)
      }

      const checkReady = setInterval(() => {
        if (resolved) {
          cleanup()
          return
        }
        const req = http.get(`http://localhost:${this.port}/health`, (res) => {
          if (res.statusCode === 200) {
            resolved = true
            cleanup()
            Effect.runSync(Effect.logInfo("[MockServerManager] Mock LLM server ready"))
            resolve()
          }
        })
        req.on("error", () => {})
      }, 500)

      this.process.on("error", (err) => {
        if (!resolved) {
          resolved = true
          cleanup()
          reject(err)
        }
      })

      this.process.on("exit", (code, signal) => {
        if (!resolved) {
          resolved = true
          cleanup()
          reject(new Error(`Mock server exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`))
        }
      })

      if (!detached) {
        this.process.stderr?.on("data", (data: Buffer) => {
          Effect.runSync(Effect.logInfo(`[MockServerManager] stderr: ${data.toString().trim()}`))
        })

        this.process.stdout?.on("data", (data: Buffer) => {
          Effect.runSync(Effect.logInfo(`[MockServerManager] stdout: ${data.toString().trim()}`))
        })
      }

      const startupTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup()
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
      Effect.runSync(Effect.logInfo("[MockServerManager] Stopping mock LLM server..."))
      this.process.kill("SIGTERM")
      this.process = null
      await new Promise((resolve) => setTimeout(resolve, 1000))
      Effect.runSync(Effect.logInfo("[MockServerManager] Mock LLM server stopped"))
    }
  }

  getPort(): number {
    return this.port
  }

  isRunning(): boolean {
    return this.process !== null
  }

  getProcessId(): number | undefined {
    return this.process?.pid
  }
}
