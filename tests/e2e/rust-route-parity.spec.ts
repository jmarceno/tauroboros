import { test, expect } from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { spawn, execFileSync, execSync, type ChildProcess } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

const SERVER_START_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

let serverProcess: ChildProcess
let serverPort: number
let projectDir: string
let baseUrl: string
let dbPath: string

function runDbScript(script: string, env: Record<string, string>): void {
  execFileSync('bun', ['-e', script], {
    cwd: join(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      ...env,
    },
    stdio: 'pipe',
  })
}

function seedRunArtifacts(input: {
  runId: string
  taskId: string
  sessionId: string
  taskRunId: string
  candidateId: string
  reportId: string
  runStatus: 'completed' | 'failed' | 'paused' | 'running'
  taskStatus: 'done' | 'failed' | 'queued'
  archivedTask?: boolean
  archivedRun?: boolean
  staleSessionUrl?: string
}): void {
  const now = Math.floor(Date.now() / 1000)

  runDbScript(
    `
      import { Database } from "bun:sqlite"

      const db = new Database(process.env.DB_PATH!)
      const now = Number(process.env.NOW)
      const runId = process.env.RUN_ID!
      const taskId = process.env.TASK_ID!
      const sessionId = process.env.SESSION_ID!
      const taskRunId = process.env.TASK_RUN_ID!
      const candidateId = process.env.CANDIDATE_ID!
      const reportId = process.env.REPORT_ID!
      const runStatus = process.env.RUN_STATUS!
      const taskStatus = process.env.TASK_STATUS!
      const archivedTask = process.env.ARCHIVED_TASK === "1" ? 1 : 0
      const archivedRun = process.env.ARCHIVED_RUN === "1" ? 1 : 0
      const sessionUrl = process.env.STALE_SESSION_URL!

      db.query(
        "UPDATE tasks SET status = ?, session_id = ?, session_url = ?, review_count = 2, completed_at = ?, updated_at = ?, is_archived = ?, archived_at = ? WHERE id = ?",
      ).run(taskStatus, sessionId, sessionUrl, now, now, archivedTask, archivedTask ? now : null, taskId)

      db.query(
        "INSERT INTO workflow_runs (id, kind, status, display_name, target_task_id, task_order, current_task_id, current_task_index, pause_requested, stop_requested, error_message, created_at, started_at, updated_at, finished_at, is_archived, archived_at, color, group_id, queued_task_count, executing_task_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(runId, "single_task", runStatus, "Seeded run", taskId, JSON.stringify([taskId]), null, 1, 0, 0, null, now, now, now, now, archivedRun, archivedRun ? now : null, "blue", null, 0, 0)

      db.query(
        "INSERT INTO pi_workflow_sessions (id, task_id, task_run_id, session_kind, status, cwd, worktree_dir, branch, pi_session_id, pi_session_file, process_pid, model, thinking_level, started_at, updated_at, finished_at, exit_code, exit_signal, error_message, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(sessionId, taskId, taskRunId, "task", "completed", process.cwd(), null, null, null, null, null, "test/test", "default", now, now, now, 0, null, null, null)

      db.query(
        "INSERT INTO session_messages (seq, message_id, session_id, task_id, task_run_id, timestamp, role, event_name, message_type, content_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(1, "message-1", sessionId, taskId, taskRunId, now, "assistant", null, "message", JSON.stringify({ text: "seeded message" }))

      db.query(
        "INSERT INTO task_runs (id, task_id, phase, slot_index, attempt_index, model, task_suffix, status, session_id, session_url, worktree_dir, summary, error_message, candidate_id, metadata_json, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(taskRunId, taskId, "worker", 0, 0, "test/test", null, "done", sessionId, sessionUrl, null, "seeded", null, candidateId, JSON.stringify({ seeded: true }), now, now, now)

      db.query(
        "INSERT INTO task_candidates (id, task_id, worker_run_id, status, changed_files_json, diff_stats_json, verification_json, summary, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(candidateId, taskId, taskRunId, "available", JSON.stringify([]), JSON.stringify({}), JSON.stringify({}), "candidate", null, now, now)

      db.query(
        "INSERT INTO self_heal_reports (id, run_id, task_id, task_status, error_message, diagnostics_summary, is_tauroboros_bug, root_cause_json, proposed_solution, implementation_plan_json, confidence, external_factors_json, source_mode, source_path, github_url, tauroboros_version, db_path, db_schema_json, raw_response, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(reportId, runId, taskId, taskStatus, null, "seeded report", 0, JSON.stringify({}), "seeded solution", JSON.stringify([]), "low", JSON.stringify([]), "task", null, "https://example.com/repo", "test-version", process.env.DB_PATH!, JSON.stringify({}), "seeded", now, now)

      db.close()
    `,
    {
      NOW: String(now),
      RUN_ID: input.runId,
      TASK_ID: input.taskId,
      SESSION_ID: input.sessionId,
      TASK_RUN_ID: input.taskRunId,
      CANDIDATE_ID: input.candidateId,
      REPORT_ID: input.reportId,
      RUN_STATUS: input.runStatus,
      TASK_STATUS: input.taskStatus,
      ARCHIVED_TASK: input.archivedTask ? '1' : '0',
      ARCHIVED_RUN: input.archivedRun ? '1' : '0',
      STALE_SESSION_URL: input.staleSessionUrl ?? 'https://opencode.invalid/session',
    },
  )
}

function seedLifecycleRun(input: {
  runId: string
  taskId: string
  runStatus: 'queued' | 'running' | 'paused' | 'stopping' | 'completed' | 'failed'
  taskStatus: 'backlog' | 'queued' | 'done' | 'failed'
  pauseRequested?: boolean
  stopRequested?: boolean
  errorMessage?: string | null
  worktreeDir?: string | null
}): void {
  const now = Math.floor(Date.now() / 1000)

  runDbScript(
    `
      import { Database } from "bun:sqlite"

      const db = new Database(process.env.DB_PATH!)
      const now = Number(process.env.NOW)
      const runId = process.env.RUN_ID!
      const taskId = process.env.TASK_ID!
      const runStatus = process.env.RUN_STATUS!
      const taskStatus = process.env.TASK_STATUS!
      const pauseRequested = process.env.PAUSE_REQUESTED === "1" ? 1 : 0
      const stopRequested = process.env.STOP_REQUESTED === "1" ? 1 : 0
      const errorMessage = process.env.ERROR_MESSAGE === "__NULL__" ? null : process.env.ERROR_MESSAGE
      const worktreeDir = process.env.WORKTREE_DIR === "__NULL__" ? null : process.env.WORKTREE_DIR
      const finishedAt = runStatus === "completed" || runStatus === "failed" ? now : null

      db.query(
        "UPDATE tasks SET status = ?, worktree_dir = ?, error_message = ?, session_id = NULL, session_url = NULL, updated_at = ?, completed_at = ? WHERE id = ?",
      ).run(taskStatus, worktreeDir, errorMessage, now, finishedAt, taskId)

      db.query(
        "INSERT INTO workflow_runs (id, kind, status, display_name, target_task_id, task_order, current_task_id, current_task_index, pause_requested, stop_requested, error_message, created_at, started_at, updated_at, finished_at, is_archived, archived_at, color, group_id, queued_task_count, executing_task_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(runId, "single_task", runStatus, "Seeded lifecycle run", taskId, JSON.stringify([taskId]), taskId, 0, pauseRequested, stopRequested, errorMessage, now, now, now, finishedAt, 0, null, "blue", null, taskStatus === "queued" ? 1 : 0, taskStatus === "running" ? 1 : 0)

      db.close()
    `,
    {
      NOW: String(now),
      RUN_ID: input.runId,
      TASK_ID: input.taskId,
      RUN_STATUS: input.runStatus,
      TASK_STATUS: input.taskStatus,
      PAUSE_REQUESTED: input.pauseRequested ? '1' : '0',
      STOP_REQUESTED: input.stopRequested ? '1' : '0',
      ERROR_MESSAGE: input.errorMessage ?? '__NULL__',
      WORKTREE_DIR: input.worktreeDir ?? '__NULL__',
    },
  )
}

test.describe('Rust Route/Payload Parity', () => {
  test.setTimeout(TEST_TIMEOUT_MS)

  test.beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, '../..')
    const rustDir = join(repoRoot, 'src/backend')
    projectDir = mkdtempSync(join(tmpdir(), 'tauroboros-backend-parity-'))
    serverPort = 3795
    baseUrl = `http://localhost:${serverPort}`
    dbPath = join(projectDir, '.tauroboros', 'tasks.db')

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
        project: { name: 'src/backend-parity', type: 'workflow' },
        workflow: {
          server: { port: serverPort, dbPath },
          container: { enabled: false },
        },
      }, null, 2),
    )

    execSync('npm run build', { cwd: join(repoRoot, 'src/frontend'), stdio: 'pipe' })
    execSync('cargo build', { cwd: rustDir, stdio: 'pipe' })

    serverProcess = spawn(join(rustDir, 'target', 'debug', 'tauroboros'), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PROJECT_ROOT: projectDir,
        SERVER_PORT: String(serverPort),
        DATABASE_PATH: dbPath,
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

  test('GET /api/models returns model catalog', async () => {
    const res = await fetch(`${baseUrl}/api/models`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('providers')
    expect(body).toHaveProperty('defaults')
  })

  test('GET /api/branches returns branch list', async () => {
    const res = await fetch(`${baseUrl}/api/branches`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('current')
    expect(body).toHaveProperty('branches')
    expect(Array.isArray(body.branches)).toBe(true)
    expect(body.branches).toContain('master')
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

  test('POST /api/runs/:id/pause rejects an already paused run', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'paused-run-target', prompt: 'Paused run lifecycle test.' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { id: string }

    const runId = `paused-run-${Date.now()}`
    seedLifecycleRun({
      runId,
      taskId: created.id,
      runStatus: 'paused',
      taskStatus: 'queued',
      pauseRequested: true,
    })

    const res = await fetch(`${baseUrl}/api/runs/${runId}/pause`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('POST /api/runs/:id/stop gracefully completes a paused run and prevents resume', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'graceful-stop-target', prompt: 'Graceful stop lifecycle test.' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { id: string }

    const runId = `graceful-stop-${Date.now()}`
    seedLifecycleRun({
      runId,
      taskId: created.id,
      runStatus: 'paused',
      taskStatus: 'queued',
      pauseRequested: true,
    })

    const stopRes = await fetch(`${baseUrl}/api/runs/${runId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destructive: false }),
    })
    expect(stopRes.status).toBe(200)
    const stopped = await stopRes.json() as {
      success: boolean
      run: { status: string; stopRequested: boolean }
      destructive: boolean
    }
    expect(stopped.success).toBe(true)
    expect(stopped.destructive).toBe(false)
    expect(stopped.run.status).toBe('completed')
    expect(stopped.run.stopRequested).toBe(true)

    const taskRes = await fetch(`${baseUrl}/api/tasks/${created.id}`)
    expect(taskRes.status).toBe(200)
    const task = await taskRes.json() as Record<string, unknown>
    expect(task).toHaveProperty('status', 'backlog')
    expect(task).toHaveProperty('errorMessage', 'Workflow stopped by user')

    const resumeRes = await fetch(`${baseUrl}/api/runs/${runId}/resume`, { method: 'POST' })
    expect(resumeRes.status).toBe(409)

    const secondStopRes = await fetch(`${baseUrl}/api/runs/${runId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destructive: false }),
    })
    expect(secondStopRes.status).toBe(409)
  })

  test('POST /api/runs/:id/force-stop fails a paused run, cleans worktree state, and prevents resume', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'force-stop-target', prompt: 'Force stop lifecycle test.' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { id: string }

    const worktreeBranch = `force-stop-${Date.now()}`
    const worktreeDir = join(projectDir, '.worktrees', worktreeBranch)
    execSync(`git worktree add -b ${worktreeBranch} ${worktreeDir} master`, {
      cwd: projectDir,
      stdio: 'ignore',
    })
    writeFileSync(join(worktreeDir, 'marker.txt'), 'force stop cleanup target\n')

    const runId = `force-stop-${Date.now()}`
    seedLifecycleRun({
      runId,
      taskId: created.id,
      runStatus: 'paused',
      taskStatus: 'queued',
      pauseRequested: true,
      worktreeDir,
    })

    const stopRes = await fetch(`${baseUrl}/api/runs/${runId}/force-stop`, { method: 'POST' })
    expect(stopRes.status).toBe(200)
    const stopped = await stopRes.json() as {
      success: boolean
      cleaned: number
      run: { status: string; stopRequested: boolean }
    }
    expect(stopped.success).toBe(true)
    expect(stopped.cleaned).toBe(1)
    expect(stopped.run.status).toBe('failed')
    expect(stopped.run.stopRequested).toBe(true)
    expect(existsSync(worktreeDir)).toBe(false)

    const taskRes = await fetch(`${baseUrl}/api/tasks/${created.id}`)
    expect(taskRes.status).toBe(200)
    const task = await taskRes.json() as Record<string, unknown>
    expect(task).toHaveProperty('status', 'failed')
    expect(task).toHaveProperty('errorMessage', 'Workflow stopped by user - all work discarded')
    expect(task).toHaveProperty('worktreeDir', null)

    const resumeRes = await fetch(`${baseUrl}/api/runs/${runId}/resume`, { method: 'POST' })
    expect(resumeRes.status).toBe(409)
  })

  test('POST /api/runs/:id/clean resets task state and deletes run artifacts', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'clean-target', prompt: 'Reset this task.' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { id: string }

    const runId = 'clean-run-1'
    const sessionId = 'clean-session-1'

    seedRunArtifacts({
      runId,
      taskId: created.id,
      sessionId,
      taskRunId: 'clean-task-run-1',
      candidateId: 'clean-candidate-1',
      reportId: 'clean-report-1',
      runStatus: 'completed',
      taskStatus: 'done',
    })

    const res = await fetch(`${baseUrl}/api/runs/${runId}/clean`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      success: boolean
      tasksReset: number
      sessionsDeleted: number
      taskRunsDeleted: number
      candidatesDeleted: number
      reportsDeleted: number
      runsDeleted: number
      message: string
    }
    expect(body.success).toBe(true)
    expect(body.tasksReset).toBe(1)
    expect(body.sessionsDeleted).toBe(1)
    expect(body.taskRunsDeleted).toBe(1)
    expect(body.candidatesDeleted).toBe(1)
    expect(body.reportsDeleted).toBe(1)
    expect(body.runsDeleted).toBe(1)
    expect(body.message).toContain('Reset 1 tasks')

    const taskRes = await fetch(`${baseUrl}/api/tasks/${created.id}`)
    expect(taskRes.status).toBe(200)
    const task = await taskRes.json() as Record<string, unknown>
    expect(task).toHaveProperty('status', 'backlog')
    expect(task).toHaveProperty('sessionId', null)
    expect(task).toHaveProperty('reviewCount', 0)

    const runsRes = await fetch(`${baseUrl}/api/runs`)
    expect(runsRes.status).toBe(200)
    const runs = await runsRes.json() as Array<{ id: string }>
    expect(runs.some((run) => run.id === runId)).toBe(false)
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

  test('Archived routes group tasks by run and normalize sessionUrl for the frontend', async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'archived-target', prompt: 'Archived task payload.' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { id: string }

    const runId = 'archived-run-1'
    const sessionId = 'archived-session-1'

    seedRunArtifacts({
      runId,
      taskId: created.id,
      sessionId,
      taskRunId: 'archived-task-run-1',
      candidateId: 'archived-candidate-1',
      reportId: 'archived-report-1',
      runStatus: 'completed',
      taskStatus: 'done',
      archivedTask: true,
      archivedRun: false,
      staleSessionUrl: 'https://opencode.invalid/bad-link',
    })

    const tasksRes = await fetch(`${baseUrl}/api/archived/tasks`)
    expect(tasksRes.status).toBe(200)
    const tasksBody = await tasksRes.json() as {
      runs: Array<{ run: { id: string }; tasks: Array<Record<string, unknown>> }>
    }
    const archivedGroup = tasksBody.runs.find((entry) => entry.run.id === runId)
    expect(archivedGroup).toBeDefined()
    expect(archivedGroup?.tasks[0]).toHaveProperty('id', created.id)
    expect(archivedGroup?.tasks[0]).toHaveProperty('sessionUrl', `/#session/${sessionId}`)

    const runsRes = await fetch(`${baseUrl}/api/archived/runs`)
    expect(runsRes.status).toBe(200)
    const runsBody = await runsRes.json() as { runs: Array<{ id: string }> }
    expect(runsBody.runs.some((run) => run.id === runId)).toBe(true)

    const taskRes = await fetch(`${baseUrl}/api/archived/tasks/${created.id}`)
    expect(taskRes.status).toBe(200)
    const archivedTask = await taskRes.json() as Record<string, unknown>
    expect(archivedTask).toHaveProperty('sessionUrl', `/#session/${sessionId}`)
  })

  // ===== Frontend Routes =====

  test('GET / serves the frontend', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.toLowerCase()).toContain('<!doctype html>')
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
    const revised = await revisionRes.json() as { task: Record<string, unknown>; run: Record<string, unknown> }
    expect(revised.task).toBeDefined()
    expect(revised.run).toBeDefined()
    expect(revised.task).toHaveProperty('executionPhase')
    expect(revised.task).toHaveProperty('planRevisionCount')
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
