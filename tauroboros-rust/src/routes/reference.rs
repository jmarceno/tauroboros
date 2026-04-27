use crate::error::{ApiError, ApiResult};
use crate::models::*;
use crate::orchestrator::git::list_branches;
use crate::state::AppStateType;
use rocket::routes;
use rocket::serde::json::Json;
use rocket::State;
use rocket::{get, Route};
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct RawModelsFile {
    providers: Option<HashMap<String, RawProvider>>,
}

#[derive(Debug, Deserialize)]
struct RawProvider {
    name: Option<String>,
    models: Option<Vec<RawModel>>,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    id: Option<String>,
}

fn model_catalog_candidates(state: &AppStateType) -> Vec<PathBuf> {
    let mut candidates = vec![Path::new(&state.settings_dir).join("agent/models.json")];

    if let Ok(home) = env::var("HOME") {
        candidates.push(Path::new(&home).join(".pi/agent/models.json"));
    }

    candidates
}

fn load_model_catalog_from_path(path: &Path) -> Result<ModelCatalog, ApiError> {
    let raw = fs::read_to_string(path).map_err(|error| {
        ApiError::internal(format!(
            "Failed to read model catalog {}: {error}",
            path.display()
        ))
    })?;

    let parsed: RawModelsFile = serde_json::from_str(&raw).map_err(|error| {
        ApiError::internal(format!(
            "Failed to parse model catalog {}: {error}",
            path.display()
        ))
    })?;

    let mut providers = parsed
        .providers
        .unwrap_or_default()
        .into_iter()
        .map(|(provider_id, provider)| {
            let mut models = provider
                .models
                .unwrap_or_default()
                .into_iter()
                .filter_map(|model| {
                    let model_id = model.id?.trim().to_string();
                    if model_id.is_empty() {
                        return None;
                    }

                    Some(ModelEntry {
                        id: model_id.clone(),
                        label: model_id.clone(),
                        value: format!("{provider_id}/{model_id}"),
                    })
                })
                .collect::<Vec<_>>();

            models.sort_by(|left, right| left.label.cmp(&right.label));

            ModelProvider {
                id: provider_id.clone(),
                name: provider.name.unwrap_or(provider_id),
                models,
            }
        })
        .filter(|provider| !provider.models.is_empty())
        .collect::<Vec<_>>();

    providers.sort_by(|left, right| left.name.cmp(&right.name));

    if providers.is_empty() {
        return Err(ApiError::internal(format!(
            "No models found in {}",
            path.display()
        )));
    }

    Ok(ModelCatalog {
        providers,
        defaults: HashMap::new(),
        warning: None,
    })
}

#[get("/healthz")]
async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
    }))
}

#[get("/api/models")]
async fn get_models(state: &State<AppStateType>) -> ApiResult<Json<ModelCatalog>> {
    for candidate in model_catalog_candidates(state) {
        if candidate.exists() {
            return Ok(Json(load_model_catalog_from_path(&candidate)?));
        }
    }

    Err(ApiError::internal(
        "No model catalog file found in .tauroboros/agent/models.json or ~/.pi/agent/models.json",
    ))
}

#[get("/api/version")]
async fn get_version(_state: &State<AppStateType>) -> ApiResult<Json<VersionInfo>> {
    let version = VersionInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: "unknown".to_string(),
        display_version: format!("{} (Rust)", env!("CARGO_PKG_VERSION")),
        is_compiled: true,
    };
    Ok(Json(version))
}

#[get("/api/branches")]
async fn get_branches(state: &State<AppStateType>) -> ApiResult<Json<BranchList>> {
    let (current, branches) = list_branches(&state.project_root).await?;
    Ok(Json(BranchList { current, branches }))
}

pub fn routes() -> Vec<Route> {
    routes![healthz, get_models, get_version, get_branches,]
}
