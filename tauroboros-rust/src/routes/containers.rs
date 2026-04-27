use crate::db::queries::has_running_workflows;
use crate::error::{ApiError, ApiResult};
use crate::models::*;
use crate::state::AppStateType;
use rocket::serde::json::{json, Json};
use rocket::routes;
use rocket::{delete, get, post, Route};
use rocket::State;

#[get("/api/container/image-status")]
async fn get_container_image_status(_state: &State<AppStateType>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "enabled": false,
        "status": "not_present",
        "message": "Container mode is not enabled in the Rust native backend",
    })))
}

#[get("/api/container/status")]
async fn get_container_status(state: &State<AppStateType>) -> ApiResult<Json<ContainerStatus>> {
    let has_running = has_running_workflows(&state.db).await.unwrap_or(false);
    let status = ContainerStatus {
        enabled: false,
        available: false,
        has_running_workflows: has_running,
        message: "Container mode is not available in the Rust native backend. Use the TypeScript backend for container support.".to_string(),
    };
    Ok(Json(status))
}

#[get("/api/container/profiles")]
async fn get_container_profiles(_state: &State<AppStateType>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "profiles": []
    })))
}

#[get("/api/container/build-status?<limit>")]
async fn get_build_status(_state: &State<AppStateType>, limit: Option<i64>) -> ApiResult<Json<serde_json::Value>> {
    let _ = limit;
    Ok(Json(json!({
        "builds": []
    })))
}

#[post("/api/container/profiles", data = "<_req>")]
async fn create_container_profile(_state: &State<AppStateType>, _req: Json<serde_json::Value>) -> ApiResult<Json<serde_json::Value>> {
    Err(ApiError::bad_request("Container profiles are not available in the Rust native backend"))
}

#[post("/api/container/validate", data = "<_req>")]
async fn validate_container_packages(_state: &State<AppStateType>, _req: Json<serde_json::Value>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "valid": [],
        "invalid": [],
        "suggestions": {},
    })))
}

#[get("/api/container/images")]
async fn get_container_images(_state: &State<AppStateType>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "images": []
    })))
}

#[post("/api/container/validate-image", data = "<_req>")]
async fn validate_image(_state: &State<AppStateType>, _req: Json<serde_json::Value>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "exists": false,
        "tag": null,
        "availableInPodman": false,
        "availableInBuilds": false
    })))
}

#[get("/api/container/dockerfile/<_profile_id>")]
async fn get_dockerfile(_state: &State<AppStateType>, _profile_id: String) -> ApiResult<Json<serde_json::Value>> {
    Err(ApiError::not_found("Container profiles not available"))
}

#[post("/api/container/build", data = "<_req>")]
async fn build_image(_state: &State<AppStateType>, _req: Json<serde_json::Value>) -> ApiResult<Json<serde_json::Value>> {
    Err(ApiError::bad_request("Container builds not available in native mode"))
}

#[post("/api/container/build/cancel", data = "<_req>")]
async fn cancel_build(_state: &State<AppStateType>, _req: Json<serde_json::Value>) -> ApiResult<Json<serde_json::Value>> {
    Err(ApiError::bad_request("Container builds are not available in native mode"))
}

#[delete("/api/container/images/<_tag>")]
async fn delete_image(_state: &State<AppStateType>, _tag: String) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "success": false,
        "message": "Container image deletion is not available in the Rust native backend",
    })))
}

pub fn routes() -> Vec<Route> {
    routes![
        get_container_image_status,
        get_container_status,
        get_container_profiles,
        create_container_profile,
        validate_container_packages,
        get_build_status,
        get_container_images,
        validate_image,
        get_dockerfile,
        build_image,
        cancel_build,
        delete_image,
    ]
}
