#![allow(dead_code)]

use crate::error::{ApiError, ErrorCode};
use git2::{
    build::CheckoutBuilder, BranchType, IndexAddOption, MergeAnalysis, Repository,
    StatusOptions, WorktreeAddOptions, WorktreePruneOptions,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::task;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub directory: String,
    pub branch: String,
    pub base_ref: String,
}

fn sanitize_for_git(value: &str) -> String {
    value
        .trim()
        .replace(|character: char| character.is_whitespace(), "-")
        .chars()
        .map(|character| match character {
            '*' | '?' | '"' | '~' | '^' | ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
}

async fn run_git(cwd: PathBuf, args: Vec<String>) -> Result<String, ApiError> {
    task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(args.iter())
            .current_dir(&cwd)
            .output()
            .map_err(|error| {
                ApiError::internal(format!("Failed to spawn git in {}: {}", cwd.display(), error))
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = [stdout, stderr]
            .into_iter()
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        Err(
            ApiError::internal(format!(
                "Git command failed in {}: {}",
                cwd.display(),
                if combined.is_empty() { "unknown git failure" } else { &combined }
            ))
            .with_code(ErrorCode::ExecutionOperationFailed),
        )
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("Git task join error: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?
}

fn git_failure(message: impl Into<String>) -> ApiError {
    ApiError::internal(message.into()).with_code(ErrorCode::ExecutionOperationFailed)
}

fn git2_failure(context: &str, error: git2::Error) -> ApiError {
    git_failure(format!("{context}: {error}"))
}

fn join_failure(error: task::JoinError) -> ApiError {
    git_failure(format!("Git task join error: {error}"))
}

async fn run_git_blocking<T, F>(operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
{
    task::spawn_blocking(operation).await.map_err(join_failure)?
}

fn discover_repository(base_directory: &Path) -> Result<Repository, ApiError> {
    Repository::discover(base_directory)
        .map_err(|error| git2_failure(&format!("Failed to discover repository from {}", base_directory.display()), error))
}

fn repository_workdir(repository: &Repository) -> Result<PathBuf, ApiError> {
    repository
        .workdir()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| git_failure("Bare repositories are not supported for workflow execution"))
}

fn repo_root_sync(base_directory: &str) -> Result<String, ApiError> {
    let repository = discover_repository(Path::new(base_directory))?;
    Ok(repository_workdir(&repository)?.to_string_lossy().to_string())
}

fn branch_exists_sync(base_directory: &str, branch: &str) -> Result<bool, ApiError> {
    let repository = discover_repository(Path::new(base_directory))?;
    let exists = repository.find_branch(branch, BranchType::Local).is_ok();
    Ok(exists)
}

fn list_branches_sync(base_directory: &str) -> Result<(String, Vec<String>), ApiError> {
    let repository = discover_repository(Path::new(base_directory))?;
    let mut branches = Vec::new();

    let iterator = repository
        .branches(Some(BranchType::Local))
        .map_err(|error| git2_failure("Failed to enumerate local branches", error))?;

    for branch_result in iterator {
        let (branch, _) = branch_result
            .map_err(|error| git2_failure("Failed to read branch entry", error))?;
        if let Some(name) = branch
            .name()
            .map_err(|error| git2_failure("Failed to read branch name", error))?
        {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                branches.push(trimmed.to_string());
            }
        }
    }

    branches.sort();
    branches.dedup();

    let current = repository
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(|value| value.trim().to_string()))
        .unwrap_or_default();

    if !current.is_empty() && !branches.contains(&current) {
        branches.insert(0, current.clone());
    }

    Ok((current, branches))
}

fn resolve_target_branch_sync(
    base_directory: &str,
    task_branch: Option<&str>,
    option_branch: Option<&str>,
) -> Result<String, ApiError> {
    if let Some(branch) = task_branch.map(str::trim).filter(|value| !value.is_empty()) {
        if branch_exists_sync(base_directory, branch)? {
            return Ok(branch.to_string());
        }
    }

    if let Some(branch) = option_branch.map(str::trim).filter(|value| !value.is_empty()) {
        if branch_exists_sync(base_directory, branch)? {
            return Ok(branch.to_string());
        }
    }

    Err(
        ApiError::bad_request(
            "No target branch specified. Configure a branch in task settings or global options before executing.",
        )
        .with_code(ErrorCode::ExecutionOperationFailed),
    )
}

fn checkout_local_branch(repository: &Repository, branch: &str) -> Result<(), ApiError> {
    let refname = format!("refs/heads/{branch}");
    repository
        .find_reference(&refname)
        .map_err(|error| git2_failure(&format!("Failed to find local branch {branch}"), error))?;

    repository
        .set_head(&refname)
        .map_err(|error| git2_failure(&format!("Failed to set HEAD to {refname}"), error))?;

    let mut checkout = CheckoutBuilder::new();
    checkout.force();
    repository
        .checkout_head(Some(&mut checkout))
        .map_err(|error| git2_failure(&format!("Failed to check out branch {branch}"), error))
}

fn create_task_worktree_sync(
    base_directory: &str,
    task_id: &str,
    task_name: &str,
    base_ref: &str,
) -> Result<WorktreeInfo, ApiError> {
    let repository = discover_repository(Path::new(base_directory))?;
    let repo_root = repository_workdir(&repository)?;
    let worktree_base = repo_root.join(".worktrees");
    std::fs::create_dir_all(&worktree_base).map_err(|error| {
        git_failure(format!(
            "Failed to create worktree directory {}: {}",
            worktree_base.display(),
            error
        ))
    })?;

    let name = format!(
        "{}-{}-{}",
        sanitize_for_git(task_name),
        task_id,
        &Uuid::new_v4().to_string()[..6],
    );
    let branch = name.clone();
    let directory = worktree_base.join(&name);

    if directory.exists() {
        return Err(
            ApiError::conflict(format!("Worktree directory already exists: {}", directory.display()))
                .with_code(ErrorCode::ExecutionOperationFailed),
        );
    }

    let base_branch = repository
        .find_branch(base_ref, BranchType::Local)
        .map_err(|error| git2_failure(&format!("Failed to find base branch {base_ref}"), error))?;
    let base_commit = base_branch
        .get()
        .peel_to_commit()
        .map_err(|error| git2_failure(&format!("Failed to resolve commit for branch {base_ref}"), error))?;

    let mut created_branch = repository
        .branch(&branch, &base_commit, false)
        .map_err(|error| git2_failure(&format!("Failed to create worktree branch {branch}"), error))?;

    let mut add_options = WorktreeAddOptions::new();
    add_options.reference(Some(created_branch.get()));

    if let Err(error) = repository.worktree(&name, &directory, Some(&add_options)) {
        let _ = created_branch.delete();
        return Err(git2_failure(
            &format!("Failed to create worktree at {}", directory.display()),
            error,
        ));
    }

    let worktree_repo = Repository::open(&directory).map_err(|error| {
        git2_failure(
            &format!("Failed to open worktree repository {}", directory.display()),
            error,
        )
    })?;
    checkout_local_branch(&worktree_repo, &branch)?;

    Ok(WorktreeInfo {
        directory: directory.to_string_lossy().to_string(),
        branch,
        base_ref: base_ref.to_string(),
    })
}

fn auto_commit_worktree_sync(worktree_dir: &str, task_name: &str, task_id: &str) -> Result<bool, ApiError> {
    let repository = Repository::open(worktree_dir)
        .map_err(|error| git2_failure(&format!("Failed to open worktree repository {worktree_dir}"), error))?;

    let mut status_options = StatusOptions::new();
    status_options.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repository
        .statuses(Some(&mut status_options))
        .map_err(|error| git2_failure("Failed to inspect worktree status", error))?;

    if statuses.is_empty() {
        return Ok(false);
    }

    let mut index = repository
        .index()
        .map_err(|error| git2_failure("Failed to open repository index", error))?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|error| git2_failure("Failed to stage worktree changes", error))?;
    index
        .write()
        .map_err(|error| git2_failure("Failed to write staged changes to index", error))?;

    let tree_id = index
        .write_tree()
        .map_err(|error| git2_failure("Failed to write tree for auto-commit", error))?;
    let tree = repository
        .find_tree(tree_id)
        .map_err(|error| git2_failure("Failed to load auto-commit tree", error))?;

    let signature = repository.signature().map_err(|error| {
        git_failure(format!(
            "Failed to create git signature for auto-commit. Configure user.name and user.email before using auto-commit: {error}"
        ))
    })?;

    let commit_subject = task_name
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(task_id)
        .to_string();
    let commit_body = format!("Automated changes for task {}.", task_id);
    let commit_message = format!("{commit_subject}\n\n{commit_body}");

    let parent_commit = repository
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok());
    let parents = parent_commit.iter().collect::<Vec<_>>();

    repository
        .commit(Some("HEAD"), &signature, &signature, &commit_message, &tree, &parents)
        .map_err(|error| git2_failure("Failed to create auto-commit", error))?;

    Ok(true)
}

fn merge_and_cleanup_worktree_sync(
    base_directory: &str,
    worktree_dir: &str,
    branch: &str,
    target_branch: &str,
    remove_after_merge: bool,
    custom_message: &str,
) -> Result<(), ApiError> {
    let repository = discover_repository(Path::new(base_directory))?;
    checkout_local_branch(&repository, target_branch)?;

    let source_branch = repository
        .find_branch(branch, BranchType::Local)
        .map_err(|error| git2_failure(&format!("Failed to find source branch {branch}"), error))?;
    let source_id = source_branch
        .get()
        .target()
        .ok_or_else(|| git_failure(format!("Source branch {branch} does not point to a commit")))?;
    let source_annotated = repository
        .find_annotated_commit(source_id)
        .map_err(|error| git2_failure(&format!("Failed to resolve annotated commit for {branch}"), error))?;

    let (analysis, _) = repository
        .merge_analysis(&[&source_annotated])
        .map_err(|error| git2_failure("Failed to analyze merge state", error))?;

    if analysis.contains(MergeAnalysis::ANALYSIS_UP_TO_DATE) {
        if remove_after_merge {
            remove_worktree_sync(base_directory, worktree_dir)?;
        }
        return Ok(());
    }

    if analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD) {
        let refname = format!("refs/heads/{target_branch}");
        let mut reference = repository
            .find_reference(&refname)
            .map_err(|error| git2_failure(&format!("Failed to find target branch {target_branch}"), error))?;
        reference
            .set_target(source_id, &format!("Fast-forward {target_branch} to {branch}"))
            .map_err(|error| git2_failure("Failed to update target branch for fast-forward", error))?;
        repository
            .set_head(&refname)
            .map_err(|error| git2_failure(&format!("Failed to set HEAD to {refname}"), error))?;

        let mut checkout = CheckoutBuilder::new();
        checkout.force();
        repository
            .checkout_head(Some(&mut checkout))
            .map_err(|error| git2_failure("Failed to update working tree after fast-forward", error))?;
    } else if analysis.contains(MergeAnalysis::ANALYSIS_NORMAL) {
        let mut checkout = CheckoutBuilder::new();
        checkout.force();
        repository
            .merge(&[&source_annotated], None, Some(&mut checkout))
            .map_err(|error| git2_failure("Failed to merge worktree branch", error))?;

        let mut index = repository
            .index()
            .map_err(|error| git2_failure("Failed to open repository index after merge", error))?;
        if index.has_conflicts() {
            let _ = repository.cleanup_state();
            return Err(
                ApiError::conflict(format!(
                    "Merge conflict detected while merging {branch} into {target_branch}"
                ))
                .with_code(ErrorCode::ExecutionOperationFailed),
            );
        }

        let tree_id = index
            .write_tree_to(&repository)
            .map_err(|error| git2_failure("Failed to write merge tree", error))?;
        let tree = repository
            .find_tree(tree_id)
            .map_err(|error| git2_failure("Failed to load merge tree", error))?;
        let head_commit = repository
            .head()
            .map_err(|error| git2_failure("Failed to resolve HEAD after merge", error))?
            .peel_to_commit()
            .map_err(|error| git2_failure("Failed to resolve target commit after merge", error))?;
        let source_commit = repository
            .find_commit(source_id)
            .map_err(|error| git2_failure("Failed to resolve source commit after merge", error))?;
        let signature = repository.signature().map_err(|error| {
            git_failure(format!(
                "Failed to create git signature for merge commit. Configure user.name and user.email before enabling auto-merge: {error}"
            ))
        })?;
        let message = if custom_message.trim().is_empty() {
            format!("Merge branch '{branch}' into {target_branch}")
        } else {
            custom_message.to_string()
        };

        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                &message,
                &tree,
                &[&head_commit, &source_commit],
            )
            .map_err(|error| git2_failure("Failed to create merge commit", error))?;
        repository
            .cleanup_state()
            .map_err(|error| git2_failure("Failed to clean merge state", error))?;

        let mut final_checkout = CheckoutBuilder::new();
        final_checkout.force();
        repository
            .checkout_head(Some(&mut final_checkout))
            .map_err(|error| git2_failure("Failed to refresh working tree after merge", error))?;
    } else {
        return Err(git_failure(format!(
            "Unsupported merge analysis while merging {branch} into {target_branch}"
        )));
    }

    if remove_after_merge {
        remove_worktree_sync(base_directory, worktree_dir)?;
    }

    Ok(())
}

fn remove_worktree_sync(base_directory: &str, worktree_dir: &str) -> Result<(), ApiError> {
    let repository = discover_repository(Path::new(base_directory))?;
    let worktree_name = Path::new(worktree_dir)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| git_failure(format!("Invalid worktree directory: {worktree_dir}")))?;
    let worktree = repository
        .find_worktree(worktree_name)
        .map_err(|error| git2_failure(&format!("Failed to find worktree {worktree_name}"), error))?;

    let mut prune_options = WorktreePruneOptions::new();
    prune_options.valid(true).locked(true).working_tree(true);
    worktree
        .prune(Some(&mut prune_options))
        .map_err(|error| git2_failure(&format!("Failed to prune worktree {worktree_name}"), error))
}

pub async fn repo_root(base_directory: &str) -> Result<String, ApiError> {
    let base_directory = base_directory.to_string();
    run_git_blocking(move || repo_root_sync(&base_directory)).await
}

pub async fn branch_exists(base_directory: &str, branch: &str) -> Result<bool, ApiError> {
    let base_directory = base_directory.to_string();
    let branch = branch.to_string();
    run_git_blocking(move || branch_exists_sync(&base_directory, &branch)).await
}

pub async fn list_branches(base_directory: &str) -> Result<(String, Vec<String>), ApiError> {
    let base_directory = base_directory.to_string();
    run_git_blocking(move || list_branches_sync(&base_directory)).await
}

pub async fn resolve_target_branch(
    base_directory: &str,
    task_branch: Option<&str>,
    option_branch: Option<&str>,
) -> Result<String, ApiError> {
    let base_directory = base_directory.to_string();
    let task_branch = task_branch.map(ToOwned::to_owned);
    let option_branch = option_branch.map(ToOwned::to_owned);
    run_git_blocking(move || {
        resolve_target_branch_sync(
            &base_directory,
            task_branch.as_deref(),
            option_branch.as_deref(),
        )
    })
    .await
}

pub async fn create_task_worktree(
    base_directory: &str,
    task_id: &str,
    task_name: &str,
    base_ref: &str,
) -> Result<WorktreeInfo, ApiError> {
    let base_directory = base_directory.to_string();
    let task_id = task_id.to_string();
    let task_name = task_name.to_string();
    let base_ref = base_ref.to_string();
    run_git_blocking(move || create_task_worktree_sync(&base_directory, &task_id, &task_name, &base_ref)).await
}

pub async fn auto_commit_worktree(
    worktree_dir: &str,
    task_name: &str,
    task_id: &str,
) -> Result<bool, ApiError> {
    let worktree_dir = worktree_dir.to_string();
    let task_name = task_name.to_string();
    let task_id = task_id.to_string();
    run_git_blocking(move || auto_commit_worktree_sync(&worktree_dir, &task_name, &task_id)).await
}

pub async fn merge_and_cleanup_worktree(
    base_directory: &str,
    worktree_dir: &str,
    branch: &str,
    target_branch: &str,
    remove_after_merge: bool,
    custom_message: &str,
) -> Result<(), ApiError> {
    let base_directory = base_directory.to_string();
    let worktree_dir = worktree_dir.to_string();
    let branch = branch.to_string();
    let target_branch = target_branch.to_string();
    let custom_message = custom_message.to_string();
    run_git_blocking(move || {
        merge_and_cleanup_worktree_sync(
            &base_directory,
            &worktree_dir,
            &branch,
            &target_branch,
            remove_after_merge,
            &custom_message,
        )
    })
    .await
}

pub async fn remove_worktree(base_directory: &str, worktree_dir: &str) -> Result<(), ApiError> {
    let base_directory = base_directory.to_string();
    let worktree_dir = worktree_dir.to_string();
    run_git_blocking(move || remove_worktree_sync(&base_directory, &worktree_dir)).await
}

pub async fn run_shell_command(command: &str, cwd: &str) -> Result<(), ApiError> {
    let command_string = command.to_string();
    let cwd_string = cwd.to_string();

    task::spawn_blocking(move || {
        let output = Command::new("sh")
            .arg("-lc")
            .arg(&command_string)
            .current_dir(&cwd_string)
            .output()
            .map_err(|error| {
                ApiError::internal(format!("Failed to run pre-execution command: {}", error))
                    .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(
            ApiError::internal(format!(
                "Pre-execution command failed in {}: {}",
                cwd_string,
                if stderr.is_empty() { "command exited non-zero" } else { &stderr }
            ))
            .with_code(ErrorCode::ExecutionOperationFailed),
        )
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("Command task join error: {}", error))
            .with_code(ErrorCode::ExecutionOperationFailed)
    })?
}

#[cfg(test)]
mod tests {
    use super::auto_commit_worktree;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use uuid::Uuid;

    fn unique_temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tauroboros-rust-{}-{}", name, Uuid::new_v4()))
    }

    async fn init_repo(repo_dir: &PathBuf) {
        fs::create_dir_all(repo_dir).expect("create temp repo directory");
        let status = Command::new("git")
            .args(["init", "-b", "master"])
            .current_dir(repo_dir)
            .status()
            .expect("init git repo");
        assert!(status.success());
        let status = Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(repo_dir)
            .status()
            .expect("configure git email");
        assert!(status.success());
        let status = Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(repo_dir)
            .status()
            .expect("configure git name");
        assert!(status.success());
        fs::write(repo_dir.join("README.md"), "initial\n").expect("write initial file");
        let status = Command::new("git")
            .args(["add", "README.md"])
            .current_dir(repo_dir)
            .status()
            .expect("stage initial file");
        assert!(status.success());
        let status = Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(repo_dir)
            .status()
            .expect("create initial commit");
        assert!(status.success());
    }

    #[tokio::test]
    async fn auto_commit_worktree_creates_commit_for_modified_files() {
        let repo_dir = unique_temp_dir("auto-commit");
        init_repo(&repo_dir).await;

        fs::write(repo_dir.join("README.md"), "updated\n").expect("update tracked file");

        let committed = auto_commit_worktree(
            repo_dir.to_str().expect("repo path to str"),
            "Implement auto commit",
            "task-1",
        )
        .await
        .expect("auto-commit worktree");

        assert!(committed);

        let output = Command::new("git")
            .args(["log", "-1", "--pretty=%s%n%b"])
            .current_dir(&repo_dir)
            .output()
            .expect("read latest commit");
        assert!(output.status.success());
        let commit_log = String::from_utf8_lossy(&output.stdout).to_string();

        assert!(commit_log.contains("Implement auto commit"));
        assert!(commit_log.contains("Automated changes for task task-1."));

        fs::remove_dir_all(&repo_dir).expect("remove temp repo");
    }

    #[tokio::test]
    async fn auto_commit_worktree_returns_false_when_clean() {
        let repo_dir = unique_temp_dir("auto-commit-clean");
        init_repo(&repo_dir).await;

        let committed = auto_commit_worktree(
            repo_dir.to_str().expect("repo path to str"),
            "No-op task",
            "task-2",
        )
        .await
        .expect("auto-commit clean worktree");

        assert!(!committed);

        fs::remove_dir_all(&repo_dir).expect("remove temp repo");
    }
}