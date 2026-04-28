#!/bin/bash

# TaurOboros Development Launcher
# Starts both Rust backend and Solid frontend with graceful shutdown

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse arguments
REBUILD=0
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "TaurOboros Development Launcher"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --rebuild    Force rebuild of Rust backend"
    echo "  --help, -h   Show this help message"
    echo ""
echo "Environment Variables:"
echo "  SERVER_PORT    Backend port (default: dynamically assigned on first start,"
echo "                 then persisted to .tauroboros/settings.json for subsequent runs)"
echo "  DEV_PORT       Frontend port (default: 5173)"
echo ""
echo "Examples:"
echo "  $0                    Start with default ports (dynamic on first boot)"
echo "  $0 --rebuild          Force Rust rebuild"
echo "  SERVER_PORT=4000 $0   Use custom backend port"
exit 0
fi
if [[ "${1:-}" == "--rebuild" ]]; then
    REBUILD=1
fi

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="${SCRIPT_DIR}/src/backend"
FRONTEND_DIR="${SCRIPT_DIR}/src/frontend"
FRONTEND_PORT="${DEV_PORT:-5173}"

# Resolve the Rust backend port:
#   1. If SERVER_PORT is explicitly set by the user (and > 0), use it.
#      SERVER_PORT=0 means "assign dynamically" — treat as unset.
#   2. Otherwise read from .tauroboros/settings.json (if it has a port > 0).
#   3. Otherwise leave empty — the binary will dynamically find a port
#      on first start and persist it to settings.json, then we discover it.
SETTINGS_FILE="${SCRIPT_DIR}/.tauroboros/settings.json"
if [[ -n "${SERVER_PORT:-}" && "${SERVER_PORT:-0}" -gt 0 ]]; then
    RUST_PORT="$SERVER_PORT"
elif [[ -f "$SETTINGS_FILE" ]]; then
    # Parse port from settings.json
    RUST_PORT=$(python3 -c "
import json
try:
    with open('$SETTINGS_FILE') as f:
        s = json.load(f)
    print(s.get('workflow', {}).get('server', {}).get('port', 0))
except:
    print(0)
" 2>/dev/null)
    if [[ -z "$RUST_PORT" || "$RUST_PORT" -eq 0 ]]; then
        RUST_PORT=""   # will be discovered after server starts
    fi
else
    RUST_PORT=""       # first start — binary will discover & persist
fi

# Process IDs
RUST_PID=""
FRONTEND_PID=""

# Cleanup flag to prevent double cleanup
CLEANING_UP=0

# Function to print colored output
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_server() {
    echo -e "${CYAN}[RUST]${NC} $1"
}

log_frontend() {
    echo -e "${CYAN}[SOLID]${NC} $1"
}

# Function to cleanup processes on exit
cleanup() {
    if [[ $CLEANING_UP -eq 1 ]]; then
        return
    fi
    CLEANING_UP=1

    echo ""
    log_info "Shutting down services..."

    # Kill Rust backend
    if [[ -n "$RUST_PID" ]] && kill -0 "$RUST_PID" 2>/dev/null; then
        log_server "Stopping Rust backend (PID: $RUST_PID)..."
        kill -TERM "$RUST_PID" 2>/dev/null || true
        # Wait up to 5 seconds for graceful shutdown
        for i in {1..5}; do
            if ! kill -0 "$RUST_PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done
        # Force kill if still running
        if kill -0 "$RUST_PID" 2>/dev/null; then
            kill -KILL "$RUST_PID" 2>/dev/null || true
        fi
        log_success "Rust backend stopped"
    fi

    # Kill frontend
    if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        log_frontend "Stopping Solid frontend (PID: $FRONTEND_PID)..."
        kill -TERM "$FRONTEND_PID" 2>/dev/null || true
        # Wait up to 5 seconds for graceful shutdown
        for i in {1..5}; do
            if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done
        # Force kill if still running
        if kill -0 "$FRONTEND_PID" 2>/dev/null; then
            kill -KILL "$FRONTEND_PID" 2>/dev/null || true
        fi
        log_success "Solid frontend stopped"
    fi

    # Release ports (kill any remaining processes using these ports)
    log_info "Releasing ports..."
    
    # Find and kill any processes using the Rust port
    if [[ -n "${RUST_PORT:-}" ]]; then
        local rust_port_pids
        rust_port_pids=$(lsof -ti:$RUST_PORT 2>/dev/null || true)
        if [[ -n "$rust_port_pids" ]]; then
            log_warn "Killing processes on port $RUST_PORT: $rust_port_pids"
            echo "$rust_port_pids" | xargs kill -TERM 2>/dev/null || true
            sleep 1
            echo "$rust_port_pids" | xargs kill -KILL 2>/dev/null || true
        fi
    fi
    
    # Find and kill any processes using the frontend port
    local frontend_port_pids
    frontend_port_pids=$(lsof -ti:$FRONTEND_PORT 2>/dev/null || true)
    if [[ -n "$frontend_port_pids" ]]; then
        log_warn "Killing processes on port $FRONTEND_PORT: $frontend_port_pids"
        echo "$frontend_port_pids" | xargs kill -TERM 2>/dev/null || true
        sleep 1
        echo "$frontend_port_pids" | xargs kill -KILL 2>/dev/null || true
    fi

    log_success "All services stopped and ports released"
    echo ""
    exit 0
}

# Set up signal handlers
trap cleanup EXIT
trap cleanup INT

# Function to check if a port is in use
check_port() {
    local port=$1
    if lsof -ti:$port >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to wait for a service to be ready
wait_for_service() {
    local port=$1
    local name=$2
    local max_attempts=30
    local attempt=1

    log_info "Waiting for $name on port $port..."
    
    while [[ $attempt -le $max_attempts ]]; do
        if check_port "$port"; then
            log_success "$name is ready on port $port"
            return 0
        fi
        sleep 1
        ((attempt++))
    done
    
    log_error "$name failed to start on port $port after ${max_attempts}s"
    return 1
}

# Print banner
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      TaurOboros Development Environment Launcher         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check prerequisites
log_info "Checking prerequisites..."

if ! command -v cargo &>/dev/null; then
    log_error "Rust/Cargo not found. Please install Rust: https://rustup.rs/"
    exit 1
fi

if ! command -v npm &>/dev/null; then
    log_error "npm not found. Please install Node.js"
    exit 1
fi

if ! command -v lsof &>/dev/null; then
    log_warn "lsof not found. Port cleanup may not work properly."
fi

log_success "Prerequisites check passed"

# Check if directories exist
if [[ ! -d "$RUST_DIR" ]]; then
    log_error "Rust backend directory '$RUST_DIR' not found"
    exit 1
fi

if [[ ! -d "$FRONTEND_DIR" ]]; then
    log_error "Frontend directory '$FRONTEND_DIR' not found"
    exit 1
fi

# Check if known ports are already in use
if [[ -n "${RUST_PORT:-}" ]] && check_port "$RUST_PORT"; then
    log_warn "Port $RUST_PORT is already in use. Attempting to free it..."
    lsof -ti:$RUST_PORT | xargs kill -TERM 2>/dev/null || true
    sleep 2
fi

if check_port "$FRONTEND_PORT"; then
    log_warn "Port $FRONTEND_PORT is already in use. Attempting to free it..."
    lsof -ti:$FRONTEND_PORT | xargs kill -TERM 2>/dev/null || true
    sleep 2
fi

# Build Rust backend if needed
log_info "Building Rust backend..."
if [[ $REBUILD -eq 1 ]] || [[ ! -f "$RUST_DIR/target/release/tauroboros-server" ]] || [[ $(find "$RUST_DIR/src" -newer "$RUST_DIR/target/release/tauroboros-server" 2>/dev/null | wc -l) -gt 0 ]]; then
    log_info "Compiling Rust backend (this may take a while on first run)..."
    local build_status=0
    (cd "$RUST_DIR" && cargo build --release 2>&1 | while read line; do
        echo -e "${CYAN}[BUILD]${NC} $line"
    done) || build_status=$?
    if [[ $build_status -ne 0 ]]; then
        log_error "Rust build failed"
        exit 1
    fi
    log_success "Rust backend built successfully"
else
    log_success "Rust backend is already built (use $0 --rebuild to force rebuild)"
fi

# Start Rust backend
echo ""
if [[ -n "${RUST_PORT:-}" ]]; then
    log_server "Starting Rust backend on port $RUST_PORT..."
    export SERVER_PORT="$RUST_PORT"
else
    log_server "Starting Rust backend with dynamically assigned port..."
    unset SERVER_PORT
fi
"$RUST_DIR/target/release/tauroboros-server" &
RUST_PID=$!

# Wait for Rust backend and discover the port if needed
if [[ -n "${RUST_PORT:-}" ]]; then
    if ! wait_for_service "$RUST_PORT" "Rust backend"; then
        log_error "Failed to start Rust backend"
        cleanup
        exit 1
    fi
else
    # Dynamic port: wait for settings.json to be written, then read the port
    log_info "Waiting for Rust backend to select a port..."
    RUST_PORT=""
    for i in {1..15}; do
        sleep 1
        if [[ -f "$SETTINGS_FILE" ]]; then
            RUST_PORT=$(python3 -c "
import json
try:
    with open('$SETTINGS_FILE') as f:
        s = json.load(f)
    print(s.get('workflow', {}).get('server', {}).get('port', 0))
except:
    print(0)
" 2>/dev/null)
            if [[ -n "$RUST_PORT" && "$RUST_PORT" -gt 0 ]]; then
                log_success "Rust backend selected port $RUST_PORT"
                break
            fi
        fi
        RUST_PORT=""
    done
    if [[ -z "$RUST_PORT" ]]; then
        log_error "Failed to discover Rust backend port"
        cleanup
        exit 1
    fi
    if ! wait_for_service "$RUST_PORT" "Rust backend"; then
        log_error "Rust backend on port $RUST_PORT is not responding"
        cleanup
        exit 1
    fi
fi

# Check and install frontend dependencies if needed
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    log_warn "Frontend dependencies not found. Installing..."
    (cd "$FRONTEND_DIR" && npm install) || {
        log_error "Failed to install frontend dependencies"
        cleanup
        exit 1
    }
    log_success "Frontend dependencies installed"
fi

# Start Solid frontend
echo ""
log_frontend "Starting Solid frontend on port $FRONTEND_PORT..."
export DEV_PORT="$FRONTEND_PORT"
(cd "$FRONTEND_DIR" && npm run dev) &
FRONTEND_PID=$!

# Wait for frontend
if ! wait_for_service "$FRONTEND_PORT" "Solid frontend"; then
    log_error "Failed to start Solid frontend"
    cleanup
    exit 1
fi

# Print success message
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              All Services Started Successfully!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
log_info "Services running:"
echo "  • Rust Backend:   ${CYAN}http://localhost:${RUST_PORT}${NC}"
echo "  • Solid Frontend: ${CYAN}http://localhost:${FRONTEND_PORT}${NC}"
echo ""
log_info "Press Ctrl+C to stop all services"
echo ""

# Keep script running and show logs
while true; do
    if ! kill -0 "$RUST_PID" 2>/dev/null; then
        log_error "Rust backend has stopped unexpectedly"
        cleanup
        exit 1
    fi
    if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
        log_error "Solid frontend has stopped unexpectedly"
        cleanup
        exit 1
    fi
    sleep 2
done
