use crate::models::WSMessage;
use std::collections::HashMap;
use tokio::sync::mpsc;

/// SSE event for streaming
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SseEvent {
    pub event_type: String,
    pub data: serde_json::Value,
}

#[allow(dead_code)]
impl SseEvent {
    pub fn new(event_type: impl Into<String>, data: impl Serialize) -> Self {
        let event_type_str = event_type.into();
        let data = match serde_json::to_value(data) {
            Ok(value) => value,
            Err(e) => {
                tracing::error!(
                    event_type = %event_type_str,
                    error = %e,
                    "Failed to serialize SSE event data"
                );
                serde_json::json!({ "error": "serialization_failed" })
            }
        };
        Self {
            event_type: event_type_str,
            data,
        }
    }

    /// Format as SSE message
    pub fn format(&self) -> String {
        let data_str = match serde_json::to_string(&self.data) {
            Ok(json) => json,
            Err(e) => {
                tracing::error!(
                    event_type = %self.event_type,
                    error = %e,
                    "Failed to stringify SSE event data"
                );
                "{}".to_string()
            }
        };
        format!(
            "event: {}\ndata: {}\n\n",
            self.event_type,
            data_str
        )
    }
}

use serde::Serialize;

/// Connection to an SSE client
#[allow(dead_code)]
pub struct SseConnection {
    pub id: String,
    pub session_id: Option<String>,
    pub sender: mpsc::Sender<SseEvent>,
}

/// SSE Hub manages all SSE connections and broadcasts messages
#[allow(dead_code)]
pub struct SseHub {
    connections: HashMap<String, SseConnection>,
    global_listeners: Vec<mpsc::Sender<SseEvent>>,
}

impl SseHub {
    pub fn new() -> Self {
        Self {
            connections: HashMap::new(),
            global_listeners: Vec::new(),
        }
    }

    /// Create a new SSE connection
    pub async fn create_connection(
        &mut self,
        session_id: Option<String>,
    ) -> (String, mpsc::Receiver<SseEvent>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel(100);

        let conn = SseConnection {
            id: id.clone(),
            session_id,
            sender,
        };

        self.connections.insert(id.clone(), conn);
        (id, receiver)
    }

    /// Remove an SSE connection
    pub fn remove_connection(&mut self, connection_id: &str) {
        self.connections.remove(connection_id);
    }

    /// Broadcast a message to all connections
    pub async fn broadcast(&self, message: &WSMessage) {
        let event = match serde_json::to_value(message) {
            Ok(data) => SseEvent {
                event_type: message.r#type.clone(),
                data,
            },
            Err(e) => {
                tracing::error!(
                    event_type = %message.r#type,
                    error = %e,
                    "Failed to serialize message for SSE broadcast"
                );
                return;
            }
        };

        for conn in self.connections.values() {
            if let Err(e) = conn.sender.send(event.clone()).await {
                tracing::debug!(
                    connection_id = %conn.id,
                    error = %e,
                    "Failed to send SSE event to connection - client may have disconnected"
                );
            }
        }
    }

    /// Broadcast to session-specific listeners
    pub async fn broadcast_to_session(&self, session_id: &str, event: SseEvent) {
        for conn in self.connections.values() {
            if conn.session_id.as_ref() == Some(&session_id.to_string()) {
                if let Err(e) = conn.sender.send(event.clone()).await {
                    tracing::debug!(
                        connection_id = %conn.id,
                        session_id = %session_id,
                        error = %e,
                        "Failed to send SSE event to session-specific connection"
                    );
                }
            }
        }
    }

    /// Send status update for a session
    /// Frontend expects event name "session_status" with data format:
    /// {"type":"session_status","sessionId":"...","payload":{...}}
    pub async fn broadcast_status(&self, session_id: &str, status: &str, finished_at: Option<i64>) {
        let event = SseEvent {
            event_type: "session_status".to_string(),
            data: serde_json::json!({
                "type": "session_status",
                "sessionId": session_id,
                "payload": {
                    "sessionId": session_id,
                    "status": status,
                    "finishedAt": finished_at,
                },
            }),
        };
        self.broadcast_to_session(session_id, event).await;
    }

    /// Broadcast a session message globally
    /// Frontend expects event name "session_message" with data format:
    /// {"type":"session_message","sessionId":"...","payload":{...}}
    pub async fn broadcast_message(&self, message: &crate::models::SessionMessage) {
        let event = SseEvent {
            event_type: "session_message".to_string(),
            data: serde_json::json!({
                "type": "session_message",
                "sessionId": message.session_id,
                "payload": message,
            }),
        };

        // Broadcast globally so both global SSE (planning chat) and session-specific
        // SSE (task sessions modal) connections receive the event.
        self.broadcast_to_session(&message.session_id, event.clone()).await;
        self.broadcast(&WSMessage {
            r#type: "session_message".to_string(),
            payload: serde_json::json!({
                "sessionId": message.session_id,
                "message": message,
            }),
        }).await;
    }
}

impl Default for SseHub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::SseHub;
use crate::models::WSMessage;
    use serde_json::json;

    #[tokio::test]
    async fn broadcast_sends_full_ws_message_payload() {
        let mut hub = SseHub::new();
        let (_connection_id, mut receiver) = hub.create_connection(None).await;

        let message = WSMessage {
            r#type: "run_updated".to_string(),
            payload: json!({ "id": "run-1", "status": "running" }),
        };

        hub.broadcast(&message).await;

        let event = receiver.recv().await.expect("receive broadcast event");
        assert_eq!(event.event_type, "run_updated");
        assert_eq!(
            event.data,
            json!({
                "type": "run_updated",
                "payload": { "id": "run-1", "status": "running" }
            })
        );
    }
}
