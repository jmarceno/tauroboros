use crate::error::{ApiError, ErrorCode};
use include_dir::{include_dir, Dir};
use std::path::Path;

static EMBEDDED_EXTENSIONS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../extensions");
static EMBEDDED_SKILLS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../skills");

#[derive(Debug, Clone, Copy, Default)]
pub struct EmbeddedResourceSummary {
    pub skills_extracted: usize,
    pub extensions_extracted: usize,
}


pub async fn ensure_embedded_pi_resources(
    project_root: &str,
) -> Result<EmbeddedResourceSummary, ApiError> {
    let pi_root = Path::new(project_root).join(".pi");
    let skills_root = pi_root.join("skills");
    let extensions_root = pi_root.join("extensions");

    let skills_extracted =
        extract_directory_skip_existing(&EMBEDDED_SKILLS, &skills_root, "skills").await?;
    let extensions_extracted =
        extract_directory_skip_existing(&EMBEDDED_EXTENSIONS, &extensions_root, "extensions")
            .await?;

    Ok(EmbeddedResourceSummary {
        skills_extracted,
        extensions_extracted,
    })
}

async fn extract_directory_skip_existing(
    embedded_dir: &Dir<'_>,
    destination_root: &Path,
    resource_name: &'static str,
) -> Result<usize, ApiError> {
    tokio::fs::create_dir_all(destination_root)
        .await
        .map_err(|error| create_dir_error(destination_root, resource_name, error))?;

    let mut extracted = 0usize;
    let mut pending = vec![embedded_dir];

    while let Some(current_dir) = pending.pop() {
        for child_dir in current_dir.dirs() {
            let target_dir = destination_root.join(child_dir.path());
            tokio::fs::create_dir_all(&target_dir)
                .await
                .map_err(|error| create_dir_error(&target_dir, resource_name, error))?;
            pending.push(child_dir);
        }

        for file in current_dir.files() {
            let target_path = destination_root.join(file.path());
            let exists = tokio::fs::try_exists(&target_path)
                .await
                .map_err(|error| check_file_error(&target_path, resource_name, error))?;

            if exists {
                continue;
            }

            let parent = target_path.parent().ok_or_else(|| {
                ApiError::internal(format!(
                    "Failed to resolve parent directory for embedded {} file {}",
                    resource_name,
                    target_path.display()
                ))
                .with_code(ErrorCode::ExecutionOperationFailed)
            })?;

            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| create_dir_error(parent, resource_name, error))?;

            tokio::fs::write(&target_path, file.contents())
                .await
                .map_err(|error| write_file_error(&target_path, resource_name, error))?;

            extracted += 1;
        }
    }

    Ok(extracted)
}

fn create_dir_error(path: &Path, resource_name: &'static str, error: std::io::Error) -> ApiError {
    ApiError::internal(format!(
        "Failed to create {} directory {}: {}",
        resource_name,
        path.display(),
        error
    ))
    .with_code(ErrorCode::ExecutionOperationFailed)
}

fn check_file_error(path: &Path, resource_name: &'static str, error: std::io::Error) -> ApiError {
    ApiError::internal(format!(
        "Failed to check embedded {} file {}: {}",
        resource_name,
        path.display(),
        error
    ))
    .with_code(ErrorCode::ExecutionOperationFailed)
}

fn write_file_error(path: &Path, resource_name: &'static str, error: std::io::Error) -> ApiError {
    ApiError::internal(format!(
        "Failed to write embedded {} file {}: {}",
        resource_name,
        path.display(),
        error
    ))
    .with_code(ErrorCode::ExecutionOperationFailed)
}

#[cfg(test)]
mod tests {
    use super::ensure_embedded_pi_resources;
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    fn unique_temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("tauroboros-rust-{}-{}", name, Uuid::new_v4()))
    }

    #[tokio::test]
    async fn extracts_skills_and_extensions_into_dot_pi() {
        let project_root = unique_temp_dir("embedded-resources");
        fs::create_dir_all(&project_root).expect("create temp project root");

        let summary = ensure_embedded_pi_resources(project_root.to_str().expect("project root to str"))
            .await
            .expect("extract embedded resources");

        assert!(summary.skills_extracted > 0);
        assert!(summary.extensions_extracted > 0);
        assert!(project_root.join(".pi/skills/task-debug/SKILL.md").exists());
        assert!(project_root
            .join(".pi/extensions/pi-tools/structured-output.ts")
            .exists());
        assert!(project_root
            .join(".pi/extensions/pi-tools/session-logger.ts")
            .exists());

        fs::remove_dir_all(&project_root).expect("remove temp project root");
    }

    #[tokio::test]
    async fn preserves_existing_skill_and_extension_files() {
        let project_root = unique_temp_dir("preserve-embedded-resources");
        let custom_skill = project_root.join(".pi/skills/task-debug/SKILL.md");
        let custom_ext1 = project_root.join(".pi/extensions/pi-tools/structured-output.ts");
        let custom_ext2 = project_root.join(".pi/extensions/pi-tools/session-logger.ts");

        fs::create_dir_all(custom_skill.parent().expect("skill parent")).expect("create skill dir");
        fs::create_dir_all(custom_ext1.parent().expect("extension parent"))
            .expect("create extension dir");
        fs::write(&custom_skill, "custom skill").expect("write custom skill");
        fs::write(&custom_ext1, "custom extension 1").expect("write custom ext1");
        fs::write(&custom_ext2, "custom extension 2").expect("write custom ext2");

        let summary = ensure_embedded_pi_resources(project_root.to_str().expect("project root to str"))
            .await
            .expect("extract embedded resources without overwrite");

        assert_eq!(fs::read_to_string(&custom_skill).expect("read custom skill"), "custom skill");
        assert_eq!(
            fs::read_to_string(&custom_ext1).expect("read custom ext1"),
            "custom extension 1"
        );
        assert_eq!(
            fs::read_to_string(&custom_ext2).expect("read custom ext2"),
            "custom extension 2"
        );
        assert!(summary.skills_extracted > 0);
        assert_eq!(summary.extensions_extracted, 0);
        assert!(Path::new(&project_root.join(".pi/skills/workflow-task-setup/SKILL.md")).exists());

        fs::remove_dir_all(&project_root).expect("remove temp project root");
    }
}