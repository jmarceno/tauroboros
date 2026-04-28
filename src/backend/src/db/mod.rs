use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::path::Path;
use std::str::FromStr;

pub mod models;
pub mod queries;
pub mod runtime;

pub use models::*;

/// Create a database connection pool
pub async fn create_pool(db_path: &str) -> Result<Pool<Sqlite>, sqlx::Error> {
    // Ensure directory exists
    if let Some(parent) = Path::new(db_path).parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }

    let options = SqliteConnectOptions::from_str(&format!("sqlite:{}", db_path))?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(30));

    SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(options)
        .await
}

/// Run database migrations
pub async fn run_migrations(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    // Note: In a production setup, use sqlx migrate!
    // For now, we assume the database schema already exists from the TypeScript version
    // or create minimal required tables

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            idx INTEGER NOT NULL DEFAULT 0,
            prompt TEXT NOT NULL,
            branch TEXT,
            plan_model TEXT,
            execution_model TEXT,
            planmode INTEGER NOT NULL DEFAULT 0,
            auto_approve_plan INTEGER NOT NULL DEFAULT 0,
            review INTEGER NOT NULL DEFAULT 0,
            auto_commit INTEGER NOT NULL DEFAULT 0,
            auto_deploy INTEGER NOT NULL DEFAULT 0,
            auto_deploy_condition TEXT,
            delete_worktree INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'backlog',
            requirements TEXT,
            agent_output TEXT NOT NULL DEFAULT '',
            review_count INTEGER NOT NULL DEFAULT 0,
            json_parse_retry_count INTEGER NOT NULL DEFAULT 0,
            session_id TEXT,
            session_url TEXT,
            worktree_dir TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            thinking_level TEXT NOT NULL DEFAULT 'default',
            plan_thinking_level TEXT NOT NULL DEFAULT 'default',
            execution_thinking_level TEXT NOT NULL DEFAULT 'default',
            execution_phase TEXT NOT NULL DEFAULT 'not_started',
            awaiting_plan_approval INTEGER NOT NULL DEFAULT 0,
            plan_revision_count INTEGER NOT NULL DEFAULT 0,
            execution_strategy TEXT NOT NULL DEFAULT 'standard',
            best_of_n_config TEXT,
            best_of_n_substage TEXT NOT NULL DEFAULT 'idle',
            skip_permission_asking INTEGER NOT NULL DEFAULT 0,
            max_review_runs_override INTEGER,
            smart_repair_hints TEXT,
            review_activity TEXT NOT NULL DEFAULT 'idle',
            is_archived INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            container_image TEXT,
            code_style_review INTEGER NOT NULL DEFAULT 0,
            group_id TEXT,
            self_heal_status TEXT NOT NULL DEFAULT 'idle',
            self_heal_message TEXT,
            self_heal_report_id TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS workflow_runs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            display_name TEXT NOT NULL,
            target_task_id TEXT,
            task_order TEXT,
            current_task_id TEXT,
            current_task_index INTEGER NOT NULL DEFAULT 0,
            pause_requested INTEGER NOT NULL DEFAULT 0,
            stop_requested INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            finished_at INTEGER,
            is_archived INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            color TEXT NOT NULL,
            group_id TEXT,
            queued_task_count INTEGER,
            executing_task_count INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_runs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            phase TEXT NOT NULL,
            slot_index INTEGER NOT NULL,
            attempt_index INTEGER NOT NULL,
            model TEXT NOT NULL,
            task_suffix TEXT,
            status TEXT NOT NULL,
            session_id TEXT,
            session_url TEXT,
            worktree_dir TEXT,
            summary TEXT,
            error_message TEXT,
            candidate_id TEXT,
            metadata_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_candidates (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            worker_run_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'available',
            changed_files_json TEXT,
            diff_stats_json TEXT,
            verification_json TEXT,
            summary TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS task_group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            idx INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            UNIQUE(group_id, task_id)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS pi_workflow_sessions (
            id TEXT PRIMARY KEY,
            task_id TEXT,
            task_run_id TEXT,
            session_kind TEXT NOT NULL,
            status TEXT NOT NULL,
            cwd TEXT NOT NULL,
            worktree_dir TEXT,
            branch TEXT,
            pi_session_id TEXT,
            pi_session_file TEXT,
            process_pid INTEGER,
            model TEXT NOT NULL,
            thinking_level TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            finished_at INTEGER,
            exit_code INTEGER,
            exit_signal TEXT,
            error_message TEXT,
            name TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS session_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seq INTEGER NOT NULL,
            message_id TEXT,
            session_id TEXT NOT NULL,
            task_id TEXT,
            task_run_id TEXT,
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
            raw_event_json TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            level TEXT NOT NULL,
            source TEXT NOT NULL,
            event_type TEXT NOT NULL,
            message TEXT NOT NULL,
            run_id TEXT,
            task_id TEXT,
            task_run_id TEXT,
            session_id TEXT,
            details_json TEXT NOT NULL DEFAULT '{}'
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS options (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            commit_prompt TEXT NOT NULL DEFAULT '',
            extra_prompt TEXT NOT NULL DEFAULT '',
            branch TEXT NOT NULL DEFAULT '',
            plan_model TEXT NOT NULL DEFAULT '',
            execution_model TEXT NOT NULL DEFAULT '',
            review_model TEXT NOT NULL DEFAULT '',
            repair_model TEXT NOT NULL DEFAULT '',
            command TEXT NOT NULL DEFAULT '',
            parallel_tasks INTEGER NOT NULL DEFAULT 1,
            auto_delete_normal_sessions INTEGER NOT NULL DEFAULT 0,
            auto_delete_review_sessions INTEGER NOT NULL DEFAULT 0,
            show_execution_graph INTEGER NOT NULL DEFAULT 1,
            port INTEGER NOT NULL DEFAULT 3789,
            thinking_level TEXT NOT NULL DEFAULT 'default',
            plan_thinking_level TEXT NOT NULL DEFAULT 'default',
            execution_thinking_level TEXT NOT NULL DEFAULT 'default',
            review_thinking_level TEXT NOT NULL DEFAULT 'default',
            repair_thinking_level TEXT NOT NULL DEFAULT 'default',
            code_style_prompt TEXT NOT NULL DEFAULT '',
            telegram_bot_token TEXT NOT NULL DEFAULT '',
            telegram_chat_id TEXT NOT NULL DEFAULT '',
            telegram_notification_level TEXT NOT NULL DEFAULT 'all',
            max_reviews INTEGER NOT NULL DEFAULT 2,
            max_json_parse_retries INTEGER NOT NULL DEFAULT 5,
            column_sorts TEXT
        )
        "#,
    )
    .execute(pool)
    .await?;

    // Insert default options if not exists
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO options (id) VALUES (1)
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS planning_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            prompt_text TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS planning_prompt_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            planning_prompt_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            prompt_text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(planning_prompt_id) REFERENCES planning_prompts(id) ON DELETE CASCADE,
            UNIQUE(planning_prompt_id, version)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO planning_prompt_versions (planning_prompt_id, version, prompt_text, created_at)
        SELECT p.id, 1, p.prompt_text, p.created_at
        FROM planning_prompts p
        WHERE NOT EXISTS (
            SELECT 1 FROM planning_prompt_versions v WHERE v.planning_prompt_id = p.id
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS prompt_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            template_text TEXT NOT NULL,
            variables_json TEXT NOT NULL DEFAULT '[]',
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;

    let now = chrono::Utc::now().timestamp();

    // Seed default planning prompts (system prompts for chat sessions)
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO planning_prompts (key, name, description, prompt_text, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("default")
    .bind("Default Planning Prompt")
    .bind("System prompt for the planning assistant agent")
    .bind("You are a specialized Planning Assistant for software development task management.\n\nYour role is to help users create well-structured implementation plans before they become kanban tasks.\n\n## Core Capabilities\n\n1. **Task Planning**: Break down complex requirements into actionable, well-defined tasks\n2. **Architecture Design**: Suggest component structures, APIs, and data models\n3. **Dependency Analysis**: Identify task dependencies and execution order\n4. **Estimation Guidance**: Provide complexity assessments and implementation hints\n5. **Visual Explanation**: Use diagrams and visual aids to explain complex concepts\n\n## Interaction Guidelines\n\n- Ask clarifying questions when requirements are ambiguous\n- Suggest concrete next steps and validation approaches\n- Reference existing codebase patterns when relevant\n- Keep responses focused on planning and design\n- Do NOT write actual implementation code unless specifically requested for prototyping\n- **ALWAYS** try to visually explain things when possible using Mermaid charts\n- **NEVER** use ASCII charts or text-based diagrams - always use Mermaid syntax instead\n\n## Visual Explanations with Mermaid\n\nWhen explaining:\n- System architecture or component relationships\n- Data flow between components\n- Task dependencies and execution order\n- State machines or workflows\n- Class hierarchies or module structures\n- Sequence of operations\n\nAlways use Mermaid chart syntax. Examples:\n\n**Flowchart:**\n```mermaid\nflowchart TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Action 1]\n    B -->|No| D[Action 2]\n    C --> E[End]\n    D --> E\n```\n\n**Sequence Diagram:**\n```mermaid\nsequenceDiagram\n    User->>+API: Request\n    API->>+Database: Query\n    Database-->>-API: Results\n    API-->>-User: Response\n```\n\n**Class Diagram:**\n```mermaid\nclassDiagram\n    class User {\n        +String name\n        +login()\n    }\n    class Order {\n        +int id\n        +place()\n    }\n    User \"1\" --> \"*\" Order : has\n```\n\n## Output Format for Task Creation\n\nWhen the user is ready to create tasks, help them structure:\n- Clear task names\n- Detailed prompts with context\n- Suggested task dependencies\n- Recommended execution order\n\n## Tool Access\n\nYou have access to file exploration tools to understand the codebase structure when needed. Use them to provide context-aware planning suggestions.")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO planning_prompts (key, name, description, prompt_text, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("container_config")
    .bind("Container Configuration Prompt")
    .bind("System prompt for the container configuration assistant agent")
    .bind("You are a Container Configuration Assistant helping users customize their Pi Agent container image.\n\nYour goal is to understand what tools the user needs and help them configure the container image accordingly.\n\n## Available Profiles\n\n- **web-dev**: Chrome, Playwright, web testing tools\n  - Packages: chromium, chromium-chromedriver, nss, freetype, harfbuzz, ttf-freefont\n\n- **rust-dev**: Rust compiler, Cargo, build tools\n  - Packages: rust, cargo, build-base, openssl-dev, pkgconfig\n\n- **python-dev**: Python 3, pip, development headers\n  - Packages: python3, py3-pip, python3-dev, gcc, musl-dev\n\n- **data-science**: Python with NumPy/SciPy/pandas support\n  - Extends python-dev, adds: lapack-dev, openblas-dev, libffi-dev\n\n- **go-dev**: Go compiler and standard tools\n  - Packages: go, git, make\n\n- **node-dev**: Additional Node.js development tools\n  - Packages: yarn, npm, nodejs\n\n- **docker-tools**: Tools for working with Docker/Podman\n  - Packages: docker-cli, buildah, skopeo\n\n- **cloud-cli**: AWS, Azure, and GCP CLI tools\n  - Packages: aws-cli, azure-cli, google-cloud-sdk\n\n- **database-tools**: Database clients and tools\n  - Packages: postgresql-client, mysql-client, redis, sqlite\n\n## Capabilities\n\n1. **Recommend profiles** based on user needs and development work\n2. **Suggest specific Alpine packages** for common tools and libraries\n3. **Explain what each package does** and why it's needed\n4. **Validate package names** against Alpine repositories\n5. **Guide users through the build process** and explain what to expect\n\n## Interaction Flow\n\n1. Ask what kind of development work they do\n2. Suggest appropriate profile(s) based on their needs\n3. Ask about specific tools they need\n4. Build package list with explanations\n5. Confirm before they trigger the rebuild\n\n## Package Categories\n\nWhen suggesting packages, categorize them appropriately:\n- **browser**: Chrome, Chromium, and related browser tools\n- **language**: Programming language runtimes and compilers (Rust, Python, Go, etc.)\n- **tool**: CLI tools, utilities, and general purpose software\n- **build**: Build tools, compilers, dev headers, libraries\n- **system**: System libraries, fonts, security tools\n\n## Tips\n\n- Alpine packages are typically lowercase\n- Common prefixes: lib*, py3-*, nodejs-*, *-dev, *-doc\n- When a user mentions a tool, try to suggest the Alpine package name\n- Warn about package availability - some packages may not be in Alpine repos\n- Building can take several minutes - set expectations appropriately\n\n## Response Style\n\nBe conversational but focused. Don't overwhelm with technical details unless asked. Use clear, concise explanations.")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO planning_prompts (key, name, description, prompt_text, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("self_healing")
    .bind("Self-Healing Diagnostics Prompt")
    .bind("System prompt for Tauroboros bug investigation")
    .bind("You are the Tauroboros bug hunter. Investigate if this task failure was caused by a bug in Tauroboros itself.\n\nInspect the Tauroboros source code, not the task worktree.\nAlways check effect-solutions for best practices if the bug involves Effect code.\nDo NOT suggest workflow repairs - only report Tauroboros bugs.\nIf no Tauroboros bug is found, clearly state it's an external issue.\n\nContext:\n- Run ID: {{run_id}}\n- Task ID: {{task_id}}\n- Task Name: {{task_name}}\n- Task Status: {{task_status}}\n- Run Status: {{run_status}}\n- Error Message: {{error_message}}\n- Has Other Active Tasks In Same Run: {{has_other_active_tasks}}\n- DB Path: {{db_path}}\n- TaurOboros Version: {{version}}\n- Is Compiled Binary: {{is_compiled}}\n- GitHub Repository: {{github_url}}\n- Source Mode: {{source_mode}}\n- Source Notes: {{source_notes}}\n\nDatabase Schema (JSON):\n{{schema_json}}\n\nYour mission:\n1) Examine the Tauroboros codebase for bugs that could cause this failure.\n2) Search ~/.local/share/effect-solutions/ for patterns if Effect code is involved.\n3) Identify if this is a Tauroboros bug or an external issue (user code, environment, etc.).\n4) Report findings in the required JSON format.\n\nReturn ONLY this JSON object shape:\n{\n  \"diagnosticsSummary\": \"What was investigated\",\n  \"isTauroborosBug\": true|false,\n  \"rootCause\": {\n    \"description\": \"What the bug is\",\n    \"affectedFiles\": [\"src/.../file.ts\"],\n    \"codeSnippet\": \"relevant code showing the bug\"\n  },\n  \"proposedSolution\": \"How to fix it\",\n  \"implementationPlan\": [\"step 1\", \"step 2\"],\n  \"confidence\": \"high|medium|low\",\n  \"externalFactors\": [\"list of non-Tauroboros causes if not a bug\"]\n}")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("execution")
    .bind("Task Execution")
    .bind("Core implementation prompt for standard execution")
    .bind(
        "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.\n\n{{execution_intro}}\n\nTask:\n{{task.prompt}}\n\n{{approved_plan_block}}\n{{user_guidance_block}}\n{{additional_context_block}}\n\nImplementation requirements:\n- Make concrete code changes in this worktree.\n- Keep changes scoped to the task goals.\n- Validate your result with focused checks before finishing.\n- Report concise progress and outcomes.",
    )
    .bind("[\"task\",\"execution_intro\",\"approved_plan_block\",\"user_guidance_block\",\"additional_context_block\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("planning")
    .bind("Plan Generation")
    .bind("Planning-only prompt used before implementation begins")
    .bind(
        "PREPARE PLAN ONLY. Do not ask follow-up questions. Make reasonable assumptions from the codebase. Output only the plan — do not proceed to implementation.\n\nTask:\n{{task.prompt}}\n\n{{additional_context_block}}\n\nPlan requirements:\n- Break work into clear, ordered implementation steps.\n- Include validation and verification approach.\n- Keep scope aligned to task goals and constraints.",
    )
    .bind("[\"task\",\"additional_context_block\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("plan_revision")
    .bind("Plan Revision")
    .bind("Revises a captured plan using user feedback while staying in planning mode")
    .bind(
        "PREPARE PLAN ONLY. Do not ask follow-up questions. Make reasonable assumptions from the codebase. Output only the plan — do not proceed to implementation.\n\nThe user has reviewed your plan and requested changes. Revise the plan based on feedback.\n\nTask:\n{{task.prompt}}\n\nPrevious plan:\n{{current_plan}}\n\nUser feedback:\n{{revision_feedback}}\n\n{{additional_context_block}}\n\nProvide a revised plan that directly addresses the feedback.",
    )
    .bind("[\"task\",\"current_plan\",\"revision_feedback\",\"additional_context_block\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("commit")
    .bind("Commit")
    .bind("Commit prompt used after successful execution")
    .bind(
        "Finalize the implementation in git.\n\nTarget branch: {{base_ref}}\nTask: {{task_name}} ({{task_id}})\n\n{{keep_worktree_note}}\n\nCreate a clear commit if changes are present and report the result.",
    )
    .bind("[\"base_ref\",\"keep_worktree_note\",\"task_name\",\"task_id\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("review")
    .bind("Review")
    .bind("Strict repository review prompt with JSON output contract")
    .bind(
        "You are the workflow review agent. You are strict and thorough.\n\nReview the current repository state against the task review file named in the user prompt.\nUse that review file as the source of truth for goals and review instructions.\nInspect the codebase and branch state directly.\nDo not rely on prior session history.\nDo not make code changes.\n\nReview the task review file at: {{review_file_path}}\n\nReview Criteria:\n1) Goal completeness: every goal must map to verified working code.\n2) Errors and bugs: logic issues, null handling, boundary failures, race conditions, exceptions.\n3) Security flaws: injection, missing validation, hardcoded secrets, unsafe file/path operations.\n4) Best practices: error handling, type safety, cleanup, edge cases, project conventions.\n5) Test coverage: critical paths and new behavior should be testable and covered.\n\nStrictness directive: default to finding gaps. Only return pass when all goals are complete and no unresolved defects remain.\n\nIMPORTANT: Your FINAL action MUST be to call the emit_review_result tool with the review findings. Do NOT output any text or JSON after calling the tool. The tool will submit your structured result automatically.\n\nCall emit_review_result with: status (\"pass\"|\"gaps_found\"|\"blocked\"), summary (brief findings), gaps (array of specific issues, empty if none), recommendedPrompt (instructions to fix gaps, or \"\" if none).\n\nContext:\nTask ID: {{task.id}}\nTask Name: {{task.name}}",
    )
    .bind("[\"task\",\"review_file_path\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("review_fix")
    .bind("Review Fix")
    .bind("Follow-up prompt that fixes issues identified by review")
    .bind(
        "Address the issues found during review and update the implementation.\n\nTask:\n{{task.prompt}}\n\nReview summary:\n{{review_summary}}\n\nGaps:\n{{review_gaps}}\n\nRequirements:\n- Fix all listed gaps completely.\n- Preserve existing correct behavior.\n- Keep the solution scoped and production-ready.",
    )
    .bind("[\"task\",\"review_summary\",\"review_gaps\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("repair")
    .bind("Repair")
    .bind("Deterministic workflow state repair analysis prompt.")
    .bind(
        "You repair workflow task states.\n\nAnalyze the task state, worktree git status, session history, and latest output. Choose what ACTUALLY happened and the right repair action.\n\nChoose exactly one action:\n- queue_implementation\n- restore_plan_approval\n- reset_backlog\n- mark_done\n- fail_task\n- continue_with_more_reviews\n\nDecision guidelines:\n- Prefer queue_implementation when a usable [plan] exists and worktree shows real code changes.\n- Prefer mark_done only when output and worktree both confirm completion.\n- Use restore_plan_approval when plan should return to human review.\n- Use reset_backlog when there are no meaningful changes and task should restart.\n- Use fail_task when state is invalid and should remain visible with actionable error.\n- Use continue_with_more_reviews when task is stuck only due to review limit and gaps seem fixable.\n\nCritical verification steps:\n1) Check worktree git status.\n2) Check session messages for where execution stopped.\n3) Check workflow session history patterns.\n4) Compare latest output claims with actual worktree changes.\n\nContext:\n{{repair_context}}\n\nYour FINAL action MUST be to call the emit_repair_decision tool with your decision. Do NOT output any text or JSON after calling the tool. Call emit_repair_decision with: action (one of the actions above), reason (why you chose this), errorMessage (only for fail_task).",
    )
    .bind("[\"task\",\"repair_context\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("code_style")
    .bind("Code Style")
    .bind("Code style enforcement agent prompt.")
    .bind(
        "You are a code style enforcement agent. Review the code in the that is changed or/and staged in this repo and apply fixes to ensure compliance.\n\nSTANDARD RULES:\n- Follow existing project conventions\n- Use consistent indentation (match existing files)\n- Remove trailing whitespace\n- Ensure consistent quote style\n- Add missing semicolons where required by the language\n- Fix obvious linting issues\n- Do not touch unchanged files.\n\nAPPROACH:\n1. First, read the relevant source files\n2. Identify any style violations\n3. Use the edit tool to fix all issues\n4. Confirm when complete\n\nIMPORTANT: You must actively use the edit tool to make changes. Do not just report issues - fix them.",
    )
    .bind("[]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("resume_task_continuation")
    .bind("Resume Task Continuation")
    .bind("Prompt to resume a task from where it left off.")
    .bind(
        "Continue from where you left off. You were in the middle of implementing a task. Review what you've done so far and continue with the remaining work.\n\nPrevious context: {{agent_output_snapshot}}",
    )
    .bind("[\"agent_output_snapshot\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("merge_conflict_repair")
    .bind("Merge Conflict Repair")
    .bind("Prompt to resolve merge conflicts during cherry-pick.")
    .bind(
        "A merge conflict occurred when merging branch '{{worktree_branch}}' into '{{target_branch}}'.\n\nGit output:\n{{merge_output}}\n\nYour task is to:\n1. Check the current git status to understand the conflicts\n2. Resolve all merge conflicts by choosing the appropriate changes (prefer the task branch changes when in doubt)\n3. Stage the resolved files\n4. Complete the merge by creating a merge commit\n5. Ensure the merge is successful\n\nRun git commands as needed to resolve the conflicts. After resolving, verify with 'git status' that there are no remaining conflicts.",
    )
    .bind("[\"worktree_branch\",\"target_branch\",\"merge_output\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("task_setup")
    .bind("Task Setup")
    .bind("Prompt to create kanban tasks from planning conversation.")
    .bind(
        "Please use the **workflow-task-setup** skill to create kanban tasks from our planning conversation.\n\n**Instructions:**\n1. Review the conversation history in this session to understand the implementation plan we discussed\n2. Use the workflow-task-setup skill to convert the plan into actionable TaurOboros kanban tasks\n3. Create appropriate tasks with proper dependencies, statuses, and configurations\n\n**API Access Information:**\n- The TaurOboros server is running on port: **{{server_port}}**\n- Base URL: http://localhost:{{server_port}}\n- Use the HTTP API endpoints to create tasks (POST /api/tasks)\n- Use the Task Groups API to organize related tasks (POST /api/task-groups)\n\n**Task Creation Guidelines:**\n- Create small, outcome-based tasks that can be completed independently\n- Set appropriate dependencies where one task truly blocks another\n- Use status \"backlog\" for runnable tasks\n- Include clear, actionable prompts for each task\n- Consider using plan-mode (planmode: true) for tasks that need approval before implementation\n\n**IMPORTANT - Create a Task Group:**\nIf the implementation plan involves multiple related tasks:\n1. Create ALL tasks first using POST /api/tasks\n2. Then create a **Task Group** using POST /api/task-groups with:\n   - \"name\": A descriptive name for the feature/project (e.g., \"Feature X\")\n   - \"color\": A hex color for visual identification (e.g., \"#6366f1\")\n   - \"taskIds\": Array of the created task IDs to add to the group\n3. Use POST /api/task-groups/:id/tasks to add tasks if the group was created without them\n\n**Group Creation Example:**\n```bash\n# Create tasks first\ncurl -X POST http://localhost:{{server_port}}/api/tasks -H \"Content-Type: application/json\" -d '{\"name\": \"Task 1\", \"prompt\": \"Do thing A\", \"status\": \"backlog\"}'\ncurl -X POST http://localhost:{{server_port}}/api/tasks -H \"Content-Type: application/json\" -d '{\"name\": \"Task 2\", \"prompt\": \"Do thing B\", \"status\": \"backlog\"}'\n\n# Create group with tasks\ncurl -X POST http://localhost:{{server_port}}/api/task-groups -H \"Content-Type: application/json\" -d '{\"name\": \"Feature X\", \"color\": \"#6366f1\", \"taskIds\": [\"task-id-1\", \"task-id-2\"]}'\n```\n\nThe group allows you to execute all related tasks together with a single click using the \"Start Group Workflow\" button.",
    )
    .bind("[\"server_port\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("mock_classification")
    .bind("Mock Classification")
    .bind("Prompt to classify messages into categories for mock testing.")
    .bind(
        "Classify the following message into one of these categories: plan, execute, read, review, default\n\nMessage: {message}\n\nCategory (one word only):",
    )
    .bind("[\"message\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("best_of_n_worker")
    .bind("Best-of-N Worker")
    .bind("Worker prompt for candidate implementation generation in best-of-n")
    .bind(
        "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.\n\nYou are one candidate implementation worker in a best-of-n workflow.\nProduce the best complete solution you can in this worktree.\n\nTask:\n{{task.prompt}}\n\n{{additional_context_block}}\n\nWorker metadata:\n- Slot index: {{slot_index}}\n- Model: {{model}}\n- Worker instructions: {{task_suffix}}\n\nDeliver complete implementation and a concise summary of what changed.",
    )
    .bind("[\"task\",\"slot_index\",\"model\",\"task_suffix\",\"additional_context_block\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("best_of_n_reviewer")
    .bind("Best-of-N Reviewer")
    .bind("Reviewer prompt for evaluating best-of-n candidates with strict JSON output")
    .bind(
        "You are a reviewer in a best-of-n workflow.\nYour job is to evaluate the candidate implementations and provide structured guidance.\n\nOriginal Task:\n{{task.prompt}}\n\n{{additional_context_block}}\n\nCandidates:\n{{candidate_summaries}}\n\nYour FINAL action MUST be to call the emit_best_of_n_vote tool with your evaluation. Do NOT output any text or JSON after calling the tool.\n\nCall emit_best_of_n_vote with: status (\"pass\"|\"needs_manual_review\"), summary (evaluation), bestCandidateIds (array of best candidate IDs), gaps (array of issues), recommendedFinalStrategy (\"pick_best\"|\"synthesize\"|\"pick_or_synthesize\"), recommendedPrompt (optional instructions for final applier).\n\nAdditional reviewer instructions:\n{{task_suffix}}",
    )
    .bind("[\"task\",\"candidate_summaries\",\"task_suffix\",\"additional_context_block\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT OR IGNORE INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind("best_of_n_final_applier")
    .bind("Best-of-N Final Applier")
    .bind("Final applier prompt to produce final implementation from best-of-n results")
    .bind(
        "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.\n\nYou are the final applier in a best-of-n workflow.\nProduce the final implementation based on the original task and reviewer guidance.\n\nOriginal Task:\n{{task.prompt}}\n\n{{additional_context_block}}\n\nSelection mode:\n{{selection_mode}}\n\nCandidate guidance:\n{{candidate_guidance}}\n\nRecurring reviewer gaps:\n{{recurring_gaps}}\n\nReviewer recommended prompts:\n{{reviewer_recommended_prompts}}\n\nConsensus reached: {{consensus_reached}}\n\nAdditional final-applier instructions:\n{{task_suffix}}\n\nProduce the final implementation now.",
    )
    .bind("[\"task\",\"selection_mode\",\"candidate_guidance\",\"recurring_gaps\",\"reviewer_recommended_prompts\",\"consensus_reached\",\"task_suffix\",\"additional_context_block\"]")
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS self_heal_reports (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            task_status TEXT NOT NULL,
            error_message TEXT,
            diagnostics_summary TEXT NOT NULL,
            is_tauroboros_bug INTEGER NOT NULL DEFAULT 0,
            root_cause_json TEXT NOT NULL DEFAULT '{}',
            proposed_solution TEXT NOT NULL,
            implementation_plan_json TEXT NOT NULL DEFAULT '[]',
            confidence TEXT NOT NULL DEFAULT 'low',
            external_factors_json TEXT NOT NULL DEFAULT '[]',
            source_mode TEXT NOT NULL,
            source_path TEXT,
            github_url TEXT NOT NULL,
            tauroboros_version TEXT NOT NULL,
            db_path TEXT NOT NULL,
            db_schema_json TEXT NOT NULL,
            raw_response TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
            FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_planning_prompt_versions_prompt_id ON planning_prompt_versions(planning_prompt_id)")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_self_heal_reports_run_id ON self_heal_reports(run_id)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_self_heal_reports_task_id ON self_heal_reports(task_id)",
    )
    .execute(pool)
    .await?;

    Ok(())
}
