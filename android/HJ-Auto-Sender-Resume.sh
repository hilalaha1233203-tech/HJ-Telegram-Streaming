#!/data/data/com.termux/files/usr/bin/bash
set -e
PROJECT_DIR="$HOME/HJ-Telegram-Streaming"
cd "$PROJECT_DIR"
printf 'RESUME\n' > auto-link-sender-control.txt
if [ -f auto-link-sender.lock ]; then
  echo "HJ Auto Sender: RESUME requested."
else
  if [ -f auto-link-sender-state.json ]; then
    nohup node auto-link-sender.js --auto-resume >> auto-link-sender.log 2>&1 &
    echo "HJ Auto Sender: started/resumed saved job."
  else
    echo "No saved HJ Auto Sender job found."
  fi
fi
