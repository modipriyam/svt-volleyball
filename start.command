#!/bin/bash
#
# Suhradam Volleyball Scoring — macOS one-click launcher.
# Double-click this file in Finder, or run ./start.command in Terminal.
# It checks Node is installed, installs dependencies on first run, then starts.

# Move to the folder this script lives in (so it works no matter where launched).
cd "$(dirname "$0")" || exit 1

echo "============================================"
echo "   Suhradam Volleyball Scoring System"
echo "============================================"
echo ""

# 1. Check Node.js is available.
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed."
  echo ""
  echo "Please install it first:"
  echo "  • Download the LTS installer from https://nodejs.org"
  echo "  • Or, with Homebrew:  brew install node"
  echo ""
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo "✅ Node.js $(node --version) found."

# 2. Install dependencies on first run (or if node_modules is missing).
if [ ! -d "node_modules" ]; then
  echo ""
  echo "📦 Installing dependencies (first run only, needs internet)..."
  npm install || {
    echo "❌ npm install failed. Check your internet connection and try again."
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
  }
fi

# 3. Start the server.
echo ""
echo "🏐 Starting server... (close this window or press Ctrl+C to stop)"
echo ""
node server.js
