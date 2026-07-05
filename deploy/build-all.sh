#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Building Hide and Seek Companion..."
(
  cd "$ROOT_DIR/Hide and Seek Companion"
  npm ci
  APP_BASE_PATH=/hide-and-seek/ VITE_API_BASE_URL=/hide-and-seek npm run build
)

echo "Building Jetlag Mobile App..."
(
  cd "$ROOT_DIR/Jetlag Mobile App"
  npm ci
  APP_BASE_PATH=/jetlag/ npm run build
  cd server
  npm ci
)

echo "Building Jetlag Deduction Board..."
(
  cd "$ROOT_DIR/jetlag-deduction-board"
  npm ci
  APP_BASE_PATH=/deduction-board/ npm run build
  cd server
  npm ci
)

echo "Build complete."
echo "Install deploy/nginx-minigames.conf into Nginx and the systemd units from deploy/systemd/."
