#!/bin/bash
# Quick start helper script for pi-easy-workflow

echo "Pi Easy Workflow - Quick Start"
echo "================================"
echo ""

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "❌ Bun is not installed. Please install Bun first:"
    echo "   curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo "✓ Bun detected: $(bun --version)"
echo ""

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    bun install
fi

# Check if setup has been run
if [ ! -d ".pi/skills" ]; then
    echo "🔧 Running setup (skills install + verify)..."
    bun run setup
fi

echo ""
echo "🚀 Starting server..."
echo "   Server will start on http://localhost:3789"
echo ""
echo "   Press Ctrl+C to stop"
echo ""

#bun run start
bun run kanban:dev
