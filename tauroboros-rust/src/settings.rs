use serde::Deserialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct StartupSettings {
    pub port: u16,
    pub project_root: String,
    pub settings_dir: String,
    pub db_path: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct InfrastructureSettings {
    skills: SkillsSettings,
    project: ProjectSettings,
    workflow: WorkflowSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct SkillsSettings {
    local_path: String,
    auto_load: bool,
    allow_global: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct ProjectSettings {
    name: String,
    r#type: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct WorkflowSettings {
    server: ServerSettings,
    container: ContainerSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct ServerSettings {
    port: u16,
    #[serde(rename = "dbPath")]
    db_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct ContainerSettings {
    enabled: bool,
    #[serde(rename = "piBin")]
    pi_bin: String,
    #[serde(rename = "piArgs")]
    pi_args: String,
    image: String,
    #[serde(rename = "imageSource")]
    image_source: String,
    #[serde(rename = "dockerfilePath")]
    dockerfile_path: String,
    #[serde(rename = "registryUrl")]
    registry_url: Option<String>,
    #[serde(rename = "autoPrepare")]
    auto_prepare: bool,
    #[serde(rename = "memoryMb")]
    memory_mb: i32,
    #[serde(rename = "cpuCount")]
    cpu_count: i32,
    #[serde(rename = "portRangeStart")]
    port_range_start: i32,
    #[serde(rename = "portRangeEnd")]
    port_range_end: i32,
    #[serde(rename = "mountPodmanSocket")]
    mount_podman_socket: bool,
}

impl Default for SkillsSettings {
    fn default() -> Self {
        Self {
            local_path: "./skills".to_string(),
            auto_load: true,
            allow_global: false,
        }
    }
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            name: "tauroboros".to_string(),
            r#type: "workflow".to_string(),
        }
    }
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            port: 3789,
            db_path: ".tauroboros/tasks.db".to_string(),
        }
    }
}

impl Default for ContainerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            pi_bin: "pi".to_string(),
            pi_args: "--mode rpc".to_string(),
            image: "ghcr.io/pi-ai/pi-agent:latest".to_string(),
            image_source: "dockerfile".to_string(),
            dockerfile_path: "docker/pi-agent/Dockerfile".to_string(),
            registry_url: None,
            auto_prepare: true,
            memory_mb: 512,
            cpu_count: 1,
            port_range_start: 30000,
            port_range_end: 40000,
            mount_podman_socket: false,
        }
    }
}

fn resolve_project_root() -> Result<String, String> {
    if let Ok(project_root) = env::var("PROJECT_ROOT") {
        return Ok(project_root);
    }

    env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| format!("Failed to determine current directory: {error}"))
}

fn read_infrastructure_settings(settings_path: &Path) -> Result<InfrastructureSettings, String> {
    if !settings_path.exists() {
        return Ok(InfrastructureSettings::default());
    }

    let raw = fs::read_to_string(settings_path)
        .map_err(|error| format!("Failed to read {}: {error}", settings_path.display()))?;

    serde_json::from_str::<InfrastructureSettings>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", settings_path.display()))
}

fn parse_port_from_env() -> Result<Option<u16>, String> {
    match env::var("SERVER_PORT") {
        Ok(value) => value
            .parse::<u16>()
            .map(Some)
            .map_err(|error| format!("Invalid SERVER_PORT '{value}': {error}")),
        Err(_) => Ok(None),
    }
}

fn resolve_db_path(project_root: &Path, raw_path: &str) -> String {
    let db_path = Path::new(raw_path);
    if db_path.is_absolute() {
        return db_path.to_string_lossy().to_string();
    }

    project_root.join(db_path).to_string_lossy().to_string()
}

pub fn load_startup_settings() -> Result<StartupSettings, String> {
    let project_root = resolve_project_root()?;
    let project_root_path = PathBuf::from(&project_root);
    let settings_dir = project_root_path.join(".tauroboros");
    let settings_path = settings_dir.join("settings.json");
    let infrastructure_settings = read_infrastructure_settings(&settings_path)?;

    let _ = (
        &infrastructure_settings.skills.local_path,
        infrastructure_settings.skills.auto_load,
        infrastructure_settings.skills.allow_global,
        &infrastructure_settings.project.name,
        &infrastructure_settings.project.r#type,
        infrastructure_settings.workflow.container.enabled,
        &infrastructure_settings.workflow.container.pi_bin,
        &infrastructure_settings.workflow.container.pi_args,
        &infrastructure_settings.workflow.container.image,
        &infrastructure_settings.workflow.container.image_source,
        &infrastructure_settings.workflow.container.dockerfile_path,
        &infrastructure_settings.workflow.container.registry_url,
        infrastructure_settings.workflow.container.auto_prepare,
        infrastructure_settings.workflow.container.memory_mb,
        infrastructure_settings.workflow.container.cpu_count,
        infrastructure_settings.workflow.container.port_range_start,
        infrastructure_settings.workflow.container.port_range_end,
        infrastructure_settings
            .workflow
            .container
            .mount_podman_socket,
    );

    let port = parse_port_from_env()?.unwrap_or(infrastructure_settings.workflow.server.port);

    let db_path = env::var("DATABASE_PATH")
        .unwrap_or_else(|_| infrastructure_settings.workflow.server.db_path.clone());

    Ok(StartupSettings {
        port,
        project_root: project_root.clone(),
        settings_dir: settings_dir.to_string_lossy().to_string(),
        db_path: resolve_db_path(&project_root_path, &db_path),
    })
}
