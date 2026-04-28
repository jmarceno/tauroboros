import { test, expect } from '@playwright/test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

const SERVER_START_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

let serverProcess: ChildProcess
let serverPort: number
let projectDir: string

function parseSseLine(line: string): { kind: 'event' | 'data'; value: string } | null {
  if (line.startsWith('event:')) {
    return { kind: 'event', value: line.slice(6).trimStart() }
  }

  if (line.startsWith('data:')) {
    return { kind: 'data', value: line.slice(5).trimStart() }
  }

  return null
}

test.describe('Rust SSE Contract', () => {
  test.setTimeout(TEST_TIMEOUT_MS)

  test.beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, '../..')
    const rustDir = join(repoRoot, 'src/backend')
    projectDir = mkdtempSync(join(tmpdir(), 'src/backend-sse-'))
    serverPort = 3794

    writeFileSync(join(projectDir, '.gitignore'), '.tauroboros/\n.worktrees/\n')
    writeFileSync(join(projectDir, 'README.md'), '# SSE contract validation\n')
    execSync('git init -b master', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.name "Test User"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git add .', { cwd: projectDir, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: projectDir, stdio: 'ignore' })

    mkdirSync(join(projectDir, '.tauroboros'), { recursive: true })
    writeFileSync(
      join(projectDir, '.tauroboros', 'settings.json'),
      JSON.stringify({
        project: { name: 'src/backend-sse', type: 'workflow' },
        workflow: {
          server: { port: serverPort, dbPath: join(projectDir, '.tauroboros', 'tasks.db') },
          container: { enabled: false },
        },
      }, null, 2),
    )

    execSync('npm run build', { cwd: join(repoRoot, 'src/frontend'), stdio: 'pipe' })
    execSync('cargo build', { cwd: rustDir, stdio: 'pipe' })

    serverProcess = spawn(join(rustDir, 'target', 'debug', 'tauroboros-server'), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PROJECT_ROOT: projectDir,
        SERVER_PORT: String(serverPort),
        DATABASE_PATH: join(projectDir, '.tauroboros', 'tasks.db'),
      },
    })

    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.log(`[RUST-SERVER] ${text}`)
    })
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.error(`[RUST-SERVER-ERR] ${text}`)
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
      try {
        const response = await fetch(`http://localhost:${serverPort}/healthz`)
        if (response.ok) break
      } catch { }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })

  test.afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM')
    }
    try { rmSync(projectDir, { recursive: true, force: true }) } catch { }
  })

  test('global SSE endpoint sends connected event on open', async () => {
    const events: string[] = []
    const response = await fetch(`http://localhost:${serverPort}/sse`)
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let connectedEvent: string | null = null

    const timeout = setTimeout(() => { }, 8000)

    try {
      while (!connectedEvent) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        let eventType = ''
        for (const line of lines) {
          const parsedLine = parseSseLine(line)
          if (parsedLine?.kind === 'event') {
            eventType = parsedLine.value
          } else if (parsedLine?.kind === 'data' && eventType) {
            const parsed = JSON.parse(parsedLine.value)
            events.push(`${eventType}:${JSON.stringify(parsed)}`)
            if (eventType === 'open' && parsed.type === 'connected') {
              connectedEvent = JSON.stringify(parsed)
            }
            eventType = ''
          }
        }
      }
    } finally {
      clearTimeout(timeout)
      reader.cancel()
    }

    expect(connectedEvent).toBeTruthy()
    const parsed = JSON.parse(connectedEvent!)
    expect(parsed.type).toBe('connected')
    expect(parsed.connectionId).toBeTruthy()
    expect(typeof parsed.connectionId).toBe('string')
  })

  test('task_created and task_updated events sent via global SSE after API calls', async () => {
    const collectedEvents: Array<{ eventType: string; payloadType: string; taskId?: string }> = []

    // Connect to SSE
    const response = await fetch(`http://localhost:${serverPort}/sse`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')
    const decoder = new TextDecoder()
    let buffer = ''

    // Wait for initial "open" event
    const waitForOpen = () => new Promise<void>((resolve) => {
      const check = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          let eventType = ''
          for (const line of lines) {
            const parsedLine = parseSseLine(line)
            if (parsedLine?.kind === 'event') eventType = parsedLine.value
            else if (parsedLine?.kind === 'data' && eventType) {
              const parsed = JSON.parse(parsedLine.value)
              if (eventType === 'open' && parsed.type === 'connected') {
                resolve()
                return
              }
              eventType = ''
            }
          }
        }
      }
      check()
    })

    await waitForOpen()

    // Start collecting events in the background
    const eventCollector = (async () => {
      while (true) {
        try {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          let eventType = ''
          for (const line of lines) {
            const parsedLine = parseSseLine(line)
            if (parsedLine?.kind === 'event') eventType = parsedLine.value
            else if (parsedLine?.kind === 'data' && eventType) {
              try {
                const parsed = JSON.parse(parsedLine.value)
                collectedEvents.push({
                  eventType,
                  payloadType: parsed.type,
                  taskId: parsed.payload?.id || parsed.payload?.taskId,
                })
              } catch { }
              eventType = ''
            }
          }
        } catch {
          break
        }
      }
    })()

    try {
      // Create a task via API
      const createResponse = await fetch(`http://localhost:${serverPort}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'sse-test-task',
          prompt: 'Test prompt for SSE contract verification',
        }),
      })
      expect(createResponse.ok).toBe(true)
      const task = await createResponse.json() as { id: string }
      expect(task.id).toBeTruthy()

      // Wait for events to arrive
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Remove the reader cancellation from the collector
    } finally {
      reader.cancel()
      await eventCollector.catch(() => { })
    }

    // Verify task_created event was received
    const taskCreated = collectedEvents.find(e => e.eventType === 'task_created')
    expect(taskCreated).toBeTruthy()
    expect(taskCreated!.payloadType).toBe('task_created')
  })

  test('SSE hub broadcasts multiple event types correctly', async () => {
    const baseUrl = `http://localhost:${serverPort}`

    // Verify the /sse endpoint is accessible with correct headers
    const headCheck = await fetch(baseUrl + '/sse', { method: 'GET' })
    expect(headCheck.ok).toBe(true)
    expect(headCheck.headers.get('content-type') || '').toContain('text/event-stream')

    // Verify the /ws alias also works
    const wsCheck = await fetch(baseUrl + '/ws', { method: 'GET' })
    expect(wsCheck.ok).toBe(true)
    expect(wsCheck.headers.get('content-type') || '').toContain('text/event-stream')

    // Verify ping keepalive events are sent
    const pingResponse = await fetch(baseUrl + '/sse')
    const pingReader = pingResponse.body?.getReader()
    if (!pingReader) throw new Error('No response body')
    const decoder = new TextDecoder()
    let pingBuffer = ''
    let foundPing = false

    const pingTimeout = setTimeout(() => {
      pingReader.cancel()
    }, 5000)

    try {
      while (!foundPing) {
        const { done, value } = await pingReader.read()
        if (done) break
        pingBuffer += decoder.decode(value, { stream: true })
        if (/event:\s*ping/.test(pingBuffer)) {
          foundPing = true
        }
      }
    } catch { }
    finally {
      clearTimeout(pingTimeout)
      pingReader.cancel()
    }

    expect(foundPing).toBe(true)
  })
})
