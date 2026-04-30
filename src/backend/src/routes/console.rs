//! Console WebSocket endpoint for interactive shell access
//!
//! Provides a WebSocket endpoint that exposes a PTY (pseudo-terminal)
//! for interactive shell access with full color and terminal support.

use crate::state::AppStateType;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use rocket::futures::{SinkExt, StreamExt};
use rocket::get;
use rocket::tokio::task::spawn_blocking;
use rocket::State;
use rocket::Route;
use rocket::{routes};
use rocket_ws as ws;
use std::io::{Read, Write};
use std::sync::Arc;

/// Find an available system shell, preferring zsh, then bash, then sh
fn find_system_shell() -> String {
    for candidate in ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

// Base64 engine for encoding/decoding
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

/// Message types for WebSocket communication
#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum ConsoleMessage {
    /// Input from client (keyboard)
    Input { data: String },
    /// Output to client (terminal data)
    Output { data: String },
    /// Resize terminal
    Resize { cols: u16, rows: u16 },
    /// Status message
    Status { status: String, shell: String },
    /// Error message
    Error { message: String },
}

/// Handle a single console WebSocket connection
async fn handle_console_stream(
    ws_stream: ws::stream::DuplexStream,
    app_state: AppStateType,
) -> Result<(), String> {
    // Get the project root for the working directory
    let working_dir = app_state.project_root.clone();

    // Create PTY system
    let pty_system = NativePtySystem::default();

    // Determine shell to use (prefer zsh, fall back to bash, then sh)
    let shell = match std::env::var("SHELL") {
        Ok(s) if !s.is_empty() => s,
        _ => find_system_shell(),
    };

    // Open a PTY
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build command to spawn the shell
    let mut cmd_builder = CommandBuilder::new(&shell);
    cmd_builder.cwd(std::path::PathBuf::from(&working_dir));

    // Spawn the shell in the PTY
    let child = pair
        .slave
        .spawn_command(cmd_builder)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Keep the child handle for cleanup
    let child = Arc::new(std::sync::Mutex::new(child));

    // Get sync reader and writer from master
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("Failed to get PTY reader: {}", e))?;
    let writer = pair.master.take_writer().map_err(|e| format!("Failed to get PTY writer: {}", e))?;
    let writer = Arc::new(std::sync::Mutex::new(writer));

    // Keep master for resize operations
    let master = Arc::new(std::sync::Mutex::new(pair.master));

    // Split the WebSocket stream
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Send initial status
    let status_msg = ConsoleMessage::Status {
        status: "ready".to_string(),
        shell: shell.clone(),
    };
    let status_json = serde_json::to_string(&status_msg)
        .map_err(|e| format!("Failed to serialize status: {}", e))?;
    ws_sender
        .send(ws::Message::Text(status_json))
        .await
        .map_err(|e| format!("Failed to send WebSocket message: {}", e))?;

    // Spawn blocking task to read from PTY
    let (tx, mut rx) = rocket::tokio::sync::mpsc::channel::<Vec<u8>>(100);
    
    let pty_reader_handle = spawn_blocking(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    if tx.blocking_send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::debug!("PTY read error: {}", e);
                    break;
                }
            }
        }
    });

    // Spawn task to forward PTY output to WebSocket
    let pty_to_ws = rocket::tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            let encoded = BASE64.encode(&data);
            let msg = ConsoleMessage::Output { data: encoded };
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(_) => continue,
            };
            if ws_sender.send(ws::Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // Handle messages from WebSocket and write to PTY
    let ws_to_pty = rocket::tokio::spawn(async move {
        while let Some(result) = ws_receiver.next().await {
            match result {
                Ok(ws::Message::Text(text)) => {
                    match serde_json::from_str::<ConsoleMessage>(&text) {
                        Ok(ConsoleMessage::Input { data }) => {
                            // Decode base64 input and write to PTY
                            if let Ok(decoded) = BASE64.decode(&data) {
                                // Clone Arc for the blocking task
                                let writer_clone = Arc::clone(&writer);
                                let write_result = spawn_blocking(move || {
                                    let mut w = writer_clone.lock().unwrap();
                                    w.write_all(&decoded).map_err(|e| e.to_string())
                                }).await;
                                
                                if write_result.is_err() {
                                    break;
                                }
                            }
                        }
                        Ok(ConsoleMessage::Resize { cols, rows }) => {
                            // Resize the PTY via the master
                            let master = master.lock().unwrap();
                            let _ = master.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                        _ => {}
                    }
                }
                Ok(ws::Message::Close(_)) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    // Wait for either task to complete
    tokio::select! {
        _ = pty_to_ws => {},
        _ = ws_to_pty => {},
    }

    // Drop the reader handle
    drop(pty_reader_handle);

    // Kill the child process
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    }

    Ok(())
}

#[get("/console")]
fn console_ws(ws: ws::WebSocket, state: &State<AppStateType>) -> ws::Channel<'static> {
    use rocket::futures::FutureExt;
    
    // Clone the Arc to have a 'static lifetime
    let app_state: AppStateType = Arc::clone(state);
    
    ws.channel(move |stream| {
        handle_console_stream(stream, app_state).map(|res| {
            if let Err(e) = &res {
                tracing::error!("Console stream error: {}", e);
            }
            Ok(())
        }).boxed()
    })
}

pub fn routes() -> Vec<Route> {
    routes![console_ws]
}
