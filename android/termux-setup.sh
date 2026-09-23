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

if [ ! -f "$HOME/HJ-Telegram-Streaming/.env" ]; then
  echo ""
  echo "Telegram API credentials are needed once for this phone."
  echo "Use the same API_ID and API_HASH already used by your HJ Telegram project."
  printf "API_ID: "
  read -r API_ID_INPUT
  printf "API_HASH: "
  read -r API_HASH_INPUT

  if [ -z "$API_ID_INPUT" ] || [ -z "$API_HASH_INPUT" ]; then
    echo "API_ID and API_HASH cannot be empty."
    exit 1
  fi

  cat > "$HOME/HJ-Telegram-Streaming/.env" <<EOF
API_ID=$API_ID_INPUT
API_HASH=$API_HASH_INPUT
AUTO_BATCH_SIZE=5
AUTO_DELAY_SECONDS=600
EOF

  chmod 600 "$HOME/HJ-Telegram-Streaming/.env"
  echo "Saved Telegram API settings locally."
fi

mkdir -p "$HOME/.shortcuts"
mkdir -p "$HOME/.termux/boot"

for SHORTCUT in \
  HJ-Auto-Sender.sh \
  HJ-Auto-Sender-Pause.sh \
  HJ-Auto-Sender-Resume.sh \
  HJ-Auto-Sender-Stop.sh \
  HJ-Auto-Sender-Status.sh
do
  NAME="${SHORTCUT%.sh}"
  cp "$HOME/HJ-Telegram-Streaming/android/$SHORTCUT" "$HOME/.shortcuts/$NAME"
  chmod 700 "$HOME/.shortcuts/$NAME"
done

cp "$HOME/HJ-Telegram-Streaming/android/HJ-Auto-Sender-Boot.sh" "$HOME/.termux/boot/HJ-Auto-Sender-Boot"
chmod 700 "$HOME/.termux/boot/HJ-Auto-Sender-Boot"

echo ""
echo "Setup complete."
echo "Install/open Termux:Widget, then add its widget to the Android home screen."
echo "Shortcuts installed: HJ-Auto-Sender, HJ-Auto-Sender-Pause, HJ-Auto-Sender-Resume, HJ-Auto-Sender-Stop, HJ-Auto-Sender-Status."
echo "Telegram: the first run will ask for login. Later runs reuse the saved session."
