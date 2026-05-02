#!/usr/bin/env bash
#
# TaurOboros Install Script
# Compiles the Rust backend (with embedded Solid frontend) and installs
# the binary to a bin directory in PATH.
#
# Usage:
#   ./scripts/install.sh              # Compile and install to ~/.local/bin
#   ./scripts/install.sh --global     # Compile and install to /usr/local/bin
#   ./scripts/install.sh --remove     # Remove from install location
#   ./scripts/install.sh --global --remove  # Remove from global location
#   ./scripts/install.sh --skip-compile    # Skip compilation (install existing build)
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BINARY_NAME="tauroboros"
RUST_DIR="src/backend"
SOURCE_BINARY="${RUST_DIR}/target/release/${BINARY_NAME}"
USER_BIN="${HOME}/.local/bin"
GLOBAL_BIN="/usr/local/bin"

# Parse arguments
INSTALL_GLOBAL=false
REMOVE_MODE=false
SKIP_COMPILE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --global)
      INSTALL_GLOBAL=true
      shift
      ;;
    --remove)
      REMOVE_MODE=true
      shift
      ;;
    --skip-compile)
      SKIP_COMPILE=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --global         Install to /usr/local/bin (requires sudo)"
      echo "  --remove         Remove the binary from install location"
      echo "  --skip-compile   Skip compilation (install existing binary)"
      echo "  --help, -h       Show this help message"
      echo ""
      echo "Default (no flags): Compile and install to ~/.local/bin"
      echo ""
      echo "Prerequisites:"
      echo "  cargo       (https://rustup.rs) - Rust build toolchain"
      echo "  bun         (https://bun.sh)    - Build runner for the embedded frontend"
      echo "  npm         (from Node.js)      - Frontend dependency management"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Run '$0 --help' for usage information"
      exit 1
      ;;
  esac
done

# Determine install location
if [[ "$INSTALL_GLOBAL" == true ]]; then
  INSTALL_DIR="$GLOBAL_BIN"
else
  INSTALL_DIR="$USER_BIN"
fi

TARGET_PATH="${INSTALL_DIR}/${BINARY_NAME}"

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Resolve absolute paths
ABSOLUTE_RUST_DIR="${PROJECT_ROOT}/${RUST_DIR}"
ABSOLUTE_SOURCE_BINARY="${PROJECT_ROOT}/${SOURCE_BINARY}"

# Compile the Rust backend (frontend is built automatically via build.rs)
compile_project() {
  echo -e "${BLUE}🔨 Compiling TaurOboros (Rust backend + embedded frontend)...${NC}"
  echo ""

  cd "$PROJECT_ROOT"

  # Check prerequisites
  if ! command -v cargo &>/dev/null; then
    echo -e "${RED}Error: Cargo is not installed or not in PATH${NC}"
    echo "Please install Rust first: https://rustup.rs"
    exit 1
  fi

  if ! command -v bun &>/dev/null; then
    echo -e "${RED}Error: Bun is not installed or not in PATH${NC}"
    echo "Bun is required to build the embedded frontend (build.rs uses 'bun run build')."
    echo "Please install Bun first: https://bun.sh"
    exit 1
  fi

  if ! command -v npm &>/dev/null; then
    echo -e "${RED}Error: npm is not installed or not in PATH${NC}"
    echo "npm is required for frontend dependency installation."
    echo "Please install Node.js: https://nodejs.org"
    exit 1
  fi

  # Ensure frontend dependencies are installed (needed by build.rs)
  FRONTEND_DIR="${PROJECT_ROOT}/src/frontend"
  if [[ ! -d "${FRONTEND_DIR}/node_modules" ]]; then
    echo -e "${YELLOW}Frontend dependencies not found. Installing...${NC}"
    (cd "$FRONTEND_DIR" && npm install) || {
      echo -e "${RED}Failed to install frontend dependencies${NC}"
      exit 1
    }
    echo -e "${GREEN}✓ Frontend dependencies installed${NC}"
  fi

  # Build Rust backend with embedded frontend
  echo -e "${BLUE}Building Rust backend (this may take a while)...${NC}"
  if ! (cd "$ABSOLUTE_RUST_DIR" && cargo build --release); then
    echo -e "${RED}Rust compilation failed${NC}"
    exit 1
  fi

  echo ""
  echo -e "${GREEN}✓ Compilation successful${NC}"
  echo ""
}

# Compile if not skipping (and not in remove mode)
if [[ "$REMOVE_MODE" == false && "$SKIP_COMPILE" == false ]]; then
  compile_project
fi

# Check if source binary exists (only for install mode)
if [[ "$REMOVE_MODE" == false && ! -f "$ABSOLUTE_SOURCE_BINARY" ]]; then
  echo -e "${RED}Error: Compiled binary not found: ${ABSOLUTE_SOURCE_BINARY}${NC}"
  echo "Compilation may have failed or did not produce the expected binary."
  exit 1
fi

# Create user bin directory if needed
if [[ "$INSTALL_GLOBAL" == false && ! -d "$USER_BIN" ]]; then
  echo -e "${BLUE}Creating ${USER_BIN}...${NC}"
  mkdir -p "$USER_BIN"
fi

# Check if install directory is in PATH
check_path() {
  if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    echo -e "${YELLOW}Warning: ${INSTALL_DIR} is not in your PATH${NC}"
    if [[ "$INSTALL_GLOBAL" == false ]]; then
      echo -e "${YELLOW}Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):${NC}"
      echo -e "${YELLOW}  export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
    fi
    echo ""
  fi
}

# Remove mode
if [[ "$REMOVE_MODE" == true ]]; then
  if [[ -f "$TARGET_PATH" ]]; then
    if [[ "$INSTALL_GLOBAL" == true ]]; then
      echo -e "${BLUE}Removing ${BINARY_NAME} from ${INSTALL_DIR}...${NC}"
      if ! sudo rm -f "$TARGET_PATH"; then
        echo -e "${RED}Failed to remove ${TARGET_PATH}${NC}"
        exit 1
      fi
    else
      echo -e "${BLUE}Removing ${BINARY_NAME} from ${INSTALL_DIR}...${NC}"
      rm -f "$TARGET_PATH"
    fi
    echo -e "${GREEN}✓ ${BINARY_NAME} removed successfully${NC}"
  else
    echo -e "${YELLOW}${BINARY_NAME} is not installed at ${TARGET_PATH}${NC}"
  fi
  exit 0
fi

# Check for existing installation and get confirmation if replacing
if [[ -f "$TARGET_PATH" ]]; then
  echo -e "${YELLOW}${BINARY_NAME} is already installed at ${TARGET_PATH}${NC}"
  echo -e "${BLUE}Replacing with new version...${NC}"
fi

# Install the binary
echo -e "${BLUE}Installing ${BINARY_NAME} to ${INSTALL_DIR}...${NC}"

if [[ "$INSTALL_GLOBAL" == true ]]; then
  # Global install requires sudo
  if ! sudo cp "$ABSOLUTE_SOURCE_BINARY" "$TARGET_PATH"; then
    echo -e "${RED}Failed to install to ${INSTALL_DIR}${NC}"
    echo "Make sure you have sudo privileges"
    exit 1
  fi
  sudo chmod +x "$TARGET_PATH"
else
  # User-local install
  if ! cp "$ABSOLUTE_SOURCE_BINARY" "$TARGET_PATH"; then
    echo -e "${RED}Failed to install to ${INSTALL_DIR}${NC}"
    exit 1
  fi
  chmod +x "$TARGET_PATH"
fi

# Verify installation
if [[ -x "$TARGET_PATH" ]]; then
  echo -e "${GREEN}✓ ${BINARY_NAME} installed successfully${NC}"
  echo ""
  echo -e "${BLUE}Location:${NC} ${TARGET_PATH}"

  echo -e "${BLUE}Version:${NC}  (run '${BINARY_NAME} --version' after adding to PATH)"

  echo ""
  check_path
  echo ""
  echo -e "${GREEN}Usage:${NC}"
  echo "  tauroboros              # Start the server"
  echo "  tauroboros --help       # Show help"
  echo ""
  echo -e "${YELLOW}Note: Run this command from within a git repository.${NC}"
  echo "  TaurOboros requires a git repository to track your project."
else
  echo -e "${RED}Installation failed - binary is not executable${NC}"
  exit 1
fi
