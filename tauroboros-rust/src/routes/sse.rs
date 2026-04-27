use rocket::routes;
use crate::state::AppStateType;
use rocket::State;
use rocket::response::stream::{Event, EventStream};
use rocket::{get, Route};
use std::time::Duration;
use tokio::time::interval;

async fn event_stream(state: &State<AppStateType>) -> EventStream![Event + '_] {
    EventStream! {
        // Create SSE connection for the global event stream
        let (conn_id, mut receiver) = {
            let mut hub = state.sse_hub.write().await;
            hub.create_connection(None).await
        };
        
        // Send initial connection open event
        yield Event::json(&serde_json::json!({
            "type": "connected",
            "connectionId": &conn_id,
        })).event("open");
        
        // Setup keepalive
        let mut keepalive = interval(Duration::from_secs(30));
        
        loop {
            tokio::select! {
                _ = keepalive.tick() => {
                    yield Event::json(&serde_json::json!({ "time": chrono::Utc::now().timestamp() })).event("ping");
                }
                Some(event) = receiver.recv() => {
                    let event_type = event.event_type.clone();
                    yield Event::json(&event.data).event(event_type);
                }
                else => {
                    break;
                }
            }
        }
        
        // Cleanup
        let mut hub = state.sse_hub.write().await;
        hub.remove_connection(&conn_id);
    }
}

#[get("/sse")]
async fn sse_stream(state: &State<AppStateType>) -> EventStream![Event + '_] {
    event_stream(state).await
}

#[get("/ws")]
async fn websocket_sse(state: &State<AppStateType>) -> EventStream![Event + '_] {
    event_stream(state).await
}

pub fn routes() -> Vec<Route> {
    routes![
        sse_stream,
        websocket_sse,
    ]
}
