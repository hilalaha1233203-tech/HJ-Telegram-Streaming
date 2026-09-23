#!/data/data/com.termux/files/usr/bin/bash
set -e

PROJECT_DIR="$HOME/HJ-Telegram-Streaming"
LOG_FILE="$PROJECT_DIR/auto-link-sender.log"

if [ ! -d "$PROJECT_DIR" ]; then
  exit 0
fi

cd "$PROJECT_DIR"

if [ ! -f "auto-link-sender-state.json" ]; then
  exit 0
fi

termux-wake-lock

nohup node auto-link-sender.js --auto-resume >> "$LOG_FILE" 2>&1 &
