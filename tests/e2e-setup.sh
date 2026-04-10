#!/bin/bash
# E2E Test Setup Script
# Starts the server and runs Playwright-based end-to-end tests

set -e

echo "========================================="
echo "Pi Easy Workflow - E2E Test Setup"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if playwright-cli is available
if ! command -v playwright-cli &> /dev/null; then
    echo -e "${RED}Error: playwright-cli is not installed${NC}"
    echo "Please install it: npm install -g @playwright/cli"
    exit 1
fi

echo -e "${GREEN}✓ playwright-cli is available${NC}"

# Check if podman is available (needed for container tests)
if ! command -v podman &> /dev/null; then
    echo -e "${YELLOW}⚠ Podman is not installed - container tests will be skipped${NC}"
fi

# Check if pi-agent image exists
if command -v podman &> /dev/null; then
    if podman images pi-agent:alpine -q | grep -q .; then
        echo -e "${GREEN}✓ pi-agent:alpine image found${NC}"
    else
        echo -e "${YELLOW}⚠ pi-agent:alpine image not found - building...${NC}"
        podman build -t pi-agent:alpine -f docker/pi-agent/Dockerfile .
        echo -e "${GREEN}✓ pi-agent:alpine image built${NC}"
    fi
fi

echo ""
echo "Setup complete. Run tests with: bun test tests/e2e/"
echo "========================================="
