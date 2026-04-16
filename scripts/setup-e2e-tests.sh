#!/bin/bash
# Podman Setup Script (without gVisor)
# Pure Podman container isolation using Ubuntu-based image

set -e

echo "========================================="
echo "Pi Easy Workflow - Podman Setup"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# =============================================================================
# Check Podman
# =============================================================================
echo "Step 1: Checking Podman installation..."
if ! command -v podman &> /dev/null; then
    echo -e "${RED}Error: Podman is not installed${NC}"
    echo "Please install Podman first:"
    echo "  - Ubuntu/Debian: sudo apt-get install -y podman"
    echo "  - Fedora: sudo dnf install -y podman"
    echo "  - Arch: sudo pacman -S podman"
    echo ""
    echo "Or see: https://podman.io/getting-started/installation"
    exit 1
fi

echo -e "${GREEN}✓ Podman is installed: $(podman --version)${NC}"
echo ""

# =============================================================================
# Build pi-agent image
# =============================================================================
echo "Step 2: Building pi-agent Podman image..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$PROJECT_ROOT/docker/pi-agent/Dockerfile" ]; then
    echo -e "${RED}Error: Dockerfile not found at $PROJECT_ROOT/docker/pi-agent/Dockerfile${NC}"
    exit 1
fi

cd "$PROJECT_ROOT"

# Build with podman
podman build -t pi-agent:latest -f docker/pi-agent/Dockerfile .

echo -e "${GREEN}✓ Podman image 'pi-agent:latest' built successfully${NC}"
echo ""

# =============================================================================
# Test container runtime
# =============================================================================
echo "Step 3: Testing container runtime..."

if podman run --rm pi-agent:latest pi --version 2>/dev/null; then
    echo -e "${GREEN}✓ Container runtime test passed${NC}"
    CONTAINER_TEST_PASSED=true
else
    echo -e "${YELLOW}⚠ Container test had issues, but image is built${NC}"
    echo "  You may need to configure Pi credentials in ~/.pi/"
    CONTAINER_TEST_PASSED=false
fi

echo ""

# =============================================================================
# Verify Installation
# =============================================================================
echo "Step 4: Verifying setup..."
echo ""
echo "Podman version:"
podman --version
echo ""
echo "pi-agent image:"
podman images pi-agent:latest --format "  Repository: {{.Repository}}\n  Tag: {{.Tag}}\n  Size: {{.Size}}"
echo ""

# =============================================================================
# Summary
# =============================================================================
echo "========================================="
if [ "$CONTAINER_TEST_PASSED" = true ]; then
    echo -e "${GREEN}Setup Complete!${NC}"
else
    echo -e "${GREEN}Setup Complete (with warnings)${NC}"
fi
echo "========================================="
echo ""
echo "Configuration:"
echo "  - Container engine: Podman"
echo "  - Image: pi-agent:latest"
echo "  - Isolation: Standard container boundaries"
echo ""
echo "To enable container mode, set in your .env file:"
echo "  PI_EASY_WORKFLOW_RUNTIME=container"
echo ""
echo "To run E2E tests:"
echo "  bun test tests/e2e/"
echo ""
echo "To verify the setup:"
echo "  bun run container:verify"
echo ""