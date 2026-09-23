#!/data/data/com.termux/files/usr/bin/bash
set -e

PROJECT_DIR="$HOME/HJ-Telegram-Streaming"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "HJ-Telegram-Streaming folder not found."
  echo "Run the Android setup steps first."
  exit 1
fi

cd "$PROJECT_DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

exec npm run auto-link
