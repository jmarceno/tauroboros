import type { Database } from "bun:sqlite"

export interface Migration {
  version: number
  description: string
  statements: string[]
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
}

export function runMigrations(db: Database, migrations: Migration[]): void {
  ensureMigrationTable(db)

  for (const migration of migrations.sort((a, b) => a.version - b.version)) {
    const alreadyApplied = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(migration.version) as { 1: number } | null

    if (alreadyApplied) continue

    const tx = db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement)
      }
      db
        .prepare("INSERT INTO schema_migrations (version, description) VALUES (?, ?)")
        .run(migration.version, migration.description)
    })

    tx()
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial Pi workflow storage schema",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        idx INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        plan_model TEXT NOT NULL DEFAULT 'default',
        execution_model TEXT NOT NULL DEFAULT 'default',
        planmode INTEGER NOT NULL DEFAULT 0,
        auto_approve_plan INTEGER NOT NULL DEFAULT 0,
        review INTEGER NOT NULL DEFAULT 1,
        auto_commit INTEGER NOT NULL DEFAULT 1,
        delete_worktree INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'backlog',
        requirements TEXT NOT NULL DEFAULT '[]',
        agent_output TEXT NOT NULL DEFAULT '',
        review_count INTEGER NOT NULL DEFAULT 0,
        json_parse_retry_count INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        session_url TEXT,
        worktree_dir TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        thinking_level TEXT NOT NULL DEFAULT 'default',
        execution_phase TEXT NOT NULL DEFAULT 'not_started',
        awaiting_plan_approval INTEGER NOT NULL DEFAULT 0,
        plan_revision_count INTEGER NOT NULL DEFAULT 0,
        execution_strategy TEXT NOT NULL DEFAULT 'standard',
        best_of_n_config TEXT,
        best_of_n_substage TEXT NOT NULL DEFAULT 'idle',
        skip_permission_asking INTEGER NOT NULL DEFAULT 1,
        max_review_runs_override INTEGER,
        smart_repair_hints TEXT,
        review_activity TEXT NOT NULL DEFAULT 'idle',
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_idx ON tasks(idx);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status_idx ON tasks(status, idx);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_execution_strategy ON tasks(execution_strategy);`,
      `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        display_name TEXT NOT NULL DEFAULT '',
        target_task_id TEXT,
        task_order_json TEXT NOT NULL DEFAULT '[]',
        current_task_id TEXT,
        current_task_index INTEGER NOT NULL DEFAULT 0,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        stop_requested INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER,
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        color TEXT NOT NULL DEFAULT '#888888'
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_current_task_id ON workflow_runs(current_task_id);`,
      `
      CREATE TABLE IF NOT EXISTS workflow_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        task_run_id TEXT,
        session_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'starting',
        cwd TEXT NOT NULL,
        worktree_dir TEXT,
        branch TEXT,
        pi_session_id TEXT,
        pi_session_file TEXT,
        process_pid INTEGER,
        model TEXT NOT NULL DEFAULT 'default',
        thinking_level TEXT NOT NULL DEFAULT 'default',
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER,
        exit_code INTEGER,
        exit_signal TEXT,
        error_message TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_task_id ON workflow_sessions(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_status ON workflow_sessions(status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_task_status ON workflow_sessions(task_id, status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_pi_session ON workflow_sessions(pi_session_id);`,
      `
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        session_id TEXT NOT NULL,
        task_id TEXT,
        task_run_id TEXT,
        timestamp INTEGER NOT NULL,
        role TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        model_provider TEXT,
        model_id TEXT,
        agent_name TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tool_name TEXT,
        tool_args_json TEXT,
        tool_result_json TEXT,
        tool_status TEXT,
        edit_diff TEXT,
        edit_file_path TEXT,
        session_status TEXT,
        workflow_phase TEXT,
        raw_event_json TEXT,
        FOREIGN KEY(session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_task_id ON session_messages(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_session_timestamp ON session_messages(session_id, timestamp);`,
      `
      CREATE TABLE IF NOT EXISTS options (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        template_text TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_prompt_templates_key ON prompt_templates(key);`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_templates_active ON prompt_templates(is_active);`,
      `
      CREATE TABLE IF NOT EXISTS prompt_template_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_template_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        template_text TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(prompt_template_id) REFERENCES prompt_templates(id) ON DELETE CASCADE,
        UNIQUE(prompt_template_id, version)
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_template_id ON prompt_template_versions(prompt_template_id);`,
    ],
  },
  {
    version: 2,
    description: "Add task_runs and task_candidates for best-of-n APIs",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        slot_index INTEGER NOT NULL DEFAULT 0,
        attempt_index INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        task_suffix TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT,
        session_url TEXT,
        worktree_dir TEXT,
        summary TEXT,
        error_message TEXT,
        candidate_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_runs_phase ON task_runs(phase);`,
      `CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);`,
      `
      CREATE TABLE IF NOT EXISTS task_candidates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_run_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        diff_stats_json TEXT NOT NULL DEFAULT '{}',
        verification_json TEXT NOT NULL DEFAULT '{}',
        summary TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(worker_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_task_candidates_task_id ON task_candidates(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_candidates_worker_run_id ON task_candidates(worker_run_id);`,
    ],
  },
  {
    version: 3,
    description: "Rebuild session_messages into pi-native event schema",
    statements: [
      `
      CREATE TABLE session_messages_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq INTEGER NOT NULL,
        message_id TEXT,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        role TEXT NOT NULL,
        event_name TEXT,
        message_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        model_provider TEXT,
        model_id TEXT,
        agent_name TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        cost_json TEXT,
        cost_total REAL,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_args_json TEXT,
        tool_result_json TEXT,
        tool_status TEXT,
        edit_diff TEXT,
        edit_file_path TEXT,
        session_status TEXT,
        workflow_phase TEXT,
        raw_event_json TEXT,
        FOREIGN KEY(session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, seq)
      )
      `,
      `
      INSERT INTO session_messages_v3 (
        id,
        seq,
        message_id,
        session_id,
        timestamp,
        role,
        event_name,
        message_type,
        content_json,
        model_provider,
        model_id,
        agent_name,
        prompt_tokens,
        completion_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_json,
        cost_total,
        tool_call_id,
        tool_name,
        tool_args_json,
        tool_result_json,
        tool_status,
        edit_diff,
        edit_file_path,
        session_status,
        workflow_phase,
        raw_event_json
      )
      SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp ASC, id ASC),
        message_id,
        session_id,
        timestamp,
        role,
        NULL,
        message_type,
        content_json,
        model_provider,
        model_id,
        agent_name,
        prompt_tokens,
        completion_tokens,
        NULL,
        NULL,
        total_tokens,
        NULL,
        NULL,
        NULL,
        tool_name,
        tool_args_json,
        tool_result_json,
        tool_status,
        edit_diff,
        edit_file_path,
        session_status,
        workflow_phase,
        raw_event_json
      FROM session_messages
      `,
      `DROP TABLE session_messages;`,
      `ALTER TABLE session_messages_v3 RENAME TO session_messages;`,
      `CREATE INDEX idx_session_messages_session_id ON session_messages(session_id);`,
      `CREATE INDEX idx_session_messages_timestamp ON session_messages(timestamp);`,
      `CREATE INDEX idx_session_messages_session_timestamp ON session_messages(session_id, timestamp);`,
      `CREATE INDEX idx_session_messages_session_seq ON session_messages(session_id, seq);`,
      `CREATE INDEX idx_session_messages_event_name ON session_messages(event_name);`,
      `CREATE INDEX idx_session_messages_tool_call_id ON session_messages(tool_call_id);`,
    ],
  },
  {
    version: 4,
    description: "Add planning_prompts table for customizable planning agent system prompt",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS planning_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL DEFAULT 'default',
        name TEXT NOT NULL DEFAULT 'Default Planning Prompt',
        description TEXT NOT NULL DEFAULT 'System prompt for the planning assistant agent',
        prompt_text TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_planning_prompts_key ON planning_prompts(key);`,
      `CREATE INDEX IF NOT EXISTS idx_planning_prompts_active ON planning_prompts(is_active);`,
      `
      CREATE TABLE IF NOT EXISTS planning_prompt_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        planning_prompt_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(planning_prompt_id) REFERENCES planning_prompts(id) ON DELETE CASCADE,
        UNIQUE(planning_prompt_id, version)
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_planning_prompt_versions_prompt_id ON planning_prompt_versions(planning_prompt_id);`,
    ],
  },
  {
    version: 5,
    description: "Add container_packages and container_builds tables for customizable container image system",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS container_packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        version_constraint TEXT,
        install_order INTEGER DEFAULT 0,
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        source TEXT DEFAULT 'manual'
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_container_packages_category ON container_packages(category);`,
      `CREATE INDEX IF NOT EXISTS idx_container_packages_order ON container_packages(install_order);`,
      `
      CREATE TABLE IF NOT EXISTS container_builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        packages_hash TEXT,
        error_message TEXT,
        image_tag TEXT
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_container_builds_status ON container_builds(status);`,
    ],
  },
  {
    version: 6,
    description: "Add per-model thinking level columns to tasks and options",
    statements: [
      // Add per-model thinking level columns to tasks table
      `ALTER TABLE tasks ADD COLUMN plan_thinking_level TEXT NOT NULL DEFAULT 'default';`,
      `ALTER TABLE tasks ADD COLUMN execution_thinking_level TEXT NOT NULL DEFAULT 'default';`,
      // Add per-model thinking level columns to options
      `INSERT OR REPLACE INTO options (key, value) VALUES ('plan_thinking_level', 'default');`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('execution_thinking_level', 'default');`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('review_thinking_level', 'default');`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('repair_thinking_level', 'default');`,
    ],
  },
  {
    version: 7,
    description: "Add paused_session_states table for workflow pause/resume functionality",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS paused_session_states (
        session_id TEXT PRIMARY KEY,
        task_id TEXT,
        task_run_id TEXT,
        session_kind TEXT NOT NULL,
        cwd TEXT,
        worktree_dir TEXT,
        branch TEXT,
        model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        pi_session_id TEXT,
        pi_session_file TEXT,
        container_id TEXT,
        container_image TEXT,
        paused_at INTEGER NOT NULL,
        last_prompt TEXT,
        execution_phase TEXT,
        context_json TEXT NOT NULL,
        pause_reason TEXT,
        FOREIGN KEY (session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_paused_sessions_task_id ON paused_session_states(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_paused_sessions_session_id ON paused_session_states(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_paused_sessions_paused_at ON paused_session_states(paused_at);`,
    ],
  },
  {
    version: 8,
    description: "Add paused_run_states table for workflow-level pause state storage",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS paused_run_states (
        run_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_order_json TEXT NOT NULL DEFAULT '[]',
        current_task_index INTEGER NOT NULL DEFAULT 0,
        current_task_id TEXT,
        target_task_id TEXT,
        paused_at INTEGER NOT NULL,
        execution_phase TEXT NOT NULL DEFAULT 'executing',
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_paused_run_states_run_id ON paused_run_states(run_id);`,
      `CREATE INDEX IF NOT EXISTS idx_paused_run_states_paused_at ON paused_run_states(paused_at);`,
    ],
  },
  {
    version: 9,
    description: "Add workflow_runs_indicators table for tracking model failure metrics",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS workflow_runs_indicators (
        id TEXT PRIMARY KEY,
        json_out_fails TEXT NOT NULL DEFAULT '{"json-output-fails":[]}',
        FOREIGN KEY (id) REFERENCES workflow_sessions(id) ON DELETE CASCADE
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_indicators_id ON workflow_runs_indicators(id);`,
    ],
  },
  {
    version: 10,
    description: "Add logs column to container_builds for storing build output",
    statements: [
      `ALTER TABLE container_builds ADD COLUMN logs TEXT;`,
    ],
  },
  {
    version: 11,
    description: "Add container_image column to tasks table for per-task image selection",
    statements: [
      `ALTER TABLE tasks ADD COLUMN container_image TEXT;`,
    ],
  },
  {
    version: 12,
    description: "Add code style fields to tasks and options tables",
    statements: [
      `ALTER TABLE tasks ADD COLUMN code_style_review INTEGER NOT NULL DEFAULT 0;`,
      `INSERT OR REPLACE INTO options (key, value) VALUES ('code_style_prompt', '');`,
    ],
  },
  {
    version: 13,
    description: "Set default values for existing tasks code style fields",
    statements: [
      // Ensure all existing tasks have code_style_review = 0 (false)
      `UPDATE tasks SET code_style_review = 0 WHERE code_style_review IS NULL;`,
      // Ensure code_style_prompt exists in options with empty string default
      `INSERT OR REPLACE INTO options (key, value) VALUES ('code_style_prompt', '');`,
    ],
  },
  {
    version: 25,
    description: "Add task_groups and task_group_members tables for task grouping feature",
    statements: [
      // task_groups table
      `
      CREATE TABLE IF NOT EXISTS task_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#888888',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      )
      `,
      // task_group_members table
      `
      CREATE TABLE IF NOT EXISTS task_group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(group_id) REFERENCES task_groups(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE(group_id, task_id)
      )
      `,
      // Indexes for task_groups
      `CREATE INDEX IF NOT EXISTS idx_task_groups_status ON task_groups(status);`,
      `CREATE INDEX IF NOT EXISTS idx_task_groups_name ON task_groups(name);`,
      // Indexes for task_group_members
      `CREATE INDEX IF NOT EXISTS idx_task_group_members_group_id ON task_group_members(group_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_group_members_task_id ON task_group_members(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_task_group_members_group_idx ON task_group_members(group_id, idx);`,
      // Add group_id column to tasks table
      `ALTER TABLE tasks ADD COLUMN group_id TEXT;`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_group_id ON tasks(group_id);`,
      // Add group_id column to workflow_runs table
      `ALTER TABLE workflow_runs ADD COLUMN group_id TEXT;`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_group_id ON workflow_runs(group_id);`,
    ],
  },
  {
    version: 26,
    description: "Migrate telegram_notifications_enabled to telegram_notification_level for granular notification control",
    statements: [
      // Migrate existing boolean value to new level format
      // true -> 'all' (preserve current behavior for users who had notifications enabled)
      // false -> 'failures' (minimum useful level for users who had notifications disabled)
      `UPDATE options SET value = 'all' WHERE key = 'telegram_notifications_enabled' AND value = 'true';`,
      `UPDATE options SET value = 'failures' WHERE key = 'telegram_notifications_enabled' AND value = 'false';`,
      // Delete the old boolean key after migration
      `DELETE FROM options WHERE key = 'telegram_notifications_enabled';`,
    ],
  },
  {
    version: 27,
    description: "Add indexes for archived tasks queries",
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_tasks_is_archived ON tasks(is_archived);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at);`,
    ],
  },
  {
    version: 28,
    description: "Add self-healing task state and self-heal reports",
    statements: [
      `ALTER TABLE tasks ADD COLUMN self_heal_status TEXT NOT NULL DEFAULT 'idle';`,
      `ALTER TABLE tasks ADD COLUMN self_heal_message TEXT;`,
      `ALTER TABLE tasks ADD COLUMN self_heal_report_id TEXT;`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_self_heal_status ON tasks(self_heal_status);`,
      `CREATE TABLE IF NOT EXISTS self_heal_reports (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_status TEXT NOT NULL,
        error_message TEXT,
        diagnostics_summary TEXT NOT NULL,
        root_causes_json TEXT NOT NULL DEFAULT '[]',
        proposed_solution TEXT NOT NULL,
        implementation_plan_json TEXT NOT NULL DEFAULT '[]',
        recoverable INTEGER NOT NULL DEFAULT 0,
        recommended_action TEXT NOT NULL,
        action_rationale TEXT NOT NULL,
        source_mode TEXT NOT NULL,
        source_path TEXT,
        github_url TEXT NOT NULL,
        tauroboros_version TEXT NOT NULL,
        db_path TEXT NOT NULL,
        db_schema_json TEXT NOT NULL,
        raw_response TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );`,
      `CREATE INDEX IF NOT EXISTS idx_self_heal_reports_run_id ON self_heal_reports(run_id);`,
      `CREATE INDEX IF NOT EXISTS idx_self_heal_reports_task_id ON self_heal_reports(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_self_heal_reports_created_at ON self_heal_reports(created_at DESC);`,
    ],
  },
  {
    version: 29,
    description: "Map legacy execution phase values in paused_run_states to current ExecutionPhase enum",
    statements: [
      // Old phases from before the plan-mode ExecutionPhase redesign:
      // "planning"   → "not_started"            (plan not yet finished)
      // "executing"  → "implementation_pending" (task was mid-execution when paused)
      // "reviewing"  → "implementation_done"    (execution finished, review pending)
      // "committing" → "implementation_done"    (about to commit = effectively done)
      `UPDATE paused_run_states SET execution_phase = 'not_started' WHERE execution_phase = 'planning';`,
      `UPDATE paused_run_states SET execution_phase = 'implementation_pending' WHERE execution_phase = 'executing';`,
      `UPDATE paused_run_states SET execution_phase = 'implementation_done' WHERE execution_phase = 'reviewing';`,
      `UPDATE paused_run_states SET execution_phase = 'implementation_done' WHERE execution_phase = 'committing';`,
    ],
  },
  {
    version: 30,
    description: "Add auto deploy fields for template tasks",
    statements: [
      `ALTER TABLE tasks ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE tasks ADD COLUMN auto_deploy_condition TEXT;`,
    ],
  },
]
