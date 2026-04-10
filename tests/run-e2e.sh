#!/bin/bash
# E2E Test Runner using Playwright Test
# This script runs the actual Playwright tests

set -e

echo "========================================="
echo "Pi Easy Workflow - E2E Test Runner"
echo "========================================="
echo ""

# Check if playwright is available
if ! command -v npx &> /dev/null; then
    echo "Error: npx is not available"
    exit 1
fi

# Install playwright if needed
if ! npx playwright --version &> /dev/null; then
    echo "Installing Playwright..."
    npm install -D @playwright/test
    npx playwright install
fi

# Run the tests
echo "Running Playwright tests..."
npx playwright test "$@"
