import { existsSync, mkdirSync } from "fs"
import { basename, join, resolve } from "path"
import { execFileSync } from "child_process"
import { Effect, Schema } from "effect"

export interface WorktreeInfo {
  directory: string
  branch: string
  baseRef: string
  isMain: boolean
  isBare: boolean
  head: string
}

export interface CreateWorktreeOptions {
  name: string
  branch?: string
  baseRef?: string
  baseDirectory?: string
  worktreeBaseDir?: string
}

export interface MergeWorktreeOptions {
  worktreeDir: string
  branch: string
  targetBranch: string
  noEdit?: boolean
}

export interface WorktreeStatus {
  directory: string
  branch: string
  isClean: boolean
  modifiedFiles: string[]
  stagedFiles: string[]
  untrackedFiles: string[]
  aheadBehind: { ahead: number; behind: number } | null
}

export interface DiffStats {
  filesChanged: number
  insertions: number
  deletions: number
  fileStats: Record<string, { insertions: number; deletions: number }>
}

export interface ResolveTargetBranchOptions {
  baseDirectory?: string
  taskBranch?: string
  optionBranch?: string
}

export interface WorktreeLifecycleOptions {
  baseDirectory: string
  worktreeBaseDir?: string
  keepWorktrees?: boolean
}

export interface CompleteWorktreeOptions {
  branch: string
  targetBranch: string
  shouldMerge: boolean
  shouldRemove: boolean
}

export interface CompleteWorktreeResult {
  merged: boolean
  removed: boolean
  kept: boolean
}

interface GitCommandResult {
  stdout: string
}

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("WorktreeError", {
  message: Schema.String,
  code: Schema.String,
  gitOutput: Schema.optional(Schema.String),
}) {}

function tryWorktree<A>(operation: string, thunk: () => A): Effect.Effect<A, WorktreeError> {
  return Effect.try({
    try: thunk,
    catch: (cause) =>
      cause instanceof WorktreeError
        ? cause
        : new WorktreeError({
            message: cause instanceof Error ? cause.message : String(cause),
            code: operation,
          }),
  })
}

function normalizeBranchName(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function runGit(args: string[], cwd: string): GitCommandResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    })
    return { stdout: stdout.replace(/\s+$/g, "") }
  } catch (error) {
    const err = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = typeof err.stdout === "string" ? err.stdout : err.stdout?.toString("utf-8") ?? ""
    const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf-8") ?? ""
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
    throw new WorktreeError({
      message: err.message ?? "git command failed",
      code: "GIT_COMMAND_FAILED",
      gitOutput: output || undefined,
    })
  }
}

function getRepoRoot(baseDirectory: string): string {
  try {
    return runGit(["rev-parse", "--show-toplevel"], baseDirectory).stdout
  } catch (error) {
    if (error instanceof WorktreeError) {
      throw new WorktreeError({ message: `Not a git repository: ${baseDirectory}`, code: "NOT_GIT_REPOSITORY", gitOutput: error.gitOutput })
    }
    throw error
  }
}

function getMainWorktreeDirectory(baseDirectory: string): string {
  const repoRoot = getRepoRoot(baseDirectory)
  const items = parseWorktreeList(runGit(["worktree", "list", "--porcelain"], repoRoot).stdout)
  const main = items.find((item) => item.isMain)
  return main?.directory ?? repoRoot
}

function normalizeDirectory(pathValue: string): string {
  return resolve(pathValue)
}

function parsePorcelainStatus(
  statusOutput: string,
): { modifiedFiles: string[]; stagedFiles: string[]; untrackedFiles: string[] } {
  const modified = new Set<string>()
  const staged = new Set<string>()
  const untracked = new Set<string>()

  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.trimEnd()
    if (!line) continue

    const state = line.slice(0, 2)
    const fileSegment = line.length > 3 ? line.slice(3).trim() : ""
    const file = fileSegment.includes(" -> ")
      ? fileSegment.slice(fileSegment.lastIndexOf(" -> ") + 4).trim()
      : fileSegment
    if (!file) continue

    if (state === "??") {
      untracked.add(file)
      continue
    }

    const indexState = state[0]
    const worktreeState = state[1]

    if (indexState !== " " && indexState !== "?") staged.add(file)
    if (worktreeState !== " " && worktreeState !== "?") modified.add(file)
  }

  return {
    modifiedFiles: Array.from(modified),
    stagedFiles: Array.from(staged),
    untrackedFiles: Array.from(untracked),
  }
}

function parseAheadBehind(output: string): { ahead: number; behind: number } | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  const [left, right] = trimmed.split(/\s+/)
  const behind = Number(left)
  const ahead = Number(right)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null
  return { ahead, behind }
}

function safeBranchNameFromRef(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice("refs/heads/".length)
  if (trimmed === "(detached)") return ""
  return trimmed
}

function buildWorktreePath(repoRoot: string, name: string, worktreeBaseDir?: string): string {
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new WorktreeError({ message: "Worktree name cannot be empty", code: "INVALID_WORKTREE_NAME" })
  }
  if (trimmedName.includes("/") || trimmedName.includes("\\")) {
    throw new WorktreeError({ message: `Worktree name must not contain path separators: ${trimmedName}`, code: "INVALID_WORKTREE_NAME" })
  }
  const base = worktreeBaseDir ? resolve(worktreeBaseDir) : join(repoRoot, ".worktrees")
  mkdirSync(base, { recursive: true })
  return join(base, trimmedName)
}

/**
 * Parses `git worktree list --porcelain` output.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = []
  const blocks = output
    .trim()
    .split(/\n\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean)

  for (const block of blocks) {
    const info: Partial<WorktreeInfo> = {
      directory: "",
      branch: "",
      baseRef: "",
      isMain: false,
      isBare: false,
      head: "",
    }

    const lines = block.split("\n")
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        info.directory = line.slice("worktree ".length).trim()
      } else if (line.startsWith("HEAD ")) {
        info.head = line.slice("HEAD ".length).trim()
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim()
        info.branch = safeBranchNameFromRef(ref)
        info.baseRef = info.baseRef || info.branch || ref
      } else if (line === "bare") {
        info.isBare = true
      } else if (line === "detached") {
        info.branch = ""
      }
    }

    if (!info.directory) continue
    result.push({
      directory: info.directory,
      branch: info.branch ?? "",
      baseRef: info.baseRef ?? info.branch ?? "",
      isMain: false,
      isBare: info.isBare ?? false,
      head: info.head ?? "",
    })
  }

  if (result.length > 0) {
    const normalizedRoots = new Map<string, number[]>()
    for (let index = 0; index < result.length; index++) {
      const parent = normalizeDirectory(join(result[index].directory, ".."))
      const list = normalizedRoots.get(parent) ?? []
      list.push(index)
      normalizedRoots.set(parent, list)
    }

    for (const indexes of normalizedRoots.values()) {
      const mainIndex = indexes
        .map((idx) => ({ idx, dirLength: result[idx].directory.length }))
        .sort((a, b) => a.dirLength - b.dirLength)[0]?.idx
      if (mainIndex !== undefined) result[mainIndex].isMain = true
    }
  }

  return result
}

/**
 * Checks if a local branch exists.
 */
export function branchExists(branch: string, directory?: string): boolean {
  const normalized = normalizeBranchName(branch)
  if (!normalized) return false
  if (!directory) return false

  try {
    runGit(["show-ref", "--verify", "--quiet", `refs/heads/${normalized}`], directory)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the remote default branch from `origin/HEAD`.
 */
export function getRemoteDefaultBranch(directory?: string): string | null {
  if (!directory) return null

  try {
    const value = runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], directory).stdout
    if (!value) return null
    return value.startsWith("origin/") ? value.slice("origin/".length) : value
  } catch {
    return null
  }
}

/**
 * Resolves merge target branch. NO FALLBACKS - user must explicitly select a branch.
 * Checks taskBranch first, then optionBranch. Throws if neither is valid.
 */
export function resolveTargetBranch(options: ResolveTargetBranchOptions): Effect.Effect<string, WorktreeError> {
  return tryWorktree("RESOLVE_TARGET_BRANCH_FAILED", () => {
    const baseDirectory = options.baseDirectory ? resolve(options.baseDirectory) : process.cwd()
    const repoRoot = getRepoRoot(baseDirectory)

    const taskBranch = normalizeBranchName(options.taskBranch)
    if (taskBranch && branchExists(taskBranch, repoRoot)) return taskBranch

    const optionBranch = normalizeBranchName(options.optionBranch)
    if (optionBranch && branchExists(optionBranch, repoRoot)) return optionBranch

    throw new WorktreeError({
      message: "No target branch specified. Please configure a branch in task options or global settings.",
      code: "TARGET_BRANCH_NOT_FOUND",
    })
  })
}

/**
 * Lists all file paths changed in a worktree (staged + unstaged + untracked).
 */
export function getChangedFiles(directory: string): Effect.Effect<string[], WorktreeError> {
  return tryWorktree("GET_CHANGED_FILES_FAILED", () => {
    const normalized = resolve(directory)
    const statusOutput = runGit(["status", "--porcelain"], normalized).stdout
    const parsed = parsePorcelainStatus(statusOutput)
    return Array.from(new Set([...parsed.modifiedFiles, ...parsed.stagedFiles, ...parsed.untrackedFiles]))
  })
}

/**
 * Collects aggregate and per-file diff stats for a worktree.
 */
export function getDiffStats(directory: string): Effect.Effect<DiffStats, WorktreeError> {
  return tryWorktree("GET_DIFF_STATS_FAILED", () => {
    const normalized = resolve(directory)
    const output = runGit(["diff", "--numstat", "HEAD"], normalized).stdout
    const fileStats: Record<string, { insertions: number; deletions: number }> = {}
    let filesChanged = 0
    let insertions = 0
    let deletions = 0

    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue

      const [insRaw, delRaw, ...pathParts] = line.split("\t")
      const filePath = pathParts.join("\t").trim()
      if (!filePath) continue

      const ins = insRaw === "-" ? 0 : Number(insRaw)
      const del = delRaw === "-" ? 0 : Number(delRaw)
      const insertionCount = Number.isFinite(ins) ? ins : 0
      const deletionCount = Number.isFinite(del) ? del : 0

      filesChanged += 1
      insertions += insertionCount
      deletions += deletionCount
      fileStats[filePath] = { insertions: insertionCount, deletions: deletionCount }
    }

    return { filesChanged, insertions, deletions, fileStats }
  })
}

/**
 * Lists worktrees from the current repository.
 */
export function listWorktrees(baseDirectory?: string): Effect.Effect<WorktreeInfo[], WorktreeError> {
  return tryWorktree("LIST_WORKTREES_FAILED", () => {
    const base = baseDirectory ? resolve(baseDirectory) : process.cwd()
    const repoRoot = getRepoRoot(base)
    const output = runGit(["worktree", "list", "--porcelain"], repoRoot).stdout
    const parsed = parseWorktreeList(output)
    if (parsed.length === 0) return []

    const main = getMainWorktreeDirectory(repoRoot)
    return parsed.map((item) => ({
      ...item,
      isMain: normalizeDirectory(item.directory) === normalizeDirectory(main),
      baseRef: item.baseRef || item.branch,
    }))
  })
}

/**
 * Creates a git worktree and returns its parsed details.
 */
export function createWorktree(options: CreateWorktreeOptions): Effect.Effect<WorktreeInfo, WorktreeError> {
  return Effect.gen(function* () {
    const prepared = yield* tryWorktree("CREATE_WORKTREE_PREPARE_FAILED", () => {
      const baseDirectory = options.baseDirectory ? resolve(options.baseDirectory) : process.cwd()
      const repoRoot = getRepoRoot(baseDirectory)

      const name = options.name?.trim()
      if (!name) {
        throw new WorktreeError({ message: "Worktree name cannot be empty", code: "INVALID_WORKTREE_NAME" })
      }

      const branch = normalizeBranchName(options.branch) ?? name
      const baseRef = normalizeBranchName(options.baseRef)
      if (!baseRef) {
        throw new WorktreeError({
          message: "No base branch specified for worktree creation. Please configure a branch in task options or global settings.",
          code: "BASE_REF_NOT_SPECIFIED",
        })
      }

      const directory = buildWorktreePath(repoRoot, name, options.worktreeBaseDir)
      if (existsSync(directory)) {
        throw new WorktreeError({ message: `Worktree directory already exists: ${directory}`, code: "WORKTREE_ALREADY_EXISTS" })
      }

      const createArgs = branchExists(branch, repoRoot)
        ? ["worktree", "add", directory, branch]
        : ["worktree", "add", "-b", branch, directory, baseRef]

      try {
        runGit(createArgs, repoRoot)
      } catch (error) {
        if (error instanceof WorktreeError) {
          throw new WorktreeError({ message: `Failed to create worktree '${name}': ${error.message}`, code: "CREATE_WORKTREE_FAILED", gitOutput: error.gitOutput })
        }
        throw error
      }

      return { repoRoot, directory, branch, baseRef }
    })

    const listed = yield* listWorktrees(prepared.repoRoot)
    const normalizedDir = normalizeDirectory(prepared.directory)
    const info = listed.find((item) => normalizeDirectory(item.directory) === normalizedDir)
    if (info) {
      return {
        ...info,
        baseRef: prepared.baseRef,
        branch: info.branch || prepared.branch,
      }
    }

    const head = yield* tryWorktree("CREATE_WORKTREE_HEAD_FAILED", () => runGit(["rev-parse", "HEAD"], prepared.directory).stdout)
    return {
      directory: prepared.directory,
      branch: prepared.branch,
      baseRef: prepared.baseRef,
      isMain: false,
      isBare: false,
      head,
    }
  })
}

/**
 * Returns git status and branch metadata for a specific worktree path.
 */
export function inspectWorktree(directory: string): Effect.Effect<WorktreeStatus, WorktreeError> {
  return Effect.gen(function* () {
    const normalizedDirectory = resolve(directory)
    yield* tryWorktree("INSPECT_WORKTREE_VALIDATE_FAILED", () => {
      if (!existsSync(normalizedDirectory)) {
        throw new WorktreeError({ message: `Worktree directory does not exist: ${normalizedDirectory}`, code: "WORKTREE_NOT_FOUND" })
      }
    })

    const worktrees = yield* listWorktrees(normalizedDirectory)
    const target = worktrees.find((item) => normalizeDirectory(item.directory) === normalizedDirectory)
    if (!target) {
      return yield* new WorktreeError({ message: `Directory is not a tracked git worktree: ${normalizedDirectory}`, code: "NOT_A_WORKTREE" })
    }

    const statusOutput = yield* tryWorktree("INSPECT_WORKTREE_STATUS_FAILED", () => runGit(["status", "--porcelain"], normalizedDirectory).stdout)
    const parsed = parsePorcelainStatus(statusOutput)

    const aheadBehind = yield* tryWorktree(
      "INSPECT_WORKTREE_AHEAD_BEHIND_FAILED",
      () => parseAheadBehind(runGit(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], normalizedDirectory).stdout),
    ).pipe(Effect.catchTag("WorktreeError", () => Effect.succeed(null)))

    return {
      directory: normalizedDirectory,
      branch: target.branch,
      isClean: parsed.modifiedFiles.length === 0 && parsed.stagedFiles.length === 0 && parsed.untrackedFiles.length === 0,
      modifiedFiles: parsed.modifiedFiles,
      stagedFiles: parsed.stagedFiles,
      untrackedFiles: parsed.untrackedFiles,
      aheadBehind,
    }
  })
}

/**
 * Merges a worktree branch back into the target branch.
 */
export function mergeWorktree(options: MergeWorktreeOptions): Effect.Effect<void, WorktreeError> {
  return Effect.gen(function* () {
    const prepared = yield* tryWorktree("MERGE_WORKTREE_PREPARE_FAILED", () => {
      const worktreeDir = resolve(options.worktreeDir)
      const branch = normalizeBranchName(options.branch)
      const targetBranch = normalizeBranchName(options.targetBranch)

      if (!branch) throw new WorktreeError({ message: "Source branch is required", code: "INVALID_BRANCH" })
      if (!targetBranch) throw new WorktreeError({ message: "Target branch is required", code: "INVALID_TARGET_BRANCH" })

      const repoRoot = getRepoRoot(worktreeDir)
      if (!branchExists(branch, repoRoot)) {
        throw new WorktreeError({ message: `Source branch does not exist: ${branch}`, code: "BRANCH_NOT_FOUND" })
      }
      if (!branchExists(targetBranch, repoRoot)) {
        throw new WorktreeError({ message: `Target branch does not exist: ${targetBranch}`, code: "TARGET_BRANCH_NOT_FOUND" })
      }

      return { worktreeDir, branch, targetBranch, repoRoot }
    })

    const worktrees = yield* listWorktrees(prepared.repoRoot)
    const targetWorktree = worktrees.find((item) => item.branch === prepared.targetBranch)
    const mergeDirectory = targetWorktree?.directory ?? prepared.worktreeDir

    if (!targetWorktree) {
      yield* tryWorktree("CHECKOUT_TARGET_BRANCH_FAILED", () => {
        try {
          runGit(["checkout", prepared.targetBranch], mergeDirectory)
        } catch (error) {
          if (error instanceof WorktreeError) {
            throw new WorktreeError({
              message: `Unable to checkout target branch '${prepared.targetBranch}' in ${mergeDirectory}`,
              code: "CHECKOUT_TARGET_BRANCH_FAILED",
              gitOutput: error.gitOutput,
            })
          }
          throw error
        }
      })
    }

    const mergeArgs = ["merge", prepared.branch]
    if (options.noEdit !== false) mergeArgs.push("--no-edit")

    yield* tryWorktree("MERGE_FAILED", () => {
      try {
        runGit(mergeArgs, mergeDirectory)
      } catch (error) {
        if (error instanceof WorktreeError) {
          throw new WorktreeError({
            message: `Failed to merge '${prepared.branch}' into '${prepared.targetBranch}'`,
            code: "MERGE_FAILED",
            gitOutput: error.gitOutput,
          })
        }
        throw error
      }
    })
  })
}

/**
 * Removes a git worktree. Non-existing directories are treated as no-op.
 */
export function removeWorktree(directory: string, force = false): Effect.Effect<void, WorktreeError> {
  return Effect.gen(function* () {
    const normalizedDirectory = resolve(directory)
    yield* tryWorktree("REMOVE_WORKTREE_VALIDATE_FAILED", () => {
      if (!existsSync(normalizedDirectory)) {
        throw new WorktreeError({ message: `Worktree directory does not exist: ${normalizedDirectory}`, code: "WORKTREE_NOT_FOUND" })
      }
    })

    const repoRoot = getRepoRoot(normalizedDirectory)
    const knownWorktrees = yield* listWorktrees(repoRoot)
    const isKnown = knownWorktrees.some((item) => normalizeDirectory(item.directory) === normalizedDirectory)
    if (!isKnown) {
      return yield* new WorktreeError({ message: `Directory is not a tracked git worktree: ${normalizedDirectory}`, code: "NOT_A_WORKTREE" })
    }

    const args = ["worktree", "remove"]
    if (force) args.push("--force")
    args.push(normalizedDirectory)

    yield* tryWorktree("REMOVE_WORKTREE_FAILED", () => {
      try {
        runGit(args, repoRoot)
      } catch (error) {
        if (error instanceof WorktreeError) {
          throw new WorktreeError({ message: `Failed to remove worktree '${normalizedDirectory}'`, code: "REMOVE_WORKTREE_FAILED", gitOutput: error.gitOutput })
        }
        throw error
      }
    })
  })
}

/**
 * High-level worktree lifecycle helper for task/run orchestration.
 */
export class WorktreeLifecycle {
  private readonly baseDirectory: string
  private readonly worktreeBaseDir?: string
  private readonly keepWorktrees: boolean

  constructor(options: WorktreeLifecycleOptions) {
    this.baseDirectory = resolve(options.baseDirectory)
    this.worktreeBaseDir = options.worktreeBaseDir ? resolve(options.worktreeBaseDir) : undefined
    this.keepWorktrees = options.keepWorktrees === true
  }

  /** Creates task worktree with `task-<taskId>-<random>` naming. */
  createForTask(taskId: string, branch?: string, baseRef?: string): Effect.Effect<WorktreeInfo, WorktreeError> {
    const normalizedTaskId = taskId.trim()
    if (!normalizedTaskId) throw new WorktreeError({ message: "taskId cannot be empty", code: "INVALID_TASK_ID" })
    // Add random suffix to ensure unique worktree names for task reruns
    const randomSuffix = Math.random().toString(36).substring(2, 8)
    const name = `task-${normalizedTaskId}-${randomSuffix}`
    return createWorktree({
      name,
      branch,
      baseRef,
      baseDirectory: this.baseDirectory,
      worktreeBaseDir: this.worktreeBaseDir,
    })
  }

  /** Creates run worktree with `<prefix>-<runId>-<random>` naming. */
  createForRun(runId: string, prefix: string, baseRef?: string): Effect.Effect<WorktreeInfo, WorktreeError> {
    const normalizedRunId = runId.trim()
    const normalizedPrefix = prefix.trim()
    if (!normalizedRunId) throw new WorktreeError({ message: "runId cannot be empty", code: "INVALID_RUN_ID" })
    if (!normalizedPrefix) throw new WorktreeError({ message: "prefix cannot be empty", code: "INVALID_PREFIX" })

    // Add random suffix to ensure unique worktree names for run reruns
    const randomSuffix = Math.random().toString(36).substring(2, 8)
    const name = `${normalizedPrefix}-${normalizedRunId}-${randomSuffix}`
    return createWorktree({
      name,
      baseRef,
      baseDirectory: this.baseDirectory,
      worktreeBaseDir: this.worktreeBaseDir,
    })
  }

  /**
   * Completes worktree lifecycle with optional merge and cleanup.
   */
  complete(worktreeDir: string, options: CompleteWorktreeOptions): Effect.Effect<CompleteWorktreeResult, WorktreeError> {
    return Effect.gen(this, function* () {
      let merged = false
      let removed = false

      if (options.shouldMerge) {
        yield* mergeWorktree({
          worktreeDir,
          branch: options.branch,
          targetBranch: options.targetBranch,
        })
        merged = true
      }

      const shouldKeep = this.keepWorktrees || !options.shouldRemove
      if (!shouldKeep) {
        yield* removeWorktree(worktreeDir, true)
        removed = true
      }

      return {
        merged,
        removed,
        kept: shouldKeep,
      }
    })
  }

  /**
   * Removes non-main worktrees that match the optional basename prefix.
   */
  cleanupOrphaned(prefixFilter?: string): Effect.Effect<string[], WorktreeError> {
    return Effect.gen(this, function* () {
      const normalizedPrefix = prefixFilter?.trim()
      const worktrees = yield* listWorktrees(this.baseDirectory)
      const candidates = worktrees.filter((worktree) => {
        if (worktree.isMain) return false
        if (!normalizedPrefix) return true
        return basename(worktree.directory).startsWith(normalizedPrefix)
      })

      return yield* Effect.forEach(candidates, (item) =>
        removeWorktree(item.directory, true).pipe(Effect.as(item.directory)),
      )
    })
  }

  /** Proxies inspect operation. */
  inspect(worktreeDir: string): Effect.Effect<WorktreeStatus, WorktreeError> {
    return inspectWorktree(worktreeDir)
  }

  /**
   * Extracts task ID from a worktree directory name.
   * Names follow pattern: `task-<taskId>-<random>`
   * Returns null if not a task worktree.
   */
  static parseTaskId(worktreeName: string): string | null {
    const match = worktreeName.match(/^task-(.+)-[a-z0-9]+$/)
    return match?.[1] ?? null
  }
}

