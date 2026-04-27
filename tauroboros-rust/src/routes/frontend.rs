use rocket::http::ContentType;
use rocket::routes;
use rocket::{get, Route};
use std::path::{Path, PathBuf};

#[cfg(feature = "embedded-frontend")]
use include_dir::{include_dir, Dir};

#[cfg(feature = "embedded-frontend")]
static FRONTEND_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../src/kanban-solid/dist");

#[cfg(not(feature = "embedded-frontend"))]
const FRONTEND_DIST_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/kanban-solid/dist");

fn content_type_for(path: &str) -> ContentType {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .and_then(ContentType::from_extension)
        .unwrap_or(ContentType::Binary)
}

#[cfg(feature = "embedded-frontend")]
fn load_frontend_asset(path: &str) -> Option<(ContentType, Vec<u8>)> {
    FRONTEND_DIST.get_file(path).map(|file| {
        let bytes = file.contents().to_vec();
        (content_type_for(path), bytes)
    })
}

#[cfg(not(feature = "embedded-frontend"))]
fn load_frontend_asset(path: &str) -> Option<(ContentType, Vec<u8>)> {
    let absolute_path = Path::new(FRONTEND_DIST_DIR).join(path);
    std::fs::read(&absolute_path)
        .ok()
        .map(|bytes| (content_type_for(path), bytes))
}

fn is_reserved_backend_path(path: &str) -> bool {
    match path.split('/').next() {
        Some("api") | Some("sse") | Some("ws") | Some("healthz") => true,
        _ => false,
    }
}

#[get("/")]
fn index() -> Option<(ContentType, Vec<u8>)> {
    load_frontend_asset("index.html")
}

#[get("/assets/<path..>", rank = 100)]
fn assets(path: PathBuf) -> Option<(ContentType, Vec<u8>)> {
    let relative_path = format!("assets/{}", path.to_string_lossy());
    load_frontend_asset(&relative_path)
}

#[get("/<path..>", rank = 200)]
fn spa_fallback(path: PathBuf) -> Option<(ContentType, Vec<u8>)> {
    let requested = path.to_string_lossy();
    if requested.is_empty() || is_reserved_backend_path(&requested) {
        return None;
    }

    if let Some(asset) = load_frontend_asset(&requested) {
        return Some(asset);
    }

    load_frontend_asset("index.html")
}

pub fn routes() -> Vec<Route> {
    routes![index, assets, spa_fallback]
}