#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=== HJ GROUPS Telegram Auto Sender - Android Setup ==="

pkg update -y
pkg install -y git nodejs-lts

cd "$HOME"

if [ ! -d "$HOME/HJ-Telegram-Streaming" ]; then
  git clone https://github.com/hilalaha1233203-tech/HJ-Telegram-Streaming.git
else
  cd "$HOME/HJ-Telegram-Streaming"
  git pull origin main
fi

cd "$HOME/HJ-Telegram-Streaming"
npm install

mkdir -p "$HOME/.shortcuts"
mkdir -p "$HOME/.termux/boot"

cp "$HOME/HJ-Telegram-Streaming/android/HJ-Auto-Sender.sh" "$HOME/.shortcuts/HJ-Auto-Sender"
chmod 700 "$HOME/.shortcuts/HJ-Auto-Sender"

cp "$HOME/HJ-Telegram-Streaming/android/HJ-Auto-Sender-Boot.sh" "$HOME/.termux/boot/HJ-Auto-Sender-Boot"
chmod 700 "$HOME/.termux/boot/HJ-Auto-Sender-Boot"

echo ""
echo "Setup complete."
echo "Install/open Termux:Widget, then add its widget to the Android home screen."
echo "The HJ-Auto-Sender shortcut will appear there."
echo "Telegram: the first run will ask for login. Later runs reuse the saved session."
