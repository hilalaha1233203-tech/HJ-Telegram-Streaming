#!/data/data/com.termux/files/usr/bin/bash
set -e
PROJECT_DIR="$HOME/HJ-Telegram-Streaming"
cd "$PROJECT_DIR"
printf 'STOP\n' > auto-link-sender-control.txt
echo "HJ Auto Sender: STOP requested."
