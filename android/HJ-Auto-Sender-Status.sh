#!/data/data/com.termux/files/usr/bin/bash
set -e
PROJECT_DIR="$HOME/HJ-Telegram-Streaming"
cd "$PROJECT_DIR"
if [ ! -f auto-link-sender-state.json ]; then
  echo "HJ Auto Sender: no saved job."
  exit 0
fi
node -e '
const fs=require("fs");
const p="auto-link-sender-state.json";
try {
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  console.log("Status       :", s.status || "unknown");
  console.log("Next batch   :", s.currentStart + "-" + s.currentEnd);
  console.log("Target bot   :", s.targetBot || "-");
  console.log("Batch size   :", s.batchSize || "-");
  console.log("Delay        :", (s.delaySeconds || 0) + " sec");
  console.log("Stop ID      :", s.lastMessageId == null ? "none" : s.lastMessageId);
  console.log("Sent batches :", Array.isArray(s.sentBatches) ? s.sentBatches.length : 0);
  console.log("Updated      :", s.updatedAt || "-");
} catch(e) {
  console.error("Could not read state:",e.message);
  process.exit(1);
}'
