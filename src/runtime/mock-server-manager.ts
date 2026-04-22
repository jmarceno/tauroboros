import { spawn, ChildProcess } from "child_process"
import { existsSync } from "fs"
import * as http from "http"
import * as path from "path"
import { Effect, Schema } from "effect"

function writeInfo(message: string): void {
  process.stdout.write(`${message}\n`)
}

type StartOptions = {
  detached?: boolean
}

export class MockServerManagerError extends Schema.TaggedError<MockServerManagerError>()("MockServerManagerError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class MockServerManager {
  private process: ChildProcess | null = null
  private port: number

  constructor(port: number = 9999) {
    this.port = port
  }

  start(mockLlmServerPath?: string, options: StartOptions = {}): Effect.Effect<void, MockServerManagerError> {
    if (this.process) {
      return Effect.sync(() => {
        writeInfo("[MockServerManager] Server already running")
      })
    }

    return Effect.async<void, MockServerManagerError>((resume) => {
      const serverPath = mockLlmServerPath || path.join(process.cwd(), "mock-llm-server")
      const distPath = path.join(serverPath, "dist")

      const [startCommand, startArgs] = this.isBuilt(distPath)
        ? ["node", [path.join(distPath, "index.js")]]
        : ["npx", ["tsx", "src/index.ts"]]

      writeInfo(`[MockServerManager] Starting mock LLM server on port ${this.port}...`)
      writeInfo(`[MockServerManager] Command: ${startCommand} ${startArgs.join(" ")}`)

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

      let settled = false

      const completeWith = (effect: Effect.Effect<void, MockServerManagerError>) => {
        if (settled) {
          return
        }
        settled = true
        clearInterval(checkReady)
        clearTimeout(startupTimeout)
        resume(effect)
      }

      const fail = (cause: unknown) => {
        completeWith(
          Effect.fail(
            new MockServerManagerError({
              operation: "start",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
          ),
        )
      }

      const succeed = () => {
        writeInfo("[MockServerManager] Mock LLM server ready")
        completeWith(Effect.void)
      }

      const checkReady = setInterval(() => {
        if (settled) {
          return
        }

        const req = http.get(`http://localhost:${this.port}/health`, (res) => {
          if (res.statusCode === 200) {
            succeed()
          }
        })
        req.on("error", () => undefined)
      }, 500)

      this.process.on("error", (err) => {
        fail(err)
      })

      this.process.on("exit", (code, signal) => {
        fail(new Error(`Mock server exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`))
      })

      if (!detached) {
        this.process.stderr?.on("data", (data: Buffer) => {
          writeInfo(`[MockServerManager] stderr: ${data.toString().trim()}`)
        })

        this.process.stdout?.on("data", (data: Buffer) => {
          writeInfo(`[MockServerManager] stdout: ${data.toString().trim()}`)
        })
      }

      const startupTimeout = setTimeout(() => {
        fail(new Error("Mock server startup timeout"))
      }, 30000)

      return Effect.sync(() => {
        clearInterval(checkReady)
        clearTimeout(startupTimeout)
      })
    })
  }

  private isBuilt(distPath: string): boolean {
    return existsSync(distPath)
  }

  stop(): Effect.Effect<void, MockServerManagerError> {
    return Effect.gen(this, function* () {
      if (!this.process) {
        return
      }

      writeInfo("[MockServerManager] Stopping mock LLM server...")

      const processToStop = this.process
      this.process = null

      yield* Effect.try({
        try: () => {
          processToStop.kill("SIGTERM")
        },
        catch: (cause) => new MockServerManagerError({
          operation: "stop",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })

      yield* Effect.sleep("1 second")
      writeInfo("[MockServerManager] Mock LLM server stopped")
    })
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
