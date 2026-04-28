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

const SERVER_START_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

let serverProcess: ChildProcess
let serverPort: number
let projectDir: string
let baseUrl: string

test.describe('Rust Planning Chat', () => {
  test.setTimeout(TEST_TIMEOUT_MS)

  test.beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, '../..')
    const rustDir = join(repoRoot, 'tauroboros-rust')
    projectDir = mkdtempSync(join(tmpdir(), 'tauroboros-rust-planning-'))
    serverPort = 3797
    baseUrl = `http://localhost:${serverPort}`

    writeFileSync(join(projectDir, '.gitignore'), '.tauroboros/\n.worktrees/\n')
    writeFileSync(join(projectDir, 'README.md'), '# Planning chat validation\n')
    execSync('git init -b master', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.name "Test User"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git add .', { cwd: projectDir, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: projectDir, stdio: 'ignore' })

    mkdirSync(join(projectDir, '.tauroboros'), { recursive: true })
    writeFileSync(
      join(projectDir, '.tauroboros', 'settings.json'),
      JSON.stringify({
        project: { name: 'tauroboros-rust-planning', type: 'workflow' },
        workflow: {
          server: { port: serverPort, dbPath: join(projectDir, '.tauroboros', 'tasks.db') },
          container: { enabled: false },
        },
      }, null, 2),
    )

    execSync('npm run build', { cwd: join(repoRoot, 'src/kanban-solid'), stdio: 'pipe' })
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
        const response = await fetch(`${baseUrl}/healthz`)
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

  // ===== Planning Prompt Routes =====

  test('GET /api/planning/prompt returns default planning prompt', async () => {
    const res = await fetch(`${baseUrl}/api/planning/prompt`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('key', 'default')
    expect(body).toHaveProperty('name', 'Default Planning Prompt')
    expect(body).toHaveProperty('description')
    expect(body).toHaveProperty('promptText')
    expect(body).toHaveProperty('isActive', true)
    expect(body).toHaveProperty('createdAt')
    expect(body).toHaveProperty('updatedAt')
    expect(typeof body.promptText).toBe('string')
    expect((body.promptText as string).length).toBeGreaterThan(100)
  })

  test('GET /api/planning/prompts returns all prompts', async () => {
    const res = await fetch(`${baseUrl}/api/planning/prompts`)
    expect(res.status).toBe(200)
    const body = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(2)
    const keys = body.map((p) => p.key)
    expect(keys).toContain('default')
    expect(keys).toContain('container_config')
  })

  test('PUT /api/planning/prompt updates the prompt', async () => {
    const newPromptText = 'Updated planning prompt for testing purposes.'
    const res = await fetch(`${baseUrl}/api/planning/prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: newPromptText }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('promptText', newPromptText)
    expect(body).toHaveProperty('updatedAt')

    const verifyRes = await fetch(`${baseUrl}/api/planning/prompt`)
    const verifyBody = await verifyRes.json() as Record<string, unknown>
    expect(verifyBody).toHaveProperty('promptText', newPromptText)
  })

  test('GET /api/planning/prompt/:key/versions returns version history', async () => {
    await fetch(`${baseUrl}/api/planning/prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: 'Version test prompt.' }),
    })

    const res = await fetch(`${baseUrl}/api/planning/prompt/default/versions`)
    expect(res.status).toBe(200)
    const body = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    expect(body[0]).toHaveProperty('version')
    expect(body[0]).toHaveProperty('promptText')
    expect(body[0]).toHaveProperty('createdAt')
  })

  // ===== Planning Session Listing =====

  test('GET /api/planning/sessions returns empty list initially', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  test('GET /api/planning/sessions/active returns empty list initially', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/active`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  // ===== Session Error Cases =====

  const nonExistentId = '00000000-0000-0000-0000-000000000000'

  test('GET /api/planning/sessions/:id returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}`)
    expect(res.status).toBe(404)
  })

  test('PATCH /api/planning/sessions/:id returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/planning/sessions/:id/stop returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/stop`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/planning/sessions/:id/close returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/close`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  test('GET /api/planning/sessions/:id/messages returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/messages`)
    expect(res.status).toBe(404)
  })

  test('GET /api/planning/sessions/:id/timeline returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/timeline`)
    expect(res.status).toBe(404)
  })

  test('PUT /api/planning/sessions/:id/name returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Session' }),
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/planning/sessions/:id/reconnect returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/planning/sessions/:id/model returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test/test' }),
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/planning/sessions/:id/create-tasks returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/create-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test('POST /api/planning/sessions/:id/messages returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/planning/sessions/${nonExistentId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello' }),
    })
    expect(res.status).toBe(404)
  })

  // ===== Non-Planning Session Error =====

  test('Session endpoints return 400 for non-planning sessions', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'non-planning-test',
        prompt: 'Test task for non-planning session check.',
      }),
    })
    expect(createRes.status).toBe(201)
    const task = await createRes.json() as Record<string, unknown>
    const taskId = task.id as string

    const res = await fetch(`${baseUrl}/api/planning/sessions/${taskId}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  // ===== Pi-Dependent Tests =====

  test.describe('Session lifecycle (requires Pi)', () => {
    let piAvailable = false

    test.beforeAll(() => {
      try {
        execSync('which pi', { stdio: 'pipe' })
        piAvailable = true
      } catch {
        console.log('Pi binary not found - skipping Pi-dependent tests')
        piAvailable = false
      }
    })

    test('POST /api/planning/sessions/:id/messages returns 400 for inactive session', async () => {
      test.skip(!piAvailable, 'Pi not available')

      const createRes = await fetch(`${baseUrl}/api/planning/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as Record<string, unknown>
      const sessionId = session.id as string

      await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/stop`, { method: 'POST' })

      const msgRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello' }),
      })
      expect(msgRes.status).toBe(400)
      const body = await msgRes.json() as Record<string, unknown>
      expect(body).toHaveProperty('error')
    })

    test('POST /api/planning/sessions/:id/model returns 400 for inactive session', async () => {
      test.skip(!piAvailable, 'Pi not available')

      const createRes = await fetch(`${baseUrl}/api/planning/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as Record<string, unknown>
      const sessionId = session.id as string

      await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/stop`, { method: 'POST' })

      const modelRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test/test' }),
      })
      expect(modelRes.status).toBe(400)
      const body = await modelRes.json() as Record<string, unknown>
      expect(body).toHaveProperty('error')
    })

    test('PUT /api/planning/sessions/:id/name rejects empty name and renames session', async () => {
      test.skip(!piAvailable, 'Pi not available')

      const createRes = await fetch(`${baseUrl}/api/planning/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as Record<string, unknown>
      const sessionId = session.id as string

      const renameRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      })
      expect(renameRes.status).toBe(400)

      const validRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Test Session' }),
      })
      expect(validRes.status).toBe(200)
      const body = await validRes.json() as Record<string, unknown>
      expect(body).toHaveProperty('name', 'My Test Session')

      await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/close`, { method: 'POST' })
    })

    test('Full session lifecycle: create, list, get, reconnect, rename, messages, timeline, stop, close', async () => {
      test.skip(!piAvailable, 'Pi not available')

      const createRes = await fetch(`${baseUrl}/api/planning/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(createRes.status).toBe(201)

      const session = await createRes.json() as Record<string, unknown>
      expect(session).toHaveProperty('id')
      expect(session).toHaveProperty('sessionKind', 'planning')
      expect(session).toHaveProperty('status', 'active')
      expect(session).toHaveProperty('sessionUrl')
      expect(typeof session.sessionUrl).toBe('string')
      expect((session.sessionUrl as string)).toContain(`/sessions/${session.id}`)

      const sessionId = session.id as string

      const listRes = await fetch(`${baseUrl}/api/planning/sessions`)
      expect(listRes.status).toBe(200)
      const list = await listRes.json() as Array<Record<string, unknown>>
      const ids = list.map((s) => s.id)
      expect(ids).toContain(sessionId)

      const activeRes = await fetch(`${baseUrl}/api/planning/sessions/active`)
      expect(activeRes.status).toBe(200)
      const active = await activeRes.json() as Array<Record<string, unknown>>
      const activeIds = active.map((s) => s.id)
      expect(activeIds).toContain(sessionId)

      const getRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}`)
      expect(getRes.status).toBe(200)
      const getBody = await getRes.json() as Record<string, unknown>
      expect(getBody).toHaveProperty('id', sessionId)
      expect(getBody).toHaveProperty('sessionUrl')

      const reconnectRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/reconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(reconnectRes.status).toBe(200)
      const reconnectBody = await reconnectRes.json() as Record<string, unknown>
      expect(reconnectBody).toHaveProperty('id', sessionId)

      const renameRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Lifecycle Test' }),
      })
      expect(renameRes.status).toBe(200)
      const renameBody = await renameRes.json() as Record<string, unknown>
      expect(renameBody).toHaveProperty('name', 'Lifecycle Test')

      const msgRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/messages`)
      expect(msgRes.status).toBe(200)
      const messages = await msgRes.json() as Array<Record<string, unknown>>
      expect(Array.isArray(messages)).toBe(true)

      const timelineRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/timeline`)
      expect(timelineRes.status).toBe(200)
      const timeline = await timelineRes.json() as Array<Record<string, unknown>>
      expect(Array.isArray(timeline)).toBe(true)

      const closeRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/close`, {
        method: 'POST',
      })
      expect(closeRes.status).toBe(200)
      const closeBody = await closeRes.json() as Record<string, unknown>
      expect(closeBody).toHaveProperty('status', 'completed')
    })

    test('reconnect to stopped session and resume conversation', async () => {
      test.skip(!piAvailable, 'Pi not available')

      const createRes = await fetch(`${baseUrl}/api/planning/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(createRes.status).toBe(201)
      const session = await createRes.json() as Record<string, unknown>
      const sessionId = session.id as string

      const stopRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/stop`, {
        method: 'POST',
      })
      expect(stopRes.status).toBe(200)

      const reconnectRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/reconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(reconnectRes.status).toBe(200)
      const reconnectBody = await reconnectRes.json() as Record<string, unknown>
      expect(reconnectBody).toHaveProperty('id', sessionId)
      expect(reconnectBody).toHaveProperty('status', 'active')

      const msgRes = await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello after reconnect.' }),
      })
      expect(msgRes.status).toBe(200)

      await fetch(`${baseUrl}/api/planning/sessions/${sessionId}/close`, {
        method: 'POST',
      })
    })
  })

  // ===== UI Tests =====

  test.describe('Planning chat UI', () => {
    test('opens and closes the planning chat panel', async ({ page }) => {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 20_000 })

      await page.getByRole('button', { name: 'Planning Chat' }).click()
      await expect(page.getByText('No active chat sessions')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start New Chat' })).toBeVisible()

      await page.getByRole('button', { name: 'Close panel' }).click()
      await expect(page.getByText('No active chat sessions')).not.toBeVisible()
    })
  })
})
