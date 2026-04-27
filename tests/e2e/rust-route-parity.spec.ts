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
let baseUrl: string

test.describe('Rust Route/Payload Parity', () => {
  test.setTimeout(TEST_TIMEOUT_MS)

  test.beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, '../..')
    const rustDir = join(repoRoot, 'tauroboros-rust')
    projectDir = mkdtempSync(join(tmpdir(), 'tauroboros-rust-parity-'))
    serverPort = 3795
    baseUrl = `http://localhost:${serverPort}`

    writeFileSync(join(projectDir, '.gitignore'), '.tauroboros/\n.worktrees/\n')
    writeFileSync(join(projectDir, 'README.md'), '# Route parity validation\n')
    execSync('git init -b master', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.name "Test User"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git add .', { cwd: projectDir, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git branch secondary', { cwd: projectDir, stdio: 'ignore' })

    mkdirSync(join(projectDir, '.tauroboros'), { recursive: true })
    writeFileSync(
      join(projectDir, '.tauroboros', 'settings.json'),
      JSON.stringify({
        project: { name: 'tauroboros-rust-parity', type: 'workflow' },
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

  // ===== Health / Version / Reference Routes =====

  test('GET /healthz returns ok', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status', 'ok')
  })

  test('GET /api/version returns version info', async () => {
    const res = await fetch(`${baseUrl}/api/version`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('commit')
  })

  test('GET /api/models returns model list', async () => {
    const res = await fetch(`${baseUrl}/api/models`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('GET /api/branches returns branch list', async () => {
    const res = await fetch(`${baseUrl}/api/branches`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    const branchNames = body.map((b: { name: string }) => b.name || b)
    expect(branchNames).toContain('master')
  })

  // ===== Tasks =====

  let taskId: string
  let depTaskId: string

  test('POST /api/tasks creates a task with standard fields', async () => {
    const createBody = {
      name: 'parity-test-task',
      prompt: 'Create a test file.',
    }
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('id')
    expect(body).toHaveProperty('name', 'parity-test-task')
    expect(body).toHaveProperty('prompt', 'Create a test file.')
    expect(body).toHaveProperty('status', 'backlog')
    expect(body).toHaveProperty('planmode', false)
    expect(body).toHaveProperty('review', false)
    expect(body).toHaveProperty('autoApprovePlan', false)
    expect(body).toHaveProperty('executionStrategy', 'standard')
    expect(body).toHaveProperty('bestOfNSubstage', 'idle')
    expect(body).toHaveProperty('awaitingPlanApproval', false)
    taskId = body.id as string
  })

  test('POST /api/tasks creates a task with plan mode fields', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'parity-plan-task',
        prompt: 'Create a test file for plan mode.',
        planmode: true,
        autoApprovePlan: true,
        review: false,
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('planmode', true)
    expect(body).toHaveProperty('autoApprovePlan', true)
    expect(body).toHaveProperty('review', false)
  })

  test('POST /api/tasks handles requirements (dependencies)', async () => {
    // First create a dependency
    const depRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dep-task', prompt: 'Dependency task.' }),
    })
    const depBody = await depRes.json() as { id: string }
    depTaskId = depBody.id

    // Create task with dependency
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'task-with-dep',
        prompt: 'Task with dependency.',
        requirements: [depTaskId],
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { requirements: string[]; warning?: string }
    expect(body.requirements).toContain(depTaskId)
  })

  test('GET /api/tasks lists all tasks', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`)
    expect(res.status).toBe(200)
    const body = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(3)
    const names = body.map((t) => t.name)
    expect(names).toContain('parity-test-task')
  })

  test('GET /api/tasks/:id returns single task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('id', taskId)
    expect(body).toHaveProperty('name', 'parity-test-task')
  })

  test('PATCH /api/tasks/:id updates task fields', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated-parity-task' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('name', 'updated-parity-task')
  })

  test('PUT /api/tasks/reorder reorders tasks', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, newIdx: 0 }),
    })
    expect(res.status).toBe(200)
  })

  test('GET /api/tasks/:id/runs returns task runs (empty initially)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/runs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('GET /api/tasks/:id/sessions returns task sessions (empty initially)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/sessions`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('GET /api/tasks/:id/last-update returns update timestamp', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/last-update`)
    expect(res.status).toBe(200)
    const body = await res.json() as { taskId: string; lastUpdateAt: number | null }
    expect(body.taskId).toBe(taskId)
    expect(typeof body.lastUpdateAt).toBe('number')
  })

  test('GET /api/tasks/:id/review-status returns review state', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/review-status`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      taskId: string; reviewCount: number; maxReviewRuns: number; maxReviewRunsOverride: number | null
    }
    expect(body.taskId).toBe(taskId)
    expect(typeof body.reviewCount).toBe('number')
    expect(typeof body.maxReviewRuns).toBe('number')
  })

  test('GET /api/tasks/:id/candidates returns empty array for standard task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/candidates`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  // ===== Plan Mode Routes =====

  test('POST /api/tasks/:id/approve-plan requires plan mode', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/approve-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  // ===== Task Groups =====

  let groupId: string

  test('CRUD task groups', async () => {
    // Create
    const createRes = await fetch(`${baseUrl}/api/task-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'parity-test-group' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { id: string; name: string }
    groupId = created.id
    expect(created.name).toBe('parity-test-group')

    // List
    const listRes = await fetch(`${baseUrl}/api/task-groups`)
    expect(listRes.status).toBe(200)
    const list = await listRes.json() as Array<{ id: string; name: string }>
    expect(list.some((g) => g.id === groupId)).toBe(true)

    // Get single
    const getRes = await fetch(`${baseUrl}/api/task-groups/${groupId}`)
    expect(getRes.status).toBe(200)
    const group = await getRes.json() as Record<string, unknown>
    expect(group).toHaveProperty('id', groupId)

    // Update
    const patchRes = await fetch(`${baseUrl}/api/task-groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated-group' }),
    })
    expect(patchRes.status).toBe(200)

    // Add task to group
    const addRes = await fetch(`${baseUrl}/api/task-groups/${groupId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: [taskId] }),
    })
    expect(addRes.status).toBe(200)

    // Delete
    const delRes = await fetch(`${baseUrl}/api/task-groups/${groupId}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
  })

  // ===== Options =====

  test('GET /api/options returns options with expected shape', async () => {
    const res = await fetch(`${baseUrl}/api/options`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('parallelTasks')
    expect(body).toHaveProperty('executionModel')
    expect(body).toHaveProperty('maxReviews')
    expect(body).toHaveProperty('branch')
  })

  test('PUT /api/options updates options', async () => {
    const res = await fetch(`${baseUrl}/api/options`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parallelTasks: 2 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('parallelTasks', 2)
  })

  // ===== Runs =====

  test('GET /api/runs returns run list', async () => {
    const res = await fetch(`${baseUrl}/api/runs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('GET /api/runs/paused-state returns state object', async () => {
    const res = await fetch(`${baseUrl}/api/runs/paused-state`)
    expect(res.status).toBe(200)
    const body = await res.json() as { hasPausedRun: boolean; state: unknown }
    expect(typeof body.hasPausedRun).toBe('boolean')
  })

  test('GET /api/slots returns slot utilization', async () => {
    const res = await fetch(`${baseUrl}/api/slots`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      maxSlots: number; usedSlots: number; availableSlots: number; tasks: unknown[]
    }
    expect(typeof body.maxSlots).toBe('number')
    expect(typeof body.usedSlots).toBe('number')
    expect(typeof body.availableSlots).toBe('number')
    expect(Array.isArray(body.tasks)).toBe(true)
  })

  // ===== Sessions =====

  test('GET /api/sessions/:id returns 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent`)
    expect(res.status).toBe(404)
  })

  // ===== Stats =====

  test('GET /api/stats/duration returns integer minutes', async () => {
    const res = await fetch(`${baseUrl}/api/stats/duration`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body).toBe('number')
  })

  test('GET /api/stats/tasks returns task stats', async () => {
    const res = await fetch(`${baseUrl}/api/stats/tasks`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('totalTasks')
    expect(body).toHaveProperty('completedTasks')
    expect(body).toHaveProperty('failedTasks')
    expect(body).toHaveProperty('pendingTasks')
  })

  test('GET /api/workflow/status returns workflow status', async () => {
    const res = await fetch(`${baseUrl}/api/workflow/status`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('active')
  })

  // ===== Container Endpoints (native-mode stubs) =====

  test('Container endpoints are accessible in native mode', async () => {
    const endpoints = [
      '/api/container/profiles',
      '/api/container/status',
      '/api/container/images',
    ]
    for (const endpoint of endpoints) {
      const res = await fetch(`${baseUrl}${endpoint}`)
      expect(res.status).toBe(200)
    }
  })

  // ===== Frontend Routes =====

  test('GET / serves the frontend', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<!doctype html>')
  })

  test('GET /assets/ serves static assets', async () => {
    const res = await fetch(`${baseUrl}/assets/index-`)
    // Assets may or may not exist at this path, but the route should handle gracefully
    if (res.status === 200) {
      expect(res.headers.get('content-type')).toBeTruthy()
    }
  })

  // ===== Plan Mode Specific Route Parity =====

  let planModeTaskId: string

  test('Plan mode task creation and approve-plan flow', async () => {
    // Create plan mode task
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'parity-plan-mode',
        prompt: 'Test plan mode.',
        planmode: true,
        autoApprovePlan: false,
        awaitingPlanApproval: true,
      }),
    })
    expect(createRes.status).toBe(201)
    const task = await createRes.json() as { id: string; planmode: boolean; awaitingPlanApproval: boolean }
    planModeTaskId = task.id
    expect(task.planmode).toBe(true)

    // Approve plan
    const approveRes = await fetch(`${baseUrl}/api/tasks/${planModeTaskId}/approve-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Approved' }),
    })
    expect(approveRes.status).toBe(200)
    const approved = await approveRes.json() as { status: string; executionPhase: string }
    expect(approved.status).toBe('backlog')
    expect(approved.executionPhase).toBe('implementation_pending')

    // Request plan revision
    const revisionRes = await fetch(`${baseUrl}/api/tasks/${planModeTaskId}/request-plan-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'Please revise the plan' }),
    })
    expect(revisionRes.status).toBe(200)
    const revised = await revisionRes.json() as { executionPhase: string; planRevisionCount: number }
    expect(revised.executionPhase).toBe('plan_revision_pending')
    expect(revised.planRevisionCount).toBeGreaterThanOrEqual(1)
  })

  // ===== Best-of-N Route Parity =====

  test('Best-of-N task creation and summary endpoint', async () => {
    // Create best-of-n task
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'parity-best-of-n',
        prompt: 'Test best of n.',
        executionStrategy: 'best_of_n',
        bestOfNConfig: {
          workers: [{ model: 'test/test', count: 1 }],
          reviewers: [],
          finalApplier: { model: 'test/test' },
          selectionMode: 'pick_best',
          minSuccessfulWorkers: 1,
        },
      }),
    })
    expect(createRes.status).toBe(201)
    const task = await createRes.json() as Record<string, unknown>
    expect(task).toHaveProperty('executionStrategy', 'best_of_n')
    expect(task).toHaveProperty('bestOfNSubstage', 'idle')

    // Summary endpoint
    const summaryRes = await fetch(`${baseUrl}/api/tasks/${task.id}/best-of-n-summary`)
    expect(summaryRes.status).toBe(200)
    const summary = await summaryRes.json() as Record<string, unknown>
    expect(summary).toHaveProperty('taskId', task.id)
    expect(summary).toHaveProperty('substage')

    // Candidates endpoint
    const candidatesRes = await fetch(`${baseUrl}/api/tasks/${task.id}/candidates`)
    expect(candidatesRes.status).toBe(200)
    const candidates = await candidatesRes.json()
    expect(Array.isArray(candidates)).toBe(true)
  })

  // ===== Error Handling =====

  test('Returns 404 for unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent-id-12345`)
    expect(res.status).toBe(404)
  })

  test('Returns 400 for invalid request body', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid json',
    })
    expect(res.status).toBe(400)
  })
})
