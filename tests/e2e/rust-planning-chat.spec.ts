import { test, expect } from '@playwright/test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

import { createMockPiBinary, prepareMockPiHome } from './rust-live-helpers'

const SERVER_START_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 90_000

let serverProcess: ChildProcess
let serverPort: number
let projectDir: string
let homeDir: string
let baseUrl: string

test.describe('Rust Planning Chat', () => {
  test.setTimeout(TEST_TIMEOUT_MS)

  test.beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, '../..')
    const rustDir = join(repoRoot, 'src/backend')
    projectDir = mkdtempSync(join(tmpdir(), 'tauroboros-planning-chat-'))
    homeDir = mkdtempSync(join(tmpdir(), 'tauroboros-planning-home-'))
    serverPort = 3797
    baseUrl = `http://localhost:${serverPort}`

    prepareGitProject(projectDir)
    prepareMockPiHome(homeDir, projectDir)

    mkdirSync(join(projectDir, '.tauroboros'), { recursive: true })
    writeFileSync(
      join(projectDir, '.tauroboros', 'settings.json'),
      JSON.stringify({
        workflow: {
          server: { port: serverPort, dbPath: '.tauroboros/tasks.db' },
          container: { enabled: false },
        },
      }, null, 2),
    )

    execSync('cargo build --release', { cwd: rustDir, stdio: 'pipe' })

    serverProcess = spawn(join(rustDir, 'target', 'release', 'tauroboros'), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH,
        HOME: homeDir,
        PI_BIN: createMockPiBinary(projectDir),
        PROJECT_ROOT: projectDir,
        SERVER_PORT: String(serverPort),
        DATABASE_PATH: join(projectDir, '.tauroboros', 'tasks.db'),
      },
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
      try {
        const response = await fetch(`${baseUrl}/healthz`)
        if (response.ok) {
          return
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    throw new Error('Planning chat server did not start in time')
  })

  test.afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM')
    }

    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}

    try {
      rmSync(homeDir, { recursive: true, force: true })
    } catch {}
  })

  test('starts a planning session, sends a message, and receives an agent response', async () => {
    const createResponse = await fetch(`${baseUrl}/api/planning/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: projectDir }),
    })

    expect(createResponse.status).toBe(201)
    const session = await createResponse.json() as { id?: string }
    expect(session.id).toBeTruthy()

    const sessionId = session.id!

    const sendResponse = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Explain the next concrete change to make.' }),
    })

    expect(sendResponse.status).toBe(200)

    await expect.poll(async () => {
      const messagesResponse = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/messages`)
      expect(messagesResponse.status).toBe(200)
      const messages = await messagesResponse.json() as Array<Record<string, unknown>>
      return JSON.stringify(messages)
    }, {
      timeout: 30_000,
      intervals: [500, 1000, 2000],
    }).toContain('Completed requested work.')

    const closeResponse = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/close`, {
      method: 'POST',
    })
    expect(closeResponse.status).toBe(200)
  })
})

function prepareGitProject(projectDir: string): void {
  writeFileSync(join(projectDir, '.gitignore'), '.tauroboros/\n.worktrees/\n')
  writeFileSync(join(projectDir, 'README.md'), '# Planning chat validation\n')

  execSync('git init -b master', { cwd: projectDir, stdio: 'ignore' })
  execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' })
  execSync('git config user.name "Test User"', { cwd: projectDir, stdio: 'ignore' })
  execSync('git add .', { cwd: projectDir, stdio: 'ignore' })
  execSync('git commit -m "init"', { cwd: projectDir, stdio: 'ignore' })
}