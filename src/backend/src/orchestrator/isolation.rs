use crate::error::{ApiError, ErrorCode};
use crate::models::{PathAccessMode, PiSessionKind, SessionIsolationMode, Task, TaskPathGrant};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const ALWAYS_RO_DIRS: &[&str] = &[
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/sbin",
    "/etc/alternatives",
];

const ALWAYS_RO_FILES: &[&str] = &[
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
];

fn expand_tilde(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        if let Some(home) = env::var_os("HOME") {
            let remainder = &path[2..];
            return PathBuf::from(home).join(remainder);
        }
    }
    if path == "~" {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

fn canonicalize_path(path: &str) -> Result<PathBuf, ApiError> {
    let expanded = expand_tilde(path);
    let canonical = expanded.canonicalize().map_err(|e| {
        ApiError::bad_request(format!("Cannot resolve path '{}': {}", path, e))
            .with_code(ErrorCode::InvalidPathGrant)
    })?;
    Ok(canonical)
}

fn parse_task_path_grants(task: &Task) -> Result<Option<Vec<TaskPathGrant>>, ApiError> {
    match task.additional_agent_access.as_deref() {
        Some(raw) => serde_json::from_str::<Option<Vec<TaskPathGrant>>>(raw).map_err(|error| {
            ApiError::bad_request(format!(
                "Task '{}' has invalid additionalAgentAccess data: {}",
                task.name, error
            ))
            .with_code(ErrorCode::InvalidPathGrant)
        }),
        None => Ok(None),
    }
}

fn collapse_duplicates(grants: Vec<PathGrant>) -> Vec<PathGrant> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for grant in grants {
        if seen.insert(grant.path.clone()) {
            result.push(grant);
        }
    }
    result
}

fn discover_bin_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Ok(path) = env::var("PATH") {
        for segment in env::split_paths(&path) {
            let canonical = match segment.canonicalize() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let dir_str = canonical.to_string_lossy().to_string();
            if !dirs.contains(&dir_str) && canonical.exists() {
                dirs.push(dir_str);
            }
        }
    }
    dirs
}

fn system_lib_roots() -> Vec<String> {
    let candidates = [
        "/lib",
        "/lib64",
        "/usr/lib",
        "/usr/lib64",
        "/usr/local/lib",
        "/usr/local/lib64",
        "/opt",
        "/run/current-system/sw", // NixOS
    ];
    let mut roots = Vec::new();
    for candidate in candidates {
        let p = Path::new(candidate);
        if p.exists() {
            roots.push(candidate.to_string());
        }
    }
    roots
}

fn is_planning_kind(kind: PiSessionKind) -> bool {
    matches!(
        kind,
        PiSessionKind::Planning | PiSessionKind::Plan | PiSessionKind::PlanRevision
    )
}

pub fn bubblewrap_available() -> bool {
    Command::new("bwrap")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathGrant {
    pub path: String,
    pub mode: PathAccessMode,
}

#[derive(Debug, Clone)]
pub struct ResolvedIsolationSpec {
    pub mode: SessionIsolationMode,
    pub grants: Vec<PathGrant>,
}

impl ResolvedIsolationSpec {
    pub fn to_grants_json(&self) -> String {
        serde_json::to_string(&self.grants).unwrap_or_default()
    }

    pub fn build_bwrap_argv(&self, inner_argv: &[String]) -> Vec<String> {
        let mut args = vec![
            "bwrap".to_string(),
            "--unshare-ipc".to_string(),
            "--die-with-parent".to_string(),
            "--proc".to_string(),
            "/proc".to_string(),
            "--dev".to_string(),
            "/dev".to_string(),
            "--share-net".to_string(),
        ];

        for grant in &self.grants {
            let flag = match grant.mode {
                PathAccessMode::Ro => "--ro-bind",
                PathAccessMode::Rw => "--bind",
            };
            args.push(flag.to_string());
            args.push(grant.path.clone());
            args.push(grant.path.clone());
        }

        args.push("--setenv".to_string());
        args.push("HOME".to_string());
        args.push({
            let home = env::var("HOME").unwrap_or_else(|_| "/root".to_string());
            home
        });

        args.push("--setenv".to_string());
        args.push("PATH".to_string());
        args.push(env::var("PATH").unwrap_or_default());

        args.push("--".to_string());
        args.extend(inner_argv.iter().cloned());

        args
    }

    pub fn spawn_plan(
        &self,
        inner_executable: &str,
        pi_args: &[String],
    ) -> (String, Vec<String>) {
        match self.mode {
            SessionIsolationMode::None => {
                let mut args = vec![inner_executable.to_string()];
                args.extend(pi_args.iter().cloned());
                (inner_executable.to_string(), pi_args.to_vec())
            }
            SessionIsolationMode::Bubblewrap => {
                let inner_argv = {
                    let mut a = vec![inner_executable.to_string()];
                    a.extend(pi_args.iter().cloned());
                    a
                };
                let bwrap_argv = self.build_bwrap_argv(&inner_argv);
                let executable = bwrap_argv[0].clone();
                let args: Vec<String> = bwrap_argv.into_iter().skip(1).collect();
                (executable, args)
            }
        }
    }
}

pub fn resolve_session_isolation(
    task: &Task,
    session_kind: PiSessionKind,
    project_root: &str,
    bubblewrap_enabled: bool,
) -> Result<ResolvedIsolationSpec, ApiError> {
    if is_planning_kind(session_kind) {
        return Ok(ResolvedIsolationSpec {
            mode: SessionIsolationMode::None,
            grants: vec![],
        });
    }

    if !bubblewrap_enabled {
        return Ok(ResolvedIsolationSpec {
            mode: SessionIsolationMode::None,
            grants: vec![],
        });
    }

    let extra_grants = parse_task_path_grants(task)?;
    let resolved = resolve_full_tree_profile(project_root, extra_grants)?;
    Ok(resolved)
}

pub fn resolve_session_isolation_by_kind(
    session_kind: PiSessionKind,
    project_root: &str,
    bubblewrap_enabled: bool,
) -> Result<ResolvedIsolationSpec, ApiError> {
    if is_planning_kind(session_kind) {
        return Ok(ResolvedIsolationSpec {
            mode: SessionIsolationMode::None,
            grants: vec![],
        });
    }

    if !bubblewrap_enabled {
        return Ok(ResolvedIsolationSpec {
            mode: SessionIsolationMode::None,
            grants: vec![],
        });
    }

    let resolved = resolve_full_tree_profile(project_root, None)?;
    Ok(resolved)
}

pub fn resolve_full_tree_profile(
    project_root: &str,
    extra_grants: Option<Vec<TaskPathGrant>>,
) -> Result<ResolvedIsolationSpec, ApiError> {
    let mut grants = Vec::new();

    let root_canonical = canonicalize_path(project_root)?;
    grants.push(PathGrant {
        path: root_canonical.to_string_lossy().to_string(),
        mode: PathAccessMode::Rw,
    });

    if let Ok(home) = env::var("HOME") {
        let pi_dir = Path::new(&home).join(".pi");
        if pi_dir.exists() {
            grants.push(PathGrant {
                path: pi_dir.to_string_lossy().to_string(),
                mode: PathAccessMode::Ro,
            });
        }
    }

    grants.push(PathGrant {
        path: "/tmp".to_string(),
        mode: PathAccessMode::Rw,
    });

    for dir in ALWAYS_RO_DIRS {
        let p = Path::new(dir);
        if p.exists() {
            grants.push(PathGrant {
                path: dir.to_string(),
                mode: PathAccessMode::Ro,
            });
        }
    }

    for file in ALWAYS_RO_FILES {
        let p = Path::new(file);
        if p.exists() {
            grants.push(PathGrant {
                path: file.to_string(),
                mode: PathAccessMode::Ro,
            });
        }
    }

    let bin_dirs = discover_bin_dirs();
    for dir in &bin_dirs {
        grants.push(PathGrant {
            path: dir.clone(),
            mode: PathAccessMode::Ro,
        });
    }

    // Also mount sibling lib/ directories for each bin dir so that
    // symlinked executables like nvm-installed `pi` resolve correctly.
    // The pi binary (pi -> ../lib/node_modules/.../cli.js) fails with
    // "execvp pi: No such file or directory" when lib/ is not available.
    for bin_dir in &bin_dirs {
        if let Some(parent) = Path::new(bin_dir).parent() {
            let lib_dir = parent.join("lib");
            if lib_dir.exists() {
                let lib_str = lib_dir.to_string_lossy().to_string();
                grants.push(PathGrant {
                    path: lib_str,
                    mode: PathAccessMode::Ro,
                });
            }
        }
    }

    for dir in system_lib_roots() {
        grants.push(PathGrant {
            path: dir,
            mode: PathAccessMode::Ro,
        });
    }

    if let Some(extras) = extra_grants {
        for extra in extras {
            let resolved_path = canonicalize_path(&extra.path)?;
            grants.push(PathGrant {
                path: resolved_path.to_string_lossy().to_string(),
                mode: extra.access,
            });
        }
    }

    grants = collapse_duplicates(grants);

    Ok(ResolvedIsolationSpec {
        mode: SessionIsolationMode::Bubblewrap,
        grants,
    })
}

#[allow(dead_code)]
pub fn validate_extra_grants(grants: &[TaskPathGrant]) -> Result<(), ApiError> {
    for grant in grants {
        let trimmed = grant.path.trim();
        if trimmed.is_empty() {
            return Err(ApiError::bad_request("Path grant must have a non-empty path")
                .with_code(ErrorCode::InvalidPathGrant));
        }

        let is_absolute = Path::new(trimmed).is_absolute();
        let is_tilde = trimmed == "~" || trimmed.starts_with("~/");
        if !is_absolute && !is_tilde {
            return Err(ApiError::bad_request(format!(
                "Path grant '{}' must be an absolute path or start with ~/",
                grant.path
            ))
            .with_code(ErrorCode::InvalidPathGrant));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        BestOfNSubstage, ExecutionPhase, ExecutionStrategy, SelfHealStatus, TaskStatus,
        ThinkingLevel,
    };

    fn make_test_task(additional_agent_access: Option<String>) -> Task {
        Task {
            id: "task1".to_string(),
            name: "task".to_string(),
            idx: 0,
            prompt: "prompt".to_string(),
            branch: None,
            plan_model: None,
            execution_model: None,
            plan_mode: false,
            auto_approve_plan: false,
            review: false,
            auto_commit: false,
            auto_deploy: false,
            auto_deploy_condition: None,
            delete_worktree: true,
            status: TaskStatus::Backlog,
            requirements: Some("[]".to_string()),
            agent_output: String::new(),
            review_count: 0,
            json_parse_retry_count: 0,
            session_id: None,
            session_url: None,
            worktree_dir: None,
            error_message: None,
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            thinking_level: ThinkingLevel::Default,
            plan_thinking_level: ThinkingLevel::Default,
            execution_thinking_level: ThinkingLevel::Default,
            execution_phase: ExecutionPhase::NotStarted,
            awaiting_plan_approval: false,
            plan_revision_count: 0,
            execution_strategy: ExecutionStrategy::Standard,
            best_of_n_config: None,
            best_of_n_substage: BestOfNSubstage::Idle,
            skip_permission_asking: true,
            max_review_runs_override: None,
            smart_repair_hints: None,
            review_activity: "idle".to_string(),
            is_archived: false,
            archived_at: None,
            container_image: None,
            additional_agent_access,
            code_style_review: false,
            group_id: None,
            self_heal_status: SelfHealStatus::Idle,
            self_heal_message: None,
            self_heal_report_id: None,
        }
    }

    #[test]
    fn test_expand_tilde() {
        let home = env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        let expanded = expand_tilde("~/test");
        assert_eq!(expanded, PathBuf::from(&home).join("test"));
    }

    #[test]
    fn test_collapse_duplicates() {
        let grants = vec![
            PathGrant {
                path: "/tmp".to_string(),
                mode: PathAccessMode::Rw,
            },
            PathGrant {
                path: "/tmp".to_string(),
                mode: PathAccessMode::Rw,
            },
            PathGrant {
                path: "/usr".to_string(),
                mode: PathAccessMode::Ro,
            },
        ];
        let collapsed = collapse_duplicates(grants);
        assert_eq!(collapsed.len(), 2);
    }

    #[test]
    fn test_bwrap_argv_generation() {
        let spec = ResolvedIsolationSpec {
            mode: SessionIsolationMode::Bubblewrap,
            grants: vec![
                PathGrant {
                    path: "/repo".to_string(),
                    mode: PathAccessMode::Rw,
                },
                PathGrant {
                    path: "/tmp".to_string(),
                    mode: PathAccessMode::Rw,
                },
            ],
        };
        let inner = vec!["pi".to_string(), "--mode".to_string(), "rpc".to_string()];
        let argv = spec.build_bwrap_argv(&inner);
        assert!(argv[0] == "bwrap");
        assert!(argv.contains(&"--die-with-parent".to_string()));
        assert!(argv.contains(&"--proc".to_string()));
        assert!(argv.contains(&"/proc".to_string()));
        assert!(argv.contains(&"--dev".to_string()));
        assert!(argv.contains(&"/dev".to_string()));
        assert!(argv.contains(&"--bind".to_string()));
        assert!(argv.contains(&"/repo".to_string()));
        assert!(argv.contains(&"--share-net".to_string()));
        assert!(argv.contains(&"--".to_string()));
    }

    #[test]
    fn test_resolve_session_isolation_respects_user_editable_fields() {
        let temp = std::env::temp_dir().join(format!(
            "tauroboros-isolation-fields-{}",
            uuid::Uuid::new_v4()
        ));
        let extra_ro = temp.join("extra_ro");
        let extra_rw = temp.join("extra_rw");

        std::fs::create_dir_all(&extra_ro).expect("create extra_ro");
        std::fs::create_dir_all(&extra_rw).expect("create extra_rw");

        let task = make_test_task(Some(
            serde_json::to_string(&vec![
                TaskPathGrant {
                    path: extra_ro.to_string_lossy().to_string(),
                    access: PathAccessMode::Ro,
                },
                TaskPathGrant {
                    path: extra_rw.to_string_lossy().to_string(),
                    access: PathAccessMode::Rw,
                },
            ])
            .expect("serialize grants"),
        ));

        let spec = resolve_session_isolation(
            &task,
            PiSessionKind::Task,
            temp.to_str().expect("temp path"),
            true,
        )
        .expect("resolve isolation");

        assert_eq!(spec.mode, SessionIsolationMode::Bubblewrap);

        let project_canonical = temp.canonicalize().expect("canonical project root");
        let ro_canonical = extra_ro.canonicalize().expect("canonical ro");
        let rw_canonical = extra_rw.canonicalize().expect("canonical rw");

        assert!(spec.grants.iter().any(|g| {
            g.path == project_canonical.to_string_lossy() && g.mode == PathAccessMode::Rw
        }));
        assert!(spec.grants.iter().any(|g| {
            g.path == ro_canonical.to_string_lossy() && g.mode == PathAccessMode::Ro
        }));
        assert!(spec.grants.iter().any(|g| {
            g.path == rw_canonical.to_string_lossy() && g.mode == PathAccessMode::Rw
        }));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_resolve_session_isolation_respects_global_disable() {
        let temp = std::env::temp_dir();
        let task = make_test_task(None);
        let spec = resolve_session_isolation(
            &task,
            PiSessionKind::Task,
            temp.to_str().expect("temp path"),
            false,
        )
        .expect("resolve isolation");

        assert_eq!(spec.mode, SessionIsolationMode::None);
        assert!(spec.grants.is_empty());
    }

    #[test]
    fn test_resolve_session_isolation_planning_bypass_even_when_enabled() {
        let temp = std::env::temp_dir();
        let task = make_test_task(None);
        let spec = resolve_session_isolation(
            &task,
            PiSessionKind::Plan,
            temp.to_str().expect("temp path"),
            true,
        )
        .expect("resolve isolation");

        assert_eq!(spec.mode, SessionIsolationMode::None);
        assert!(spec.grants.is_empty());
    }

    #[test]
    fn test_resolve_session_isolation_invalid_stored_grants_fails_explicitly() {
        let temp = std::env::temp_dir();
        let task = make_test_task(Some("not-json".to_string()));
        let error = resolve_session_isolation(
            &task,
            PiSessionKind::Task,
            temp.to_str().expect("temp path"),
            true,
        )
        .expect_err("invalid grants should fail");

        match error {
            ApiError::BadRequest { code, .. } => assert_eq!(code, ErrorCode::InvalidPathGrant),
            other => panic!("unexpected error variant: {}", other),
        }
    }

    #[test]
    fn test_spawn_plan_bubblewrap() {
        let spec = ResolvedIsolationSpec {
            mode: SessionIsolationMode::Bubblewrap,
            grants: vec![PathGrant {
                path: "/tmp".to_string(),
                mode: PathAccessMode::Rw,
            }],
        };
        let (executable, args) = spec.spawn_plan("pi", &["--mode".to_string(), "rpc".to_string()]);
        assert_eq!(executable, "bwrap");
        assert!(!args.is_empty());
    }

    #[test]
    fn test_spawn_plan_none() {
        let spec = ResolvedIsolationSpec {
            mode: SessionIsolationMode::None,
            grants: vec![],
        };
        let (executable, args) = spec.spawn_plan("pi", &["--mode".to_string(), "rpc".to_string()]);
        assert_eq!(executable, "pi");
        assert_eq!(args.len(), 2);
    }

    #[test]
    fn test_is_planning_kind() {
        assert!(is_planning_kind(PiSessionKind::Planning));
        assert!(is_planning_kind(PiSessionKind::Plan));
        assert!(is_planning_kind(PiSessionKind::PlanRevision));
        assert!(!is_planning_kind(PiSessionKind::Task));
        assert!(!is_planning_kind(PiSessionKind::ReviewScratch));
    }

    #[test]
    fn test_resolve_planning_bypass() {
        let spec = resolve_session_isolation_by_kind(
            PiSessionKind::Planning,
            "/tmp",
            true,
        )
        .expect("planning bypass should not fail");
        assert_eq!(spec.mode, SessionIsolationMode::None);
    }

    #[test]
    fn test_resolve_bubblewrap_disabled() {
        let spec = resolve_session_isolation_by_kind(
            PiSessionKind::Task,
            "/tmp",
            false,
        )
        .expect("disabled bubblewrap should not fail");
        assert_eq!(spec.mode, SessionIsolationMode::None);
    }

    #[test]
    fn test_resolve_full_tree_profile() {
        let tmp = std::env::temp_dir();
        let spec = resolve_full_tree_profile(
            tmp.to_str().unwrap(),
            None,
        )
        .expect("full tree profile should resolve");
        assert_eq!(spec.mode, SessionIsolationMode::Bubblewrap);
        assert!(spec.grants.iter().any(|g| g.path == "/tmp"));
    }

    #[test]
    fn test_validate_extra_grants_empty_path() {
        let grants = vec![TaskPathGrant {
            path: "".to_string(),
            access: PathAccessMode::Ro,
        }];
        assert!(validate_extra_grants(&grants).is_err());
    }

    #[test]
    fn test_validate_extra_grants_valid() {
        let grants = vec![TaskPathGrant {
            path: "/some/path".to_string(),
            access: PathAccessMode::Rw,
        }];
        assert!(validate_extra_grants(&grants).is_ok());
    }

    #[test]
    fn test_validate_extra_grants_rejects_relative_paths() {
        let grants = vec![TaskPathGrant {
            path: "relative/path".to_string(),
            access: PathAccessMode::Ro,
        }];
        assert!(validate_extra_grants(&grants).is_err());
    }

    #[test]
    fn test_validate_extra_grants_accepts_tilde_prefix() {
        let grants = vec![TaskPathGrant {
            path: "~/allowed".to_string(),
            access: PathAccessMode::Ro,
        }];
        assert!(validate_extra_grants(&grants).is_ok());
    }

    #[test]
    fn test_bubblewrap_available_check_runs() {
        let _ = bubblewrap_available();
    }

    #[test]
    fn test_bubblewrap_integration_starts_and_enforces_ro_rw_grants() {
        if !bubblewrap_available() {
            return;
        }

        let base = std::env::temp_dir().join(format!(
            "tauroboros-bwrap-int-{}",
            uuid::Uuid::new_v4()
        ));
        let ro_dir = base.join("ro");
        let rw_dir = base.join("rw");

        std::fs::create_dir_all(&ro_dir).expect("create ro dir");
        std::fs::create_dir_all(&rw_dir).expect("create rw dir");
        std::fs::write(ro_dir.join("seed.txt"), "seed").expect("write seed file");

        let task = make_test_task(Some(
            serde_json::to_string(&vec![
                TaskPathGrant {
                    path: ro_dir.to_string_lossy().to_string(),
                    access: PathAccessMode::Ro,
                },
                TaskPathGrant {
                    path: rw_dir.to_string_lossy().to_string(),
                    access: PathAccessMode::Rw,
                },
            ])
            .expect("serialize grants"),
        ));

        let spec = resolve_session_isolation(
            &task,
            PiSessionKind::Task,
            base.to_str().expect("base path"),
            true,
        )
        .expect("resolve isolation spec");

        assert_eq!(spec.mode, SessionIsolationMode::Bubblewrap);

        let rw_write_cmd = format!(
            "cat '{}' >/dev/null && echo ok > '{}/from_bwrap.txt'",
            ro_dir.join("seed.txt").display(),
            rw_dir.display()
        );
        let (exe_ok, args_ok) = spec.spawn_plan(
            "sh",
            &["-c".to_string(), rw_write_cmd],
        );
        let ok_output = Command::new(exe_ok)
            .args(args_ok)
            .output()
            .expect("run bwrap write-to-rw command");
        assert!(ok_output.status.success(), "rw command failed: {}", String::from_utf8_lossy(&ok_output.stderr));
        assert!(rw_dir.join("from_bwrap.txt").exists());

        let ro_write_cmd = format!("echo blocked > '{}/blocked.txt'", ro_dir.display());
        let (exe_ro, args_ro) = spec.spawn_plan(
            "sh",
            &["-c".to_string(), ro_write_cmd],
        );
        let ro_output = Command::new(exe_ro)
            .args(args_ro)
            .output()
            .expect("run bwrap write-to-ro command");
        assert!(
            !ro_output.status.success(),
            "expected ro write to fail but it succeeded"
        );
        assert!(!ro_dir.join("blocked.txt").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_bubblewrap_pi_binary_starts() {
        if !bubblewrap_available() {
            return;
        }

        // Find the pi binary — skip test if not available
        let pi_bin = match std::process::Command::new("which")
            .arg("pi")
            .output()
        {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            }
            _ => return, // pi not installed, skip
        };

        if pi_bin.is_empty() {
            return;
        }

        // Resolve the real path (follow symlinks) to catch cases where
        // bubblewrap only mounts bin/ but not lib/ (e.g. nvm symlinks).
        let real_pi = std::fs::canonicalize(&pi_bin)
            .expect("canonicalize pi path");

        let project_root = std::env::temp_dir().join(format!(
            "tauroboros-bwrap-pi-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&project_root).expect("create temp project root");

        let spec = resolve_full_tree_profile(
            project_root.to_str().expect("project root to str"),
            None,
        )
        .expect("resolve full tree profile");

        assert_eq!(spec.mode, SessionIsolationMode::Bubblewrap);

        // Verify pi's real path is covered by at least one grant.
        // This catches the nvm symlink scenario: pi -> ../lib/node_modules/.../cli.js
        // where bin/ is mounted but lib/ (containing the actual file) is not.
        let real_pi_str = real_pi.to_string_lossy().to_string();
        let pi_covered = spec.grants.iter().any(|g| real_pi_str.starts_with(&g.path));
        assert!(
            pi_covered,
            "pi binary at {} is NOT accessible inside bwrap sandbox! \
             The resolve_full_tree_profile grants do not cover its real path. \
             This means bubblewrap task sessions will fail with \
             'bwrap: execvp pi: No such file or directory'. \
             Available grants: {:?}",
            real_pi_str,
            spec.grants.iter().map(|g| &g.path).collect::<Vec<_>>()
        );

        // Run pi --version inside bwrap to confirm it actually starts
        let (executable, args) = spec.spawn_plan(
            "pi",
            &["--version".to_string()],
        );

        let output = std::process::Command::new(&executable)
            .args(&args)
            .output()
            .expect("run pi --version inside bwrap");

        assert!(
            output.status.success(),
            "pi --version failed inside bubblewrap!\n\
             stdout: {}\nstderr: {}\n\
             executable: {}\nargs: {:?}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
            executable,
            args,
        );

        let _ = std::fs::remove_dir_all(&project_root);
    }
}
